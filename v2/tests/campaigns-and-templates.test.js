import "./helpers/network-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  handleGetCampaigns,
  handleGetCampaignDetail,
  handleGetCampaignRecipients,
  handleCreateCampaign,
  handleSetCampaignMessages,
  handlePreviewCampaignAudience,
  handleLaunchCampaign,
  handleScheduleCampaign,
  handleCancelCampaign
} from "../src/api/campaigns.js";
import { processCampaignRecipient, processCampaignBatch, handleQueueBatch } from "../src/scheduler/consumer.js";
import { scanAndClaimDueOccurrences } from "../src/scheduler/scanner.js";
import { handleWebhookEvent } from "../src/api/webhook.js";

const rootDir = path.resolve(process.cwd());
const v2Dir = fs.existsSync(path.join(rootDir, "src", "db", "schema.sql"))
  ? rootDir
  : path.join(rootDir, "v2");

const schemaSqlPath = path.join(v2Dir, "src", "db", "schema.sql");
const testDbPath = path.join(v2Dir, `tmp_campaigns_test_${Date.now()}.db`);

// Initialize temp SQLite database
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

    const isQueryOrReturning = trimmed.toUpperCase().startsWith("SELECT") ||
                               trimmed.toUpperCase().startsWith("PRAGMA") ||
                               trimmed.toUpperCase().includes("RETURNING");

    if (isQueryOrReturning) {
      const jsonOut = execFileSync(
        "sqlite3",
        [testDbPath, `-json`, formatted],
        { encoding: "utf8" }
      ).trim();
      const rows = JSON.parse(jsonOut || "[]");
      return { rows, results: rows, changes: rows.length };
    } else {
      execFileSync("sqlite3", [testDbPath, formatted], { encoding: "utf8" });
      return { rows: [], results: [], changes: 1 };
    }
  }
};

const mockEnv = {
  DB: mockDb,
  ENVIRONMENT: "development",
  MOCK_WHATSAPP: "true",
  MOCK_WHATSAPP_STATUS: "sent",
  MOCK_EMAIL: "true",
  WHATSAPP_PHONE_ID: "wa_phone_test_123"
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
    },
    text(txt, status = 200) {
      return { status, text: txt };
    }
  };
}

test("Collectrr Campaigns Engine & Lifecycle Tests", async (t) => {
  const userA = { id: "usr_camp_A", username: "FounderA", role: "user" };
  const userB = { id: "usr_camp_B", username: "FounderB", role: "user" };

  // Setup seed users
  await db.execute({
    sql: `INSERT OR IGNORE INTO users (id, username, password_hash, role, credit_balance, wa_phone_number_id) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [userA.id, userA.username, "hashA", "user", 5000, "wa_phone_test_123"]
  });
  await db.execute({
    sql: `INSERT OR IGNORE INTO users (id, username, password_hash, role, credit_balance, wa_phone_number_id) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [userB.id, userB.username, "hashB", "user", 5000, "wa_phone_test_456"]
  });

  // Setup seed contacts for userA
  const contact1 = { id: "cnt_1", user_id: userA.id, name: "Aaryan Shah", phone_number: "9876543210", email: "aaryan@example.com", company: "Acme Inc" };
  const contact2 = { id: "cnt_2", user_id: userA.id, name: "Rahul Verma", phone_number: "9876543211", email: "rahul@example.com", company: "Verma Corp" };
  const contact3 = { id: "cnt_3", user_id: userA.id, name: "Priya Patel", phone_number: "9876543212", email: "priya@example.com", company: "Patel Tech" };

  for (const c of [contact1, contact2, contact3]) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO contacts (id, user_id, name, phone_number, email, company, created_at, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      args: [c.id, c.user_id, c.name, c.phone_number, c.email, c.company]
    });
  }

  let campaignId = null;

  await t.test("1. Create Campaign in draft state with multi-channel selection", async () => {
    const payload = {
      name: "Q4 Outreach Campaign",
      channels: ["whatsapp", "email"],
      timezone: "Asia/Kolkata",
      target_filter: {}
    };

    const c = createMockContext(userA, payload);
    const res = await handleCreateCampaign(c);
    assert.strictEqual(res.status, 201);
    assert.ok(res.data.success);
    assert.ok(res.data.campaign.id);
    assert.strictEqual(res.data.campaign.status, "draft");
    assert.deepStrictEqual(res.data.campaign.channels, ["whatsapp", "email"]);
    campaignId = res.data.campaign.id;
  });

  await t.test("2. Configure message snapshots for both WhatsApp and Email channels", async () => {
    // Configure WhatsApp message
    const waPayload = {
      channel: "whatsapp",
      body: "Hi {{1}}, this is Collectrr following up regarding {{2}}.",
      param_mappings: { "1": "name", "2": "company" }
    };
    const cWa = createMockContext(userA, waPayload, {}, { id: campaignId });
    const resWa = await handleSetCampaignMessages(cWa);
    assert.strictEqual(resWa.status, 200);
    assert.ok(resWa.data.success);

    // Configure Email message
    const emailPayload = {
      channel: "email",
      subject: "Partnership follow-up for {{company}}",
      body: "Hello {{name}},\n\nReaching out regarding our partnership with {{company}}.\n\nBest,\nCollectrr",
      param_mappings: { "1": "name", "2": "company" }
    };
    const cEm = createMockContext(userA, emailPayload, {}, { id: campaignId });
    const resEm = await handleSetCampaignMessages(cEm);
    assert.strictEqual(resEm.status, 200);
    assert.ok(resEm.data.success);

    // Verify campaign detail endpoint exposes message snapshots
    const cGet = createMockContext(userA, {}, {}, { id: campaignId });
    const resGet = await handleGetCampaignDetail(cGet);
    assert.strictEqual(resGet.status, 200);
    assert.strictEqual(resGet.data.campaign.messages.length, 2);
  });

  await t.test("3. Preview audience returns exact matching contacts and count", async () => {
    const previewPayload = {
      target_filter: {}
    };
    const c = createMockContext(userA, previewPayload, {}, { id: campaignId });
    const res = await handlePreviewCampaignAudience(c);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.total_count, 3);
    assert.strictEqual(res.data.sample_recipients.length, 3);
  });

  await t.test("4. Launch campaign atomically snapshots destination and marks recipients queued", async () => {
    const launchPayload = {
      target_filter: {}
    };
    const c = createMockContext(userA, launchPayload, {}, { id: campaignId });
    const res = await handleLaunchCampaign(c);
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.success);
    // 3 contacts * 2 channels = 6 total recipients
    assert.strictEqual(res.data.total_recipients, 6);

    const checkCmp = await db.execute({
      sql: `SELECT status, total_recipients_snapshot FROM campaigns WHERE id = ?`,
      args: [campaignId]
    });
    assert.strictEqual(checkCmp.rows[0].status, "running");
    assert.strictEqual(checkCmp.rows[0].total_recipients_snapshot, 6);

    const recpList = await db.execute({
      sql: `SELECT id, channel, recipient_name_snapshot, phone_snapshot, email_snapshot, delivery_status FROM campaign_recipients WHERE campaign_id = ?`,
      args: [campaignId]
    });
    assert.strictEqual(recpList.rows.length, 6);
    assert.ok(recpList.rows.every(r => r.delivery_status === "queued"));
  });

  await t.test("5. Destination Snapshotting Immutability: Mutating or deleting CRM contacts preserves recipient snapshot", async () => {
    // Modify Contact 1 and Delete Contact 2
    await db.execute({
      sql: `UPDATE contacts SET name = 'Aaryan Changed', phone_number = '9999999999', email = 'new_aaryan@example.com' WHERE id = ?`,
      args: [contact1.id]
    });
    await db.execute({
      sql: `DELETE FROM contacts WHERE id = ?`,
      args: [contact2.id]
    });

    // Check campaign_recipients for contact 1 (should retain snapshotted original name & phone)
    const recp1 = await db.execute({
      sql: `SELECT recipient_name_snapshot, phone_snapshot, email_snapshot FROM campaign_recipients WHERE campaign_id = ? AND contact_id = ? AND channel = 'whatsapp'`,
      args: [campaignId, contact1.id]
    });
    assert.strictEqual(recp1.rows[0].recipient_name_snapshot, "Aaryan Shah");
    assert.strictEqual(recp1.rows[0].phone_snapshot, "9876543210");
    assert.strictEqual(recp1.rows[0].email_snapshot, "aaryan@example.com");

    // Check campaign_recipients for deleted contact 2 (MUST NOT BE DELETED, contact_id is SET NULL)
    const recp2 = await db.execute({
      sql: `SELECT recipient_name_snapshot, phone_snapshot, delivery_status FROM campaign_recipients WHERE campaign_id = ? AND phone_snapshot = '9876543211'`,
      args: [campaignId]
    });
    assert.strictEqual(recp2.rows.length, 2, "Historical recipient snapshots must persist even if contact is deleted from CRM");
    assert.strictEqual(recp2.rows[0].recipient_name_snapshot, "Rahul Verma");
  });

  await t.test("6. Queue Worker processes campaign batch independently and settles recipients to sent", async () => {
    const res = await processCampaignBatch(campaignId, mockEnv, db);
    assert.ok(res.handled);
    assert.strictEqual(res.total, 6);

    const recpStates = await db.execute({
      sql: `SELECT id, channel, delivery_status, error_code, error_message, provider_message_id, sent_at FROM campaign_recipients WHERE campaign_id = ?`,
      args: [campaignId]
    });
    assert.ok(recpStates.rows.every(r => r.delivery_status === "sent"), "All 6 recipients must be settled to sent");
    assert.ok(recpStates.rows.every(r => r.provider_message_id !== null), "All recipients must have provider_message_id");

    // Campaign status should have automatically transitioned to completed
    const cmpCheck = await db.execute({
      sql: `SELECT status, completed_at FROM campaigns WHERE id = ?`,
      args: [campaignId]
    });
    assert.strictEqual(cmpCheck.rows[0].status, "completed", "Campaign must auto-complete when all dispatches are terminal");
  });

  await t.test("7. Webhook delivery status update idempotently marks recipient delivered and read", async () => {
    // Get provider message ID for first recipient
    const firstWaRecp = await db.execute({
      sql: `SELECT id, provider_message_id FROM campaign_recipients WHERE campaign_id = ? AND channel = 'whatsapp' LIMIT 1`,
      args: [campaignId]
    });
    const providerMsgId = firstWaRecp.rows[0].provider_message_id;

    // Simulate delivered webhook event
    const deliveredPayload = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            statuses: [{
              id: providerMsgId,
              status: "delivered",
              timestamp: String(Math.floor(Date.now() / 1000)),
              recipient_id: "9876543210"
            }]
          }
        }]
      }]
    };

    const cDelivered = createMockContext(userA, deliveredPayload);
    await handleWebhookEvent(cDelivered);

    const recpDelivered = await db.execute({
      sql: `SELECT delivery_status, delivered_at FROM campaign_recipients WHERE id = ?`,
      args: [firstWaRecp.rows[0].id]
    });
    assert.strictEqual(recpDelivered.rows[0].delivery_status, "delivered");
    assert.ok(recpDelivered.rows[0].delivered_at !== null);

    // Simulate read webhook event
    const readPayload = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            statuses: [{
              id: providerMsgId,
              status: "read",
              timestamp: String(Math.floor(Date.now() / 1000)),
              recipient_id: "9876543210"
            }]
          }
        }]
      }]
    };

    const cRead = createMockContext(userA, readPayload);
    await handleWebhookEvent(cRead);

    const recpRead = await db.execute({
      sql: `SELECT delivery_status, read_at FROM campaign_recipients WHERE id = ?`,
      args: [firstWaRecp.rows[0].id]
    });
    assert.strictEqual(recpRead.rows[0].delivery_status, "read");
    assert.ok(recpRead.rows[0].read_at !== null);
  });

  await t.test("8. Inbound WhatsApp reply webhook attributes response to most recent campaign recipient", async () => {
    // Inbound reply from 9876543210
    const inboundPayload = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: {
              phone_number_id: "wa_phone_test_123"
            },
            messages: [{
              from: "919876543210",
              id: `wamid_inbound_${Date.now()}`,
              timestamp: String(Math.floor(Date.now() / 1000)),
              text: { body: "Yes, I am interested! Please share the brochure." },
              type: "text"
            }]
          }
        }]
      }]
    };

    const cInbound = createMockContext(userA, inboundPayload);
    await handleWebhookEvent(cInbound);

    // Verify campaign_recipient response_status updated to replied
    const recpReplied = await db.execute({
      sql: `SELECT response_status, replied_at FROM campaign_recipients WHERE campaign_id = ? AND phone_snapshot = '9876543210' AND channel = 'whatsapp'`,
      args: [campaignId]
    });
    assert.strictEqual(recpReplied.rows[0].response_status, "replied");
    assert.ok(recpReplied.rows[0].replied_at !== null);
  });

  await t.test("9. Multi-tenant security isolation: User B cannot access or modify User A campaigns", async () => {
    // User B tries to view User A campaign
    const cGetB = createMockContext(userB, {}, {}, { id: campaignId });
    const resGetB = await handleGetCampaignDetail(cGetB);
    assert.strictEqual(resGetB.status, 403, "Cross-tenant access must return 403 Forbidden");

    // User B tries to cancel User A campaign
    const cCancelB = createMockContext(userB, {}, {}, { id: campaignId });
    const resCancelB = await handleCancelCampaign(cCancelB);
    assert.strictEqual(resCancelB.status, 403, "Cross-tenant cancellation must return 403 Forbidden");
  });

  // Cleanup temp db
  t.after(() => {
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch (_) {}
  });
});
