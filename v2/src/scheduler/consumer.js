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

export async function processCampaignRecipient(recipientId, env, db) {
  if (!recipientId) return { handled: false, reason: "missing_id" };

  // 1. Fetch recipient snapshot with campaign and message configuration
  const queryRes = await db.execute({
    sql: `
      SELECT 
        r.id, r.campaign_id, r.user_id, r.contact_id, r.channel,
        r.recipient_name_snapshot, r.phone_snapshot, r.email_snapshot, r.company_snapshot, r.custom_vars_snapshot,
        r.delivery_status,
        m.template_id, m.template_name_snapshot, m.subject_snapshot, m.body_snapshot, m.param_mappings_snapshot,
        c.status as campaign_status
      FROM campaign_recipients r
      JOIN campaigns c ON r.campaign_id = c.id
      LEFT JOIN campaign_messages m ON m.campaign_id = r.campaign_id AND m.channel = r.channel
      WHERE r.id = ?
    `,
    args: [recipientId],
  });

  const row = queryRes.rows?.[0];
  if (!row) return { handled: false, reason: "recipient_not_found" };

  // 2. Status & cancellation guards
  if (row.campaign_status === "cancelled") {
    await db.execute({
      sql: "UPDATE campaign_recipients SET delivery_status = 'cancelled' WHERE id = ?",
      args: [recipientId],
    });
    return { handled: true, status: "cancelled" };
  }

  if (["sent", "delivered", "read", "cancelled"].includes(row.delivery_status)) {
    return { handled: true, status: row.delivery_status, alreadyDone: true };
  }

  // 3. Atomic claim
  await db.execute({
    sql: "UPDATE campaign_recipients SET delivery_status = 'sending', sending_started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    args: [recipientId],
  });

  const channel = String(row.channel || "whatsapp").toLowerCase();

  // 4. Destination validation against snapshot
  if (channel === "whatsapp" && !row.phone_snapshot) {
    await db.execute({
      sql: "UPDATE campaign_recipients SET delivery_status = 'failed', error_code = 'MISSING_PHONE', error_message = 'Missing phone number snapshot', updated_at = datetime('now') WHERE id = ?",
      args: [recipientId],
    });
    return { handled: true, status: "failed", error: "missing_phone_number" };
  }

  if (channel === "email" && !row.email_snapshot) {
    await db.execute({
      sql: "UPDATE campaign_recipients SET delivery_status = 'failed', error_code = 'MISSING_EMAIL', error_message = 'Missing email snapshot', updated_at = datetime('now') WHERE id = ?",
      args: [recipientId],
    });
    return { handled: true, status: "failed", error: "missing_email" };
  }

  // 5. User & JIT Credit Check
  const userRes = await db.execute({
    sql: "SELECT id, username, credit_balance FROM users WHERE id = ?",
    args: [row.user_id],
  });
  const user = userRes.rows?.[0] || { id: row.user_id, username: "Collectrr", credit_balance: 900 };

  const currentBalance = Number(user.credit_balance || 0);
  if (currentBalance < MESSAGE_COST_PAISE) {
    await db.execute({
      sql: "UPDATE campaign_recipients SET delivery_status = 'failed', error_code = 'INSUFFICIENT_CREDITS', error_message = 'Insufficient credit balance', updated_at = datetime('now') WHERE id = ?",
      args: [recipientId],
    });
    return { handled: true, status: "failed", error: "insufficient_credits" };
  }

  // 6. Parameter mappings & variable resolution
  let customVars = {};
  try {
    customVars = typeof row.custom_vars_snapshot === "string" ? JSON.parse(row.custom_vars_snapshot) : (row.custom_vars_snapshot || {});
  } catch (_) {}

  let paramMappings = {};
  try {
    paramMappings = typeof row.param_mappings_snapshot === "string" ? JSON.parse(row.param_mappings_snapshot) : (row.param_mappings_snapshot || {});
  } catch (_) {}

  const templateParams = [];
  const keys = Object.keys(paramMappings);
  for (const k of keys) {
    const varName = paramMappings[k];
    let val = "";
    if (varName === "name" || varName === "contact_person") val = row.recipient_name_snapshot || "";
    else if (varName === "company") val = row.company_snapshot || "";
    else if (varName === "phone" || varName === "phone_number") val = row.phone_snapshot || "";
    else if (varName === "email") val = row.email_snapshot || "";
    else if (customVars[varName] !== undefined) val = customVars[varName];
    templateParams.push(val);
  }

  const referenceId = `cr_${recipientId}`;

  // Ensure contact record exists for conversation linkage
  let contactId = row.contact_id;
  if (!contactId && (row.phone_snapshot || row.email_snapshot)) {
    const checkCnt = await db.execute({
      sql: `SELECT id FROM contacts WHERE user_id = ? AND (phone_number = ? OR email = ?) LIMIT 1`,
      args: [row.user_id, row.phone_snapshot || "__none__", row.email_snapshot || "__none__"]
    });
    if (checkCnt?.rows?.length > 0) {
      contactId = checkCnt.rows[0].id;
    } else {
      contactId = `cnt_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.execute({
        sql: `INSERT OR IGNORE INTO contacts (id, user_id, name, phone_number, email, company, created_at, last_updated)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        args: [
          contactId,
          row.user_id,
          row.recipient_name_snapshot,
          row.phone_snapshot || "",
          row.email_snapshot || null,
          row.company_snapshot || null
        ]
      });
    }
    await db.execute({
      sql: `UPDATE campaign_recipients SET contact_id = ? WHERE id = ?`,
      args: [contactId, recipientId]
    });
  }

  // 7. Dispatch via single messaging pipeline
  let pipeRes;
  if (channel === "email") {
    pipeRes = await executeEmailMessagingPipeline(
      db,
      user,
      row.email_snapshot,
      row.template_id || row.template_name_snapshot || "general_email",
      row.recipient_name_snapshot,
      "verify",
      env,
      referenceId,
      templateParams,
      contactId
    );
  } else {
    pipeRes = await executeWhatsAppMessagingPipeline({
      db,
      user,
      contact: {
        id: contactId,
        name: row.recipient_name_snapshot || "Client",
        phone_number: row.phone_snapshot,
        email: row.email_snapshot,
      },
      templateId: row.template_id || row.template_name_snapshot,
      messageBody: row.body_snapshot,
      templateParams,
      referenceId,
      env,
    });
  }

  // 8. Settle status
  if (pipeRes?.success) {
    await db.execute({
      sql: "UPDATE campaign_recipients SET delivery_status = 'sent', provider_message_id = ?, sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      args: [pipeRes.providerMsgId || null, recipientId],
    });
  } else if (pipeRes?.inFlight) {
    await db.execute({
      sql: "UPDATE campaign_recipients SET delivery_status = 'sending', updated_at = datetime('now') WHERE id = ?",
      args: [recipientId],
    });
  } else if (pipeRes?.error === "WHATSAPP_TIMEOUT" || pipeRes?.error === "EMAIL_TIMEOUT" || pipeRes?.ambiguous) {
    await db.execute({
      sql: "UPDATE campaign_recipients SET delivery_status = 'sending', error_code = 'TIMEOUT', error_message = ?, updated_at = datetime('now') WHERE id = ?",
      args: [pipeRes.message || "Provider timeout", recipientId],
    });
  } else {
    await db.execute({
      sql: "UPDATE campaign_recipients SET delivery_status = 'failed', error_code = 'DISPATCH_FAILED', error_message = ?, updated_at = datetime('now') WHERE id = ?",
      args: [pipeRes?.message || "Dispatch failed", recipientId],
    });
  }

  // 9. Check if campaign execution is completed
  const remainingRes = await db.execute({
    sql: "SELECT COUNT(*) as remaining FROM campaign_recipients WHERE campaign_id = ? AND delivery_status IN ('pending', 'queued', 'sending')",
    args: [row.campaign_id],
  });
  const remaining = Number(remainingRes?.rows?.[0]?.remaining || 0);
  if (remaining === 0) {
    await db.execute({
      sql: "UPDATE campaigns SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'running'",
      args: [row.campaign_id],
    });
  }

  return {
    handled: true,
    status: pipeRes?.success ? "sent" : (pipeRes?.inFlight ? "sending" : "failed"),
    providerMsgId: pipeRes?.providerMsgId,
    error: pipeRes?.error,
  };
}

export async function processCampaignBatch(campaignId, env, db) {
  if (!campaignId) return { handled: false };

  const recipientsRes = await db.execute({
    sql: "SELECT id FROM campaign_recipients WHERE campaign_id = ? AND delivery_status IN ('pending', 'queued') ORDER BY created_at ASC",
    args: [campaignId],
  });

  const recipients = recipientsRes.rows || [];
  for (const r of recipients) {
    try {
      await processCampaignRecipient(r.id, env, db);
    } catch (err) {
      console.error(`[CAMPAIGN CONSUMER] Error processing recipient ${r.id}:`, err);
    }
  }

  return { handled: true, total: recipients.length };
}

export async function handleQueueBatch(batch, env, ctx, db) {
  const messages = batch?.messages || [];
  for (const message of messages) {
    const body = message?.body || {};
    if (body.type === "campaign_dispatch" && body.campaign_id) {
      try {
        await processCampaignBatch(body.campaign_id, env, db);
      } catch (err) {
        console.error(`[QUEUE CONSUMER] Error processing campaign ${body.campaign_id}:`, err);
      }
    } else if (body.type === "campaign_recipient" && body.recipient_id) {
      try {
        await processCampaignRecipient(body.recipient_id, env, db);
      } catch (err) {
        console.error(`[QUEUE CONSUMER] Error processing campaign recipient ${body.recipient_id}:`, err);
      }
    } else if (body.occurrenceId) {
      try {
        await processScheduledOccurrence(body.occurrenceId, env, db);
      } catch (err) {
        console.error(`[QUEUE CONSUMER] Error processing occurrence ${body.occurrenceId}:`, err);
      }
    }
    if (typeof message?.ack === "function") {
      message.ack();
    }
  }
}

