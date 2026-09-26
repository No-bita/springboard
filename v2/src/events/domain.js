/**
 * Durable Collectr Domain Event Processor
 * Springboard V2
 * 
 * Invariant: Gmail ingestion emits domain events; core Collectr engine owns state transitions.
 * Event handling is idempotent and crash-resilient.
 */

/**
 * Emits and processes a domain event (e.g. EMAIL_RECEIVED) against the Collectr core state engine.
 * 
 * @param {object} db D1 database client
 * @param {object} event
 * @param {string} event.type Event type ('EMAIL_RECEIVED', 'EMAIL_SENT')
 * @param {string} event.userId Tenant user ID
 * @param {string} event.contactId Contact ID
 * @param {string|null} event.requestId Associated request ID (if deterministically matched)
 * @param {string} event.messageId Message ID in messages table
 * @param {string} event.timestamp Canonical ISO timestamp
 * @param {string} [event.snippet] Short snippet for lean activity
 * @param {string} [event.subject] Email subject line
 * @param {string} [event.direction] 'inbound' | 'outbound'
 */
export async function emitCollectrDomainEvent(db, event) {
  const {
    userId,
    contactId,
    requestId,
    messageId,
    timestamp,
    snippet = "",
    subject = "(No Subject)",
    direction = "inbound",
  } = event;

  if (!userId || !contactId) return;

  const eventKey = `msg_${messageId}_${direction}`;

  // 1. Idempotency Check: Verify if event has already been recorded in activities
  const searchPattern = `"message_id":"${messageId}"`;
  const existingAct = await db.execute({
    sql: `SELECT id FROM activities WHERE user_id = ? AND contact_id = ? AND instr(metadata, ?) > 0 LIMIT 1`,
    args: [userId, contactId, searchPattern],
  });

  if (existingAct.rows && existingAct.rows.length > 0) {
    return { duplicate: true, activityId: existingAct.rows[0].id };
  }

  // 2. Insert Lean Activity
  const actId = "act_" + crypto.randomUUID();
  const actType = direction === "outbound" ? "email_sent" : "email_received";
  const actTitle = direction === "outbound" ? "Gmail Sent" : "Gmail Received";
  const shortSnippet = snippet ? snippet.slice(0, 140) : "";
  const actDesc = subject + (shortSnippet ? " — " + shortSnippet : "");

  await db.execute({
    sql: `INSERT INTO activities (
      id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      actId,
      userId,
      contactId,
      requestId || null,
      actType,
      actTitle,
      actDesc,
      JSON.stringify({ message_id: messageId, subject, provider: "gmail", event_key: eventKey }),
      timestamp || new Date().toISOString(),
    ],
  });

  // 3. Update Contact Timestamps & Trigger Attention Triage
  if (direction === "inbound") {
    await db.execute({
      sql: `UPDATE contacts 
            SET last_inbound_at = MAX(COALESCE(last_inbound_at, ''), ?),
                last_interaction_at = MAX(COALESCE(last_interaction_at, ''), ?),
                last_updated = datetime('now')
            WHERE id = ?`,
      args: [timestamp, timestamp, contactId],
    });

    // 4. If matched or active request exists, advance request state & cancel pending follow-up
    let targetRequestId = requestId;
    if (!targetRequestId) {
      const activeReq = await db.execute({
        sql: `SELECT id FROM requests WHERE user_id = ? AND contact_id = ? AND status IN ('waiting_on_them', 'needs_follow_up', 'open') ORDER BY updated_at DESC LIMIT 1`,
        args: [userId, contactId],
      });
      if (activeReq.rows && activeReq.rows.length > 0) {
        targetRequestId = activeReq.rows[0].id;
      }
    }

    if (targetRequestId) {
      const { handleInboundRequestReply } = await import("../api/requests.js");
      await handleInboundRequestReply(db, targetRequestId, userId, contactId);
    }
  } else {
    // Outbound email
    await db.execute({
      sql: `UPDATE contacts 
            SET last_outbound_at = MAX(COALESCE(last_outbound_at, ''), ?),
                last_interaction_at = MAX(COALESCE(last_interaction_at, ''), ?),
                last_updated = datetime('now')
            WHERE id = ?`,
      args: [timestamp, timestamp, contactId],
    });
  }

  return { success: true, activityId: actId };
}
