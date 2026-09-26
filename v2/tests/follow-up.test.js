import "./helpers/network-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import { sign } from "hono/jwt";
import app from "../src/index.js";
import { computeFollowUpUtc, localToUtc, utcToLocalParts } from "../src/scheduler/time.js";
import { scanAndExecuteDueFollowUps } from "../src/scheduler/scanner.js";
import { handleInboundRequestReply } from "../src/api/requests.js";

const JWT_SECRET = "collectr_dev_jwt_secret_change_in_prod";

async function createAuthHeader(user) {
  const token = await sign(
    {
      id: user.id,
      user_id: user.id,
      sub: user.id,
      username: user.username,
      role: user.role || "agent",
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET
  );
  return `Bearer ${token}`;
}

function createMockDb() {
  const store = {
    users: [
      { id: "usr_1", username: "Agent1", role: "agent", credit_balance: 1000 },
      { id: "usr_2", username: "Agent2", role: "agent", credit_balance: 1000 },
    ],
    contacts: [
      { id: "cnt_1", user_id: "usr_1", name: "Ramesh Kumar", phone_number: "919876543210", email: "ramesh@example.com" },
      { id: "cnt_2", user_id: "usr_2", name: "Suresh Patel", phone_number: "919876543211", email: "suresh@example.com" },
    ],
    conversations: [
      { id: "conv_1", user_id: "usr_1", contact_id: "cnt_1", channel: "whatsapp" },
    ],
    requests: [
      { id: "req_1", user_id: "usr_1", contact_id: "cnt_1", title: "Send GST Certificate", status: "open", due_date: null },
      { id: "req_2", user_id: "usr_1", contact_id: "cnt_1", title: "Sign Loan Agreement", status: "waiting_on_them", due_date: null },
      { id: "req_done", user_id: "usr_1", contact_id: "cnt_1", title: "Completed Task", status: "completed", due_date: null },
    ],
    request_items: [],
    request_follow_ups: [],
    activities: [],
    messages: [],
  };

  return {
    store,
    execute: async (query) => {
      const sql = typeof query === "string" ? query : query.sql;
      const args = typeof query === "string" ? [] : (query.args || []);
      const norm = sql.replace(/\s+/g, " ").trim();

      // SELECT users
      if (norm.includes("FROM users WHERE id = ?")) {
        const u = store.users.find(x => x.id === args[0]);
        return { rows: u ? [u] : [] };
      }

      // SELECT contacts
      if (norm.includes("FROM contacts WHERE id = ? AND user_id = ?")) {
        const c = store.contacts.find(x => x.id === args[0] && x.user_id === args[1]);
        return { rows: c ? [c] : [] };
      }
      if (norm.includes("FROM contacts WHERE id = ?")) {
        const c = store.contacts.find(x => x.id === args[0]);
        return { rows: c ? [c] : [] };
      }

      // SELECT conversations
      if (norm.includes("FROM conversations WHERE user_id = ? AND contact_id = ?")) {
        const convs = store.conversations.filter(x => x.user_id === args[0] && x.contact_id === args[1]);
        return { rows: convs };
      }
      if (norm.includes("FROM conversations WHERE contact_id = ?")) {
        const convs = store.conversations.filter(x => x.contact_id === args[0]);
        return { rows: convs };
      }

      // SELECT messages
      if (norm.includes("FROM messages WHERE contact_id = ?")) {
        const msgs = store.messages.filter(x => x.contact_id === args[0]);
        return { rows: msgs };
      }

      // SELECT requests
      if (norm.includes("FROM requests WHERE id = ? AND user_id = ?")) {
        const r = store.requests.find(x => x.id === args[0] && x.user_id === args[1]);
        return { rows: r ? [r] : [] };
      }
      if (norm.includes("FROM requests WHERE contact_id = ?")) {
        const reqs = store.requests.filter(x => x.contact_id === args[0]);
        return { rows: reqs };
      }
      if (norm.includes("FROM requests WHERE id = ?")) {
        const r = store.requests.find(x => x.id === args[0]);
        return { rows: r ? [r] : [] };
      }
      if (norm.includes("FROM requests WHERE user_id = ? AND contact_id = ?")) {
        const reqs = store.requests.filter(x => x.user_id === args[0] && x.contact_id === args[1]);
        return { rows: reqs };
      }

      // SELECT request_items
      if (norm.includes("FROM request_items WHERE request_id = ?")) {
        const items = store.request_items.filter(x => x.request_id === args[0]);
        return { rows: items };
      }

      // SELECT request_follow_ups
      if (norm.includes("FROM request_follow_ups WHERE request_id = ? AND status = 'pending'")) {
        const rfus = store.request_follow_ups.filter(x => x.request_id === args[0] && x.status === "pending");
        return { rows: rfus };
      }
      if (norm.includes("FROM request_follow_ups WHERE status = 'pending' AND scheduled_for_utc <= datetime('now')")) {
        const rfus = store.request_follow_ups.filter(x => x.status === "pending");
        return { rows: rfus };
      }

      // INSERT INTO request_follow_ups
      if (norm.startsWith("INSERT INTO request_follow_ups")) {
        const [id, request_id, user_id, contact_id, preset, scheduled_for_utc] = args;
        const row = {
          id,
          request_id,
          user_id,
          contact_id,
          preset,
          scheduled_for_utc,
          status: "pending",
          skip_reason: null,
          completed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        store.request_follow_ups.push(row);
        return { rowsAffected: 1, changes: 1 };
      }

      // UPDATE request_follow_ups
      if (norm.startsWith("UPDATE request_follow_ups")) {
        let changed = 0;
        if (norm.includes("WHERE id = ? AND status = 'pending'")) {
          const row = store.request_follow_ups.find(x => x.id === args[0] && x.status === "pending");
          if (row) {
            row.status = "completed";
            row.completed_at = new Date().toISOString();
            row.updated_at = new Date().toISOString();
            return { rows: [{ id: row.id }], rowsAffected: 1, changes: 1, meta: { changes: 1 } };
          }
        }
        if (norm.includes("WHERE request_id = ? AND status = 'pending'")) {
          const targetReqId = args[args.length - 1];
          const rows = store.request_follow_ups.filter(x => x.request_id === targetReqId && x.status === "pending");
          for (const r of rows) {
            r.status = "cancelled";
            if (norm.includes("skip_reason = ?")) {
              r.skip_reason = args[0];
            } else if (norm.includes("skip_reason = 'rescheduled'")) {
              r.skip_reason = "rescheduled";
            } else if (norm.includes("skip_reason = 'user_cleared'")) {
              r.skip_reason = "user_cleared";
            } else if (norm.includes("skip_reason = 'request_replied'")) {
              r.skip_reason = "request_replied";
            }
            r.updated_at = new Date().toISOString();
            changed++;
          }
          return { rowsAffected: changed, changes: changed, meta: { changes: changed } };
        }
        if (norm.includes("SET skip_reason = ? WHERE id = ?")) {
          const r = store.request_follow_ups.find(x => x.id === args[1]);
          if (r) {
            r.skip_reason = args[0];
            changed = 1;
          }
          return { rowsAffected: changed, changes: changed, meta: { changes: changed } };
        }
        return { rowsAffected: changed, changes: changed, meta: { changes: changed } };
      }

      // UPDATE requests
      if (norm.startsWith("UPDATE requests")) {
        let changed = 0;
        if (norm.includes("WHERE id = ? AND user_id = ?")) {
          const [targetStatus, completedAt, requestId, userId] = args;
          const r = store.requests.find(x => x.id === requestId && x.user_id === userId);
          if (r) {
            r.status = targetStatus;
            r.completed_at = completedAt;
            r.updated_at = new Date().toISOString();
            changed = 1;
          }
        } else if (norm.includes("SET status = 'needs_follow_up'") || norm.includes("status IN ('waiting_on_them', 'open')")) {
          const r = store.requests.find(x => x.id === args[0]);
          if (r && ["waiting_on_them", "open"].includes(r.status)) {
            r.status = "needs_follow_up";
            r.updated_at = new Date().toISOString();
            changed = 1;
          }
        } else if (norm.includes("SET status = 'waiting_on_me'")) {
          const r = store.requests.find(x => x.id === args[0]);
          if (r) {
            r.status = "waiting_on_me";
            r.updated_at = new Date().toISOString();
            changed = 1;
          }
        } else if (norm.includes("SET status = 'waiting_on_them'")) {
          const r = store.requests.find(x => x.id === args[0]);
          if (r) {
            r.status = "waiting_on_them";
            r.updated_at = new Date().toISOString();
            changed = 1;
          }
        }
        return { rowsAffected: changed, changes: changed, meta: { changes: changed } };
      }

      // INSERT INTO activities
      if (norm.startsWith("INSERT INTO activities")) {
        let activity_type = "unknown";
        if (norm.includes("'follow_up_scheduled'")) activity_type = "follow_up_scheduled";
        else if (norm.includes("'follow_up_cancelled'")) activity_type = "follow_up_cancelled";
        else if (norm.includes("'request_needs_follow_up'")) activity_type = "request_needs_follow_up";
        else if (norm.includes("'request_status_updated'")) activity_type = "request_status_updated";
        else if (norm.includes("'request_completed'")) activity_type = "request_completed";

        const [id, user_id, contact_id, request_id] = args;
        store.activities.push({
          id, user_id, contact_id, request_id, activity_type,
          created_at: new Date().toISOString()
        });
        return { rowsAffected: 1, changes: 1, meta: { changes: 1 } };
      }

      // SELECT activities
      if (norm.includes("FROM activities WHERE contact_id = ?")) {
        const acts = store.activities.filter(x => x.contact_id === args[0]);
        return { rows: acts };
      }

      return { rows: [], rowsAffected: 0, changes: 0, meta: { changes: 0 } };
    },
  };
}

test("1-Click Request Follow-Up Engine Invariant Tests", async (t) => {

  await t.test("Invariant 1: Presets anchor strictly to 10:00:00 AM local time in configured timezone", () => {
    const tz = "Asia/Kolkata"; // UTC+5:30
    const tomorrowUtc = computeFollowUpUtc("tomorrow", null, tz);
    const threeDaysUtc = computeFollowUpUtc("3_days", null, tz);
    const nextWeekUtc = computeFollowUpUtc("next_week", null, tz);

    // In Asia/Kolkata, 10:00:00 AM is 04:30:00 UTC
    assert.match(tomorrowUtc, /04:30:00$/);
    assert.match(threeDaysUtc, /04:30:00$/);
    assert.match(nextWeekUtc, /04:30:00$/);

    // Verify day difference
    const d1 = new Date(tomorrowUtc.replace(" ", "T") + "Z");
    const d3 = new Date(threeDaysUtc.replace(" ", "T") + "Z");
    const d7 = new Date(nextWeekUtc.replace(" ", "T") + "Z");

    const diffDays1to3 = Math.round((d3.getTime() - d1.getTime()) / (24 * 3600 * 1000));
    assert.equal(diffDays1to3, 2);

    const diffDays1to7 = Math.round((d7.getTime() - d1.getTime()) / (24 * 3600 * 1000));
    assert.equal(diffDays1to7, 6);
  });

  await t.test("Invariant 2: POST /api/requests/:id/follow-up creates follow-up and moves open request to waiting_on_them", async () => {
    const db = createMockDb();
    const env = { DB: db, JWT_SECRET };
    const authHeader = await createAuthHeader(db.store.users[0]);

    const res = await app.request("http://localhost/api/requests/req_1/follow-up", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ preset: "tomorrow", timezone: "Asia/Kolkata" }),
    }, env);

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.followUp.preset, "tomorrow");
    assert.equal(data.followUp.status, "pending");
    assert.equal(data.requestStatus, "waiting_on_them");

    // Request in store moved to waiting_on_them
    const req = db.store.requests.find(r => r.id === "req_1");
    assert.equal(req.status, "waiting_on_them");

    // Audit activity created
    const act = db.store.activities.find(a => a.activity_type === "follow_up_scheduled");
    assert.ok(act);
    assert.equal(act.request_id, "req_1");
  });

  await t.test("Invariant 3: Rescheduling cancels existing pending follow-up with skip_reason = 'rescheduled'", async () => {
    const db = createMockDb();
    const env = { DB: db, JWT_SECRET };
    const authHeader = await createAuthHeader(db.store.users[0]);

    // Schedule 1st
    await app.request("http://localhost/api/requests/req_1/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ preset: "tomorrow" }),
    }, env);

    const firstFollowUp = db.store.request_follow_ups.find(f => f.request_id === "req_1" && f.preset === "tomorrow");
    assert.ok(firstFollowUp);
    assert.equal(firstFollowUp.status, "pending");

    // Reschedule to 3_days
    const res2 = await app.request("http://localhost/api/requests/req_1/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ preset: "3_days" }),
    }, env);

    assert.equal(res2.status, 201);

    // Old follow-up cancelled with rescheduled
    assert.equal(firstFollowUp.status, "cancelled");
    assert.equal(firstFollowUp.skip_reason, "rescheduled");

    // New active pending follow-up
    const active = db.store.request_follow_ups.filter(f => f.request_id === "req_1" && f.status === "pending");
    assert.equal(active.length, 1);
    assert.equal(active[0].preset, "3_days");
  });

  await t.test("Invariant 4: Cannot schedule follow-up for completed or cancelled request (returns 400)", async () => {
    const db = createMockDb();
    const env = { DB: db, JWT_SECRET };
    const authHeader = await createAuthHeader(db.store.users[0]);

    const res = await app.request("http://localhost/api/requests/req_done/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ preset: "tomorrow" }),
    }, env);

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /Cannot schedule a follow-up for a completed or cancelled request/i);
  });

  await t.test("Invariant 5: Tenant isolation prevents cross-tenant follow-up scheduling (returns 404)", async () => {
    const db = createMockDb();
    const env = { DB: db, JWT_SECRET };
    const authHeaderUser2 = await createAuthHeader(db.store.users[1]);

    // User 2 trying to set follow-up on User 1's request
    const res = await app.request("http://localhost/api/requests/req_1/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeaderUser2 },
      body: JSON.stringify({ preset: "tomorrow" }),
    }, env);

    assert.equal(res.status, 404);
  });

  await t.test("Invariant 6: POST /api/requests/:id/follow-up/clear cancels active follow-up with 'user_cleared'", async () => {
    const db = createMockDb();
    const env = { DB: db, JWT_SECRET };
    const authHeader = await createAuthHeader(db.store.users[0]);

    // Set follow-up
    await app.request("http://localhost/api/requests/req_2/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ preset: "next_week" }),
    }, env);

    // Clear follow-up
    const clearRes = await app.request("http://localhost/api/requests/req_2/follow-up/clear", {
      method: "POST",
      headers: { Authorization: authHeader },
    }, env);

    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.success, true);
    assert.equal(clearData.cleared, true);

    const f = db.store.request_follow_ups.find(x => x.request_id === "req_2");
    assert.equal(f.status, "cancelled");
    assert.equal(f.skip_reason, "user_cleared");

    const act = db.store.activities.find(a => a.activity_type === "follow_up_cancelled");
    assert.ok(act);
  });

  await t.test("Invariant 7: Completing a request automatically cancels pending follow-up with 'request_completed'", async () => {
    const db = createMockDb();
    const env = { DB: db, JWT_SECRET };
    const authHeader = await createAuthHeader(db.store.users[0]);

    // Set follow-up
    await app.request("http://localhost/api/requests/req_2/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ preset: "tomorrow" }),
    }, env);

    const f = db.store.request_follow_ups.find(x => x.request_id === "req_2" && x.status === "pending");
    assert.ok(f);

    // Complete request
    const patchRes = await app.request("http://localhost/api/requests/req_2/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ status: "completed" }),
    }, env);

    assert.equal(patchRes.status, 200);
    assert.equal(f.status, "cancelled");
    assert.equal(f.skip_reason, "request_completed");
  });

  await t.test("Invariant 8: Cron scanner transitions due follow-up to completed and request to needs_follow_up", async () => {
    const db = createMockDb();
    db.store.request_follow_ups.push({
      id: "rfu_due_1",
      request_id: "req_2",
      user_id: "usr_1",
      contact_id: "cnt_1",
      preset: "tomorrow",
      scheduled_for_utc: "2026-09-20 04:30:00",
      status: "pending",
      skip_reason: null,
      completed_at: null,
      created_at: "2026-09-19T10:00:00Z",
      updated_at: "2026-09-19T10:00:00Z",
    });

    const result = await scanAndExecuteDueFollowUps(db, 50);
    assert.equal(result.scanned, 1);
    assert.equal(result.completed, 1);

    const f = db.store.request_follow_ups.find(x => x.id === "rfu_due_1");
    assert.equal(f.status, "completed");

    const req = db.store.requests.find(r => r.id === "req_2");
    assert.equal(req.status, "needs_follow_up");

    const act = db.store.activities.find(a => a.activity_type === "request_needs_follow_up");
    assert.ok(act);
    assert.equal(act.request_id, "req_2");
  });

  await t.test("Invariant 9: Inbound reply transitions request to waiting_on_me and cancels pending follow-up with 'request_replied'", async () => {
    const db = createMockDb();
    db.store.request_follow_ups.push({
      id: "rfu_pending_1",
      request_id: "req_2",
      user_id: "usr_1",
      contact_id: "cnt_1",
      preset: "3_days",
      scheduled_for_utc: "2026-09-28 04:30:00",
      status: "pending",
      skip_reason: null,
      completed_at: null,
      created_at: "2026-09-25T10:00:00Z",
      updated_at: "2026-09-25T10:00:00Z",
    });

    const replyResult = await handleInboundRequestReply(db, "req_2", "usr_1", "cnt_1");
    assert.equal(replyResult.updated, true);

    const req = db.store.requests.find(r => r.id === "req_2");
    assert.equal(req.status, "waiting_on_me");

    const f = db.store.request_follow_ups.find(x => x.id === "rfu_pending_1");
    assert.equal(f.status, "cancelled");
    assert.equal(f.skip_reason, "request_replied");
  });

  await t.test("Invariant 10: Workspace GET /api/contacts/:id attaches active followUp to requests", async () => {
    const db = createMockDb();
    const env = { DB: db, JWT_SECRET };
    const authHeader = await createAuthHeader(db.store.users[0]);

    db.store.request_follow_ups.push({
      id: "rfu_active_1",
      request_id: "req_1",
      user_id: "usr_1",
      contact_id: "cnt_1",
      preset: "tomorrow",
      scheduled_for_utc: "2026-09-27 04:30:00",
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = await app.request("http://localhost/api/contacts/cnt_1", {
      headers: { Authorization: authHeader },
    }, env);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.requests));

    const req1 = data.requests.find(r => r.id === "req_1");
    assert.ok(req1);
    assert.ok(req1.followUp);
    assert.equal(req1.followUp.preset, "tomorrow");
    assert.equal(req1.followUp.status, "pending");
  });
});
