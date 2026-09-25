import { getDbClient } from "../db/client.js";
import { getWhatsAppTemplate, renderTemplateBody } from "../whatsapp/templates.js";
import { sendWhatsAppTemplate as clientSendWhatsAppTemplate, sendWhatsAppText, normalizeIndianPhoneNumber } from "../whatsapp/client.js";
import { getCustomerReplyWindowStatus } from "../whatsapp/window.js";
import { toSqliteUtc, isValidTimezone, parseScheduledForToUtc } from "../scheduler/time.js";
import { executeEmailMessagingPipeline } from "../email/pipeline.js";

import { executeWhatsAppMessagingPipeline } from "../whatsapp/pipeline.js";
export { executeWhatsAppMessagingPipeline, executeEmailMessagingPipeline, sendWhatsAppText, getCustomerReplyWindowStatus };

export async function ensureContact(db, userId, canonicalPhone, contactPerson, email = null) {
  const existingRes = await db.execute({
    sql: "SELECT id, contact_person, phone_number, email FROM contacts WHERE user_id = ? AND phone_number = ? LIMIT 1",
    args: [userId, canonicalPhone]
  }).catch(async () => {
    return db.execute({
      sql: "SELECT id, name as contact_person, phone_number, email FROM contacts WHERE user_id = ? AND phone_number = ? LIMIT 1",
      args: [userId, canonicalPhone]
    });
  });

  if (existingRes.rows && existingRes.rows.length > 0) {
    const existing = existingRes.rows[0];
    if (email && !existing.email) {
      await db.execute({
        sql: "UPDATE contacts SET email = ?, last_updated = datetime('now') WHERE id = ?",
        args: [email, existing.id]
      }).catch(() => {});
    }
    return {
      id: existing.id,
      contactPerson: existing.contact_person || existing.name || contactPerson,
      phoneNumber: existing.phone_number,
      email: existing.email || email || null
    };
  }

  const contactId = "cnt_" + crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO contacts (id, user_id, name, contact_person, phone_number, email, created_at, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    args: [contactId, userId, contactPerson, contactPerson, canonicalPhone, email]
  });

  return {
    id: contactId,
    contactPerson,
    phoneNumber: canonicalPhone,
    email
  };
}

export async function handleBulkPrecheck(c) {
  const body = await c.req.json().catch(() => ({}));
  const rawList = Array.isArray(body.phones)
    ? body.phones
    : (Array.isArray(body.clients) ? body.clients.map(cl => (typeof cl === 'string' ? cl : (cl.phoneNumber || cl.phone || ""))) : []);

  const env = c.env;
  const db = getDbClient(env);
  const user = c.get("user");
  const userId = user ? (user.id || user.sub || null) : null;
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const canonicalPhones = [];
  for (const item of rawList.slice(0, 1000)) {
    try {
      const rawStr = typeof item === 'string' ? item : (item?.phoneNumber || item?.phone || "");
      const canon = normalizeIndianPhoneNumber(rawStr);
      if (canon && !canonicalPhones.includes(canon)) {
        canonicalPhones.push(canon);
      }
    } catch (_) {}
  }

  const activeExistingPhones = {};

  if (canonicalPhones.length > 0) {
    const CHUNK_SIZE = 100;
    for (let i = 0; i < canonicalPhones.length; i += CHUNK_SIZE) {
      const chunk = canonicalPhones.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const res = await db.execute({
        sql: `SELECT id, phone_number, contact_person, status FROM loan_cases
              WHERE user_id = ? AND status NOT IN ('closed', 'completed')
              AND phone_number IN (${placeholders})`,
        args: [userId, ...chunk]
      }).catch(async () => {
        return db.execute({
          sql: `SELECT id, phone_number, name as contact_person, 'active' as status FROM contacts
                WHERE user_id = ? AND phone_number IN (${placeholders})`,
          args: [userId, ...chunk]
        });
      });
      for (const row of (res.rows || [])) {
        activeExistingPhones[row.phone_number] = {
          existingCaseId: row.id,
          contactPerson: row.contact_person || row.name,
          status: row.status || "active"
        };
      }
    }
  }

  return c.json({
    success: true,
    activeExistingPhones
  });
}

export const handleBulkImportPreview = handleBulkPrecheck;

export async function handleBulkImportCases(c) {
  const body = await c.req.json().catch(() => ({}));
  const rawClients = Array.isArray(body.clients) ? body.clients : [];
  if (rawClients.length === 0) {
    return c.json({ error: "No client records provided for import." }, 400);
  }

  if (rawClients.length > 500) {
    return c.json({ error: "Import limit exceeded. Maximum 500 clients per batch." }, 400);
  }

  const env = c.env;
  const db = getDbClient(env);
  const user = c.get("user");
  const userId = user ? (user.id || user.sub || null) : null;
  const sendWhatsApp = body.sendWhatsApp !== false;
  const templateName = body.templateName || env?.WHATSAPP_NEW_LEAD_TEMPLATE || "new_convo_1";
  const defaultProduct = body.defaultLoanProduct || "Direct Intake";

  const isScheduled = !!(sendWhatsApp && body.schedule && body.schedule.scheduledFor);
  let scheduledForUtc = null;
  let timezone = "Asia/Kolkata";

  if (isScheduled) {
    timezone = isValidTimezone(body.schedule.timezone) ? body.schedule.timezone : "Asia/Kolkata";
    scheduledForUtc = parseScheduledForToUtc(body.schedule.scheduledFor, timezone);
  }

  const results = [];
  let importedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;
  const immediateJobs = [];
  const seenPhonesInBatch = new Set();

  for (let i = 0; i < rawClients.length; i++) {
    const item = rawClients[i];
    let contactPerson = String(item.contactPerson || item.name || item.contact_person || "").trim();
    let rawPhone = String(item.phoneNumber || item.phone || item.phone_number || item.mobile || "").trim();

    let canonicalPhone;
    try {
      canonicalPhone = normalizeIndianPhoneNumber(rawPhone);
    } catch (e) {
      failedCount++;
      results.push({ index: i, name: contactPerson || "Unknown", phone: rawPhone, success: false, error: e.message });
      continue;
    }

    if (!contactPerson) {
      contactPerson = "Client " + canonicalPhone.slice(-4);
    }

    if (seenPhonesInBatch.has(canonicalPhone)) {
      duplicateCount++;
      results.push({
        index: i,
        name: contactPerson,
        phone: canonicalPhone,
        status: "duplicate_skipped",
        skipped: true,
        reason: "Duplicate phone number in same import batch",
        success: true
      });
      continue;
    }
    seenPhonesInBatch.add(canonicalPhone);

    const activeCaseRes = await db.execute({
      sql: "SELECT id, contact_person, status, whatsapp_delivery_status FROM loan_cases WHERE user_id = ? AND phone_number = ? AND status NOT IN ('closed', 'completed') LIMIT 1",
      args: [userId, canonicalPhone]
    }).catch(() => ({ rows: [] }));

    if (activeCaseRes?.rows && activeCaseRes.rows.length > 0) {
      const existing = activeCaseRes.rows[0];
      duplicateCount++;
      results.push({
        index: i,
        name: contactPerson || existing.contact_person,
        phone: canonicalPhone,
        status: "duplicate_skipped",
        skipped: true,
        existingCaseId: existing.id,
        reason: `Active workflow already exists (${existing.status})`,
        success: true
      });
      continue;
    }

    let caseId = null;
    try {
      const rowEmail = item.email && typeof item.email === "string" && item.email.trim().length > 0 ? item.email.trim() : null;
      const contact = await ensureContact(db, userId, canonicalPhone, contactPerson, rowEmail);

      caseId = crypto.randomUUID();
      const rowStatements = [];
      const rowParams = Array.isArray(item.templateParams) ? item.templateParams : (Array.isArray(item.params) ? item.params : []);
      const importChannel = String(body.channel || (sendWhatsApp ? "whatsapp" : "none")).toLowerCase();
      const deliveryStatus = (isScheduled && scheduledForUtc) ? 'scheduled' : (importChannel !== "none" ? 'queued' : 'not_sent');

      rowStatements.push({
        sql: `INSERT INTO loan_cases (id, contact_id, user_id, contact_person, phone_number, loan_product, template_name, amount_required, status, whatsapp_delivery_status, created_at, last_updated)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        args: [caseId, contact.id, userId, contact.contactPerson, canonicalPhone, defaultProduct, templateName, null, 'documents_pending', deliveryStatus]
      });

      rowStatements.push({
        sql: "INSERT INTO secure_tokens (token, case_id, expires_at) VALUES (?, ?, ?)",
        args: [crypto.randomUUID(), caseId, new Date(Date.now() + 14 * 86400000).toISOString()]
      });

      rowStatements.push({
        sql: `INSERT INTO case_timeline (id, contact_id, case_id, event_type, content, created_by)
              VALUES (?, ?, ?, 'case_created', ?, 'agent')`,
        args: [crypto.randomUUID(), contact.id, caseId, `Client imported: ${contact.contactPerson}`]
      });

      rowStatements.push({
        sql: `INSERT INTO activities (id, user_id, contact_id, activity_type, title, description, created_at)
              VALUES (?, ?, ?, 'contact_created', 'Target Created', ?, datetime('now'))`,
        args: [crypto.randomUUID(), userId, contact.id, `Target imported: ${contact.contactPerson}`]
      });

      const occExecutionUtc = (isScheduled && scheduledForUtc) ? scheduledForUtc : toSqliteUtc(new Date());

      if (importChannel === "both") {
        const schWaId = `sch_wa_${crypto.randomUUID()}`;
        const occWaId = `occ_${crypto.randomUUID()}`;
        const occWaKey = (isScheduled && scheduledForUtc) ? `${schWaId}_${scheduledForUtc}` : `${schWaId}_immediate`;

        rowStatements.push({
          sql: `
            INSERT INTO schedules (
              id, user_id, case_id, contact_id, phone_number, channel, template_name,
              template_params, schedule_type, recurrence_interval, timezone,
              status, next_run_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
          `,
          args: [schWaId, userId, caseId, contact.id, canonicalPhone, 'whatsapp', templateName, JSON.stringify(rowParams), 'one_off', null, timezone, occExecutionUtc]
        });

        rowStatements.push({
          sql: `
            INSERT INTO scheduled_occurrences (
              id, schedule_id, occurrence_key, scheduled_for_utc, operational_status, channel, recipient_phone, recipient_email
            ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
          `,
          args: [occWaId, schWaId, occWaKey, occExecutionUtc, 'whatsapp', canonicalPhone, null]
        });

        if (!isScheduled) {
          immediateJobs.push({ occurrenceId: occWaId, caseId });
        }

        const recipientEmail = contact.email || rowEmail;
        if (recipientEmail) {
          const schEmId = `sch_em_${crypto.randomUUID()}`;
          const occEmId = `occ_${crypto.randomUUID()}`;
          const occEmKey = (isScheduled && scheduledForUtc) ? `${schEmId}_${scheduledForUtc}` : `${schEmId}_immediate`;

          rowStatements.push({
            sql: `
              INSERT INTO schedules (
                id, user_id, case_id, contact_id, phone_number, channel, template_name,
                template_params, schedule_type, recurrence_interval, timezone,
                status, next_run_utc
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
            `,
            args: [schEmId, userId, caseId, contact.id, canonicalPhone, 'email', templateName, JSON.stringify(rowParams), 'one_off', null, timezone, occExecutionUtc]
          });

          rowStatements.push({
            sql: `
              INSERT INTO scheduled_occurrences (
                id, schedule_id, occurrence_key, scheduled_for_utc, operational_status, channel, recipient_phone, recipient_email
              ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
            `,
            args: [occEmId, schEmId, occEmKey, occExecutionUtc, 'email', null, recipientEmail]
          });

          if (!isScheduled) {
            immediateJobs.push({ occurrenceId: occEmId, caseId });
          }
        }
      } else if (importChannel === "email" || importChannel === "whatsapp") {
        const scheduleId = `sch_${crypto.randomUUID()}`;
        const occId = `occ_${crypto.randomUUID()}`;
        const occKey = (isScheduled && scheduledForUtc) ? `${scheduleId}_${scheduledForUtc}` : `${scheduleId}_immediate`;
        const recipientEmail = (importChannel === "email") ? (contact.email || rowEmail) : null;
        const recipientPhone = (importChannel === "whatsapp") ? canonicalPhone : null;

        rowStatements.push({
          sql: `
            INSERT INTO schedules (
              id, user_id, case_id, contact_id, phone_number, channel, template_name,
              template_params, schedule_type, recurrence_interval, timezone,
              status, next_run_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
          `,
          args: [
            scheduleId,
            userId,
            caseId,
            contact.id,
            canonicalPhone,
            importChannel,
            templateName,
            JSON.stringify(rowParams),
            'one_off',
            null,
            timezone,
            occExecutionUtc
          ]
        });

        rowStatements.push({
          sql: `
            INSERT INTO scheduled_occurrences (
              id, schedule_id, occurrence_key, scheduled_for_utc, operational_status, channel, recipient_phone, recipient_email
            ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
          `,
          args: [occId, scheduleId, occKey, occExecutionUtc, importChannel, recipientPhone, recipientEmail]
        });

        if (!isScheduled) {
          immediateJobs.push({ occurrenceId: occId, caseId });
        }
      }

      if (typeof db.batch === "function") {
        await db.batch(rowStatements);
      } else {
        for (const stmt of rowStatements) {
          await db.execute(stmt);
        }
      }

      importedCount++;
      results.push({
        index: i,
        caseId,
        contactId: contact.id,
        name: contact.contactPerson,
        phone: canonicalPhone,
        email: contact.email || rowEmail || null,
        loanProduct: defaultProduct,
        channel: importChannel,
        whatsappStatus: deliveryStatus,
        status: "imported",
        success: true
      });
    } catch (err) {
      const errMsg = String(err?.message || "");
      if (errMsg.includes("unq_active_case_user_phone") || errMsg.includes("UNIQUE constraint failed: loan_cases.user_id, loan_cases.phone_number")) {
        duplicateCount++;
        results.push({
          index: i,
          name: contactPerson,
          phone: canonicalPhone,
          status: "duplicate_skipped",
          skipped: true,
          reason: "Active workflow already exists (concurrent conflict)",
          success: true
        });
      } else {
        console.error(`Error importing row ${i}:`, err);
        failedCount++;
        results.push({ index: i, name: contactPerson, phone: canonicalPhone, success: false, error: err.message || "Failed to insert record" });
      }
    }
  }

  if (immediateJobs.length > 0) {
    const claimedJobs = [];
    for (const job of immediateJobs) {
      try {
        const claimRes = await db.execute({
          sql: `UPDATE scheduled_occurrences
                SET operational_status = 'claimed',
                    claimed_at = datetime('now'),
                    attempts = attempts + 1
                WHERE id = ? AND operational_status = 'pending'
                RETURNING id`,
          args: [job.occurrenceId]
        });
        const isClaimed = (claimRes?.rows && claimRes.rows.length === 1) || (claimRes?.changes === 1) || (claimRes?.meta?.changes === 1);
        if (isClaimed) {
          claimedJobs.push(job);
        }
      } catch (claimErr) {
        console.error(`Failed to claim occurrence ${job.occurrenceId}:`, claimErr);
      }
    }

    if (claimedJobs.length > 0) {
      if (env?.SCHEDULE_QUEUE && typeof env.SCHEDULE_QUEUE.sendBatch === "function") {
        const queueMessages = claimedJobs.map(j => ({
          body: {
            occurrenceId: j.occurrenceId,
            caseId: j.caseId
          }
        }));
        for (let offset = 0; offset < queueMessages.length; offset += 100) {
          const chunk = queueMessages.slice(offset, offset + 100);
          try {
            await env.SCHEDULE_QUEUE.sendBatch(chunk);
          } catch (queueErr) {
            console.error(`[BULK IMPORT] Queue sendBatch failure:`, queueErr);
          }
        }
      } else if (typeof env?.INLINE_QUEUE_CONSUMER === "function") {
        for (const j of claimedJobs) {
          try {
            await env.INLINE_QUEUE_CONSUMER({ occurrenceId: j.occurrenceId, caseId: j.caseId });
          } catch (_) {}
        }
      }
    }
  }

  const actionMsg = (isScheduled && scheduledForUtc)
    ? `Successfully scheduled outreach for ${importedCount} of ${rawClients.length} targets${duplicateCount > 0 ? ` (${duplicateCount} duplicate${duplicateCount > 1 ? 's' : ''} skipped)` : ''}.`
    : (sendWhatsApp
      ? `Successfully imported ${importedCount} of ${rawClients.length} targets${duplicateCount > 0 ? ` (${duplicateCount} duplicate${duplicateCount > 1 ? 's' : ''} skipped)` : ''} · outreach queued.`
      : `Successfully imported ${importedCount} of ${rawClients.length} targets${duplicateCount > 0 ? ` (${duplicateCount} duplicate${duplicateCount > 1 ? 's' : ''} skipped)` : ''}.`);

  return c.json({
    success: true,
    message: actionMsg,
    total: rawClients.length,
    importedCount,
    duplicateCount,
    failedCount,
    scheduled: !!(isScheduled && scheduledForUtc),
    queued: !isScheduled && sendWhatsApp && immediateJobs.length > 0,
    nextRunUtc: scheduledForUtc,
    results
  });
}

export async function handleCreateCase(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user ? (user.id || user.sub || null) : null;
  const body = await c.req.json().catch(() => ({}));

  const rawPhone = String(body.phone || body.phone_number || body.phoneNumber || "").trim();
  const contactPerson = String(body.contactPerson || body.name || "").trim() || "Client";
  const canonicalPhone = normalizeIndianPhoneNumber(rawPhone);
  const email = body.email ? String(body.email).trim().toLowerCase() : null;
  const channel = String(body.channel || "whatsapp").toLowerCase();
  const templateName = body.templateName || "new_convo_1";
  const templateParams = body.templateParams || [];
  const isScheduled = !!(body.schedule && body.schedule.scheduledFor);

  const contact = await ensureContact(db, userId, canonicalPhone, contactPerson, email);
  const caseId = crypto.randomUUID();

  await db.execute({
    sql: `INSERT INTO loan_cases (id, contact_id, user_id, contact_person, phone_number, loan_product, template_name, status, whatsapp_delivery_status, created_at, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'documents_pending', ?, datetime('now'), datetime('now'))`,
    args: [caseId, contact.id, userId, contactPerson, canonicalPhone, body.loanProduct || "General", templateName, isScheduled ? "scheduled" : "pending"]
  }).catch(() => {});

  if (isScheduled) {
    const scheduledForUtc = parseScheduledForToUtc(body.schedule.scheduledFor, body.schedule.timezone || "Asia/Kolkata");
    if (channel === "both") {
      const schWaId = `sch_wa_${crypto.randomUUID()}`;
      const occWaId = `occ_${crypto.randomUUID()}`;
      await db.execute({
        sql: `INSERT INTO schedules (id, user_id, case_id, contact_id, phone_number, channel, template_name, template_params, schedule_type, recurrence_interval, timezone, status, next_run_utc)
              VALUES (?, ?, ?, ?, ?, 'whatsapp', ?, ?, 'one_off', NULL, ?, 'active', ?)`,
        args: [schWaId, userId, caseId, contact.id, canonicalPhone, templateName, JSON.stringify(templateParams), body.schedule.timezone || "Asia/Kolkata", scheduledForUtc]
      });
      await db.execute({
        sql: `INSERT INTO scheduled_occurrences (id, schedule_id, occurrence_key, scheduled_for_utc, channel, recipient_phone, recipient_email)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [occWaId, schWaId, `${schWaId}_${scheduledForUtc}`, scheduledForUtc, 'whatsapp', canonicalPhone, null]
      });

      if (email) {
        const schEmId = `sch_em_${crypto.randomUUID()}`;
        const occEmId = `occ_${crypto.randomUUID()}`;
        await db.execute({
          sql: `INSERT INTO schedules (id, user_id, case_id, contact_id, phone_number, channel, template_name, template_params, schedule_type, recurrence_interval, timezone, status, next_run_utc)
                VALUES (?, ?, ?, ?, ?, 'email', ?, ?, 'one_off', NULL, ?, 'active', ?)`,
          args: [schEmId, userId, caseId, contact.id, canonicalPhone, templateName, JSON.stringify(templateParams), body.schedule.timezone || "Asia/Kolkata", scheduledForUtc]
        });
        await db.execute({
          sql: `INSERT INTO scheduled_occurrences (id, schedule_id, occurrence_key, scheduled_for_utc, channel, recipient_phone, recipient_email)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [occEmId, schEmId, `${schEmId}_${scheduledForUtc}`, scheduledForUtc, 'email', null, email]
        });
      }
    }
    return c.json({ success: true, scheduled: true, caseId, contactId: contact.id }, 201);
  }

  // Immediate send
  if (channel === "both") {
    await executeWhatsAppMessagingPipeline({
      db,
      user,
      contact,
      templateId: templateName,
      templateName,
      templateParams,
      referenceId: `case_${caseId}_wa`,
      env: c.env
    });
    if (email) {
      await executeEmailMessagingPipeline(
        db,
        user,
        email,
        templateName,
        contactPerson,
        "tok_email",
        c.env,
        `case_${caseId}_em`,
        templateParams,
        contact.id,
        caseId
      );
    }
  } else if (channel === "email" && email) {
    await executeEmailMessagingPipeline(
      db,
      user,
      email,
      templateName,
      contactPerson,
      "tok_email",
      c.env,
      `case_${caseId}_em`,
      templateParams,
      contact.id,
      caseId
    );
  } else {
    await executeWhatsAppMessagingPipeline({
      db,
      user,
      contact,
      templateId: templateName,
      templateName,
      templateParams,
      referenceId: `case_${caseId}_wa`,
      env: c.env
    });
  }

  return c.json({ success: true, caseId, contactId: contact.id }, 200);
}

export async function handleGetCases(c) {
  const { handleGetContacts } = await import("./contacts.js");
  return handleGetContacts(c);
}

export async function handleGetSingleCase(c) {
  const { handleGetContactWorkspace } = await import("./contacts.js");
  return handleGetContactWorkspace(c);
}

export async function handleUpdateStatus(c) {
  const { handleUpdateContact } = await import("./contacts.js");
  return handleUpdateContact(c);
}
