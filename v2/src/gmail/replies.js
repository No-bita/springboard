/**
 * Conservative Request Attribution Engine (V1 Deterministic Only)
 * Springboard V2 — Gmail Integration
 * 
 * Invariant: Zero False Positives.
 * Emails attach to a request ONLY if there is an explicit, deterministic thread
 * or RFC In-Reply-To / References linkage.
 * Ambiguous emails attach strictly at the Contact level (request_id = null).
 */

/**
 * Evaluates whether an incoming email deterministically corresponds to an open request.
 * 
 * @param {object} db D1 database client
 * @param {object} params
 * @param {string} params.userId Tenant ID
 * @param {string} params.contactId Matched Contact ID
 * @param {string} params.gmailThreadId Gmail thread ID
 * @param {string} [params.inReplyTo] RFC In-Reply-To header
 * @param {string} [params.references] RFC References header
 * @returns {Promise<{ matched: boolean, requestId: string|null, reason: string }>}
 */
export async function classifyRequestAttribution(db, {
  userId,
  contactId,
  gmailThreadId,
  inReplyTo = "",
  references = "",
}) {
  if (!contactId || !userId) {
    return { matched: false, requestId: null, reason: "no_contact_context" };
  }

  // Tier 1: Deterministic Thread Match
  if (gmailThreadId) {
    const threadMatch = await db.execute({
      sql: `SELECT m.request_id 
            FROM messages m
            JOIN requests r ON r.id = m.request_id
            WHERE m.user_id = ? 
              AND m.contact_id = ? 
              AND m.thread_id = ? 
              AND m.request_id IS NOT NULL
              AND r.status NOT IN ('completed', 'cancelled')
            ORDER BY m.created_at DESC LIMIT 1`,
      args: [userId, contactId, gmailThreadId],
    });

    if (threadMatch.rows && threadMatch.rows.length > 0) {
      return {
        matched: true,
        requestId: threadMatch.rows[0].request_id,
        reason: "thread_match",
      };
    }
  }

  // Tier 2: Deterministic RFC Header Reference Match (In-Reply-To / References)
  const headerIds = [inReplyTo, references]
    .filter(Boolean)
    .join(" ")
    .match(/<([^>]+)>/g)
    ?.map((s) => s.replace(/[<>]/g, "").trim()) || [];

  if (headerIds.length > 0) {
    const placeholders = headerIds.map(() => "?").join(", ");
    const headerMatch = await db.execute({
      sql: `SELECT m.request_id 
            FROM messages m
            JOIN requests r ON r.id = m.request_id
            WHERE m.user_id = ? 
              AND m.contact_id = ? 
              AND m.request_id IS NOT NULL
              AND r.status NOT IN ('completed', 'cancelled')
              AND m.provider_message_id IN (${placeholders})
            ORDER BY m.created_at DESC LIMIT 1`,
      args: [userId, contactId, ...headerIds],
    });

    if (headerMatch.rows && headerMatch.rows.length > 0) {
      return {
        matched: true,
        requestId: headerMatch.rows[0].request_id,
        reason: "rfc_header_match",
      };
    }
  }

  // Ambiguous / General Email: attach to Contact only. DO NOT guess or auto-assign.
  return {
    matched: false,
    requestId: null,
    reason: "ambiguous_contact_level",
  };
}
