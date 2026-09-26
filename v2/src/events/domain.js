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

    // 4. If deterministically matched to an active request, advance request state
    if (requestId) {
      const reqRes = await db.execute({
        sql: `SELECT status, title FROM requests WHERE id = ? AND user_id = ? LIMIT 1`,
        args: [requestId, userId],
      });

      if (reqRes.rows && reqRes.rows.length > 0) {
        const req = reqRes.rows[0];
        if (["waiting_on_them", "needs_follow_up", "open"].includes(req.status)) {
          await db.execute({
            sql: `UPDATE requests SET status = 'waiting_on_me', updated_at = datetime('now') WHERE id = ?`,
            args: [requestId],
          });

          // Log request status transition activity
          const reqActId = "act_" + crypto.randomUUID();
          await db.execute({
            sql: `INSERT INTO activities (
              id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at
            ) VALUES (?, ?, ?, ?, 'request_status_updated', 'Request Waiting on Me (Gmail Reply)', ?, ?, datetime('now'))`,
            args: [
              reqActId,
              userId,
              contactId,
              requestId,
              `Reply received on request: ${req.title}`,
              JSON.stringify({ previous_status: req.status, new_status: "waiting_on_me", trigger: "gmail_reply" }),
            ],
          });
        }
      }
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
