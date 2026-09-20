import "./helpers/network-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import { localToUtc, utcToLocalParts } from "../src/scheduler/time.js";
import { scanAndClaimDueOccurrences } from "../src/scheduler/scanner.js";
import { processScheduledOccurrence, handleQueueBatch } from "../src/scheduler/consumer.js";
import { handleCreateSchedule, handleGetSchedules, handleCancelSchedule, handleRetryOccurrence } from "../src/api/schedules.js";

function createInMemoryDb() {
  const tables = {
    users: [
      { id: "usr_test_1", username: "Test Agent", credit_balance: 900, role: "agent" }
    ],
    loan_cases: [
      { id: "case_active", user_id: "usr_test_1", contact_person: "Rahul Verma", phone_number: "9876543210", status: "lead" },
      { id: "case_closed", user_id: "usr_test_1", contact_person: "Anita Roy", phone_number: "9876543211", status: "closed" }
    ],
    contacts: [],
    schedules: [],
    scheduled_occurrences: [],
    whatsapp_messages: [],
    credit_reservations: [],
    credit_transactions: [],
    message_templates: []
  };

  return {
    tables,
    execute: async (query) => {
      const sql = typeof query === "string" ? query : query.sql;
      const args = typeof query === "string" ? [] : (query.args || []);
      const normSql = sql.replace(/\s+/g, " ").trim();

      // INSERT INTO schedules
      if (normSql.startsWith("INSERT INTO schedules")) {
        const [id, user_id, case_id, contact_id, phone_number, template_name, template_params, schedule_type, recurrence_interval, timezone, status, next_run_utc] = args;
        tables.schedules.push({
          id, user_id, case_id, contact_id, phone_number, template_name, template_params,
          schedule_type, recurrence_interval, timezone, status, next_run_utc,
          created_at: new Date().toISOString(), cancelled_at: null
        });
        return { rows: [] };
      }

      // INSERT INTO scheduled_occurrences
      if (normSql.startsWith("INSERT OR IGNORE INTO scheduled_occurrences") || normSql.startsWith("INSERT INTO scheduled_occurrences")) {
        const [id, schedule_id, occurrence_key, scheduled_for_utc, operational_status] = args;
        const exists = tables.scheduled_occurrences.find(o => o.schedule_id === schedule_id && o.occurrence_key === occurrence_key);
        if (!exists) {
          tables.scheduled_occurrences.push({
            id, schedule_id, occurrence_key, scheduled_for_utc,
            operational_status: operational_status || "pending",
            claimed_at: null, attempts: 0, provider_message_id: null,
            skip_reason: null, last_error: null, created_at: new Date().toISOString(),
            executed_at: null
          });
        }
        return { rows: [] };
      }

      // SELECT candidates in scanner
      if (normSql.includes("FROM scheduled_occurrences") && normSql.includes("ORDER BY scheduled_for_utc ASC LIMIT")) {
        const limit = args[0] || 50;
        const now = Date.now();
        const tenMinsAgo = now - 10 * 60 * 1000;
        const matches = tables.scheduled_occurrences.filter(o => {
          if (o.operational_status === "pending") {
            const schedTime = new Date(o.scheduled_for_utc.replace(" ", "T") + "Z").getTime();
            return schedTime <= now + 1000;
          }
          if (o.operational_status === "claimed" && o.claimed_at) {
            const claimTime = new Date(o.claimed_at.replace(" ", "T") + "Z").getTime();
            return claimTime < tenMinsAgo;
          }
          return false;
        }).slice(0, limit);
        return { rows: matches };
      }

      // UPDATE atomic claim in scanner
      if (normSql.startsWith("UPDATE scheduled_occurrences SET operational_status = 'claimed'")) {
        const id = args[0];
        const occ = tables.scheduled_occurrences.find(o => o.id === id);
        if (occ) {
          const now = Date.now();
          const tenMinsAgo = now - 10 * 60 * 1000;
          const isPending = occ.operational_status === "pending";
          const isStale = occ.operational_status === "claimed" && occ.claimed_at && (new Date(occ.claimed_at.replace(" ", "T") + "Z").getTime() < tenMinsAgo);

          if (isPending || isStale) {
            occ.operational_status = "claimed";
            occ.claimed_at = new Date().toISOString().replace("T", " ").substring(0, 19);
            occ.attempts = (occ.attempts || 0) + 1;
            return { rows: [{ id: occ.id }], changes: 1 };
          }
        }
        return { rows: [], changes: 0 };
      }

      // SELECT occurrence joined with schedule
      if (normSql.includes("FROM scheduled_occurrences o") && normSql.includes("JOIN schedules s ON o.schedule_id = s.id")) {
        const id = args[0];
        const occ = tables.scheduled_occurrences.find(o => o.id === id);
        if (!occ) return { rows: [] };
        const sch = tables.schedules.find(s => s.id === occ.schedule_id);
        if (!sch) return { rows: [] };
        const user = tables.users.find(u => u.id === sch.user_id) || tables.users[0];
        return {
          rows: [{
            ...occ,
            user_id: sch.user_id,
            case_id: sch.case_id,
            contact_id: sch.contact_id || sch.case_id,
            recipient_phone: sch.phone_number || "9876543210",
            recipient_email: null,
            phone_number: sch.phone_number || "9876543210",
            template_id: sch.template_name || "new_convo_1",
            template_name: sch.template_name || "new_convo_1",
            template_params: sch.template_params || [],
            schedule_type: sch.schedule_type,
            recurrence_interval: sch.recurrence_interval,
            timezone: sch.timezone,
            schedule_status: sch.status,
            contact_name: "Test Contact",
            contact_phone: sch.phone_number || "9876543210",
            contact_email: null
          }]
        };
      }

      // SELECT single occurrence
      if (normSql.includes("FROM scheduled_occurrences WHERE id = ?")) {
        const occ = tables.scheduled_occurrences.find(o => o.id === args[0]);
        return { rows: occ ? [occ] : [] };
      }

      // SELECT users
      if (normSql.includes("FROM users WHERE id = ?")) {
        const usr = tables.users.find(u => u.id === args[0]);
        return { rows: usr ? [usr] : [] };
      }

      // SELECT loan_cases
      if (normSql.includes("FROM loan_cases WHERE id = ?")) {
        const c = tables.loan_cases.find(x => x.id === args[0]);
        return { rows: c ? [c] : [] };
      }

      // SELECT schedules
      if (normSql.includes("FROM schedules") && normSql.includes("WHERE id = ?")) {
        const sch = tables.schedules.find(s => s.id === args[0]);
        return { rows: sch ? [sch] : [] };
      }

      if (normSql.includes("FROM schedules s LEFT JOIN scheduled_occurrences o")) {
        const res = tables.schedules.map(s => {
          const occ = tables.scheduled_occurrences.find(o => o.schedule_id === s.id);
          return {
            ...s,
            occurrence_id: occ?.id || null,
            occurrence_scheduled_for: occ?.scheduled_for_utc || null,
            occurrence_status: occ?.operational_status || null,
            occurrence_attempts: occ?.attempts || 0,
            provider_message_id: occ?.provider_message_id || null,
            skip_reason: occ?.skip_reason || null,
            last_error: occ?.last_error || null,
            occurrence_executed_at: occ?.executed_at || null
          };
        });
        return { rows: res };
      }

      // Generic updates on scheduled_occurrences
      if (normSql.startsWith("UPDATE scheduled_occurrences SET operational_status =")) {
        const lastArg = args[args.length - 1];
        let targets = [];
        if (normSql.includes("WHERE schedule_id = ?")) {
          targets = tables.scheduled_occurrences.filter(o => o.schedule_id === lastArg);
        } else {
          const occ = tables.scheduled_occurrences.find(o => o.id === lastArg);
          if (occ) targets.push(occ);
        }

        for (const occ of targets) {
          if (normSql.includes("operational_status = 'completed'")) {
            occ.operational_status = "completed";
            occ.provider_message_id = args[0];
            occ.executed_at = new Date().toISOString();
          } else if (normSql.includes("operational_status = 'unknown'")) {
            occ.operational_status = "unknown";
            occ.last_error = args[0];
            occ.executed_at = new Date().toISOString();
          } else if (normSql.includes("operational_status = 'failed'")) {
            occ.operational_status = "failed";
            occ.last_error = args[0];
            occ.executed_at = new Date().toISOString();
          } else if (normSql.includes("operational_status = 'skipped'")) {
            occ.operational_status = "skipped";
            const match = normSql.match(/skip_reason\s*=\s*'([^']+)'/);
            occ.skip_reason = match ? match[1] : args[0];
            occ.executed_at = new Date().toISOString();
          } else if (normSql.includes("operational_status = 'pending'")) {
            occ.operational_status = "pending";
            occ.claimed_at = null;
            occ.last_error = null;
            occ.skip_reason = null;
          }
        }
        return { rows: [] };
      }

      // Update schedule status / next_run_utc
      if (normSql.startsWith("UPDATE schedules SET next_run_utc =")) {
        const nextUtc = args[0];
        const schId = args[1];
        const sch = tables.schedules.find(s => s.id === schId);
        if (sch) sch.next_run_utc = nextUtc;
        return { rows: [] };
      }

      if (normSql.startsWith("UPDATE schedules SET status = 'completed'")) {
        const schId = args[0];
        const sch = tables.schedules.find(s => s.id === schId);
        if (sch) {
          sch.status = "completed";
          sch.next_run_utc = null;
        }
        return { rows: [] };
      }

      if (normSql.startsWith("UPDATE schedules SET status = 'cancelled'")) {
        const schId = args[0];
        const sch = tables.schedules.find(s => s.id === schId);
        if (sch) {
          sch.status = "cancelled";
          sch.cancelled_at = new Date().toISOString();
          sch.next_run_utc = null;
        }
        return { rows: [] };
      }

      // whatsapp_messages & credit tables fallbacks
      if (normSql.includes("FROM whatsapp_messages")) return { rows: [] };
      if (normSql.includes("INSERT INTO whatsapp_messages")) return { rows: [{ id: "mock_wa_msg" }], changes: 1 };
      if (normSql.includes("UPDATE whatsapp_messages")) return { rows: [] };
      if (normSql.includes("INSERT INTO credit_reservations")) return { rows: [] };
      if (normSql.includes("UPDATE credit_reservations")) return { rows: [] };
      if (normSql.includes("INSERT OR IGNORE INTO credit_transactions")) return { rows: [] };
      if (normSql.includes("FROM message_templates")) return { rows: [] };

      return { rows: [] };
    }
  };
}

test("Collectrr Scheduling Engine Architecture & Reliability Tests", async (t) => {
  await t.test("1. One-Off Timezone Conversion via localToUtc and utcToLocalParts", () => {
    // 09:00 AM in Asia/Kolkata (UTC+5:30) is 03:30 AM UTC
    const utcDate = localToUtc(2026, 9, 13, 9, 0, 0, "Asia/Kolkata");
    const utcFormatted = utcDate.toISOString().replace("T", " ").substring(0, 19);
    assert.equal(utcFormatted, "2026-09-13 03:30:00", "Local 09:00 IST must convert to 03:30:00 UTC");

    const parts = utcToLocalParts(utcDate, "Asia/Kolkata");
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 9);
    assert.equal(parts.day, 13);
    assert.equal(parts.hour, 9);
    assert.equal(parts.minute, 0);
  });

  await t.test("2. Claim -> Queue Crash Window Recovery (10-Minute Lease)", async () => {
    const db = createInMemoryDb();
    const tenMinutesOneSecAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString().replace("T", " ").substring(0, 19);
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString().replace("T", " ").substring(0, 19);

    // Occurrence A: Claimed 11 minutes ago (crashed worker) -> MUST be reclaimed
    db.tables.scheduled_occurrences.push({
      id: "occ_crashed",
      schedule_id: "sch_1",
      occurrence_key: "k1",
      scheduled_for_utc: "2026-09-13 00:00:00",
      operational_status: "claimed",
      claimed_at: tenMinutesOneSecAgo,
      attempts: 1
    });

    // Occurrence B: Claimed 2 minutes ago (actively running worker) -> MUST NOT be reclaimed
    db.tables.scheduled_occurrences.push({
      id: "occ_active_lease",
      schedule_id: "sch_1",
      occurrence_key: "k2",
      scheduled_for_utc: "2026-09-13 00:00:00",
      operational_status: "claimed",
      claimed_at: twoMinutesAgo,
      attempts: 1
    });

    const enqueued = [];
    const mockQueue = {
      send: async (payload) => enqueued.push(payload)
    };

    const scanResult = await scanAndClaimDueOccurrences(db, mockQueue);
    assert.equal(scanResult.claimed, 1, "Only the expired lease must be reclaimed");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].occurrenceId, "occ_crashed");

    const crashedOcc = db.tables.scheduled_occurrences.find(o => o.id === "occ_crashed");
    assert.equal(crashedOcc.attempts, 2, "Attempts counter must be incremented upon recovery");
  });

  await t.test("3. JIT Execution-Time Credit Exhaustion Check", async () => {
    const db = createInMemoryDb();
    // User credit balance is 0 paise (< 90 paise cost)
    db.tables.users[0].credit_balance = 0;

    db.tables.schedules.push({
      id: "sch_oneoff",
      user_id: "usr_test_1",
      case_id: "case_active",
      phone_number: "9876543210",
      template_name: "new_convo_1",
      schedule_type: "one_off",
      recurrence_interval: null,
      timezone: "Asia/Kolkata",
      status: "active",
      next_run_utc: "2026-09-13 03:30:00"
    });

    db.tables.scheduled_occurrences.push({
      id: "occ_no_credit",
      schedule_id: "sch_oneoff",
      occurrence_key: "sch_oneoff_2026-09-13 03:30:00",
      scheduled_for_utc: "2026-09-13 03:30:00",
      operational_status: "claimed"
    });

    const mockEnv = { ENVIRONMENT: "development" };
    const res = await processScheduledOccurrence("occ_no_credit", mockEnv, db);

    assert.equal(res.status, "skipped");
    assert.equal(res.reason, "insufficient_credits");

    const occ = db.tables.scheduled_occurrences.find(o => o.id === "occ_no_credit");
    assert.equal(occ.operational_status, "skipped");
    assert.equal(occ.skip_reason, "insufficient_credits");
  });

  await t.test("4. UNKNOWN Network Outcome Semantics (No Auto-Retry, Warning on Manual Retry)", async () => {
    const db = createInMemoryDb();
    db.tables.users[0].credit_balance = 900;

    db.tables.schedules.push({
      id: "sch_timeout",
      user_id: "usr_test_1",
      case_id: "case_active",
      phone_number: "9876543210",
      template_name: "new_convo_1",
      schedule_type: "one_off",
      status: "active"
    });

    db.tables.scheduled_occurrences.push({
      id: "occ_timeout",
      schedule_id: "sch_timeout",
      occurrence_key: "k_timeout",
      scheduled_for_utc: "2026-09-13 03:30:00",
      operational_status: "claimed"
    });

    // Mock environment where WhatsApp provider call encounters network timeout
    const mockEnv = {
      ENVIRONMENT: "development",
      WHATSAPP_TOKEN: "mock_token",
      WHATSAPP_PHONE_ID: "12345",
      MOCK_WHATSAPP: "false"
    };

    // Override fetch to simulate gateway timeout
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("HTTP 504 Gateway Timeout connecting to Meta Graph API");
    };

    try {
      const res = await processScheduledOccurrence("occ_timeout", mockEnv, db);
      assert.equal(res.status, "unknown", "Network timeout must settle occurrence as unknown");
      assert.equal(res.error, "WHATSAPP_TIMEOUT");

      const occ = db.tables.scheduled_occurrences.find(o => o.id === "occ_timeout");
      assert.equal(occ.operational_status, "unknown");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Attempting manual retry without forceDuplicateRiskAcknowledgement MUST be rejected with warning
    const reqContextNoFlag = {
      get: () => ({ id: "usr_test_1", role: "agent" }),
      req: {
        param: () => "occ_timeout",
        json: async () => ({ forceDuplicateRiskAcknowledgement: false })
      },
      env: { DB: db },
      json: (data, status = 200) => ({ status, data })
    };

    const retryResBlocked = await handleRetryOccurrence(reqContextNoFlag);
    assert.equal(retryResBlocked.status, 400);
    assert.equal(retryResBlocked.data.error, "UNKNOWN_DUPLICATE_RISK");
    assert.ok(retryResBlocked.data.message.includes("possible duplicate"));

    // Manual retry WITH explicit forceDuplicateRiskAcknowledgement succeeds
    const reqContextWithFlag = {
      get: () => ({ id: "usr_test_1", role: "agent" }),
      req: {
        param: () => "occ_timeout",
        json: async () => ({ forceDuplicateRiskAcknowledgement: true })
      },
      env: { DB: db },
      json: (data, status = 200) => ({ status, data })
    };

    const retryResAllowed = await handleRetryOccurrence(reqContextWithFlag);
    assert.equal(retryResAllowed.status, 200);
    assert.equal(retryResAllowed.data.success, true);

    const resetOcc = db.tables.scheduled_occurrences.find(o => o.id === "occ_timeout");
    assert.equal(resetOcc.operational_status, "pending", "Occurrence must be reset to pending");
  });

  await t.test("5. Case Closed Eligibility Skip & Schedule Auto-Completion", async () => {
    const db = createInMemoryDb();

    db.tables.schedules.push({
      id: "sch_closed_case",
      user_id: "usr_test_1",
      case_id: "case_closed", // case is 'closed'
      phone_number: "9876543211",
      template_name: "new_convo_1",
      schedule_type: "one_off",
      recurrence_interval: null,
      status: "active"
    });

    db.tables.scheduled_occurrences.push({
      id: "occ_closed_case",
      schedule_id: "sch_closed_case",
      occurrence_key: "k_closed",
      scheduled_for_utc: "2026-09-13 03:30:00",
      operational_status: "claimed"
    });

    const res = await processScheduledOccurrence("occ_closed_case", { ENVIRONMENT: "development" }, db);
    assert.equal(res.status, "skipped");
    assert.equal(res.reason, "case_closed");

    const sch = db.tables.schedules.find(s => s.id === "sch_closed_case");
    assert.equal(sch.status, "completed", "Schedule linked to a terminal case must be marked completed");
  });

  await t.test("6. Schedule Cancellation Immunity", async () => {
    const db = createInMemoryDb();

    db.tables.schedules.push({
      id: "sch_to_cancel",
      user_id: "usr_test_1",
      case_id: "case_active",
      phone_number: "9876543210",
      template_name: "new_convo_1",
      schedule_type: "one_off",
      status: "active"
    });

    db.tables.scheduled_occurrences.push({
      id: "occ_cancel",
      schedule_id: "sch_to_cancel",
      occurrence_key: "k_cancel",
      scheduled_for_utc: "2026-09-13 03:30:00",
      operational_status: "pending"
    });

    // Cancel schedule via API controller
    const cancelCtx = {
      get: () => ({ id: "usr_test_1", role: "agent" }),
      req: { param: () => "sch_to_cancel" },
      env: { DB: db },
      json: (data, status = 200) => ({ status, data })
    };

    const cancelRes = await handleCancelSchedule(cancelCtx);
    assert.equal(cancelRes.status, 200);

    const sch = db.tables.schedules.find(s => s.id === "sch_to_cancel");
    assert.equal(sch.status, "cancelled");

    const occ = db.tables.scheduled_occurrences.find(o => o.id === "occ_cancel");
    assert.equal(occ.operational_status, "skipped");
    assert.equal(occ.skip_reason, "cancelled");
  });

  await t.test("7. Zero-Credit Schedule Creation (Credit check binds only at execution)", async () => {
    const db = createInMemoryDb();
    // User has zero credits
    db.tables.users[0].credit_balance = 0;

    const createCtx = {
      get: () => ({ id: "usr_test_1", role: "agent" }),
      req: {
        json: async () => ({
          phoneNumber: "9876543210",
          templateName: "new_convo_1",
          scheduleType: "one_off",
          timezone: "Asia/Kolkata",
          scheduledFor: "2026-09-15T10:00:00"
        })
      },
      env: { DB: db },
      json: (data, status = 200) => ({ status, data })
    };

    // Creating schedule must succeed despite 0 credit balance
    const res = await handleCreateSchedule(createCtx);
    assert.equal(res.status, 201, "Schedule creation must succeed without upfront credit check");
    assert.equal(res.data.success, true);
    assert.ok(res.data.schedule.id);
    assert.equal(res.data.occurrence.operationalStatus, "pending");
  });

  await t.test("8. One-Off Execution Schedule Finalization Invariant", async () => {
    const db = createInMemoryDb();
    db.tables.users[0].credit_balance = 900;

    db.tables.schedules.push({
      id: "sch_oneoff_final",
      user_id: "usr_test_1",
      case_id: "case_active",
      phone_number: "9876543210",
      template_name: "new_convo_1",
      schedule_type: "one_off",
      recurrence_interval: null,
      timezone: "Asia/Kolkata",
      status: "active",
      next_run_utc: "2026-09-13 03:30:00"
    });

    db.tables.scheduled_occurrences.push({
      id: "occ_h1",
      schedule_id: "sch_oneoff_final",
      occurrence_key: "sch_oneoff_final_2026-09-13 03:30:00",
      scheduled_for_utc: "2026-09-13 03:30:00",
      operational_status: "claimed"
    });

    // Before execution, exactly 1 occurrence exists
    const beforeOccs = db.tables.scheduled_occurrences.filter(o => o.schedule_id === "sch_oneoff_final");
    assert.equal(beforeOccs.length, 1);

    // Mock successful execution
    const mockEnv = { ENVIRONMENT: "development", MOCK_WHATSAPP: "true" };
    const res = await processScheduledOccurrence("occ_h1", mockEnv, db);
    assert.equal(res.handled, true);

    // After execution, occurrence is completed and schedule status is completed with NO extra occurrences created
    const afterOccs = db.tables.scheduled_occurrences.filter(o => o.schedule_id === "sch_oneoff_final");
    assert.equal(afterOccs.length, 1);
    assert.equal(afterOccs[0].operational_status, "completed");

    const sch = db.tables.schedules.find(s => s.id === "sch_oneoff_final");
    assert.equal(sch.status, "completed", "One-off schedule must be marked completed upon occurrence execution");
  });

  await t.test("9. Concurrent Cron Execution & Race Condition Protection (Pending & Stale Claims)", async () => {
    const db = createInMemoryDb();

    // Setup 1: A due pending occurrence
    db.tables.scheduled_occurrences.push({
      id: "occ_race_pending",
      schedule_id: "sch_race",
      occurrence_key: "k_race_p",
      scheduled_for_utc: "2026-09-13 00:00:00",
      operational_status: "pending",
      claimed_at: null,
      attempts: 0
    });

    // Setup 2: A stale claimed occurrence (claimed 15 min ago)
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace("T", " ").substring(0, 19);
    db.tables.scheduled_occurrences.push({
      id: "occ_race_stale",
      schedule_id: "sch_race",
      occurrence_key: "k_race_s",
      scheduled_for_utc: "2026-09-13 00:00:00",
      operational_status: "claimed",
      claimed_at: fifteenMinsAgo,
      attempts: 1
    });

    const queueWorker1 = [];
    const queueWorker2 = [];

    const mockQ1 = { send: async (payload) => queueWorker1.push(payload) };
    const mockQ2 = { send: async (payload) => queueWorker2.push(payload) };

    // Simulate two concurrent Cron executions executing at the same time
    const [res1, res2] = await Promise.all([
      scanAndClaimDueOccurrences(db, mockQ1),
      scanAndClaimDueOccurrences(db, mockQ2)
    ]);

    const totalEnqueued = queueWorker1.length + queueWorker2.length;
    assert.equal(totalEnqueued, 2, "Across concurrent Cron runs, each occurrence must be claimed exactly once (2 total)");

    // Check specific occurrence keys in enqueued queues
    const allEnqueuedIds = [...queueWorker1, ...queueWorker2].map(p => p.occurrenceId);
    assert.equal(allEnqueuedIds.filter(id => id === "occ_race_pending").length, 1, "occ_race_pending must be enqueued exactly once");
    assert.equal(allEnqueuedIds.filter(id => id === "occ_race_stale").length, 1, "occ_race_stale must be enqueued exactly once");

    // The stale occurrence must have its attempt count incremented by exactly 1 (1 -> 2)
    const staleOcc = db.tables.scheduled_occurrences.find(o => o.id === "occ_race_stale");
    assert.equal(staleOcc.attempts, 2, "Stale occurrence attempts must be incremented by exactly 1");

    // Re-running a third immediate cron run must find 0 candidates to claim
    const queueWorker3 = [];
    const res3 = await scanAndClaimDueOccurrences(db, { send: async (p) => queueWorker3.push(p) });
    assert.equal(res3.claimed, 0, "No occurrences can be claimed while active leases are held");
    assert.equal(queueWorker3.length, 0);
  });

  await t.test("10. Queue Consumer 200+ Messages Batch Processing & Safe Size Verification", async () => {
    const db = createInMemoryDb();
    const mockEnv = { ENVIRONMENT: "development", MOCK_WHATSAPP: "true", MOCK_WHATSAPP_STATUS: "sent" };

    const TOTAL_MESSAGES = 225; // 200+ messages
    const occurrenceIds = [];

    for (let i = 1; i <= TOTAL_MESSAGES; i++) {
      const occId = `occ_bulk_${i}`;
      const schId = `sch_bulk_${i}`;
      const phone = `983000${String(i).padStart(4, "0")}`;

      db.tables.schedules.push({
        id: schId,
        user_id: "usr_test_1",
        case_id: null,
        contact_id: `cnt_${i}`,
        phone_number: phone,
        template_name: "welcome_template",
        template_params: "[]",
        schedule_type: "one_off",
        recurrence_interval: null,
        timezone: "Asia/Kolkata",
        status: "active",
        next_run_utc: "2026-09-13 00:00:00",
        created_at: new Date().toISOString(),
        cancelled_at: null
      });

      db.tables.scheduled_occurrences.push({
        id: occId,
        schedule_id: schId,
        occurrence_key: `key_bulk_${i}`,
        scheduled_for_utc: "2026-09-13 00:00:00",
        operational_status: "claimed",
        claimed_at: new Date().toISOString().replace("T", " ").substring(0, 19),
        attempts: 1,
        provider_message_id: null,
        skip_reason: null,
        last_error: null,
        created_at: new Date().toISOString(),
        executed_at: null
      });

      occurrenceIds.push(occId);
    }

    // Set user credits: usr_test_1 credit_balance has enough credits for all 225 messages
    db.tables.users[0].credit_balance = 25000;

    // Simulate Worker queue invocations adhering to max_batch_size = 1
    let totalAcked = 0;
    for (const id of occurrenceIds) {
      const singleBatch = {
        messages: [{
          body: { occurrenceId: id },
          ack: () => { totalAcked++; }
        }]
      };
      await handleQueueBatch(singleBatch, mockEnv, null, db);
    }

    assert.equal(totalAcked, TOTAL_MESSAGES, `All ${TOTAL_MESSAGES} messages must be acknowledged`);
    const allCompleted = db.tables.scheduled_occurrences.every(o => o.operational_status === "completed");
    assert.ok(allCompleted, `All ${TOTAL_MESSAGES} occurrences must be settled to completed`);
  });
});
