import "./helpers/network-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import { sign } from "hono/jwt";
import app from "../src/index.js";

const JWT_SECRET = "test_jwt_auth_secret_key_987654";

function createMockDb(cases = []) {
  return {
    prepare: (sql) => {
      let boundArgs = [];
      return {
        bind: (...args) => {
          boundArgs = args;
          return {
            all: async () => {
              // Handle SELECT for loan_cases
              if (sql.includes("FROM loan_cases")) {
                const caseId = boundArgs[0];
                const userId = boundArgs[1];
                if (sql.includes("user_id = ?")) {
                  const filtered = cases.filter(c => c.id === caseId && (c.user_id === userId || c.is_demo === 1));
                  return { results: filtered };
                }
                const found = cases.filter(c => c.id === caseId);
                return { results: found };
              }
              if (sql.includes("FROM message_templates")) {
                return { results: [] };
              }
              return { results: [] };
            },
            run: async () => ({ success: true, meta: { changes: 1 } })
          };
        },
        all: async () => ({ results: [] }),
        run: async () => ({ success: true })
      };
    }
  };
}

test("Route-Level Authentication, Role Matrix & Cross-Tenant Isolation Tests", async (t) => {
  const env = {
    ENVIRONMENT: "production",
    JWT_SECRET,
    DB: createMockDb([
      { id: "case_tenant_b", user_id: "user_b", contact_person: "Borrower B", is_demo: 0, status: "lead" }
    ])
  };

  const agentToken = await sign({ id: "user_a", username: "AgentA", role: "agent" }, JWT_SECRET);
  const adminToken = await sign({ id: "admin_1", username: "AdminUser", role: "admin" }, JWT_SECRET);
  const noRoleToken = await sign({ id: "user_norole", username: "NoRoleUser", role: null }, JWT_SECRET);
  const unknownRoleToken = await sign({ id: "user_guest", username: "GuestUser", role: "guest" }, JWT_SECRET);

  await t.test("1. Unauthenticated request to protected route (/api/cases) returns 401", async () => {
    const res = await app.request("https://collectrr.workers.dev/api/cases", {
      method: "GET"
    }, env);

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  });

  await t.test("2. Unauthenticated request to admin route (/api/admin/templates) returns 401", async () => {
    const res = await app.request("https://collectrr.workers.dev/api/admin/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test_tpl" })
    }, env);

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  });

  await t.test("3. Forged or invalid JWT token returns 401", async () => {
    const forgedToken = await sign({ id: "hacker", role: "admin" }, "wrong_secret_key");
    const res = await app.request("https://collectrr.workers.dev/api/cases", {
      method: "GET",
      headers: { Authorization: `Bearer ${forgedToken}` }
    }, env);

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  });

  await t.test("4. Missing or invalid role claim (role: null or role: 'guest') accessing admin route returns 403", async () => {
    const resNullRole = await app.request("https://collectrr.workers.dev/api/admin/templates", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${noRoleToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: "test_tpl" })
    }, env);
    assert.equal(resNullRole.status, 403);

    const resGuestRole = await app.request("https://collectrr.workers.dev/api/admin/templates", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${unknownRoleToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: "test_tpl" })
    }, env);
    assert.equal(resGuestRole.status, 403);
  });

  await t.test("5. Agent role (role: 'agent') accessing admin endpoints returns 403", async () => {
    const resTemplates = await app.request("https://collectrr.workers.dev/api/admin/templates", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: "unauthorized_custom_tpl" })
    }, env);
    assert.equal(resTemplates.status, 403);

    const resAdjustCredits = await app.request("https://collectrr.workers.dev/api/admin/credits/adjust", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ targetUserId: "usr_123", amountRupees: 50, reason: "Unauthorized attempt" })
    }, env);
    assert.equal(resAdjustCredits.status, 403);
  });

  await t.test("6. Admin role (role: 'admin') passes admin authorization on admin route", async () => {
    // Admin access should pass both authMiddleware and adminOnlyMiddleware (status is not 401 or 403)
    const res = await app.request("https://collectrr.workers.dev/api/admin/templates", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: "" }) // Invalid payload triggers 400 validation error in controller, proving auth passed
    }, env);

    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 403);
  });

  await t.test("7. Cross-tenant read isolation: User A requesting case belonging to User B returns 403", async () => {
    const res = await app.request("https://collectrr.workers.dev/api/cases/case_tenant_b", {
      method: "GET",
      headers: { Authorization: `Bearer ${agentToken}` }
    }, env);

    // Case exists in database under user_b, but user_a is requesting it -> must be 403
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error);
  });

  await t.test("8. Cross-tenant mutation isolation: User A attempting status update on User B's case is rejected with 403", async () => {
    const res = await app.request("https://collectrr.workers.dev/api/cases/case_tenant_b/status", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ status: "disbursed" })
    }, env);

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error);
  });

  await t.test("9. Analytics & Observability pages return 200 HTML without 404", async () => {
    const resAnalytics = await app.request("https://collectrr.workers.dev/admin/analytics", { method: "GET" }, env);
    assert.equal(resAnalytics.status, 200);
    const htmlAnalytics = await resAnalytics.text();
    assert.ok(htmlAnalytics.includes("Platform Analytics"));

    const resObservability = await app.request("https://collectrr.workers.dev/observability", { method: "GET" }, env);
    assert.equal(resObservability.status, 200);
    const htmlObservability = await resObservability.text();
    assert.ok(htmlObservability.includes("System Observability"));

    const resDd = await app.request("https://collectrr.workers.dev/dd", { method: "GET" }, env);
    assert.equal(resDd.status, 200);

    const resAdmin = await app.request("https://collectrr.workers.dev/admin", { method: "GET" }, env);
    assert.equal(resAdmin.status, 302); // Redirects to /admin/analytics
  });

  await t.test("10. Reset Password API validates input & handles missing user gracefully", async () => {
    const resShort = await app.request("https://collectrr.workers.dev/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "papajohn", newPassword: "123" })
    }, env);
    assert.equal(resShort.status, 400);

    const resMissing = await app.request("https://collectrr.workers.dev/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nonexistent_user", newPassword: "valid_password_123" })
    }, env);
    assert.equal(resMissing.status, 404);

    const resPage = await app.request("https://collectrr.workers.dev/forgot-password", { method: "GET" }, env);
    assert.equal(resPage.status, 302);
  });
});

