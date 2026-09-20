import { getDbClient } from "../db/client.js";
import { sendWhatsAppText, sendWhatsAppTemplate } from "../whatsapp/client.js";
import { getWhatsAppTemplate, renderTemplateBody } from "../whatsapp/templates.js";
import { isWithin24HourServiceWindow } from "../whatsapp/window.js";
import { executeEmailMessagingPipeline } from "../email/pipeline.js";

const MESSAGE_COST_PAISE = 90;

/**
 * POST /api/contacts/:id/messages/text
 * Dispatches a freeform WhatsApp text message within the 24-hour service window.
 */
export async function handleSendContactText(c, passedBody = null) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user.id;
  const contactId = c.req.param("id");

  const body = passedBody || (await c.req.json().catch(() => ({})));
  const text = String(body.text || body.message || body.message_body || "").trim();
  const requestId = body.requestId || null;

  if (!text) {
    return c.json({ error: "Message text cannot be empty." }, 400);
  }

  try {
    // 1. Fetch Contact & Conversation
    const contactRes = await db.execute({
      sql: "SELECT * FROM contacts WHERE id = ? AND user_id = ? LIMIT 1",
      args: [contactId, userId],
    });

    if (contactRes.rows.length === 0) {
      return c.json({ error: "Contact not found." }, 404);
    }
    const contact = contactRes.rows[0];

    // Ensure conversation
    let convRes = await db.execute({
      sql: "SELECT * FROM conversations WHERE contact_id = ? AND user_id = ? AND channel = 'whatsapp' LIMIT 1",
      args: [contactId, userId],
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

    // 2. Fetch past messages to verify 24h customer service window
    const msgsRes = await db.execute({
      sql: "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
      args: [conversationId],
    });

    const isWindowOpen = isWithin24HourServiceWindow(msgsRes.rows || []);
    if (!isWindowOpen) {
      return c.json({
        error: "The 24-hour WhatsApp customer window has closed. You must send an approved template message to initiate contact.",
        windowClosed: true,
      }, 403);
    }

    // 3. Dispatch WhatsApp text message
    const sendResult = await sendWhatsAppText(contact.phone_number, text, c.env);
    const providerMsgId = sendResult?.messages?.[0]?.id || `wamid.mock_${Date.now()}`;

    // 4. Record message
    const messageId = "msg_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO messages (
        id, conversation_id, contact_id, user_id, request_id, direction, channel, sender_type, content, provider, provider_message_id, delivery_status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'outbound', 'whatsapp', 'user', ?, 'meta_whatsapp', ?, 'sent', datetime('now'))`,
      args: [messageId, conversationId, contactId, userId, requestId, text, providerMsgId],
    });

    // 5. Update Timestamps & Activity
    await db.execute({
      sql: "UPDATE contacts SET last_outbound_at = datetime('now'), last_interaction_at = datetime('now'), last_updated = datetime('now') WHERE id = ?",
      args: [contactId],
    });
    await db.execute({
      sql: "UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?",
      args: [conversationId],
    });

    const actId = "act_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, ?, 'outreach_sent', 'Text Message Sent', ?, ?, datetime('now'))`,
      args: [actId, userId, contactId, requestId, text, JSON.stringify({ provider_message_id: providerMsgId, channel: 'whatsapp' })],
    });

    return c.json({
      success: true,
      message: {
        id: messageId,
        content: text,
        providerMessageId: providerMsgId,
        deliveryStatus: "sent",
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("handleSendContactText error:", err);
    return c.json({ error: "Failed to send text message", details: err.message }, 500);
  }
}

/**
 * POST /api/contacts/:id/messages/template
 * Dispatches an approved WhatsApp Meta template message to a contact.
 */
export async function handleSendContactTemplate(c, passedBody = null) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user.id;
  const contactId = c.req.param("id");

  const body = passedBody || (await c.req.json().catch(() => ({})));
  const templateIdentifier = body.templateId || body.template_id || body.templateName || "new_convo_1";
  const templateParams = Array.isArray(body.templateParams || body.template_params) ? (body.templateParams || body.template_params) : [];
  const requestId = body.requestId || null;

  try {
    // 1. Fetch Contact & Conversation
    const contactRes = await db.execute({
      sql: "SELECT * FROM contacts WHERE id = ? AND user_id = ? LIMIT 1",
      args: [contactId, userId],
    });

    if (contactRes.rows.length === 0) {
      return c.json({ error: "Contact not found." }, 404);
    }
    const contact = contactRes.rows[0];

    // Ensure conversation
    let convRes = await db.execute({
      sql: "SELECT * FROM conversations WHERE contact_id = ? AND user_id = ? AND channel = 'whatsapp' LIMIT 1",
      args: [contactId, userId],
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

    // 2. Fetch custom templates
    const customTplsRes = await db.execute({
      sql: "SELECT * FROM message_templates WHERE user_id = ? OR user_id IS NULL",
      args: [userId],
    });
    const customTemplates = customTplsRes.rows || [];

    // 3. Credit Validation
    const userRes = await db.execute({
      sql: "SELECT credit_balance FROM users WHERE id = ? LIMIT 1",
      args: [userId],
    });
    const currentBalance = userRes.rows[0]?.credit_balance || 0;
    if (currentBalance < MESSAGE_COST_PAISE) {
      return c.json({ error: "Insufficient messaging credits. Please recharge your wallet." }, 402);
    }

    // 4. Reserve Credit Hold
    const idempotencyKey = "wa_tpl_" + crypto.randomUUID();
    const resId = "res_" + crypto.randomUUID();
    await db.execute({
      sql: "INSERT INTO credit_reservations (id, user_id, amount_paise, reference_id, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', datetime('now'))",
      args: [resId, userId, MESSAGE_COST_PAISE, idempotencyKey],
    });

    // 5. Build Template Payload & Dispatch
    const templateConfig = getWhatsAppTemplate(templateIdentifier, c.env, customTemplates);
    const sendResult = await sendWhatsAppTemplate({
      phone: contact.phone_number,
      templateConfig,
      templateParams: {
        name: contact.name,
        userName: user.username || "Collectr",
        templateParams,
      },
      env: c.env,
    });

    const providerMsgId = sendResult?.messages?.[0]?.id || `wamid.mock_${Date.now()}`;
    const renderedBody = renderTemplateBody(templateIdentifier, {
      name: contact.name,
      userName: user.username || "Collectr",
      templateParams,
      customTemplates,
    });

    // 6. Record Message
    const messageId = "msg_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO messages (
        id, conversation_id, contact_id, user_id, request_id, direction, channel, sender_type, content, template_id, provider, provider_message_id, delivery_status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'outbound', 'whatsapp', 'user', ?, ?, 'meta_whatsapp', ?, 'sent', datetime('now'))`,
      args: [messageId, conversationId, contactId, userId, requestId, renderedBody, templateIdentifier, providerMsgId],
    });

    // 7. Update transport ledger
    await db.execute({
      sql: `INSERT INTO whatsapp_messages (id, user_id, message_id, idempotency_key, status, provider_message_id, created_at)
            VALUES (?, ?, ?, ?, 'SENT', ?, datetime('now'))`,
      args: ["wm_" + crypto.randomUUID(), userId, messageId, idempotencyKey, providerMsgId],
    });

    // 8. Capture Credit Hold & Write Ledger
    await db.execute({
      sql: "UPDATE credit_reservations SET status = 'CAPTURED', completed_at = datetime('now') WHERE id = ?",
      args: [resId],
    });
    await db.execute({
      sql: "UPDATE users SET credit_balance = credit_balance - ? WHERE id = ?",
      args: [MESSAGE_COST_PAISE, userId],
    });
    await db.execute({
      sql: `INSERT INTO credit_transactions (id, user_id, amount_paise, balance_after_paise, transaction_type, reference_type, reference_id, description, created_at)
            VALUES (?, ?, ?, ?, 'whatsapp_deduction', 'whatsapp_message', ?, 'WhatsApp Template Outreach (-₹0.90)', datetime('now'))`,
      args: ["tx_" + crypto.randomUUID(), userId, -MESSAGE_COST_PAISE, currentBalance - MESSAGE_COST_PAISE, idempotencyKey],
    });

    // 9. Update Timestamps & Activity
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
            VALUES (?, ?, ?, ?, 'outreach_sent', 'Template Message Dispatched', ?, ?, datetime('now'))`,
      args: [actId, userId, contactId, requestId, renderedBody, JSON.stringify({ template: templateIdentifier, provider_message_id: providerMsgId })],
    });

    // If channel is 'both' and recipient email is present, dispatch email as well
    if (body.channel === "both" && (contact.email || body.email)) {
      await handleSendContactEmail(c, {
        ...body,
        templateId: templateIdentifier,
        templateName: templateIdentifier,
        templateParams,
      }).catch((err) => console.warn("handleSendContactTemplate dual email dispatch failed:", err));
    }

    return c.json({
      success: true,
      message: {
        id: messageId,
        content: renderedBody,
        templateId: templateIdentifier,
        providerMessageId: providerMsgId,
        deliveryStatus: "sent",
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("handleSendContactTemplate error:", err);
    return c.json({ error: "Failed to send template message", details: err.message }, 500);
  }
}

/**
 * POST /api/contacts/:id/messages/email
 * Dispatches an email outreach message to a contact via Resend.
 */
export async function handleSendContactEmail(c, passedBody = null) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user.id;
  const contactId = c.req.param("id");

  const body = passedBody || (await c.req.json().catch(() => ({})));
  const customText = String(body.message_body || body.text || body.message || "").trim();
  const templateIdentifier = body.template_id || body.templateId || "general_outreach";
  const templateParams = Array.isArray(body.template_params || body.templateParams) ? (body.template_params || body.templateParams) : [];
  const requestId = body.requestId || null;

  try {
    const contactRes = await db.execute({
      sql: "SELECT * FROM contacts WHERE id = ? AND user_id = ? LIMIT 1",
      args: [contactId, userId],
    });

    if (contactRes.rows.length === 0) {
      return c.json({ error: "Contact not found." }, 404);
    }
    const contact = contactRes.rows[0];

    if (!contact.email) {
      return c.json({ error: "Contact does not have an email address configured." }, 400);
    }

    // Ensure email conversation
    let convRes = await db.execute({
      sql: "SELECT * FROM conversations WHERE contact_id = ? AND user_id = ? AND channel = 'email' LIMIT 1",
      args: [contactId, userId],
    });

    let conversationId;
    if (convRes.rows.length > 0) {
      conversationId = convRes.rows[0].id;
    } else {
      conversationId = "conv_" + crypto.randomUUID();
      await db.execute({
        sql: "INSERT INTO conversations (id, user_id, contact_id, channel, last_message_at, unread_count, created_at) VALUES (?, ?, ?, 'email', datetime('now'), 0, datetime('now'))",
        args: [conversationId, userId, contactId],
      });
    }

    const refId = "msg_email_" + crypto.randomUUID();
    const emailRes = await executeEmailMessagingPipeline(
      db,
      user,
      contact.email,
      templateIdentifier,
      contact.name || "Client",
      "", // token
      c.env,
      refId,
      templateParams.length > 0 ? templateParams : [customText || contact.name || "Client"],
      contactId,
      null
    );

    if (!emailRes.success) {
      return c.json({ error: emailRes.message || "Failed to dispatch email" }, 500);
    }

    const messageId = "msg_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO messages (
        id, conversation_id, contact_id, user_id, request_id, direction, channel, sender_type, content, provider, provider_message_id, delivery_status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'outbound', 'email', 'user', ?, 'resend', ?, 'sent', datetime('now'))`,
      args: [messageId, conversationId, contactId, requestId, emailRes.renderedBody || customText || templateIdentifier, emailRes.providerMsgId],
    });

    await db.execute({
      sql: "UPDATE contacts SET last_outbound_at = datetime('now'), last_interaction_at = datetime('now'), last_updated = datetime('now') WHERE id = ?",
      args: [contactId],
    });
    await db.execute({
      sql: "UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?",
      args: [conversationId],
    });

    const actId = "act_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
            VALUES (?, ?, ?, ?, 'outreach_sent', 'Email Outreach Sent', ?, ?, datetime('now'))`,
      args: [actId, userId, contactId, requestId, emailRes.subject || "Email dispatched", JSON.stringify({ provider_message_id: emailRes.providerMsgId, channel: 'email' })],
    });

    return c.json({
      success: true,
      message: {
        id: messageId,
        content: emailRes.renderedBody || customText,
        providerMessageId: emailRes.providerMsgId,
        deliveryStatus: "sent",
        channel: "email",
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("handleSendContactEmail error:", err);
    return c.json({ error: "Failed to dispatch email", details: err.message }, 500);
  }
}

/**
 * POST /api/contacts/:id/messages
 * Unified endpoint to dispatch a message (text, template, or email) to an existing contact.
 */
export async function handleSendMessage(c) {
  const body = await c.req.json().catch(() => ({}));
  const channel = (body.channel || "whatsapp").toLowerCase();

  if (channel === "email") {
    return handleSendContactEmail(c, body);
  }

  if (channel === "both") {
    const waRes = (body.template_id || body.templateId)
      ? await handleSendContactTemplate(c, body)
      : await handleSendContactText(c, body);

    await handleSendContactEmail(c, body).catch((err) => {
      console.warn("handleSendMessage dual dispatch email error:", err);
    });

    return waRes;
  }

  if (body.template_id || body.templateId) {
    return handleSendContactTemplate(c, body);
  }

  return handleSendContactText(c, body);
}
