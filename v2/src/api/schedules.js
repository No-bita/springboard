/**
 * Schedules API Controller
 * Collectr Personal CRM - Scheduling Engine
 */

import { getDbClient } from "../db/client.js";
import { isValidTimezone, parseScheduledForToUtc } from "../scheduler/time.js";
import { normalizeIndianPhoneNumber } from "../whatsapp/client.js";
import { renderTemplateBody } from "../whatsapp/templates.js";

export async function handleCreateSchedule(c) {
  const user = c.get("user");
  const userId = user.id;
  const db = getDbClient(c.env);

  const body = await c.req.json().catch(() => ({}));
  const {
    contactId = null,
    requestId = null,
    phoneNumber = null,
    email = null,
    channel = "whatsapp",
    templateId = null,
    templateName = null,
    messageBody = null,
    templateParams = [],
    timezone = "Asia/Kolkata",
    scheduledFor,
  } = body;

  const outreachChannel = String(channel || "whatsapp").toLowerCase();

  // Validate XOR: template_id XOR message_body
  const resolvedTemplateId = templateId || templateName || null;
  const resolvedMessageBody = messageBody ? String(messageBody).trim() : null;

  if (resolvedTemplateId && resolvedMessageBody) {
    return c.json({ error: "Cannot provide both template and freeform message body. Choose one." }, 400);
  }
  if (!resolvedTemplateId && !resolvedMessageBody) {
    return c.json({ error: "Either a template or a message body is required." }, 400);
  }

  // Resolve Contact
  let targetContactId = contactId;
  let canonicalPhone = null;
  let recipientEmail = null;

  if (targetContactId) {
    const contactRes = await db.execute({
      sql: "SELECT id, name, phone_number, email FROM contacts WHERE id = ? AND user_id = ? LIMIT 1",
      args: [targetContactId, userId],
    });
    if (contactRes.rows.length === 0) {
      return c.json({ error: "Contact not found." }, 404);
    }
    canonicalPhone = contactRes.rows[0].phone_number;
    recipientEmail = contactRes.rows[0].email;
  } else if (phoneNumber) {
    try {
      canonicalPhone = normalizeIndianPhoneNumber(phoneNumber);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }

    // Lookup or create contact
    const contactRes = await db.execute({
      sql: "SELECT id FROM contacts WHERE user_id = ? AND phone_number = ? LIMIT 1",
      args: [userId, canonicalPhone],
    });
    if (contactRes.rows.length > 0) {
      targetContactId = contactRes.rows[0].id;
    } else {
      targetContactId = "cnt_" + crypto.randomUUID();
      const contactDisplayName = body.name || `Contact ${canonicalPhone.slice(-4)}`;
      await db.execute({
        sql: `INSERT INTO contacts (id, user_id, contact_person, name, phone_number, email, created_at, last_updated)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        args: [targetContactId, userId, contactDisplayName, contactDisplayName, canonicalPhone, email],
      });
    }
  }

  if (outreachChannel === "whatsapp" && !canonicalPhone) {
    return c.json({ error: "Phone number is required for WhatsApp schedule." }, 400);
  }
  if (outreachChannel === "email" && !recipientEmail && !email) {
    return c.json({ error: "Email address is required for email schedule." }, 400);
  }

  const safeTz = isValidTimezone(timezone) ? timezone : "Asia/Kolkata";
  const scheduledForUtc = parseScheduledForToUtc(scheduledFor, safeTz);

  // Snapshot rendered content
  const renderedContent = resolvedMessageBody || renderTemplateBody(resolvedTemplateId, {
    name: body.name || "there",
    userName: user.username || "Collectr",
    templateParams,
  });

  const payloadSnapshot = {
    channel: outreachChannel,
    templateId: resolvedTemplateId,
    messageBody: resolvedMessageBody,
    renderedContent,
    templateParams,
    timezone: safeTz,
    recipientPhone: canonicalPhone,
    recipientEmail: recipientEmail || email,
  };

  const scheduleId = `sch_${crypto.randomUUID()}`;
  const occurrenceId = `occ_${crypto.randomUUID()}`;
  const occurrenceKey = `${scheduleId}_${scheduledForUtc}`;

  const scheduleStatements = [
    {
      sql: `
        INSERT INTO schedules (
          id, user_id, contact_id, request_id, channel, template_id, message_body,
          payload_snapshot, schedule_type, recurrence_interval, timezone,
          status, next_run_utc, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'one_off', null, ?, 'active', ?, datetime('now'))
      `,
      args: [
        scheduleId,
        userId,
        targetContactId,
        requestId,
        outreachChannel,
        resolvedTemplateId,
        resolvedMessageBody,
        JSON.stringify(payloadSnapshot),
        safeTz,
        scheduledForUtc,
      ],
    },
    {
      sql: `
        INSERT INTO scheduled_occurrences (
          id, schedule_id, occurrence_key, scheduled_for_utc, operational_status,
          channel, recipient_phone, recipient_email, created_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))
      `,
      args: [
        occurrenceId,
        scheduleId,
        occurrenceKey,
        scheduledForUtc,
        outreachChannel,
        canonicalPhone,
        recipientEmail || email,
      ],
    },
  ];

  if (typeof db.batch === "function") {
    await db.batch(scheduleStatements);
  } else {
    for (const stmt of scheduleStatements) {
      await db.execute(stmt);
    }
  }

  // Log Activity
  if (targetContactId) {
    const actId = "act_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, ?, 'schedule_created', 'Outreach Scheduled', ?, ?, datetime('now'))`,
      args: [actId, userId, targetContactId, requestId, `Scheduled for ${scheduledForUtc} UTC`, JSON.stringify({ scheduleId, scheduledForUtc })],
    });
  }

  return c.json({
    success: true,
    schedule: {
      id: scheduleId,
      contactId: targetContactId,
      requestId,
      scheduleType: "one_off",
      timezone: safeTz,
      scheduledForUtc,
      status: "active",
      payloadSnapshot,
    },
    occurrence: {
      id: occurrenceId,
      occurrenceKey,
      scheduledForUtc,
      operationalStatus: "pending",
    },
  }, 201);
}

export async function handleGetSchedules(c) {
  const user = c.get("user");
  const userId = user.id;
  const db = getDbClient(c.env);
  const isAdmin = String(user.role).toLowerCase() === "admin";

  let sql = `
    SELECT s.*, 
           c.name as contact_name,
           c.phone_number as contact_phone,
           o.id as occurrence_id,
           o.scheduled_for_utc as occurrence_scheduled_for,
           o.operational_status as occurrence_status,
           o.attempts as occurrence_attempts,
           o.provider_message_id,
           o.message_id,
           o.skip_reason,
           o.last_error,
           o.executed_at as occurrence_executed_at
    FROM schedules s
    LEFT JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN scheduled_occurrences o ON o.schedule_id = s.id
    WHERE 1=1
  `;
  const args = [];

  if (!isAdmin) {
    sql += " AND s.user_id = ?";
    args.push(userId);
  }

  sql += " ORDER BY s.created_at DESC, o.scheduled_for_utc DESC LIMIT 100";

  const res = await db.execute({ sql, args });
  return c.json({ schedules: res.rows || [] });
}

export async function handleCancelSchedule(c) {
  const user = c.get("user");
  const userId = user.id;
  const scheduleId = c.req.param("id");
  const db = getDbClient(c.env);
  const isAdmin = String(user.role).toLowerCase() === "admin";

  let checkSql = "SELECT id, user_id FROM schedules WHERE id = ?";
  const checkArgs = [scheduleId];
  if (!isAdmin) {
    checkSql += " AND user_id = ?";
    checkArgs.push(userId);
  }

  const checkRes = await db.execute({ sql: checkSql, args: checkArgs });
  if (!checkRes.rows || checkRes.rows.length === 0) {
    return c.json({ error: "Schedule not found or unauthorized" }, 404);
  }

  await db.execute({
    sql: "UPDATE schedules SET status = 'cancelled', cancelled_at = datetime('now'), next_run_utc = NULL WHERE id = ?",
    args: [scheduleId],
  });

  await db.execute({
    sql: "UPDATE scheduled_occurrences SET operational_status = 'skipped', skip_reason = 'cancelled', executed_at = datetime('now') WHERE schedule_id = ? AND operational_status IN ('pending', 'claimed')",
    args: [scheduleId],
  });

  return c.json({ success: true, message: "Schedule cancelled successfully" });
}

export async function handleRetryOccurrence(c) {
  const user = c.get("user");
  const userId = user.id;
  const occurrenceId = c.req.param("id");
  const db = getDbClient(c.env);
  const body = await c.req.json().catch(() => ({}));
  const isAdmin = String(user.role).toLowerCase() === "admin";

  const queryRes = await db.execute({
    sql: `
      SELECT o.*, s.user_id, s.status as schedule_status
      FROM scheduled_occurrences o
      JOIN schedules s ON o.schedule_id = s.id
      WHERE o.id = ?
    `,
    args: [occurrenceId],
  });

  const row = queryRes.rows?.[0];
  if (!row) {
    return c.json({ error: "Occurrence not found" }, 404);
  }

  if (!isAdmin && row.user_id !== userId) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  if (row.operational_status === "completed") {
    return c.json({ error: "Occurrence already completed successfully" }, 400);
  }

  if (row.operational_status === "unknown" && !body.forceDuplicateRiskAcknowledgement) {
    return c.json({
      error: "UNKNOWN_DUPLICATE_RISK",
      message: "Unknown — possible duplicate. Manual verification required.",
      warning: "Provider may already have dispatched this message. If verified, retry with forceDuplicateRiskAcknowledgement: true.",
    }, 400);
  }

  await db.execute({
    sql: `
      UPDATE scheduled_occurrences
      SET operational_status = 'pending',
          claimed_at = NULL,
          last_error = NULL,
          skip_reason = NULL,
          scheduled_for_utc = datetime('now')
      WHERE id = ?
    `,
    args: [occurrenceId],
  });

  return c.json({ success: true, message: "Occurrence reset to pending for retry" });
}
