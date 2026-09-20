/**
 * Scheduler Queue Consumer
 * Consumes occurrence messages from Cloudflare Queue, validates business eligibility
 * and JIT credit balance, and delegates dispatching to the existing messaging pipeline.
 */

import { executeWhatsAppMessagingPipeline } from "../whatsapp/pipeline.js";
import { executeEmailMessagingPipeline } from "../email/pipeline.js";
import { MESSAGE_COST_PAISE } from "../whatsapp/pipeline.js";

async function finalizeOneOffSchedule(db, scheduleId) {
  if (!scheduleId) return;
  try {
    await db.execute({
      sql: "UPDATE schedules SET status = 'completed', next_run_utc = NULL WHERE id = ?",
      args: [scheduleId],
    });
  } catch (_) {}
}

export async function processScheduledOccurrence(occurrenceId, env, db) {
  if (!occurrenceId) return { handled: false, reason: "missing_id" };

  // 1. Fetch occurrence with joined schedule and contact
  const queryRes = await db.execute({
    sql: `
      SELECT o.id, o.schedule_id, o.occurrence_key, o.scheduled_for_utc, o.operational_status,
             o.channel as occ_channel, o.recipient_phone, o.recipient_email,
             s.user_id, s.contact_id, s.case_id, s.request_id, s.channel as schedule_channel,
             s.template_id, s.message_body, s.payload_snapshot,
             s.schedule_type, s.recurrence_interval, s.timezone, s.status as schedule_status,
             c.name as contact_name, c.phone_number as contact_phone, c.email as contact_email
      FROM scheduled_occurrences o
      JOIN schedules s ON o.schedule_id = s.id
      LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE o.id = ?
    `,
    args: [occurrenceId],
  });

  const row = queryRes.rows?.[0];
  if (!row) {
    return { handled: false, reason: "occurrence_not_found" };
  }

  // 2. Schedule & occurrence status guards
  if (row.schedule_status === "cancelled") {
    await db.execute({
      sql: "UPDATE scheduled_occurrences SET operational_status = 'skipped', skip_reason = 'cancelled', executed_at = datetime('now') WHERE id = ?",
      args: [occurrenceId],
    });
    return { handled: true, status: "skipped", reason: "cancelled" };
  }

  if (row.case_id) {
    const caseRes = await db.execute({
      sql: "SELECT status FROM loan_cases WHERE id = ? LIMIT 1",
      args: [row.case_id],
    }).catch(() => ({ rows: [] }));
    if (caseRes.rows?.[0]?.status === "closed") {
      await db.execute({
        sql: "UPDATE scheduled_occurrences SET operational_status = 'skipped', skip_reason = 'case_closed', executed_at = datetime('now') WHERE id = ?",
        args: [occurrenceId],
      });
      await finalizeOneOffSchedule(db, row.schedule_id);
      return { handled: true, status: "skipped", reason: "case_closed" };
    }
  }

  if (row.request_id) {
    const reqRes = await db.execute({
      sql: "SELECT status FROM requests WHERE id = ? LIMIT 1",
      args: [row.request_id],
    }).catch(() => ({ rows: [] }));
    if (reqRes.rows?.[0]?.status === "completed" || reqRes.rows?.[0]?.status === "cancelled") {
      await db.execute({
        sql: "UPDATE scheduled_occurrences SET operational_status = 'skipped', skip_reason = 'request_completed', executed_at = datetime('now') WHERE id = ?",
        args: [occurrenceId],
      });
      await finalizeOneOffSchedule(db, row.schedule_id);
      return { handled: true, status: "skipped", reason: "request_completed" };
    }
  }

  if (row.operational_status === "completed" || row.operational_status === "skipped" || row.operational_status === "unknown") {
    return { handled: true, status: row.operational_status, alreadyDone: true };
  }

  // 3. Contact Resolution
  const contact = {
    id: row.contact_id,
    name: row.contact_name || "there",
    phone_number: row.recipient_phone || row.contact_phone,
    email: row.recipient_email || row.contact_email,
  };

  // 4. User & JIT Credit Check
  const userRes = await db.execute({
    sql: "SELECT id, username, credit_balance FROM users WHERE id = ?",
    args: [row.user_id],
  });
  const user = userRes.rows?.[0] || { id: row.user_id, username: "Collectr", credit_balance: 900 };

  const currentBalance = Number(user.credit_balance || 0);
  if (currentBalance < MESSAGE_COST_PAISE) {
    await db.execute({
      sql: "UPDATE scheduled_occurrences SET operational_status = 'skipped', skip_reason = 'insufficient_credits', executed_at = datetime('now') WHERE id = ?",
      args: [occurrenceId],
    });
    await finalizeOneOffSchedule(db, row.schedule_id);
    return { handled: true, status: "skipped", reason: "insufficient_credits" };
  }

  // Parse payload snapshot if available
  let snapshot = {};
  if (row.payload_snapshot) {
    try {
      snapshot = typeof row.payload_snapshot === "string" ? JSON.parse(row.payload_snapshot) : row.payload_snapshot;
    } catch (_) {
      snapshot = {};
    }
  }

  const channel = String(row.occ_channel || row.schedule_channel || "whatsapp").toLowerCase();
  const referenceId = `occ_${occurrenceId}`;

  // 5. Dispatch via Channel Pipeline
  let pipeRes;
  if (channel === "email") {
    pipeRes = await executeEmailMessagingPipeline(
      db,
      user,
      contact.email,
      snapshot.templateId || row.template_id || "general_email",
      contact.name,
      "verify",
      env,
      referenceId,
      snapshot.templateParams || [],
      row.contact_id,
      row.request_id
    );
  } else {
    // WhatsApp pipeline
    pipeRes = await executeWhatsAppMessagingPipeline({
      db,
      user,
      contact,
      requestId: row.request_id,
      templateId: snapshot.templateId || row.template_id,
      messageBody: snapshot.messageBody || row.message_body,
      templateParams: snapshot.templateParams || [],
      referenceId,
      env,
    });
  }

  // 6. Settle Terminal Status and Link Message
  if (pipeRes?.success) {
    await db.execute({
      sql: "UPDATE scheduled_occurrences SET operational_status = 'completed', provider_message_id = ?, message_id = ?, executed_at = datetime('now') WHERE id = ?",
      args: [pipeRes.providerMsgId || null, pipeRes.messageId || null, occurrenceId],
    });
    if (row.case_id) {
      await db.execute({
        sql: "UPDATE loan_cases SET whatsapp_delivery_status = 'sent' WHERE id = ?",
        args: [row.case_id],
      }).catch(() => {});
    }
    await finalizeOneOffSchedule(db, row.schedule_id);
    return { handled: true, status: "completed", providerMsgId: pipeRes.providerMsgId, messageId: pipeRes.messageId };
  }

  if (pipeRes?.inFlight) {
    return { handled: true, status: "in_flight_duplicate", inFlight: true };
  }

  if (pipeRes?.error === "WHATSAPP_TIMEOUT" || pipeRes?.error === "EMAIL_TIMEOUT" || pipeRes?.ambiguous) {
    await db.execute({
      sql: "UPDATE scheduled_occurrences SET operational_status = 'unknown', last_error = ?, executed_at = datetime('now') WHERE id = ?",
      args: [pipeRes.message || "Provider timeout", occurrenceId],
    });
    await finalizeOneOffSchedule(db, row.schedule_id);
    return { handled: true, status: "unknown", error: pipeRes?.error };
  }

  // Failed
  await db.execute({
    sql: "UPDATE scheduled_occurrences SET operational_status = 'failed', last_error = ?, executed_at = datetime('now') WHERE id = ?",
    args: [pipeRes?.message || "Dispatch failed", occurrenceId],
  });
  await finalizeOneOffSchedule(db, row.schedule_id);
  return { handled: true, status: "failed", error: pipeRes?.error || "DISPATCH_FAILED" };
}

export async function handleQueueBatch(batch, env, ctx, db) {
  const messages = batch?.messages || [];
  for (const message of messages) {
    const { occurrenceId } = message?.body || {};
    if (occurrenceId) {
      try {
        await processScheduledOccurrence(occurrenceId, env, db);
      } catch (err) {
        console.error(`[QUEUE CONSUMER] Error processing occurrence ${occurrenceId}:`, err);
      }
    }
    if (typeof message?.ack === "function") {
      message.ack();
    }
  }
}
