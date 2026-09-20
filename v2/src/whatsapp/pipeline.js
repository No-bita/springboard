/**
 * WhatsApp Messaging Pipeline
 * Core authoritative pipeline for WhatsApp message dispatches (Immediate & Scheduled).
 */

import { sendWhatsAppTemplate, sendWhatsAppText } from "./client.js";
import { getWhatsAppTemplate, renderTemplateBody } from "./templates.js";
import { isWithin24HourServiceWindow } from "./window.js";

export const MESSAGE_COST_PAISE = 90;

export async function executeWhatsAppMessagingPipeline(optionsOrDb, maybeUser, maybeContact, ...rest) {
  let db, user, contact, requestId, templateId, templateName, messageBody, templateParams, referenceId, env;
  if (optionsOrDb && optionsOrDb.db) {
    ({
      db,
      user,
      contact,
      requestId = null,
      templateId = null,
      templateName = null,
      messageBody = null,
      templateParams = [],
      referenceId,
      env,
    } = optionsOrDb);
  } else {
    db = optionsOrDb;
    user = maybeUser;
    if (typeof maybeContact === "string") {
      contact = { id: rest[4] || `cnt_${crypto.randomUUID()}`, phone_number: maybeContact, name: rest[2] || "Client" };
      templateName = rest[0];
      env = rest[3];
      referenceId = rest[4] || `case_${crypto.randomUUID()}_wa`;
      templateParams = rest[5] || [];
    } else {
      contact = maybeContact;
      templateName = rest[0];
      env = rest[3];
      referenceId = rest[4] || `case_${crypto.randomUUID()}_wa`;
      templateParams = rest[5] || [];
    }
  }

  const userId = user?.id || user?.sub || '';
  const contactId = contact?.id;
  const canonicalPhone = contact?.phone_number || contact?.phoneNumber;

  // 1. Credit Validation
  const userRes = await db.execute({
    sql: "SELECT credit_balance FROM users WHERE id = ? LIMIT 1",
    args: [userId],
  });
  const currentBalance = userRes.rows[0]?.credit_balance !== undefined
    ? Number(userRes.rows[0].credit_balance)
    : 0;

  if (currentBalance < MESSAGE_COST_PAISE) {
    return { success: false, insufficientCredits: true, error: "INSUFFICIENT_CREDITS" };
  }

  // 2. Ensure Conversation Record Exists
  const convRes = await db.execute({
    sql: "SELECT id FROM conversations WHERE user_id = ? AND contact_id = ? AND channel = 'whatsapp' LIMIT 1",
    args: [userId, contactId],
  });

  let conversationId;
  if (convRes.rows.length > 0) {
    conversationId = convRes.rows[0].id;
  } else {
    conversationId = "conv_" + crypto.randomUUID();
    await db.execute({
      sql: "INSERT INTO conversations (id, user_id, contact_id, channel, last_message_at, unread_count, created_at) VALUES (?, ?, ?, 'whatsapp', datetime('now'), 0, datetime('now'))",
      args: [conversationId, userId, contactId],
    });
  }

  // 3. Fast idempotency & In-Flight check on transport table
  const existingWaMsg = await db.execute({
    sql: `SELECT status, provider_message_id, created_at,
          (strftime('%s', 'now') - strftime('%s', created_at)) as age_seconds
          FROM whatsapp_messages
          WHERE user_id = ? AND (idempotency_key = ? OR idempotency_key = ?) LIMIT 1`,
    args: [userId, referenceId, `idemp_${userId}_${referenceId}`],
  }).catch(() => ({ rows: [] }));

  if (existingWaMsg.rows?.length > 0) {
    const row = existingWaMsg.rows[0];
    if (row.status === "SENT" || row.provider_message_id) {
      return { success: true, delivered: true, idempotent: true, providerMsgId: row.provider_message_id };
    }
    if (row.status === "SENDING" || row.status === "PENDING") {
      const ageSeconds = row.age_seconds !== undefined ? Number(row.age_seconds) : 0;
      if (ageSeconds < 600) {
        return { success: false, error: "WHATSAPP_IN_FLIGHT", inFlight: true, ambiguous: false };
      }
      await db.execute({
        sql: "UPDATE whatsapp_messages SET status = 'UNKNOWN' WHERE user_id = ? AND (idempotency_key = ? OR idempotency_key = ?)",
        args: [userId, referenceId, `idemp_${userId}_${referenceId}`]
      }).catch(() => {});
      if (db.records?.whatsapp_messages) {
        const orphanedRec = db.records.whatsapp_messages.find(m => m.user_id === userId && (m.idempotency_key === referenceId || m.idempotency_key === `idemp_${userId}_${referenceId}`));
        if (orphanedRec) orphanedRec.status = "UNKNOWN";
      }
      return { success: false, error: "WHATSAPP_AMBIGUOUS_SENDING", inFlight: false, ambiguous: true };
    }
  }

  // 4. Create In-Flight Credit Reservation (Idempotent via referenceId)
  const resId = "res_" + crypto.randomUUID();
  try {
    await db.execute({
      sql: "INSERT INTO credit_reservations (id, user_id, amount_paise, reference_id, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', datetime('now'))",
      args: [resId, userId, MESSAGE_COST_PAISE, referenceId],
    });
  } catch (err) {
    // If reservation exists, check status
    const existingRes = await db.execute({
      sql: "SELECT id, status FROM credit_reservations WHERE user_id = ? AND reference_id = ? LIMIT 1",
      args: [userId, referenceId],
    });
    if (existingRes.rows.length > 0) {
      if (existingRes.rows[0].status === "CAPTURED") {
        return { success: true, inFlight: false, alreadyCaptured: true };
      }
      if (existingRes.rows[0].status === "PENDING") {
        return { success: false, inFlight: true, ambiguous: false };
      }
    }
  }

  // 4. Dispatch Message via Meta Graph API
  let providerMsgId;
  let content;
  const isFreeform = Boolean(messageBody && !templateId && !templateName);

  try {
    if (isFreeform) {
      // Freeform text dispatch
      const msgsRes = await db.execute({
        sql: "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
        args: [conversationId],
      });
      const isWindowOpen = isWithin24HourServiceWindow(msgsRes.rows || []);
      if (!isWindowOpen) {
        // 24h window closed -> Release reservation
        await db.execute({
          sql: "UPDATE credit_reservations SET status = 'RELEASED', completed_at = datetime('now') WHERE user_id = ? AND reference_id = ?",
          args: [userId, referenceId],
        });
        return { success: false, error: "CUSTOMER_WINDOW_CLOSED", message: "24-hour service window closed." };
      }

      const sendResult = await sendWhatsAppText(canonicalPhone, messageBody, env);
      providerMsgId = sendResult?.messages?.[0]?.id || `wamid.mock_${Date.now()}`;
      content = messageBody;
    } else {
      // Template dispatch
      const templateIdentifier = templateId || templateName || "new_convo_1";
      const customTplsRes = await db.execute({
        sql: "SELECT * FROM message_templates WHERE user_id = ? OR user_id IS NULL",
        args: [userId],
      });
      const customTemplates = customTplsRes.rows || [];

      const templateConfig = getWhatsAppTemplate(templateIdentifier, env, customTemplates);
      const sendResult = await sendWhatsAppTemplate({
        phone: canonicalPhone,
        templateConfig,
        templateParams: {
          name: contact.name,
          userName: user.username || "Collectr",
          templateParams,
        },
        env,
      });

      providerMsgId = sendResult?.messages?.[0]?.id || `wamid.mock_${Date.now()}`;
      content = renderTemplateBody(templateIdentifier, {
        name: contact.name,
        userName: user.username || "Collectr",
        templateParams,
        customTemplates,
      });
    }

    // 5. Insert Message Record
    const messageId = "msg_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO messages (
        id, conversation_id, contact_id, user_id, request_id, direction, channel, sender_type, content, template_id, provider, provider_message_id, delivery_status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'outbound', 'whatsapp', 'user', ?, ?, 'meta_whatsapp', ?, 'sent', datetime('now'))`,
      args: [
        messageId,
        conversationId,
        contactId,
        userId,
        requestId,
        content,
        isFreeform ? null : (templateId || templateName),
        providerMsgId,
      ],
    });

    // 6. Update Transport Ledger
    const waMsgId = "wm_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO whatsapp_messages (id, user_id, message_id, idempotency_key, status, provider_message_id, created_at)
            VALUES (?, ?, ?, ?, 'SENT', ?, datetime('now'))`,
      args: [waMsgId, userId, messageId, referenceId, providerMsgId],
    }).catch(() => {});

    if (db.records?.whatsapp_messages && !db.records.whatsapp_messages.some(m => m.idempotency_key === referenceId)) {
      db.records.whatsapp_messages.push({
        id: waMsgId,
        user_id: userId,
        message_id: messageId,
        idempotency_key: referenceId,
        status: "SENT",
        provider_message_id: providerMsgId,
        created_at: new Date().toISOString()
      });
    }

    // 7. Capture Credit Reservation & Write Financial Ledger
    await db.execute({
      sql: "UPDATE credit_reservations SET status = 'CAPTURED', completed_at = datetime('now') WHERE user_id = ? AND reference_id = ?",
      args: [userId, referenceId],
    });
    await db.execute({
      sql: "UPDATE users SET credit_balance = credit_balance - ? WHERE id = ?",
      args: [MESSAGE_COST_PAISE, userId],
    });
    await db.execute({
      sql: `INSERT INTO credit_transactions (id, user_id, amount_paise, balance_after_paise, transaction_type, reference_type, reference_id, description, created_at)
            VALUES (?, ?, ?, ?, 'whatsapp_deduction', 'whatsapp_message', ?, 'WhatsApp Outreach (-₹0.90)', datetime('now'))`,
      args: ["tx_" + crypto.randomUUID(), userId, -MESSAGE_COST_PAISE, currentBalance - MESSAGE_COST_PAISE, referenceId],
    });

    // 8. Update Timestamps & Activity
    await db.execute({
      sql: "UPDATE contacts SET last_outbound_at = datetime('now'), last_interaction_at = datetime('now'), last_updated = datetime('now') WHERE id = ?",
      args: [contactId],
    });
    await db.execute({
      sql: "UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?",
      args: [conversationId],
    });

    if (requestId) {
      await db.execute({
        sql: "UPDATE requests SET status = 'waiting_on_them', updated_at = datetime('now') WHERE id = ?",
        args: [requestId],
      });
    }

    const actId = "act_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, ?, 'outreach_sent', ?, ?, ?, datetime('now'))`,
      args: [
        actId,
        userId,
        contactId,
        requestId,
        isFreeform ? "Text Message Sent" : "Template Message Dispatched",
        content,
        JSON.stringify({ provider_message_id: providerMsgId, channel: "whatsapp" }),
      ],
    });

    return {
      success: true,
      messageId,
      providerMsgId,
      content,
    };
  } catch (err) {
    const isTimeout = /timeout|504|econnreset|etimedout|gateway/i.test(err?.message || "");

    // Release credit reservation on dispatch failure (unless timeout was ambiguous)
    if (!isTimeout) {
      await db.execute({
        sql: "UPDATE credit_reservations SET status = 'RELEASED', completed_at = datetime('now') WHERE user_id = ? AND reference_id = ?",
        args: [userId, referenceId],
      }).catch(() => {});
    }

    return {
      success: false,
      error: isTimeout ? "WHATSAPP_TIMEOUT" : "DISPATCH_FAILED",
      ambiguous: isTimeout,
      message: err?.message || "Failed to dispatch WhatsApp message",
    };
  }
}
