/**
 * Email Outreach Pipeline
 * Collectrr v2 - Email Messaging Module
 * Authoritative single dispatch pipeline for outbound email executions with atomic locks,
 * stable idempotency, credit settlement, and timeline persistence.
 */

import { clientSendEmail } from "./client.js";
import { renderEmailContent } from "./templates.js";
import { MESSAGE_COST_PAISE } from "../api/credits.js";

export async function executeEmailMessagingPipeline(
  db,
  user,
  email,
  templateName,
  contactPerson,
  token,
  env,
  referenceId,
  templateParams = [],
  contactId = null,
  caseId = null
) {
  const idempotencyKey = `idemp_${user?.id || "sys"}_${referenceId}`;

  // Helper to handle already existing email_messages row
  const handleExistingMessage = async (existingMsg) => {
    if (existingMsg.status === "SENT" || existingMsg.provider_message_id) {
      return {
        success: true,
        delivered: true,
        idempotent: true,
        providerMsgId: existingMsg.provider_message_id || null
      };
    }
    if (existingMsg.status === "SENDING") {
      const ageSeconds = (existingMsg.age_seconds !== undefined && existingMsg.age_seconds !== null)
        ? Number(existingMsg.age_seconds)
        : 0;
      if (ageSeconds < 600) {
        return {
          success: false,
          error: "EMAIL_IN_FLIGHT",
          message: "Email dispatch actively in-flight by concurrent consumer.",
          inFlight: true,
          ambiguous: false
        };
      }
      await db.execute({
        sql: "UPDATE email_messages SET status = 'UNKNOWN' WHERE user_id = ? AND idempotency_key = ?",
        args: [user?.id || "sys", idempotencyKey]
      }).catch(() => {});
      return {
        success: false,
        error: "EMAIL_AMBIGUOUS_SENDING",
        message: "Email dispatch was interrupted. Flagged unknown to prevent duplicate sends.",
        inFlight: false,
        ambiguous: true
      };
    }
    return {
      success: false,
      error: "EMAIL_ALREADY_EXISTS",
      message: `Email message already exists in state ${existingMsg.status}.`,
      inFlight: false,
      ambiguous: true
    };
  };

  // 1. Fast read check: if message already exists, handle immediately without doing work
  const msgCheck = await db.execute({
    sql: `SELECT status, provider_message_id, created_at,
          (strftime('%s', 'now') - strftime('%s', created_at)) as age_seconds
          FROM email_messages
          WHERE user_id = ? AND idempotency_key = ?`,
    args: [user?.id || "sys", idempotencyKey]
  });
  if (msgCheck.rows && msgCheck.rows.length > 0) {
    return await handleExistingMessage(msgCheck.rows[0]);
  }

  // 2. Pre-execution credit check
  const isDevEnv = (env?.ENVIRONMENT === "development");
  let currentBalance = 900;

  if (isDevEnv) {
    const userRes = await db.execute({
      sql: "SELECT credit_balance FROM users WHERE id = ?",
      args: [user?.id || "sys"]
    });
    currentBalance = (userRes.rows[0]?.credit_balance !== undefined && userRes.rows[0]?.credit_balance !== null)
      ? Number(userRes.rows[0].credit_balance)
      : 900;

    if (currentBalance < MESSAGE_COST_PAISE) {
      const balanceRupees = (currentBalance / 100).toFixed(2);
      return {
        success: false,
        insufficientCredits: true,
        error: "INSUFFICIENT_CREDITS",
        message: `Your credit balance (₹${balanceRupees}) is exhausted. Minimum ₹0.90 required to send email outreach.`,
        balancePaise: currentBalance,
        balanceRupees
      };
    }
  }

  // 3. ATOMIC LOCK ACQUISITION
  const msgId = "msg_em_" + crypto.randomUUID();
  let isAcquired = false;
  try {
    const insertRes = await db.execute({
      sql: `INSERT INTO email_messages (id, user_id, idempotency_key, recipient_email, status)
            VALUES (?, ?, ?, ?, 'SENDING')
            ON CONFLICT(user_id, idempotency_key) DO NOTHING
            RETURNING id`,
      args: [msgId, user?.id || "sys", idempotencyKey, email]
    });
    isAcquired = Boolean(
      (insertRes?.rows && insertRes.rows.length === 1) ||
      (insertRes?.changes === 1) ||
      (insertRes?.meta?.changes === 1)
    );
  } catch (insertErr) {
    console.error("Atomic email_messages lock error:", insertErr);
    isAcquired = false;
  }

  if (!isAcquired) {
    const raceCheck = await db.execute({
      sql: `SELECT status, provider_message_id, created_at,
            (strftime('%s', 'now') - strftime('%s', created_at)) as age_seconds
            FROM email_messages
            WHERE user_id = ? AND idempotency_key = ?`,
      args: [user?.id || "sys", idempotencyKey]
    });
    if (raceCheck.rows && raceCheck.rows.length > 0) {
      return await handleExistingMessage(raceCheck.rows[0]);
    }
    return {
      success: false,
      error: "EMAIL_LOCK_FAILED",
      message: "Failed to acquire exclusive dispatch lock. Suppressed duplicate email call.",
      inFlight: true,
      ambiguous: false
    };
  }

  const resId = "res_" + crypto.randomUUID();
  if (isDevEnv) {
    await db.execute({
      sql: "INSERT INTO credit_reservations (id, user_id, amount_paise, reference_id, status) VALUES (?, ?, ?, ?, 'PENDING')",
      args: [resId, user?.id || "sys", MESSAGE_COST_PAISE, referenceId]
    }).catch(e => console.error("Failed writing reservation:", e));
  }

  const rawToken = token || "verify";
  const baseUrl = `${env.FRONTEND_URL || "https://collectrr-v2.collectr.workers.dev"}/upload.html?t=`;
  const uploadLink = `${baseUrl}${rawToken}`;

  let customTpls = [];
  try {
    const customRes = await db.execute("SELECT * FROM message_templates");
    if (customRes && customRes.rows) customTpls = customRes.rows;
  } catch (_) {}

  // 4. Render Email Content
  const { subject, html, text, renderedBody } = renderEmailContent({
    templateName,
    templateParams,
    contactPerson,
    userName: user?.username || "Collectrr",
    userPhone: user?.phone || "",
    rawToken,
    uploadLink,
    customTemplates: customTpls
  });

  // 5. Dispatch via Resend
  try {
    const sendRes = await clientSendEmail({
      to: email,
      subject,
      html,
      text,
      idempotencyKey,
      env
    });

    const providerMsgId = sendRes.id || null;

    let newBalance = currentBalance;
    if (isDevEnv) {
      newBalance = Math.max(0, currentBalance - MESSAGE_COST_PAISE);
      await db.execute({
        sql: "UPDATE users SET credit_balance = ? WHERE id = ?",
        args: [newBalance, user?.id || "sys"]
      });

      await db.execute({
        sql: "UPDATE credit_reservations SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
        args: [resId]
      }).catch(e => console.error("Failed updating reservation success:", e));

      const txId = "tx_ded_" + crypto.randomUUID();
      await db.execute({
        sql: "INSERT OR IGNORE INTO credit_transactions (id, user_id, amount_paise, balance_after_paise, transaction_type, reference_type, reference_id, description) VALUES (?, ?, ?, ?, 'email_deduction', 'email_message', ?, 'Outbound Email Request (-₹0.90)')",
        args: [txId, user?.id || "sys", -MESSAGE_COST_PAISE, newBalance, referenceId]
      }).catch(e => console.error("Failed writing deduction ledger:", e));
    }

    await db.execute({
      sql: "UPDATE email_messages SET status = 'SENT', provider_message_id = ? WHERE id = ?",
      args: [providerMsgId, msgId]
    }).catch(e => console.error("Failed updating email message success:", e));

    const timelineId = crypto.randomUUID();
    const metadata = {
      channel: "email",
      message_type: "template",
      template_name: templateName,
      recipient_email: email,
      subject,
      provider_message_id: providerMsgId,
      email_status: "sent"
    };

    // Persist message into conversations, messages, and activities
    if (contactId && user?.id) {
      try {
        const convRes = await db.execute({
          sql: "SELECT id FROM conversations WHERE user_id = ? AND contact_id = ? AND channel = 'email' LIMIT 1",
          args: [user.id, contactId]
        });

        let convId = convRes?.rows?.[0]?.id;
        if (!convId) {
          convId = "conv_em_" + crypto.randomUUID();
          await db.execute({
            sql: "INSERT INTO conversations (id, user_id, contact_id, channel, last_message_at, created_at) VALUES (?, ?, ?, 'email', datetime('now'), datetime('now'))",
            args: [convId, user.id, contactId]
          });
        }

        const msgRowId = "msg_em_" + crypto.randomUUID();
        await db.execute({
          sql: `INSERT INTO messages (id, conversation_id, contact_id, user_id, direction, channel, sender_type, content, template_id, provider, provider_message_id, delivery_status, created_at)
                VALUES (?, ?, ?, ?, 'outbound', 'email', 'user', ?, ?, 'resend', ?, 'sent', datetime('now'))`,
          args: [msgRowId, convId, contactId, user.id, renderedBody, templateName, providerMsgId]
        });

        const actId = "act_" + crypto.randomUUID();
        await db.execute({
          sql: `INSERT INTO activities (id, user_id, contact_id, activity_type, title, description, metadata, created_at)
                VALUES (?, ?, ?, 'outreach_sent', 'Email Outreach Dispatched', ?, ?, datetime('now'))`,
          args: [actId, user.id, contactId, renderedBody, JSON.stringify(metadata)]
        });
      } catch (_) {}
    }

    // Legacy case_timeline fallback
    await db.execute({
      sql: `INSERT INTO case_timeline (id, contact_id, case_id, provider_message_id, template_name, event_type, content, metadata, created_by)
            VALUES (?, ?, ?, ?, ?, 'email_sent', ?, ?, 'system')`,
      args: [timelineId, contactId, caseId, providerMsgId, templateName, renderedBody, JSON.stringify(metadata)]
    }).catch(() => {});

    return {
      success: true,
      delivered: true,
      newBalancePaise: newBalance,
      providerMsgId,
      renderedBody,
      subject
    };
  } catch (emailErr) {
    const errMsg = String(emailErr?.message || emailErr).toLowerCase();
    const isTimeout = errMsg.includes("timeout") || errMsg.includes("econnreset") || errMsg.includes("504") || errMsg.includes("502");

    if (isTimeout) {
      await db.execute({
        sql: "UPDATE credit_reservations SET status = 'UNKNOWN' WHERE id = ?",
        args: [resId]
      }).catch(e => console.error(e));
      await db.execute({
        sql: "UPDATE email_messages SET status = 'UNKNOWN' WHERE id = ?",
        args: [msgId]
      }).catch(e => console.error(e));
      return { success: false, error: "EMAIL_TIMEOUT", message: "Email gateway status unknown due to provider timeout." };
    } else {
      if (isDevEnv) {
        await db.execute({
          sql: "UPDATE credit_reservations SET status = 'REFUNDED', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [resId]
        }).catch(e => console.error(e));
      }
      await db.execute({
        sql: "UPDATE email_messages SET status = 'FAILED' WHERE id = ?",
        args: [msgId]
      }).catch(e => console.error(e));

      // Also record timeline failure event
      const timelineId = crypto.randomUUID();
      const metadata = {
        channel: "email",
        template_name: templateName,
        recipient_email: email,
        email_status: "failed",
        error: emailErr?.message || "Delivery failed"
      };
      await db.execute({
        sql: `INSERT INTO case_timeline (id, contact_id, case_id, template_name, event_type, content, metadata, created_by)
              VALUES (?, ?, ?, ?, 'email_failed', ?, ?, 'system')`,
        args: [timelineId, contactId, caseId, templateName, `Email delivery failed: ${emailErr?.message || "Unknown error"}`, JSON.stringify(metadata)]
      }).catch(() => {});

      return { success: false, error: "EMAIL_FAILED", message: emailErr?.message || "Email message delivery failed" };
    }
  }
}
