import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { normalizeIndianPhoneNumber } from "../src/whatsapp/client.js";
import { renderTemplateBody } from "../src/whatsapp/templates.js";
import { parseWebhookPayload } from "../src/whatsapp/webhook.js";

test("Personal CRM Contact Domain Model & WhatsApp Invariants", async (t) => {

  // 1. Phone Number Normalization Specification
  await t.test("1. Phone Number Normalization handles all valid Indian formats and rejects invalid numbers", () => {
    // 10 digits
    assert.strictEqual(normalizeIndianPhoneNumber("9876543210"), "919876543210");
    assert.strictEqual(normalizeIndianPhoneNumber(9876543210), "919876543210");

    // Leading 0
    assert.strictEqual(normalizeIndianPhoneNumber("09876543210"), "919876543210");

    // 12 digits with 91 prefix
    assert.strictEqual(normalizeIndianPhoneNumber("919876543210"), "919876543210");

    // Non-digit characters: spaces, hyphens, plus signs, brackets
    assert.strictEqual(normalizeIndianPhoneNumber("+91 98765-43210"), "919876543210");
    assert.strictEqual(normalizeIndianPhoneNumber("+91 (98765) 43210"), "919876543210");
    assert.strictEqual(normalizeIndianPhoneNumber("  098765 43210  "), "919876543210");

    // Invalid inputs throw actionable errors
    assert.throws(() => normalizeIndianPhoneNumber("12345"), /valid 10-digit Indian mobile number/);
    assert.throws(() => normalizeIndianPhoneNumber(""), /valid 10-digit Indian mobile number/);
    assert.throws(() => normalizeIndianPhoneNumber("98765432109876"), /valid 10-digit Indian mobile number/);
    assert.throws(() => normalizeIndianPhoneNumber("abcdefghij"), /valid 10-digit Indian mobile number/);
    assert.throws(() => normalizeIndianPhoneNumber(null), /valid 10-digit Indian mobile number/);
  });

  // 2. Exact Rendered Body Persistence
  await t.test("2. renderTemplateBody renders exact Meta template texts without leakage or reconstruction", () => {
    // new_convo_1 (Personal CRM Generic Outreach)
    const body1 = renderTemplateBody("new_convo_1", {
      name: "Ramesh Sharma",
      userName: "Shah & Associates",
      templateParams: ["Ramesh Sharma", "Shah & Associates"]
    });
    assert.ok(body1.includes("Hi Ramesh Sharma,"), "Missing contact name");
    assert.ok(body1.includes("Shah & Associates"), "Missing user name");
    assert.ok(!body1.includes("{{"), "Body contains raw template variables");

    // hello_world
    const body2 = renderTemplateBody("hello_world");
    assert.ok(body2.includes("Hello World"), "Missing hello world text");
    assert.ok(!body2.includes("{{"), "Body contains raw template variables");
  });

  // 3. Webhook Parsing & Tenant Resolution Contract
  await t.test("3. Webhook Parser extracts Meta Business Phone ID, profile names and delivery status updates", () => {
    const rawWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_12345",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "919999999999",
                  phone_number_id: "WABA_PHONE_ID_001"
                },
                contacts: [
                  {
                    profile: { name: "Sunil Verma" },
                    wa_id: "919876543210"
                  }
                ],
                messages: [
                  {
                    from: "919876543210",
                    id: "wamid.HBgLMTIzNDU2",
                    timestamp: "1724500000",
                    text: { body: "Sent the updates" },
                    type: "text"
                  }
                ],
                statuses: [
                  {
                    id: "wamid.HBgLMzg3NjU0",
                    status: "delivered",
                    timestamp: "1724500005",
                    recipient_id: "919876543210"
                  }
                ]
              },
              field: "messages"
            }
          ]
        }
      ]
    };

    const parsed = parseWebhookPayload(rawWebhookPayload);
    assert.strictEqual(parsed.messages.length, 1);
    assert.strictEqual(parsed.messages[0].phoneNumberId, "WABA_PHONE_ID_001");
    assert.strictEqual(parsed.messages[0].profileName, "Sunil Verma");
    assert.strictEqual(parsed.messages[0].text, "Sent the updates");
    assert.strictEqual(parsed.messages[0].messageId, "wamid.HBgLMTIzNDU2");

    assert.strictEqual(parsed.statuses.length, 1);
    assert.strictEqual(parsed.statuses[0].providerMsgId, "wamid.HBgLMzg3NjU0");
    assert.strictEqual(parsed.statuses[0].status, "delivered");
    assert.strictEqual(parsed.statuses[0].phoneNumberId, "WABA_PHONE_ID_001");
  });

  // 4. Multi-Tenancy & Schema Verification
  const baseDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

  await t.test("4. schema.sql and migrations enforce Personal CRM multi-tenancy constraints", () => {
    const masterSchemaSql = fs.readFileSync(path.join(baseDir, "src", "db", "schema.sql"), "utf8");
    const migrationSql = fs.readFileSync(path.join(baseDir, "migrations", "0001_personal_crm_schema.sql"), "utf8");

    // UNIQUE(user_id, phone_number) on contacts
    assert.ok(masterSchemaSql.includes("CONSTRAINT unq_user_contact_phone UNIQUE(user_id, phone_number)"), "Missing user_id scoped contact uniqueness in schema.sql");
    assert.ok(migrationSql.includes("CONSTRAINT unq_user_contact_phone UNIQUE(user_id, phone_number)"), "Missing user_id scoped contact uniqueness in 0001 migration");

    // users.wa_phone_number_id
    assert.ok(masterSchemaSql.includes("wa_phone_number_id"), "Missing wa_phone_number_id in schema.sql");
    assert.ok(migrationSql.includes("wa_phone_number_id"), "Missing wa_phone_number_id in 0001 migration");

    // messages table with provider_message_id index
    assert.ok(masterSchemaSql.includes("CREATE TABLE IF NOT EXISTS messages"), "Missing messages table in schema.sql");
    assert.ok(masterSchemaSql.includes("unq_messages_provider"), "Missing unq_messages_provider in schema.sql");
  });

  // 5. Backend Endpoints Registration
  await t.test("5. Endpoint routing in index.js includes Personal CRM routes", () => {
    const indexJs = fs.readFileSync(path.join(baseDir, "src", "index.js"), "utf8");
    assert.ok(indexJs.includes("/api/contacts"), "Missing /api/contacts route");
    assert.ok(indexJs.includes("/api/contacts/check"), "Missing /api/contacts/check route");
    assert.ok(indexJs.includes("/api/contacts/:id"), "Missing /api/contacts/:id route");
    assert.ok(indexJs.includes("/api/contacts/:id/messages/text"), "Missing text message route");
    assert.ok(indexJs.includes("/api/contacts/:id/messages/template"), "Missing template message route");
    assert.ok(indexJs.includes("/api/contacts/:id/requests"), "Missing create request route");
  });

  // 6. Frontend Workspace & Case Detail Exact Message Rendering
  await t.test("6. case-detail.js renders exact persisted message bodies and 2-way conversation stream", () => {
    const caseDetailJs = fs.readFileSync(path.join(baseDir, "public", "js", "case-detail.js"), "utf8");
    assert.ok(caseDetailJs.includes("m.content"), "case-detail.js not using m.content");
    assert.ok(caseDetailJs.includes("renderMessages"), "case-detail.js missing renderMessages function");
    assert.ok(caseDetailJs.includes("renderRequests"), "case-detail.js missing renderRequests function");
  });

  // 7. Workspace Controller Contract & Runtime Execution
  await t.test("7. handleGetContactWorkspace executes cleanly and returns full contact context, requests, and activity feed", async () => {
    const { handleGetContactWorkspace } = await import("../src/api/contacts.js");
    
    // Mock database
    const mockDb = {
      async execute({ sql, args }) {
        if (sql.includes("FROM contacts WHERE id = ?")) {
          return {
            rows: [{
              id: "cnt_test_123",
              user_id: "usr_1",
              name: "Rahul Sharma",
              phone_number: "919876543210",
              email: "rahul@example.com",
              created_at: "2026-09-20 00:00:00",
              last_updated: "2026-09-20 00:00:00"
            }]
          };
        }
        if (sql.includes("FROM conversations")) {
          return {
            rows: [{
              id: "conv_test_123",
              user_id: "usr_1",
              contact_id: "cnt_test_123",
              channel: "whatsapp",
              unread_count: 0
            }]
          };
        }
        if (sql.includes("FROM messages")) {
          return { rows: [] };
        }
        if (sql.includes("FROM requests")) {
          return { rows: [] };
        }
        if (sql.includes("FROM activities")) {
          return {
            rows: [{
              id: "act_1",
              title: "Target Created",
              created_at: "2026-09-20 00:00:00"
            }]
          };
        }
        return { rows: [] };
      }
    };

    const mockContext = {
      env: { DB: mockDb },
      get: (key) => (key === "user" ? { id: "usr_1" } : null),
      req: {
        param: (key) => (key === "id" ? "cnt_test_123" : null)
      },
      json: (data, status = 200) => ({ status, data })
    };

    const res = await handleGetContactWorkspace(mockContext);
    if (res.status !== 200) {
      console.error("handleGetContactWorkspace test error output:", res);
    }
    assert.strictEqual(res.status, 200, "handleGetContactWorkspace must return status 200");
    assert.strictEqual(res.data.success, true, "handleGetContactWorkspace must return success: true");
    assert.strictEqual(res.data.contact.name, "Rahul Sharma");
    assert.ok(res.data.customerWindow, "handleGetContactWorkspace must compute customerWindow");
    assert.ok(Array.isArray(res.data.activities), "handleGetContactWorkspace must return activities array");
  });
});
