import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  handleGetTemplates,
  handleCreateTemplate,
  handleUpdateTemplate,
  handleDeleteTemplate,
  extractTemplateVariables,
  SUPPORTED_LANGUAGES,
  SYSTEM_EMAIL_TEMPLATES
} from "../src/api/templates.js";
import { getDbClient } from "../src/db/client.js";

const rootDir = path.resolve(process.cwd());
const v2Dir = fs.existsSync(path.join(rootDir, "src", "db", "schema.sql"))
  ? rootDir
  : path.join(rootDir, "v2");

const schemaSqlPath = path.join(v2Dir, "src", "db", "schema.sql");
const testDbPath = path.join(v2Dir, `tmp_templates_test_${Date.now()}.db`);

// Initialize in-memory/temp SQLite database
const schemaSql = fs.readFileSync(schemaSqlPath, "utf8");
execFileSync("sqlite3", [testDbPath], { input: schemaSql, encoding: "utf8" });

function formatSql(sql, args = []) {
  if (!args || args.length === 0) return sql;
  let idx = 0;
  return sql.replace(/\?/g, () => {
    const val = args[idx++];
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number") return String(val);
    if (typeof val === "boolean") return val ? "1" : "0";
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}

const mockDb = {
  async execute(query) {
    const sql = typeof query === "string" ? query : query.sql;
    const args = typeof query === "string" ? [] : (query.args || []);
    const formatted = formatSql(sql, args);
    const trimmed = formatted.trim();

    if (trimmed.toUpperCase().startsWith("SELECT") || trimmed.toUpperCase().startsWith("PRAGMA")) {
      const jsonOut = execFileSync(
        "sqlite3",
        [testDbPath, `-json`, formatted],
        { encoding: "utf8" }
      ).trim();
      const rows = JSON.parse(jsonOut || "[]");
      return { rows, results: rows };
    } else {
      execFileSync("sqlite3", [testDbPath, formatted], { encoding: "utf8" });
      return { rows: [], results: [] };
    }
  }
};

const mockEnv = {
  DB: mockDb
};

const db = mockDb;

function createMockContext(user, body = {}, query = {}, params = {}) {
  return {
    env: mockEnv,
    get(key) {
      if (key === "user") return user;
      return null;
    },
    req: {
      query(k) {
        return query[k] || "";
      },
      param(k) {
        return params[k] || "";
      },
      async json() {
        return body;
      }
    },
    json(data, status = 200) {
      return { status, data };
    }
  };
}

test("Template Manager API & Engine Tests", async (t) => {
  const userA = { id: "user_tenant_A", role: "user" };
  const userB = { id: "user_tenant_B", role: "user" };

  // Insert test users
  await db.execute({
    sql: `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`,
    args: [userA.id, "tenantA", "hashA", "user"]
  });
  await db.execute({
    sql: `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`,
    args: [userB.id, "tenantB", "hashB", "user"]
  });

  await t.test("1. extractTemplateVariables accurately parses numbered and named placeholders", () => {
    const waVars = extractTemplateVariables(
      "Hi {{1}}, your order at {{2}} is ready.",
      "Update: {{1}}",
      { header: ["order_title"], body: ["client_name", "company_name"] }
    );
    assert.strictEqual(waVars.length, 3);
    assert.strictEqual(waVars[0].component, "header");
    assert.strictEqual(waVars[0].label, "order_title");
    assert.strictEqual(waVars[1].component, "body");
    assert.strictEqual(waVars[1].label, "Client Name");
    assert.strictEqual(waVars[2].label, "Company Name");

    const emailVars = extractTemplateVariables(
      "Hello {{name}}, following up on {{topic}} with {{company}}.",
      ""
    );
    assert.strictEqual(emailVars.length, 3);
    assert.strictEqual(emailVars[0].label, "Name");
    assert.strictEqual(emailVars[1].label, "Topic");
    assert.strictEqual(emailVars[2].label, "Company");
  });

  await t.test("2. handleGetTemplates lists system WhatsApp and Email templates", async () => {
    const c = createMockContext(userA);
    const res = await handleGetTemplates(c);
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.success);
    assert.ok(res.data.templates.length > 0);

    const waTemplates = res.data.templates.filter(t => t.channel === "whatsapp");
    const emailTemplates = res.data.templates.filter(t => t.channel === "email");

    assert.ok(waTemplates.some(t => t.is_system), "Must include system WhatsApp templates");
    assert.ok(emailTemplates.some(t => t.name === "founder_intro_email"), "Must include system Email templates");
  });

  let createdWaTplId = null;
  await t.test("3. Create custom WhatsApp template with buttons and parameters", async () => {
    const payload = {
      name: "payment_reminder_v1",
      displayName: "Payment Reminder Notice",
      channel: "whatsapp",
      category: "UTILITY",
      language: "en",
      header_type: "TEXT",
      header_text: "Payment Due: {{1}}",
      body_text: "Hi {{1}}, invoice {{2}} is due on {{3}}.",
      footer_text: "Finance Team",
      buttons: [
        { type: "URL", text: "Pay Online", url: "https://pay.example.com" }
      ],
      param_mappings: {
        header: ["invoice_id"],
        body: ["client_name", "invoice_number", "due_date"]
      }
    };

    const c = createMockContext(userA, payload);
    const res = await handleCreateTemplate(c);
    assert.strictEqual(res.status, 201);
    assert.ok(res.data.success);
    assert.strictEqual(res.data.template.name, "payment_reminder_v1");
    assert.strictEqual(res.data.template.channel, "whatsapp");
    createdWaTplId = res.data.template.id;

    // Verify persisted in DB
    const dbTpl = await db.execute({
      sql: `SELECT t.*, wa.category, wa.buttons FROM templates t JOIN whatsapp_template_configs wa ON t.id = wa.template_id WHERE t.id = ?`,
      args: [createdWaTplId]
    });
    assert.strictEqual(dbTpl.rows.length, 1);
    assert.strictEqual(dbTpl.rows[0].name, "payment_reminder_v1");
    assert.strictEqual(dbTpl.rows[0].category, "UTILITY");
  });

  let createdEmailTplId = null;
  await t.test("4. Create custom Email template with subject and parameters", async () => {
    const payload = {
      name: "onboarding_welcome",
      displayName: "Client Welcome Email",
      channel: "email",
      subject: "Welcome to Collectrr, {{name}}!",
      body_text: "Hi {{name}},\n\nWelcome to your new workspace. Please let us know if you need anything.\n\nBest,\n{{sender_name}}",
      param_mappings: {
        subject: ["name"],
        body: ["name", "sender_name"]
      }
    };

    const c = createMockContext(userA, payload);
    const res = await handleCreateTemplate(c);
    assert.strictEqual(res.status, 201);
    assert.ok(res.data.success);
    assert.strictEqual(res.data.template.name, "onboarding_welcome");
    assert.strictEqual(res.data.template.channel, "email");
    createdEmailTplId = res.data.template.id;

    const dbTpl = await db.execute({
      sql: `SELECT t.*, em.subject FROM templates t JOIN email_template_configs em ON t.id = em.template_id WHERE t.id = ?`,
      args: [createdEmailTplId]
    });
    assert.strictEqual(dbTpl.rows.length, 1);
    assert.strictEqual(dbTpl.rows[0].subject, "Welcome to Collectrr, {{name}}!");
  });

  await t.test("5. Duplicate template name rejection within same tenant", async () => {
    const payload = {
      name: "payment_reminder_v1",
      displayName: "Duplicate Reminder",
      channel: "whatsapp",
      body_text: "Duplicate body"
    };
    const c = createMockContext(userA, payload);
    const res = await handleCreateTemplate(c);
    assert.strictEqual(res.status, 409);
    assert.ok(!res.data.success);
  });

  await t.test("6. Multi-tenant isolation: User B CAN create same template name as User A", async () => {
    const payload = {
      name: "payment_reminder_v1",
      displayName: "User B Reminder",
      channel: "whatsapp",
      body_text: "User B body text"
    };
    const c = createMockContext(userB, payload);
    const res = await handleCreateTemplate(c);
    assert.strictEqual(res.status, 201);
    assert.ok(res.data.success);
  });

  await t.test("7. Update custom template increments version", async () => {
    const payload = {
      displayName: "Payment Reminder Notice (Updated)",
      body_text: "Hi {{1}}, invoice {{2}} is due tomorrow. Please pay promptly.",
      category: "UTILITY",
      language: "en"
    };
    const c = createMockContext(userA, payload, {}, { id: createdWaTplId });
    const res = await handleUpdateTemplate(c);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.version, 2);

    const check = await db.execute({
      sql: `SELECT version, display_name FROM templates WHERE id = ?`,
      args: [createdWaTplId]
    });
    assert.strictEqual(check.rows[0].version, 2);
    assert.strictEqual(check.rows[0].display_name, "Payment Reminder Notice (Updated)");
  });

  await t.test("8. User B cannot update User A template (403 Forbidden)", async () => {
    const payload = {
      body_text: "Malicious update attempt"
    };
    const c = createMockContext(userB, payload, {}, { id: createdWaTplId });
    const res = await handleUpdateTemplate(c);
    assert.strictEqual(res.status, 403);
  });

  await t.test("9. Soft-archive custom template sets status = 'archived'", async () => {
    const c = createMockContext(userA, {}, {}, { id: createdEmailTplId });
    const res = await handleDeleteTemplate(c);
    assert.strictEqual(res.status, 200);

    const check = await db.execute({
      sql: `SELECT status FROM templates WHERE id = ?`,
      args: [createdEmailTplId]
    });
    assert.strictEqual(check.rows[0].status, "archived");

    // handleGetTemplates default active query excludes archived
    const listC = createMockContext(userA, {}, { status: "active" });
    const listRes = await handleGetTemplates(listC);
    const hasArchived = listRes.data.templates.some(t => t.id === createdEmailTplId);
    assert.ok(!hasArchived, "Active list must not include archived templates");
  });

  // Cleanup temp db
  t.after(() => {
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch (_) {}
  });
});
