/**
 * Unmatched Inbound Emails Review & Linking Handlers
 * Springboard V2 — Gmail Integration
 * 
 * Invariants:
 * 1. Unmatched emails are preserved with lightweight metadata in gmail_unmatched_messages.
 * 2. Linking an unmatched email refetches the full message via messages.get(format=full).
 * 3. Deterministic request correlation is re-run with the newly resolved contact context.
 */

import { getDbClient } from "../../db/client.js";
import { getEphemeralAccessToken } from "../../gmail/auth.js";
import { gmailGetMessage } from "../../gmail/client.js";
import { parseGmailHeaders } from "../../gmail/matcher.js";
import { classifyRequestAttribution } from "../../gmail/replies.js";
import { emitCollectrDomainEvent } from "../../events/domain.js";
import { normalizeIndianPhoneNumber } from "../../whatsapp/client.js";

/**
 * GET /api/integrations/google/unmatched
 * Lists all unresolved unmatched emails for the authenticated user.
 */
export async function handleGetUnmatchedEmails(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;

  const res = await db.execute({
    sql: `SELECT id, google_connection_id, gmail_message_id, gmail_thread_id,
                 from_email, from_name, to_emails, subject, snippet, received_at, status
          FROM gmail_unmatched_messages
          WHERE user_id = ? AND status = 'unresolved'
          ORDER BY received_at DESC LIMIT 100`,
    args: [userId],
  });

  return c.json({
    success: true,
    unmatched: res.rows || [],
    count: res.rows?.length || 0,
  });
}

/**
 * POST /api/integrations/google/unmatched/:id/link
 * Links an unmatched email to an existing contact, refetches full body, re-evaluates requests, and logs activity.
 */
export async function handleLinkUnmatchedEmail(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const unmatchedId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const contactId = body.contactId || body.contact_id;

  if (!contactId) {
    return c.json({ error: "contactId is required to link message." }, 400);
  }

  // 1. Fetch unmatched record
  const unmRes = await db.execute({
    sql: "SELECT * FROM gmail_unmatched_messages WHERE id = ? AND user_id = ? LIMIT 1",
    args: [unmatchedId, userId],
  });

  if (!unmRes.rows || unmRes.rows.length === 0) {
    return c.json({ error: "Unmatched email record not found." }, 404);
  }
  const unmatched = unmRes.rows[0];

  // 2. Fetch Contact
  const contactRes = await db.execute({
    sql: "SELECT id, name, email, phone_number FROM contacts WHERE id = ? AND user_id = ? LIMIT 1",
    args: [contactId, userId],
  });

  if (!contactRes.rows || contactRes.rows.length === 0) {
    return c.json({ error: "Target contact not found." }, 404);
  }
  const contact = contactRes.rows[0];

  // 3. Refetch Full Message Content from Gmail API
  const { accessToken } = await getEphemeralAccessToken(db, unmatched.google_connection_id, c.env);
  const fullGmailMsg = await gmailGetMessage(accessToken, unmatched.gmail_message_id, "full", c.env);
  const parsed = parseGmailHeaders(fullGmailMsg);

  // 4. Ensure Conversation for Channel = 'email'
  let convRes = await db.execute({
    sql: "SELECT id FROM conversations WHERE user_id = ? AND contact_id = ? AND channel = 'email' LIMIT 1",
    args: [userId, contactId],
  });

  let conversationId;
  if (convRes.rows && convRes.rows.length > 0) {
    conversationId = convRes.rows[0].id;
  } else {
    conversationId = "conv_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO conversations (id, user_id, contact_id, channel, last_message_at, unread_count, created_at)
            VALUES (?, ?, ?, 'email', ?, 0, datetime('now'))`,
      args: [conversationId, userId, contactId, parsed.canonicalDateIso],
    });
  }

  // 5. Re-run Conservative Request Correlation
  const attrResult = await classifyRequestAttribution(db, {
    userId,
    contactId,
    gmailThreadId: parsed.gmailThreadId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
  });
  const requestId = attrResult.matched ? attrResult.requestId : null;

  // 6. Ingest into messages table
  const messageId = "msg_" + crypto.randomUUID();
  await db.execute({
    sql: `INSERT OR IGNORE INTO messages (
      id, conversation_id, contact_id, user_id, request_id,
      direction, channel, sender_type, content, subject, thread_id,
      provider, provider_message_id, delivery_status, google_connection_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'inbound', 'email', 'contact', ?, ?, ?, 'gmail', ?, NULL, ?, ?)`,
    args: [
      messageId,
      conversationId,
      contactId,
      userId,
      requestId,
      parsed.content || parsed.snippet,
      parsed.subject,
      parsed.gmailThreadId,
      parsed.gmailMessageId,
      unmatched.google_connection_id,
      parsed.canonicalDateIso,
    ],
  });

  // 7. Update Contact Email if empty
  if (!contact.email) {
    await db.execute({
      sql: "UPDATE contacts SET email = ?, last_updated = datetime('now') WHERE id = ?",
      args: [unmatched.from_email, contactId],
    });
  }

  // 8. Emit Collectr Domain Event
  await emitCollectrDomainEvent(db, {
    type: "EMAIL_RECEIVED",
    userId,
    contactId,
    requestId,
    messageId,
    timestamp: parsed.canonicalDateIso,
    snippet: parsed.snippet,
    subject: parsed.subject,
    direction: "inbound",
  });

  // 9. Update Unmatched Record Status
  await db.execute({
    sql: "UPDATE gmail_unmatched_messages SET status = 'linked', linked_contact_id = ? WHERE id = ?",
    args: [contactId, unmatchedId],
  });

  return c.json({
    success: true,
    message: "Email linked successfully.",
    messageId,
    contactId,
    requestId,
  });
}

/**
 * POST /api/integrations/google/unmatched/:id/create-contact
 * Provisions a new contact from the unmatched email, inserts message, and links record.
 */
export async function handleCreateContactFromUnmatched(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const unmatchedId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const rawName = String(body.name || body.contactPerson || "").trim();
  const rawPhone = String(body.phoneNumber || body.phone_number || "").trim();
  const company = body.company ? String(body.company).trim() : null;

  if (!rawName) {
    return c.json({ error: "Contact name is required." }, 400);
  }
  if (!rawPhone) {
    return c.json({ error: "Contact phone number is required." }, 400);
  }

  let canonicalPhone;
  try {
    canonicalPhone = normalizeIndianPhoneNumber(rawPhone);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }

  // 1. Fetch unmatched record
  const unmRes = await db.execute({
    sql: "SELECT * FROM gmail_unmatched_messages WHERE id = ? AND user_id = ? LIMIT 1",
    args: [unmatchedId, userId],
  });

  if (!unmRes.rows || unmRes.rows.length === 0) {
    return c.json({ error: "Unmatched email record not found." }, 404);
  }
  const unmatched = unmRes.rows[0];

  // 2. Check phone uniqueness
  const existing = await db.execute({
    sql: "SELECT id FROM contacts WHERE user_id = ? AND phone_number = ? LIMIT 1",
    args: [userId, canonicalPhone],
  });

  let contactId;
  if (existing.rows && existing.rows.length > 0) {
    contactId = existing.rows[0].id;
  } else {
    // 3. Create Contact
    contactId = "cnt_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO contacts (id, user_id, name, contact_person, phone_number, email, company, created_at, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      args: [contactId, userId, rawName, rawName, canonicalPhone, unmatched.from_email, company],
    });

    // 4. Create Initial Conversations (WhatsApp + Email)
    await db.execute({
      sql: `INSERT INTO conversations (id, user_id, contact_id, channel, last_message_at, unread_count, created_at)
            VALUES (?, ?, ?, 'whatsapp', NULL, 0, datetime('now'))`,
      args: ["conv_" + crypto.randomUUID(), userId, contactId],
    });
  }

  // 5. Link Email to the created/found contact
  return await handleLinkUnmatchedEmail({
    ...c,
    req: {
      ...c.req,
      param: (k) => (k === "id" ? unmatchedId : null),
      json: async () => ({ contactId }),
    },
  });
}

/**
 * POST /api/integrations/google/unmatched/:id/ignore
 * Marks an unmatched email as ignored.
 */
export async function handleIgnoreUnmatchedEmail(c) {
  const db = getDbClient(c.env);
  const user = c.get("user");
  const userId = user?.id || user?.user_id || user?.sub;
  const unmatchedId = c.req.param("id");

  await db.execute({
    sql: "UPDATE gmail_unmatched_messages SET status = 'ignored' WHERE id = ? AND user_id = ?",
    args: [unmatchedId, userId],
  });

  return c.json({ success: true, message: "Email ignored." });
}
