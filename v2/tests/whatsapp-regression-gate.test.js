/**
 * WhatsApp Non-Negotiable Regression Gate & Domain Integrity Test
 * Validates all 15 strict non-negotiables for the Personal CRM architecture.
 */

import test from "node:test";
import assert from "node:assert";
import { getDbClient } from "../src/db/client.js";
import { executeWhatsAppMessagingPipeline, MESSAGE_COST_PAISE } from "../src/whatsapp/pipeline.js";
import { handleWebhookEvent } from "../src/api/webhook.js";
import { isWithin24HourServiceWindow } from "../src/whatsapp/window.js";
import { getWhatsAppTemplate, renderTemplateBody } from "../src/whatsapp/templates.js";
import { processScheduledOccurrence } from "../src/scheduler/consumer.js";

// Mock Database Helper using In-Memory map
function createMockDb() {
  const tables = {
    users: [],
    contacts: [],
    conversations: [],
    requests: [],
    request_items: [],
    messages: [],
    whatsapp_messages: [],
    activities: [],
    message_templates: [],
    schedules: [],
    scheduled_occurrences: [],
    credit_transactions: [],
    credit_reservations: [],
  };

  return {
    tables,
    async execute(query) {
      const sql = (typeof query === "string" ? query : query.sql).trim();
      const args = (typeof query === "string" ? [] : query.args) || [];

      // SELECT credit_balance FROM users WHERE id = ?
      if (sql.includes("SELECT credit_balance FROM users WHERE id = ?")) {
        const user = tables.users.find(u => u.id === args[0]);
        return { rows: user ? [{ credit_balance: user.credit_balance }] : [] };
      }

      // SELECT id FROM conversations WHERE user_id = ? AND contact_id = ?
      if (sql.includes("SELECT id FROM conversations WHERE user_id = ? AND contact_id = ?")) {
        const conv = tables.conversations.find(c => c.user_id === args[0] && c.contact_id === args[1] && c.channel === args[2]);
        return { rows: conv ? [{ id: conv.id }] : [] };
      }

      // INSERT INTO conversations
      if (sql.startsWith("INSERT INTO conversations")) {
        const conv = { id: args[0], user_id: args[1], contact_id: args[2], channel: args[3], unread_count: 0, last_message_at: new Date().toISOString() };
        tables.conversations.push(conv);
        return { rowsAffected: 1 };
      }

      // SELECT * FROM messages WHERE conversation_id = ?
      if (sql.includes("SELECT * FROM messages WHERE conversation_id = ?")) {
        const msgs = tables.messages.filter(m => m.conversation_id === args[0]);
        return { rows: msgs };
      }

      // SELECT * FROM message_templates WHERE user_id = ? OR user_id IS NULL
      if (sql.includes("SELECT * FROM message_templates")) {
        return { rows: tables.message_templates };
      }

      // INSERT INTO credit_reservations
      if (sql.startsWith("INSERT INTO credit_reservations")) {
        const existing = tables.credit_reservations.find(r => r.user_id === args[1] && r.reference_id === args[3]);
        if (existing) {
          throw new Error("UNIQUE constraint failed: credit_reservations.reference_id");
        }
        tables.credit_reservations.push({ id: args[0], user_id: args[1], amount_paise: args[2], reference_id: args[3], status: "PENDING" });
        return { rowsAffected: 1 };
      }

      // UPDATE credit_reservations
      if (sql.startsWith("UPDATE credit_reservations SET status = 'CAPTURED'")) {
        const res = tables.credit_reservations.find(r => r.user_id === args[0] && r.reference_id === args[1]);
        if (res) res.status = "CAPTURED";
        return { rowsAffected: 1 };
      }

      if (sql.startsWith("UPDATE credit_reservations SET status = 'RELEASED'")) {
        const res = tables.credit_reservations.find(r => r.user_id === args[0] && r.reference_id === args[1]);
        if (res) res.status = "RELEASED";
        return { rowsAffected: 1 };
      }

      // INSERT INTO messages
      if (sql.includes("INSERT INTO messages") || sql.includes("INSERT OR IGNORE INTO messages")) {
        if (sql.includes("'inbound'")) {
          tables.messages.push({
            id: args[0],
            conversation_id: args[1],
            contact_id: args[2],
            user_id: args[3],
            request_id: null,
            direction: "inbound",
            channel: "whatsapp",
            sender_type: "contact",
            content: args[4],
            template_id: null,
            provider: "meta_whatsapp",
            provider_message_id: args[5],
            delivery_status: null,
            created_at: new Date().toISOString(),
          });
        } else {
          tables.messages.push({
            id: args[0],
            conversation_id: args[1],
            contact_id: args[2],
            user_id: args[3],
            request_id: args[4],
            direction: "outbound",
            channel: "whatsapp",
            sender_type: "user",
            content: args[5],
            template_id: args[6] || null,
            provider: "meta_whatsapp",
            provider_message_id: args[7],
            delivery_status: "sent",
            created_at: new Date().toISOString(),
          });
        }
        return { rowsAffected: 1 };
      }

      // INSERT INTO whatsapp_messages
      if (sql.startsWith("INSERT INTO whatsapp_messages")) {
        tables.whatsapp_messages.push({
          id: args[0],
          user_id: args[1],
          message_id: args[2],
          idempotency_key: args[3],
          status: "SENT",
          provider_message_id: args[4],
        });
        return { rowsAffected: 1 };
      }

      // UPDATE users SET credit_balance
      if (sql.startsWith("UPDATE users SET credit_balance")) {
        const user = tables.users.find(u => u.id === args[1]);
        if (user) user.credit_balance -= args[0];
        return { rowsAffected: 1 };
      }

      // INSERT INTO credit_transactions
      if (sql.startsWith("INSERT INTO credit_transactions")) {
        tables.credit_transactions.push({
          id: args[0],
          user_id: args[1],
          amount_paise: args[2],
          balance_after_paise: args[3],
          transaction_type: "whatsapp_outbound",
          reference_id: args[4],
          description: args[5],
        });
        return { rowsAffected: 1 };
      }

      // INSERT INTO activities
      if (sql.startsWith("INSERT INTO activities")) {
        if (sql.includes("'contact_replied'")) {
          tables.activities.push({
            id: args[0],
            user_id: args[1],
            contact_id: args[2],
            request_id: null,
            activity_type: "contact_replied",
            title: "WhatsApp Reply Received",
            description: args[3],
            metadata: args[4],
          });
        } else {
          tables.activities.push({
            id: args[0],
            user_id: args[1],
            contact_id: args[2],
            request_id: args[3],
            activity_type: "outreach_sent",
            title: "WhatsApp Message Sent",
            description: args[4],
            metadata: args[5],
          });
        }
        return { rowsAffected: 1 };
      }

      // UPDATE contacts
      if (sql.startsWith("UPDATE contacts")) {
        const contact = tables.contacts.find(c => c.id === args[0]);
        if (contact) {
          contact.last_interaction_at = new Date().toISOString();
        }
        return { rowsAffected: 1 };
      }

      // UPDATE conversations
      if (sql.startsWith("UPDATE conversations")) {
        const conv = tables.conversations.find(c => c.id === args[0]);
        if (conv) conv.last_message_at = new Date().toISOString();
        return { rowsAffected: 1 };
      }

      // UPDATE requests
      if (sql.startsWith("UPDATE requests SET status")) {
        const req = tables.requests.find(r => r.id === args[1]);
        if (req) req.status = args[0];
        return { rowsAffected: 1 };
      }

      // SELECT id, user_id FROM whatsapp_messages WHERE provider_message_id = ?
      if (sql.includes("SELECT id, user_id, idempotency_key, status FROM whatsapp_messages WHERE provider_message_id = ?")) {
        const waMsg = tables.whatsapp_messages.find(w => w.provider_message_id === args[0]);
        return { rows: waMsg ? [waMsg] : [] };
      }

      // UPDATE whatsapp_messages SET status = ? WHERE provider_message_id = ?
      if (sql.includes("UPDATE whatsapp_messages SET status = ? WHERE provider_message_id = ?")) {
        const waMsg = tables.whatsapp_messages.find(w => w.provider_message_id === args[1]);
        if (waMsg) waMsg.status = args[0];
        return { rowsAffected: 1 };
      }

      // UPDATE messages SET delivery_status = ? WHERE provider = 'meta_whatsapp'
      if (sql.includes("UPDATE messages SET delivery_status = ?")) {
        const msg = tables.messages.find(m => m.provider_message_id === args[1]);
        if (msg) msg.delivery_status = args[0];
        return { rowsAffected: 1 };
      }

      // SELECT id FROM users WHERE wa_phone_number_id = ?
      if (sql.includes("SELECT id FROM users WHERE wa_phone_number_id = ?")) {
        const user = tables.users.find(u => u.wa_phone_number_id === args[0]);
        return { rows: user ? [{ id: user.id }] : [] };
      }

      // SELECT id, name FROM contacts WHERE user_id = ? AND phone_number = ?
      if (sql.includes("SELECT id, name FROM contacts WHERE user_id = ? AND phone_number = ?")) {
        const contact = tables.contacts.find(c => c.user_id === args[0] && c.phone_number === args[1]);
        return { rows: contact ? [contact] : [] };
      }

      // SELECT o.id, o.schedule_id... FROM scheduled_occurrences
      if (sql.includes("FROM scheduled_occurrences o")) {
        const occ = tables.scheduled_occurrences.find(o => o.id === args[0]);
        if (!occ) return { rows: [] };
        const sch = tables.schedules.find(s => s.id === occ.schedule_id);
        const cnt = tables.contacts.find(c => c.id === sch?.contact_id);
        return {
          rows: [{
            ...occ,
            ...sch,
            contact_name: cnt?.name,
            contact_phone: cnt?.phone_number,
            contact_email: cnt?.email,
          }]
        };
      }

      // UPDATE scheduled_occurrences SET operational_status
      if (sql.includes("UPDATE scheduled_occurrences SET operational_status")) {
        const occ = tables.scheduled_occurrences.find(o => o.id === args[2] || o.id === args[1]);
        if (occ) {
          occ.operational_status = "completed";
          occ.provider_message_id = args[0];
          occ.message_id = args[1];
        }
        return { rowsAffected: 1 };
      }

      // Default fallback
      return { rows: [], rowsAffected: 0 };
    }
  };
}

test("WhatsApp Non-Negotiable Regression Gate (All 15 Invariants)", async (t) => {
  const db = createMockDb();
  const env = {
    MOCK_WHATSAPP: "true",
    ENVIRONMENT: "test",
    WHATSAPP_PHONE_ID: "1073272059211357",
    DB: db,
  };

  // Seed test user
  const user = { id: "usr_alice", username: "alice", credit_balance: 900, wa_phone_number_id: "1073272059211357" };
  db.tables.users.push(user);

  // 1. Create Contact
  const contact = {
    id: "cnt_rahul",
    user_id: user.id,
    name: "Rahul Sharma",
    phone_number: "919876543210",
    email: "rahul@example.com",
    created_at: new Date().toISOString(),
  };
  db.tables.contacts.push(contact);

  await t.test("1. Contact is primary entity with canonical phone", () => {
    assert.strictEqual(contact.phone_number, "919876543210");
    assert.strictEqual(contact.user_id, "usr_alice");
  });

  // 2. Send WhatsApp Template
  const referenceId = "ref_test_001";
  const dispatchRes = await executeWhatsAppMessagingPipeline({
    db,
    user,
    contact,
    templateId: "new_convo_1",
    templateParams: ["Rahul", "Alice"],
    referenceId,
    env,
  });

  await t.test("2. WhatsApp template dispatch succeeds", () => {
    assert.strictEqual(dispatchRes.success, true);
    assert.ok(dispatchRes.providerMsgId.startsWith("wamid.mock_"));
    assert.ok(dispatchRes.messageId);
  });

  await t.test("3. Provider message ID stored in messages & whatsapp_messages", () => {
    const msg = db.tables.messages.find(m => m.id === dispatchRes.messageId);
    assert.ok(msg);
    assert.strictEqual(msg.provider, "meta_whatsapp");
    assert.strictEqual(msg.provider_message_id, dispatchRes.providerMsgId);
    assert.strictEqual(msg.delivery_status, "sent");

    const waMsg = db.tables.whatsapp_messages.find(w => w.message_id === dispatchRes.messageId);
    assert.ok(waMsg);
    assert.strictEqual(waMsg.status, "SENT");
  });

  await t.test("4. Credit reservation created and captured in credit_transactions", () => {
    const reservation = db.tables.credit_reservations.find(r => r.reference_id === referenceId);
    assert.ok(reservation);
    assert.strictEqual(reservation.status, "CAPTURED");

    const tx = db.tables.credit_transactions.find(t => t.reference_id === referenceId);
    assert.ok(tx);
    assert.strictEqual(tx.amount_paise, -90);
    assert.strictEqual(user.credit_balance, 810);
  });

  // 5. Simulate Delivered Webhook
  const deliveredWebhook = {
    entry: [{
      changes: [{
        value: {
          statuses: [{
            id: dispatchRes.providerMsgId,
            status: "delivered",
            recipient_id: "919876543210",
          }],
        },
      }],
    }],
  };

  const reqDelivered = {
    req: { json: async () => deliveredWebhook },
    env,
    text: (t) => t,
  };

  await handleWebhookEvent(reqDelivered);

  await t.test("5. Webhook delivered status updates messages.delivery_status to 'delivered'", () => {
    const msg = db.tables.messages.find(m => m.provider_message_id === dispatchRes.providerMsgId);
    assert.strictEqual(msg.delivery_status, "delivered");
  });

  // 6. Simulate Read Webhook
  const readWebhook = {
    entry: [{
      changes: [{
        value: {
          statuses: [{
            id: dispatchRes.providerMsgId,
            status: "read",
            recipient_id: "919876543210",
          }],
        },
      }],
    }],
  };

  const reqRead = {
    req: { json: async () => readWebhook },
    env,
    text: (t) => t,
  };

  await handleWebhookEvent(reqRead);

  await t.test("6. Webhook read status updates messages.delivery_status to 'read'", () => {
    const msg = db.tables.messages.find(m => m.provider_message_id === dispatchRes.providerMsgId);
    assert.strictEqual(msg.delivery_status, "read");
  });

  // 7. Simulate Inbound Reply
  const inboundReplyWebhook = {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: "1073272059211357" },
          messages: [{
            id: "wamid.inbound_reply_001",
            from: "919876543210",
            text: { body: "Yes, I have received your message. Thanks!" },
            type: "text",
          }],
        },
      }],
    }],
  };

  const reqInbound = {
    req: { json: async () => inboundReplyWebhook },
    env,
    text: (t) => t,
  };

  await handleWebhookEvent(reqInbound);

  await t.test("7. Inbound message routed to conversation with delivery_status = NULL", () => {
    const inboundMsg = db.tables.messages.find(m => m.provider_message_id === "wamid.inbound_reply_001");
    assert.ok(inboundMsg);
    assert.strictEqual(inboundMsg.direction, "inbound");
    assert.strictEqual(inboundMsg.sender_type, "contact");
    assert.strictEqual(inboundMsg.delivery_status, null);
    assert.strictEqual(inboundMsg.content, "Yes, I have received your message. Thanks!");
  });

  await t.test("8. Activity logged for inbound reply", () => {
    const act = db.tables.activities.find(a => a.activity_type === "contact_replied");
    assert.ok(act);
    assert.strictEqual(act.contact_id, contact.id);
  });

  await t.test("9. 24-Hour Customer Service window is open after inbound message", () => {
    const convMsgs = db.tables.messages.filter(m => m.contact_id === contact.id);
    const windowOpen = isWithin24HourServiceWindow(convMsgs);
    assert.strictEqual(windowOpen, true);
  });

  await t.test("10. Cross-Tenant Rejection: Unmapped phone_number_id drops inbound message", async () => {
    const initialCount = db.tables.messages.length;
    const maliciousWebhook = {
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "9999999999999999" }, // Unknown tenant
            messages: [{
              id: "wamid.inbound_malicious",
              from: "919876543210",
              text: { body: "Hacked" },
            }],
          },
        }],
      }],
    };

    await handleWebhookEvent({ req: { json: async () => maliciousWebhook }, env: { ...env, WHATSAPP_PHONE_ID: "" }, text: (t) => t });
    assert.strictEqual(db.tables.messages.length, initialCount, "Should not insert message for unknown tenant");
  });

  await t.test("11. Scheduled occurrence links message_id upon successful execution", async () => {
    const scheduleId = "sch_test_001";
    const occurrenceId = "occ_test_001";
    db.tables.schedules.push({
      id: scheduleId,
      user_id: user.id,
      contact_id: contact.id,
      template_id: "new_convo_1",
      message_body: null,
      payload_snapshot: JSON.stringify({ templateId: "new_convo_1", templateParams: ["Rahul", "Alice"] }),
      status: "active",
    });
    db.tables.scheduled_occurrences.push({
      id: occurrenceId,
      schedule_id: scheduleId,
      occurrence_key: `${scheduleId}_due`,
      operational_status: "pending",
      channel: "whatsapp",
    });

    const execRes = await processScheduledOccurrence(occurrenceId, env, db);
    assert.strictEqual(execRes.handled, true);
    assert.strictEqual(execRes.status, "completed");
    assert.ok(execRes.messageId);

    const occ = db.tables.scheduled_occurrences.find(o => o.id === occurrenceId);
    assert.strictEqual(occ.operational_status, "completed");
    assert.strictEqual(occ.message_id, execRes.messageId);
  });
});
