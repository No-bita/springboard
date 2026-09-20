import { getDbClient } from "../db/client.js";
import { normalizeIndianPhoneNumber } from "../whatsapp/client.js";
import { verifyWebhookSubscription, parseWebhookPayload } from "../whatsapp/webhook.js";

export async function handleWebhookVerify(c) {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  const verification = verifyWebhookSubscription(mode, token, challenge, c.env.WHATSAPP_VERIFY_TOKEN);
  if (verification.verified) {
    return c.text(verification.challenge);
  }
  return c.text("Forbidden", 403);
}

export async function handleWebhookEvent(c) {
  const body = await c.req.json().catch(() => ({}));

  console.log("WHATSAPP WEBHOOK RECEIVED:", JSON.stringify(body));

  const env = c.env;
  const db = getDbClient(env);

  try {
    const { statuses, messages } = parseWebhookPayload(body);

    // 1. Handle Status Updates (sent, delivered, read, failed)
    for (const statusObj of statuses) {
      const status = String(statusObj.status || "").toLowerCase(); // 'sent', 'delivered', 'read', 'failed'
      const providerMsgId = statusObj.providerMsgId;
      const errorMsg = statusObj.errorMsg;

      if (!providerMsgId) continue;

      // Update whatsapp_messages transport table
      await db.execute({
        sql: "UPDATE whatsapp_messages SET status = ? WHERE provider_message_id = ?",
        args: [status.toUpperCase(), providerMsgId]
      }).catch(() => {});

      // Update product-level messages table
      await db.execute({
        sql: "UPDATE messages SET delivery_status = ? WHERE provider = 'meta_whatsapp' AND provider_message_id = ?",
        args: [status, providerMsgId]
      }).catch(() => {});

      // Update campaign_recipients if message originated from a campaign
      if (status === "delivered" || status === "read" || status === "sent") {
        await db.execute({
          sql: `UPDATE campaign_recipients 
                SET delivery_status = ?,
                    delivered_at = CASE WHEN ? = 'delivered' AND delivered_at IS NULL THEN datetime('now') ELSE delivered_at END,
                    read_at = CASE WHEN ? = 'read' AND read_at IS NULL THEN datetime('now') ELSE read_at END
                WHERE provider_message_id = ?`,
          args: [status, status, status, providerMsgId]
        }).catch(() => {});
      } else if (status === "failed") {
        await db.execute({
          sql: `UPDATE campaign_recipients 
                SET delivery_status = 'failed',
                    error_code = 'DELIVERY_FAILED',
                    error_message = ?,
                    updated_at = datetime('now')
                WHERE provider_message_id = ?`,
          args: [errorMsg || "Delivery failed", providerMsgId]
        }).catch(() => {});
      }

      // Credit Reconciliation & Refunds on failure
      const msgRes = await db.execute({
        sql: "SELECT id, user_id, idempotency_key, status FROM whatsapp_messages WHERE provider_message_id = ? LIMIT 1",
        args: [providerMsgId]
      });

      const waMsg = msgRes.rows[0] || null;
      const userId = waMsg?.user_id || null;

      if (userId && waMsg) {
        const MESSAGE_COST_PAISE = 90;

        if (status === "delivered" || status === "read" || status === "sent") {
          // Capture / finalize reservation to COMPLETED
          await db.execute({
            sql: "UPDATE credit_reservations SET status = 'CAPTURED', completed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND reference_id = ? AND status = 'PENDING'",
            args: [userId, waMsg.idempotency_key]
          }).catch(() => {});
        } else if (status === "failed") {
          // Release reservation on failure & refund balance
          const resCheck = await db.execute({
            sql: "SELECT id, status FROM credit_reservations WHERE user_id = ? AND reference_id = ? AND status = 'PENDING' LIMIT 1",
            args: [userId, waMsg.idempotency_key]
          });

          if (resCheck.rows.length > 0) {
            await db.execute({
              sql: "UPDATE credit_reservations SET status = 'RELEASED', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
              args: [resCheck.rows[0].id]
            }).catch(() => {});

            // Refund user balance
            await db.execute({
              sql: "UPDATE users SET credit_balance = credit_balance + ? WHERE id = ?",
              args: [MESSAGE_COST_PAISE, userId]
            }).catch(() => {});

            // Log refund ledger entry
            const txId = "tx_ref_" + crypto.randomUUID();
            await db.execute({
              sql: `INSERT OR IGNORE INTO credit_transactions (id, user_id, amount_paise, balance_after_paise, transaction_type, reference_type, reference_id, description)
                    SELECT ?, ?, ?, credit_balance, 'whatsapp_refund', 'whatsapp_message', ?, 'WhatsApp Delivery Failure Refund (+₹0.90)'
                    FROM users WHERE id = ?`,
              args: [txId, userId, MESSAGE_COST_PAISE, providerMsgId, userId]
            }).catch(() => {});
          }
        }
      }
    }

    // 2. Handle Inbound Customer Messages (Strict Inbound Tenant Resolution)
    for (const msg of messages) {
      const phoneNumberId = msg.phoneNumberId;
      const clientText = msg.text;
      const providerMsgId = msg.messageId;

      if (!clientText) continue;

      let canonicalPhone;
      try {
        canonicalPhone = normalizeIndianPhoneNumber(msg.fromPhone || msg.fullPhone);
      } catch (_) {
        console.warn("Invalid inbound phone format, skipping:", msg.fromPhone);
        continue;
      }

      // Resolve Tenant (user_id) strictly via Meta Business Phone ID
      let userId = null;

      if (phoneNumberId) {
        const userRes = await db.execute({
          sql: "SELECT id FROM users WHERE wa_phone_number_id = ? LIMIT 1",
          args: [phoneNumberId]
        });
        if (userRes.rows.length > 0) {
          userId = userRes.rows[0].id;
        }
      }

      // Dev environment fallback if wa_phone_number_id is unset
      if (!userId) {
        if (env?.WHATSAPP_PHONE_ID && phoneNumberId === env.WHATSAPP_PHONE_ID) {
          const firstAdmin = await db.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
          if (firstAdmin.rows.length > 0) {
            userId = firstAdmin.rows[0].id;
          }
        }
      }

      if (!userId) {
        console.warn(`[SECURITY] Inbound webhook received for unmapped WhatsApp Phone Number ID: ${phoneNumberId}. Dropping safely.`);
        continue;
      }

      // Tenant-Scoped Contact Lookup
      const contactRes = await db.execute({
        sql: "SELECT id, name FROM contacts WHERE user_id = ? AND phone_number = ? LIMIT 1",
        args: [userId, canonicalPhone]
      });

      let contactId = null;
      let contactName = null;

      if (contactRes.rows.length > 0) {
        contactId = contactRes.rows[0].id;
        contactName = contactRes.rows[0].name;
      } else {
        // Auto-create Contact under this tenant
        contactId = "cnt_" + crypto.randomUUID();
        contactName = msg.profileName || `Contact ${canonicalPhone.slice(-4)}`;
        await db.execute({
          sql: "INSERT INTO contacts (id, user_id, name, phone_number, last_inbound_at, last_interaction_at, created_at, last_updated) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))",
          args: [contactId, userId, contactName, canonicalPhone]
        });
      }

      // Ensure Single Unified WhatsApp Conversation exists for Contact
      const convRes = await db.execute({
        sql: "SELECT id FROM conversations WHERE user_id = ? AND contact_id = ? AND channel = 'whatsapp' LIMIT 1",
        args: [userId, contactId]
      });

      let conversationId = null;
      if (convRes.rows.length > 0) {
        conversationId = convRes.rows[0].id;
        await db.execute({
          sql: "UPDATE conversations SET last_message_at = datetime('now'), unread_count = unread_count + 1 WHERE id = ?",
          args: [conversationId]
        });
      } else {
        conversationId = "conv_" + crypto.randomUUID();
        await db.execute({
          sql: "INSERT INTO conversations (id, user_id, contact_id, channel, last_message_at, unread_count, created_at) VALUES (?, ?, ?, 'whatsapp', datetime('now'), 1, datetime('now'))",
          args: [conversationId, userId, contactId]
        });
      }

      // Insert Inbound Message (Idempotent via provider_message_id)
      const messageId = "msg_" + crypto.randomUUID();
      await db.execute({
        sql: `INSERT OR IGNORE INTO messages (
          id, conversation_id, contact_id, user_id, request_id, direction, channel, sender_type, content, provider, provider_message_id, delivery_status, created_at
        ) VALUES (?, ?, ?, ?, NULL, 'inbound', 'whatsapp', 'contact', ?, 'meta_whatsapp', ?, NULL, datetime('now'))`,
        args: [messageId, conversationId, contactId, userId, clientText, providerMsgId]
      });

      // Attribute reply to most recent unreplied outbound campaign recipient
      const phone10 = canonicalPhone.startsWith("91") ? canonicalPhone.slice(2) : canonicalPhone;
      const campRecpRes = await db.execute({
        sql: `SELECT id, campaign_id FROM campaign_recipients 
              WHERE user_id = ? AND channel = 'whatsapp' AND (phone_snapshot = ? OR phone_snapshot = ?) AND response_status = 'no_reply' AND delivery_status IN ('sent', 'delivered', 'read')
              ORDER BY sent_at DESC LIMIT 1`,
        args: [userId, canonicalPhone, phone10]
      });

      if (campRecpRes?.rows?.length > 0) {
        const recp = campRecpRes.rows[0];
        await db.execute({
          sql: `UPDATE campaign_recipients 
                SET response_status = 'replied',
                    replied_at = datetime('now'),
                    updated_at = datetime('now')
                WHERE id = ?`,
          args: [recp.id]
        });
      }

      // Log Business Activity Event
      const activityId = "act_" + crypto.randomUUID();
      await db.execute({
        sql: `INSERT INTO activities (id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at)
              VALUES (?, ?, ?, NULL, 'contact_replied', 'WhatsApp Reply Received', ?, ?, datetime('now'))`,
        args: [
          activityId,
          userId,
          contactId,
          clientText,
          JSON.stringify({ channel: "whatsapp", from: canonicalPhone, provider_message_id: providerMsgId })
        ]
      });

      // Update Contact Timestamps
      await db.execute({
        sql: "UPDATE contacts SET last_inbound_at = datetime('now'), last_interaction_at = datetime('now'), last_updated = datetime('now') WHERE id = ?",
        args: [contactId]
      });
    }

    return c.text("EVENT_RECEIVED");
  } catch (err) {
    console.error("Webhook processing error:", err);
    return c.text("ERROR", 500);
  }
}
