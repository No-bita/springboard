import test from "node:test";
import assert from "node:assert/strict";
import { renderEmailContent } from "../src/email/templates.js";
import { executeEmailMessagingPipeline } from "../src/email/pipeline.js";
import { processScheduledOccurrence } from "../src/scheduler/consumer.js";
import { handleCreateCase, handleBulkImportCases, ensureContact } from "../src/api/cases.js";
import { MESSAGE_COST_PAISE } from "../src/api/credits.js";

function createMockEmailDb() {
  const records = {
    users: [
      { id: "usr_email_1", username: "Agent Roy", credit_balance: 900 }
    ],
    contacts: [],
    loan_cases: [],
    secure_tokens: [],
    required_documents: [],
    schedules: [],
    scheduled_occurrences: [],
    case_timeline: [],
    email_messages: [],
    whatsapp_messages: [],
    credit_reservations: [],
    credit_transactions: [],
    message_templates: []
  };

  const executeFn = async (query) => {
    let sql = "";
    let args = [];
    if (typeof query === "string") {
      sql = query;
    } else if (query && typeof query === "object") {
      sql = query.sql || query.query || query._query || "";
      args = query.args || query._params || query.params || [];
    }
    const norm = (sql || "").replace(/\s+/g, " ").trim();

    if (norm.startsWith("SELECT id, contact_person, email FROM contacts") || norm.startsWith("SELECT id, contact_person FROM contacts")) {
      const [userId, phone] = args;
      const c = records.contacts.find(x => x.phone_number === phone && x.user_id === userId);
      return { rows: c ? [c] : [] };
    }
    if (norm.startsWith("SELECT email FROM contacts WHERE id = ?")) {
      const [contactId] = args;
      const c = records.contacts.find(x => x.id === contactId);
      return { rows: c ? [c] : [] };
    }
    if (norm.startsWith("INSERT INTO contacts")) {
      let id, user_id, contact_person, name, phone_number, email;
      if (args.length >= 6) {
        [id, user_id, contact_person, name, phone_number, email] = args;
      } else {
        [id, user_id, contact_person, phone_number, email] = args;
        name = contact_person;
      }
      records.contacts.push({ id, user_id, contact_person, name, phone_number, email: email || null });
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("UPDATE contacts SET email =")) {
      const [email, id] = args;
      const c = records.contacts.find(x => x.id === id);
      if (c) c.email = email;
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("SELECT id, contact_person, status FROM loan_cases") || norm.startsWith("SELECT id FROM loan_cases")) {
      const [userId, phone] = args;
      const match = records.loan_cases.find(x => x.phone_number === phone && x.user_id === userId && !['closed', 'completed'].includes(x.status));
      return { rows: match ? [match] : [] };
    }
    if (norm.startsWith("SELECT id, status, contact_person, phone_number FROM loan_cases WHERE id = ?")) {
      const [caseId] = args;
      const match = records.loan_cases.find(x => x.id === caseId);
      return { rows: match ? [match] : [] };
    }
    if (norm.startsWith("INSERT INTO loan_cases")) {
      const [id, contact_id, user_id, contact_person, phone_number, loan_product, template_name, amount_required, status, whatsapp_delivery_status] = args;
      records.loan_cases.push({
        id, contact_id, user_id, contact_person, phone_number,
        loan_product, template_name, amount_required, status,
        whatsapp_delivery_status: whatsapp_delivery_status || "pending"
      });
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("INSERT INTO secure_tokens")) {
      const [token, case_id, expires_at] = args;
      records.secure_tokens.push({ token, case_id, expires_at });
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("SELECT token FROM secure_tokens WHERE case_id = ?")) {
      const [caseId] = args;
      const t = records.secure_tokens.find(x => x.case_id === caseId);
      return { rows: t ? [t] : [] };
    }
    if (norm.startsWith("INSERT INTO required_documents")) {
      const [id, case_id, document_type, label] = args;
      records.required_documents.push({ id, case_id, document_type, label });
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("INSERT INTO schedules")) {
      let id, user_id, case_id, contact_id, phone_number, channel, template_name, template_params, schedule_type, recurrence_interval, timezone, scheduled_for_utc;
      if (args.length === 12) {
        [id, user_id, case_id, contact_id, phone_number, channel, template_name, template_params, schedule_type, recurrence_interval, timezone, scheduled_for_utc] = args;
      } else {
        [id, user_id, case_id, contact_id, phone_number, template_name, template_params, schedule_type, recurrence_interval, timezone, scheduled_for_utc] = args;
        channel = 'whatsapp';
      }
      records.schedules.push({
        id, user_id, case_id, contact_id, phone_number, channel: channel || "whatsapp",
        template_name, template_params, schedule_type, recurrence_interval, timezone,
        status: "active", next_run_utc: scheduled_for_utc
      });
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("UPDATE schedules SET status = 'completed'")) {
      const [schId] = args;
      const s = records.schedules.find(x => x.id === schId);
      if (s) {
        s.status = "completed";
        s.next_run_utc = null;
      }
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("INSERT INTO scheduled_occurrences")) {
      let id, schedule_id, occurrence_key, scheduled_for_utc, channel = 'whatsapp', recipient_phone = null, recipient_email = null;
      if (args.length >= 7) {
        [id, schedule_id, occurrence_key, scheduled_for_utc, channel, recipient_phone, recipient_email] = args;
      } else {
        [id, schedule_id, occurrence_key, scheduled_for_utc] = args;
      }
      records.scheduled_occurrences.push({
        id, schedule_id, occurrence_key, scheduled_for_utc,
        channel: channel || "whatsapp",
        recipient_phone: recipient_phone || null,
        recipient_email: recipient_email || null,
        operational_status: "pending",
        attempts: 0
      });
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("UPDATE scheduled_occurrences SET operational_status = 'completed'")) {
      const occId = args[args.length - 1];
      const providerMsgId = args[0];
      const occ = records.scheduled_occurrences.find(x => x.id === occId);
      if (occ) {
        occ.operational_status = "completed";
        occ.provider_message_id = providerMsgId;
      }
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("UPDATE scheduled_occurrences SET operational_status = 'skipped'")) {
      const occId = args[args.length - 1];
      const occ = records.scheduled_occurrences.find(x => x.id === occId);
      if (occ) {
        occ.operational_status = "skipped";
      }
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("UPDATE scheduled_occurrences SET operational_status = 'failed'")) {
      const errMsg = args[0];
      const occId = args[args.length - 1];
      const occ = records.scheduled_occurrences.find(x => x.id === occId);
      if (occ) {
        occ.operational_status = "failed";
        occ.last_error = errMsg;
      }
      return { rows: [], changes: 1 };
    }
    if (norm.includes("FROM scheduled_occurrences o") && norm.includes("JOIN schedules s ON o.schedule_id = s.id") && norm.includes("WHERE o.id = ?")) {
      const occId = args[0];
      const occ = records.scheduled_occurrences.find(x => x.id === occId);
      if (!occ) return { rows: [] };
      const sch = records.schedules.find(x => x.id === occ.schedule_id);
      if (!sch) return { rows: [] };
      return {
        rows: [{
          id: occ.id,
          schedule_id: sch.id,
          occurrence_key: occ.occurrence_key,
          scheduled_for_utc: occ.scheduled_for_utc,
          operational_status: occ.operational_status,
          occ_channel: occ.channel,
          recipient_phone: occ.recipient_phone,
          recipient_email: occ.recipient_email,
          user_id: sch.user_id,
          case_id: sch.case_id,
          contact_id: sch.contact_id,
          phone_number: sch.phone_number,
          schedule_channel: sch.channel,
          template_name: sch.template_name,
          template_params: sch.template_params,
          schedule_type: sch.schedule_type,
          recurrence_interval: sch.recurrence_interval,
          timezone: sch.timezone,
          schedule_status: sch.status
        }]
      };
    }
    if (norm.startsWith("SELECT status, provider_message_id, created_at") && norm.includes("FROM email_messages")) {
      const [userId, idempKey] = args;
      const msg = records.email_messages.find(x => x.user_id === userId && x.idempotency_key === idempKey);
      if (msg) return { rows: [{ ...msg, age_seconds: 10 }] };
      return { rows: [] };
    }
    if (norm.startsWith("INSERT INTO email_messages")) {
      const [id, user_id, idempotency_key, recipient_email] = args;
      const exists = records.email_messages.find(x => x.user_id === user_id && x.idempotency_key === idempotency_key);
      if (exists) {
        return { rows: [], changes: 0, meta: { changes: 0 } };
      }
      records.email_messages.push({
        id, user_id, idempotency_key, recipient_email,
        status: "SENDING", provider_message_id: null, created_at: new Date().toISOString()
      });
      return { rows: [{ id }], changes: 1, meta: { changes: 1 } };
    }
    if (norm.startsWith("UPDATE email_messages SET status = 'SENT'")) {
      const [providerMsgId, msgId] = args;
      const m = records.email_messages.find(x => x.id === msgId);
      if (m) {
        m.status = "SENT";
        m.provider_message_id = providerMsgId;
      }
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("UPDATE email_messages SET status = 'FAILED'")) {
      const [msgId] = args;
      const m = records.email_messages.find(x => x.id === msgId);
      if (m) m.status = "FAILED";
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("SELECT status, provider_message_id, created_at") && norm.includes("FROM whatsapp_messages")) {
      const [userId, idempKey] = args;
      const msg = records.whatsapp_messages.find(x => x.user_id === userId && x.idempotency_key === idempKey);
      if (msg) return { rows: [{ ...msg, age_seconds: 10 }] };
      return { rows: [] };
    }
    if (norm.startsWith("INSERT INTO whatsapp_messages")) {
      let id, user_id, message_id, idempotency_key, provider_message_id;
      if (args.length >= 4) {
        [id, user_id, message_id, idempotency_key, provider_message_id] = args;
      } else {
        [id, user_id, idempotency_key] = args;
      }
      const exists = records.whatsapp_messages.find(x => x.user_id === user_id && x.idempotency_key === idempotency_key);
      if (exists) {
        return { rows: [], changes: 0, meta: { changes: 0 } };
      }
      records.whatsapp_messages.push({
        id, user_id, message_id: message_id || null, idempotency_key,
        status: "SENT", provider_message_id: provider_message_id || null, created_at: new Date().toISOString()
      });
      return { rows: [{ id }], changes: 1, meta: { changes: 1 } };
    }
    if (norm.startsWith("UPDATE whatsapp_messages SET status = 'SENT'")) {
      const [providerMsgId, msgId] = args;
      const m = records.whatsapp_messages.find(x => x.id === msgId);
      if (m) {
        m.status = "SENT";
        m.provider_message_id = providerMsgId;
      }
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("SELECT credit_balance FROM users") || norm.startsWith("SELECT id, username, credit_balance FROM users")) {
      const [userId] = args;
      const u = records.users.find(x => x.id === userId);
      return { rows: u ? [u] : [] };
    }
    if (norm.startsWith("UPDATE users SET credit_balance = ?")) {
      const [newBal, userId] = args;
      const u = records.users.find(x => x.id === userId);
      if (u) u.credit_balance = newBal;
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("INSERT INTO credit_reservations")) {
      const [id, user_id, amount_paise, reference_id] = args;
      records.credit_reservations.push({ id, user_id, amount_paise, reference_id, status: "PENDING" });
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("UPDATE credit_reservations SET status = 'COMPLETED'")) {
      const [resId] = args;
      const r = records.credit_reservations.find(x => x.id === resId);
      if (r) r.status = "COMPLETED";
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("INSERT OR IGNORE INTO credit_transactions")) {
      records.credit_transactions.push({
        id: args[0],
        user_id: args[1],
        amount_paise: args[2],
        balance_after_paise: args[3],
        transaction_type: norm.includes("'email_deduction'") ? "email_deduction" : args[4],
        reference_type: args[5],
        reference_id: args[args.length - 1]
      });
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("INSERT INTO case_timeline")) {
      const eventType = norm.includes("'email_sent'") ? "email_sent" : (norm.includes("'case_created'") ? "case_created" : (norm.includes("'outreach_scheduled'") ? "outreach_scheduled" : "other"));
      records.case_timeline.push({ sql, args, event_type: eventType });
      return { rows: [], changes: 1 };
    }
    if (norm.startsWith("SELECT * FROM message_templates")) {
      return { rows: records.message_templates };
    }

    return { rows: [], changes: 1 };
  };

  return {
    records,
    prepare: (q) => ({
      _query: q,
      _params: [],
      bind: (...params) => ({
        _query: q,
        _params: params,
        sql: q,
        args: params,
        all: async () => executeFn({ sql: q, args: params }),
        run: async () => executeFn({ sql: q, args: params })
      })
    }),
    execute: executeFn,
    batch: async (stmts) => {
      for (const s of stmts) {
        await executeFn(s);
      }
      return [];
    }
  };
}

test("Email Outreach Channel Architecture & Execution Suite (Phase 1)", async (t) => {
  await t.test("1. Email HTML and Text Renderer with Token Link and Parameters", () => {
    const rendered = renderEmailContent({
      templateName: "new_convo_1",
      templateParams: ["Rajesh Sharma", "Business Loan Application"],
      contactPerson: "Rajesh Sharma",
      userName: "Capital Assist",
      userPhone: "+919876543210",
      rawToken: "tok_secure_12345",
      uploadLink: "https://collectrr.workers.dev/upload.html?t=tok_secure_12345"
    });

    assert.ok(rendered.subject, "Should generate a valid email subject");
    assert.ok(rendered.html.includes("Upload Documents"), "HTML should include CTA button");
    assert.ok(rendered.html.includes("https://collectrr.workers.dev/upload.html?t=tok_secure_12345"), "HTML must contain exact upload link");
    assert.ok(rendered.text.includes("https://collectrr.workers.dev/upload.html?t=tok_secure_12345"), "Plain-text fallback must contain upload link");
    assert.ok(rendered.renderedBody.length > 0, "Rendered body must be non-empty");
  });

  await t.test("2. Resend Client mock dispatch & idempotency key in dev environment", async () => {
    const mockDb = createMockEmailDb();
    const user = { id: "usr_email_1", username: "Agent Roy" };
    const env = { ENVIRONMENT: "development", FRONTEND_URL: "https://collectrr.workers.dev" };

    const result = await executeEmailMessagingPipeline(
      mockDb,
      user,
      "client@example.com",
      "new_convo_1",
      "Aarav Patel",
      "token_abc",
      env,
      "occ_test_101",
      ["Aarav Patel"],
      "cnt_1",
      "case_1"
    );

    assert.equal(result.success, true);
    assert.equal(result.delivered, true);
    assert.ok(result.providerMsgId.startsWith("re_mock_"));

    // Check atomic ledger
    assert.equal(mockDb.records.email_messages.length, 1);
    assert.equal(mockDb.records.email_messages[0].status, "SENT");
    assert.equal(mockDb.records.email_messages[0].recipient_email, "client@example.com");

    // Check credit transaction recorded as email_deduction (-90 paise)
    assert.equal(mockDb.records.credit_transactions.length, 1);
    assert.equal(mockDb.records.credit_transactions[0].transaction_type, "email_deduction");
    assert.equal(mockDb.records.credit_transactions[0].amount_paise, -MESSAGE_COST_PAISE);

    // Check case timeline
    assert.equal(mockDb.records.case_timeline.length, 1);
    assert.equal(mockDb.records.case_timeline[0].event_type, "email_sent");
  });

  await t.test("3. Concurrent duplicate email execution suppressed by atomic lock", async () => {
    const mockDb = createMockEmailDb();
    const user = { id: "usr_email_1", username: "Agent Roy" };
    const env = { ENVIRONMENT: "development" };

    // First execution
    const res1 = await executeEmailMessagingPipeline(
      mockDb, user, "client@example.com", "new_convo_1", "Aarav", "tok_1", env, "occ_dup_1"
    );
    assert.equal(res1.success, true);

    // Second execution with same referenceId (idempotency key)
    const res2 = await executeEmailMessagingPipeline(
      mockDb, user, "client@example.com", "new_convo_1", "Aarav", "tok_1", env, "occ_dup_1"
    );
    assert.equal(res2.success, true);
    assert.equal(res2.idempotent, true, "Should return idempotent success without re-dispatching");
    assert.equal(mockDb.records.email_messages.length, 1, "Exactly one email_messages record must exist");
  });

  await t.test("4. Queue Consumer channel routing: occurrence channel is authoritative", async () => {
    const mockDb = createMockEmailDb();
    const env = { ENVIRONMENT: "development" };

    // Setup an email occurrence in DB
    mockDb.records.contacts.push({ id: "cnt_99", user_id: "usr_email_1", contact_person: "Priya", phone_number: "919876500000", email: "priya@gmail.com" });
    mockDb.records.loan_cases.push({ id: "case_99", user_id: "usr_email_1", contact_person: "Priya", phone_number: "919876500000", status: "lead" });
    mockDb.records.schedules.push({
      id: "sch_99", user_id: "usr_email_1", case_id: "case_99", contact_id: "cnt_99", phone_number: "919876500000",
      channel: "email", template_name: "new_convo_1", template_params: JSON.stringify(["Priya"]),
      schedule_type: "one_off", timezone: "Asia/Kolkata", status: "active", next_run_utc: "2026-09-15 10:00:00"
    });
    mockDb.records.scheduled_occurrences.push({
      id: "occ_99", schedule_id: "sch_99", occurrence_key: "sch_99_occ", scheduled_for_utc: "2026-09-15 10:00:00",
      channel: "email", recipient_phone: null, recipient_email: "priya@gmail.com",
      operational_status: "pending", attempts: 0
    });

    const result = await processScheduledOccurrence("occ_99", env, mockDb);
    assert.equal(result.handled, true);
    assert.equal(result.status, "completed");

    // Verified email dispatch happened
    assert.equal(mockDb.records.email_messages.length, 1);
    assert.equal(mockDb.records.email_messages[0].recipient_email, "priya@gmail.com");
    assert.equal(mockDb.records.scheduled_occurrences[0].operational_status, "completed");
    assert.equal(mockDb.records.schedules[0].status, "completed");
  });

  await t.test("5. Send Now with channel 'both' executes independent dispatches", async () => {
    const mockDb = createMockEmailDb();
    const env = { DB: mockDb, ENVIRONMENT: "development", FRONTEND_URL: "https://collectrr.workers.dev" };

    const reqBody = {
      phone: "9876543210",
      contactPerson: "Sunil Kumar",
      email: "sunil@example.com",
      channel: "both",
      loanProduct: "Working Capital"
    };

    const mockCtx = {
      req: { json: async () => reqBody },
      env,
      get: (k) => k === "user" ? { id: "usr_email_1", username: "Agent Roy" } : null,
      json: (data, code = 200) => ({ data, code })
    };

    const res = await handleCreateCase(mockCtx);
    assert.equal(res.code, 200);
    assert.equal(res.data.success, true);

    // Contact stored with phone and email
    const contact = mockDb.records.contacts.find(c => c.phone_number === "919876543210");
    assert.ok(contact);
    assert.equal(contact.email, "sunil@example.com");

    // Case created without loan_cases.email or loan_cases.channel pollution
    const createdCase = mockDb.records.loan_cases[0];
    assert.ok(createdCase);
    assert.equal(createdCase.email, undefined);
    assert.equal(createdCase.channel, undefined);

    // Both WhatsApp and Email pipelines executed
    assert.equal(mockDb.records.whatsapp_messages.length, 1);
    assert.equal(mockDb.records.email_messages.length, 1);
    assert.equal(mockDb.records.email_messages[0].recipient_email, "sunil@example.com");
  });

  await t.test("6. Schedule Later with channel 'both' creates 2 separate occurrences with explicit snapshots", async () => {
    const mockDb = createMockEmailDb();
    const env = { DB: mockDb, ENVIRONMENT: "development" };
    const futureDate = new Date(Date.now() + 3600 * 1000);

    const reqBody = {
      phone: "9876543222",
      contactPerson: "Geeta Devi",
      email: "geeta@example.com",
      channel: "both",
      loanProduct: "Term Loan",
      schedule: {
        scheduledFor: futureDate.toISOString(),
        scheduleType: "one_off",
        timezone: "Asia/Kolkata"
      }
    };

    const mockCtx = {
      req: { json: async () => reqBody },
      env,
      get: (k) => k === "user" ? { id: "usr_email_1", username: "Agent Roy" } : null,
      json: (data, code = 200) => ({ data, code })
    };

    const res = await handleCreateCase(mockCtx);
    assert.equal(res.code, 201);
    assert.equal(res.data.scheduled, true);

    // Exactly 2 schedules and 2 occurrences created
    assert.equal(mockDb.records.schedules.length, 2);
    assert.equal(mockDb.records.scheduled_occurrences.length, 2);

    const waOcc = mockDb.records.scheduled_occurrences.find(o => o.channel === "whatsapp");
    const emOcc = mockDb.records.scheduled_occurrences.find(o => o.channel === "email");

    assert.ok(waOcc, "WhatsApp occurrence must exist");
    assert.equal(waOcc.recipient_phone, "919876543222");
    assert.equal(waOcc.recipient_email, null);

    assert.ok(emOcc, "Email occurrence must exist");
    assert.equal(emOcc.recipient_phone, null);
    assert.equal(emOcc.recipient_email, "geeta@example.com");
  });

  await t.test("7. Bulk Import with channel 'both' creates dual occurrences per row with email", async () => {
    const mockDb = createMockEmailDb();
    const env = { DB: mockDb, ENVIRONMENT: "development" };

    const reqBody = {
      clients: [
        { contactPerson: "Client A", phoneNumber: "9876500001", email: "a@domain.com" },
        { contactPerson: "Client B", phoneNumber: "9876500002" } // No email
      ],
      channel: "both",
      defaultLoanProduct: "Machinery Loan"
    };

    const mockCtx = {
      req: { json: async () => reqBody },
      env,
      get: (k) => k === "user" ? { id: "usr_email_1", username: "Agent Roy" } : null,
      json: (data, code = 200) => ({ data, code })
    };

    const res = await handleBulkImportCases(mockCtx);
    assert.equal(res.code, 200);
    assert.equal(res.data.importedCount, 2);

    // Client A has 2 occurrences (WA + EM), Client B has 1 occurrence (WA only)
    assert.equal(mockDb.records.scheduled_occurrences.length, 3);
    const emOccs = mockDb.records.scheduled_occurrences.filter(o => o.channel === "email");
    const waOccs = mockDb.records.scheduled_occurrences.filter(o => o.channel === "whatsapp");

    assert.equal(emOccs.length, 1);
    assert.equal(emOccs[0].recipient_email, "a@domain.com");
    assert.equal(waOccs.length, 2);
  });
});
