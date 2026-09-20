/**
 * WhatsApp 24-Hour Customer Service Window Logic
 * Collectrr v2 - WhatsApp Messaging Module
 *
 * Enforces Meta's 24-hour policy for free-form business messaging
 * based on the customer's most recent inbound WhatsApp message.
 */

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Pure timestamp calculation or message list evaluation to test if within the 24h window.
 * Accepts:
 *  - timestamp (number or ISO string)
 *  - array of message objects (finds latest inbound message)
 *  - contact/conversation object with last_inbound_at
 */
export function isWithin24HourServiceWindow(input, now = Date.now()) {
  if (!input) return false;

  let timestamp = null;

  if (Array.isArray(input)) {
    // Find most recent inbound message
    const inboundMsgs = input
      .filter(m => (m.direction === "inbound" || m.sender_type === "contact" || m.created_by === "client" || m.event_type === "whatsapp_reply") && (m.created_at || m.timestamp))
      .sort((a, b) => new Date(b.created_at || b.timestamp).getTime() - new Date(a.created_at || a.timestamp).getTime());

    if (inboundMsgs.length === 0) return false;
    timestamp = inboundMsgs[0].created_at || inboundMsgs[0].timestamp;
  } else if (typeof input === "object" && input !== null) {
    timestamp = input.last_inbound_at || input.created_at || input.timestamp;
  } else {
    timestamp = input;
  }

  if (!timestamp) return false;

  const replyTime = typeof timestamp === "number"
    ? timestamp
    : new Date(String(timestamp).includes("T") ? timestamp : String(timestamp).replace(" ", "T") + "Z").getTime();

  if (isNaN(replyTime)) {
    const fallbackTime = new Date(timestamp).getTime();
    if (isNaN(fallbackTime)) return false;
    return (now - fallbackTime) < TWENTY_FOUR_HOURS_MS && (now - fallbackTime) >= 0;
  }

  return (now - replyTime) < TWENTY_FOUR_HOURS_MS && (now - replyTime) >= 0;
}

/**
 * Evaluate the customer service window for a contact or conversation from its history.
 */
export async function getCustomerReplyWindowStatus(db, contactId) {
  const replyRes = await db.execute({
    sql: `SELECT created_at FROM messages 
          WHERE contact_id = ? AND direction = 'inbound' AND channel = 'whatsapp'
          ORDER BY created_at DESC LIMIT 1`,
    args: [contactId],
  });

  if (!replyRes || !replyRes.rows || replyRes.rows.length === 0) {
    return {
      hasReplied: false,
      isOpen: false,
      lastReplyAt: null,
      expiresAt: null,
      reason: "No customer reply has been received. Free-form messaging requires an inbound customer message.",
    };
  }

  const lastReplyStr = replyRes.rows[0].created_at;
  let lastReplyTime = new Date(
    lastReplyStr.includes("T") ? lastReplyStr : lastReplyStr.replace(" ", "T") + "Z"
  ).getTime();
  if (isNaN(lastReplyTime)) {
    lastReplyTime = new Date(lastReplyStr).getTime();
  }

  const now = Date.now();
  const expiresTime = lastReplyTime + TWENTY_FOUR_HOURS_MS;
  const isOpen = isWithin24HourServiceWindow(lastReplyTime, now);

  return {
    hasReplied: true,
    isOpen,
    lastReplyAt: new Date(lastReplyTime).toISOString(),
    expiresAt: new Date(expiresTime).toISOString(),
    reason: isOpen
      ? "24-hour customer service window is active."
      : "The 24-hour customer service window has expired. Waiting for customer to reply before sending new free-form messages.",
  };
}
