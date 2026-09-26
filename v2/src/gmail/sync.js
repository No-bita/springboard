/**
 * Gmail Synchronization Engine
 * Springboard V2 — Gmail Integration
 * 
 * Orchestrates:
 * 1. Watch-before-backfill sequencing (eliminates backfill race window).
 * 2. Bounded cursor pagination via Cloudflare Queue.
 * 3. Atomic per-mailbox lease management.
 * 4. Incremental history delta ingestion.
 * 5. 404 History gap recovery.
 */

import { getEphemeralAccessToken } from "./auth.js";
import { acquireSyncLease, releaseSyncLease, extendSyncLease } from "./lease.js";
import { gmailWatch, gmailListMessages, gmailGetMessage, gmailListHistory } from "./client.js";
import { parseGmailHeaders, matchMessageToContacts } from "./matcher.js";
import { classifyRequestAttribution } from "./replies.js";
import { emitCollectrDomainEvent } from "../events/domain.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Initializes the connection with a watch-before-backfill sequence.
 */
export async function startInitialSyncPipeline(db, connectionId, env = {}) {
  const secretKey = env.ENCRYPTION_SECRET || env.JWT_SECRET || "collectr_dev_secret_key_32_bytes!!";

  // 1. Fetch connection
  const connRes = await db.execute({
    sql: "SELECT * FROM google_connections WHERE id = ? LIMIT 1",
    args: [connectionId],
  });

  if (!connRes.rows || connRes.rows.length === 0) {
    throw new Error(`Google connection ${connectionId} not found.`);
  }

  const conn = connRes.rows[0];

  // 2. Step 1: Register Gmail Watch & Capture Baseline History ID (H0)
  const { accessToken } = await getEphemeralAccessToken(db, connectionId, env);
  const topicName = env.GOOGLE_PUBSUB_TOPIC || "projects/springboard/topics/gmail-inbox-watch";
  
  let watchResult;
  try {
    watchResult = await gmailWatch(accessToken, topicName, env);
  } catch (err) {
    console.warn("Gmail watch registration warning (may require live Pub/Sub config):", err.message);
    watchResult = { historyId: "100001", expiration: String(Date.now() + 7 * 86400000) };
  }

  const baselineHistoryId = String(watchResult.historyId || "100001");
  const watchExpirationAt = new Date(Number(watchResult.expiration || Date.now() + 7 * 86400000)).toISOString();

  await db.execute({
    sql: `UPDATE google_connections 
          SET history_id = ?, watch_expiration_at = ?, sync_status = 'syncing', error_message = 'stage:watch', updated_at = datetime('now')
          WHERE id = ?`,
    args: [baselineHistoryId, watchExpirationAt, connectionId],
  });

  // 3. Step 2: Enqueue 30-Day Bounded Backfill Job
  const boundaryTimestamp = Date.now() - THIRTY_DAYS_MS;
  const queuePayload = {
    type: "GMAIL_BACKFILL_SYNC",
    connectionId,
    baselineHistoryId,
    boundaryTimestamp,
    pageToken: null,
  };

  if (env.SCHEDULE_QUEUE) {
    await env.SCHEDULE_QUEUE.send(queuePayload);
  } else {
    // Synchronous execution fallback for local dev / testing
    await executeBackfillBatch(db, connectionId, queuePayload, env);
  }

  return { success: true, baselineHistoryId, watchExpirationAt };
}

/**
 * Executes a single bounded page of 30-day historical backfill.
 */
export async function executeBackfillBatch(db, connectionId, jobPayload, env = {}) {
  const { pageToken, boundaryTimestamp, baselineHistoryId } = jobPayload;

  // 1. Acquire Per-Mailbox Sync Lease
  const { acquired, syncOwner } = await acquireSyncLease(db, connectionId, 180);
  if (!acquired) {
    console.log(`[GMAIL_SYNC] Connection ${connectionId} is currently leased by another worker. Deferring.`);
    return { deferred: true };
  }

  try {
    const connRes = await db.execute({
      sql: "SELECT * FROM google_connections WHERE id = ? LIMIT 1",
      args: [connectionId],
    });
    const conn = connRes.rows[0];
    if (!conn) {
      await releaseSyncLease(db, connectionId, syncOwner, null, "error", "Connection deleted");
      return { error: "Connection not found" };
    }

    const { accessToken } = await getEphemeralAccessToken(db, connectionId, env);

    // 2. Fetch User Contacts for Tenant-Scoped Matching
    const contactsRes = await db.execute({
      sql: "SELECT id, name, email, phone_number FROM contacts WHERE user_id = ? AND email IS NOT NULL",
      args: [conn.user_id],
    });
    const userContacts = contactsRes.rows || [];

    // 3. List messages for this page
    await db.execute({
      sql: "UPDATE google_connections SET sync_status = 'syncing', error_message = 'stage:scan', updated_at = datetime('now') WHERE id = ?",
      args: [connectionId],
    });

    const afterEpochSeconds = Math.floor((boundaryTimestamp || (Date.now() - THIRTY_DAYS_MS)) / 1000);
    const listRes = await gmailListMessages(
      accessToken,
      { q: `after:${afterEpochSeconds}`, maxResults: 50, pageToken },
      env
    );

    const messageRefs = listRes.messages || [];

    // 4. Batch Fetch Message Details & Correlation
    if (messageRefs.length > 0) {
      await db.execute({
        sql: "UPDATE google_connections SET sync_status = 'syncing', error_message = 'stage:correlate', updated_at = datetime('now') WHERE id = ?",
        args: [connectionId],
      });
    }

    for (const ref of messageRefs) {
      try {
        const fullMsg = await gmailGetMessage(accessToken, ref.id, "full", env);
        await processSingleGmailMessage(db, conn, fullMsg, userContacts);
      } catch (msgErr) {
        console.error(`Failed to ingest message ${ref.id}:`, msgErr);
      }
    }

    // 5. Check if more pages exist
    if (listRes.nextPageToken) {
      await releaseSyncLease(db, connectionId, syncOwner, null, "syncing");

      const nextJob = {
        type: "GMAIL_BACKFILL_SYNC",
        connectionId,
        baselineHistoryId,
        boundaryTimestamp,
        pageToken: listRes.nextPageToken,
      };

      if (env.SCHEDULE_QUEUE) {
        await env.SCHEDULE_QUEUE.send(nextJob);
      } else {
        await executeBackfillBatch(db, connectionId, nextJob, env);
      }
      return { hasMore: true };
    }

    // 6. Step 3: Catch-Up Delta from Baseline H0
    let latestHistoryId = baselineHistoryId || conn.history_id;
    if (baselineHistoryId) {
      await db.execute({
        sql: "UPDATE google_connections SET sync_status = 'syncing', error_message = 'stage:catching_up_delta', updated_at = datetime('now') WHERE id = ?",
        args: [connectionId],
      });
      try {
        const deltaRes = await gmailListHistory(accessToken, { startHistoryId: baselineHistoryId }, env);
        const historyRecords = deltaRes.history || [];
        for (const h of historyRecords) {
          const added = h.messagesAdded || [];
          for (const item of added) {
            if (item.message?.id) {
              const fullDeltaMsg = await gmailGetMessage(accessToken, item.message.id, "full", env);
              await processSingleGmailMessage(db, conn, fullDeltaMsg, userContacts);
            }
          }
        }
        latestHistoryId = String(deltaRes.historyId || latestHistoryId);
      } catch (deltaErr) {
        console.warn("Delta catch-up warning:", deltaErr.message);
      }
    }

    // 7. Finalize Backfill Checkpoint
    await releaseSyncLease(db, connectionId, syncOwner, latestHistoryId, "synced");
    return { completed: true, historyId: latestHistoryId };
  } catch (err) {
    console.error(`Backfill sync failed for connection ${connectionId}:`, err);
    await releaseSyncLease(db, connectionId, syncOwner, null, "error", err.message);
    throw err;
  }
}

/**
 * Handles incoming push delta notification via history.list.
 */
export async function executePushDeltaSync(db, connectionId, incomingHistoryId, env = {}) {
  const { acquired, syncOwner } = await acquireSyncLease(db, connectionId, 120);
  if (!acquired) {
    console.log(`[GMAIL_PUSH] Connection ${connectionId} is leased. Requeuing delta sync.`);
    return { deferred: true };
  }

  try {
    const connRes = await db.execute({
      sql: "SELECT * FROM google_connections WHERE id = ? LIMIT 1",
      args: [connectionId],
    });
    const conn = connRes.rows[0];
    if (!conn) {
      await releaseSyncLease(db, connectionId, syncOwner, null, "error", "Connection deleted");
      return { error: "Connection not found" };
    }

    const startHistoryId = conn.history_id || incomingHistoryId;
    const { accessToken } = await getEphemeralAccessToken(db, connectionId, env);

    const contactsRes = await db.execute({
      sql: "SELECT id, name, email, phone_number FROM contacts WHERE user_id = ? AND email IS NOT NULL",
      args: [conn.user_id],
    });
    const userContacts = contactsRes.rows || [];

    let historyRes;
    try {
      historyRes = await gmailListHistory(accessToken, { startHistoryId }, env);
    } catch (err) {
      if (err.status === 404 || err.message?.includes("404") || err.message?.includes("History ID not found")) {
        console.warn(`[GMAIL_SYNC] History gap detected for connection ${connectionId}. Recovering via date boundary.`);
        return await recoverHistoryGap(db, connectionId, conn, accessToken, syncOwner, userContacts, env);
      }
      throw err;
    }

    const historyRecords = historyRes.history || [];
    const ingestedMsgIds = new Set();

    for (const rec of historyRecords) {
      const added = rec.messagesAdded || [];
      for (const item of added) {
        const msgId = item.message?.id;
        if (msgId && !ingestedMsgIds.has(msgId)) {
          ingestedMsgIds.add(msgId);
          try {
            const fullMsg = await gmailGetMessage(accessToken, msgId, "full", env);
            await processSingleGmailMessage(db, conn, fullMsg, userContacts);
          } catch (itemErr) {
            console.error(`Failed to process push message ${msgId}:`, itemErr);
          }
        }
      }
    }

    const newHistoryId = String(historyRes.historyId || incomingHistoryId || startHistoryId);
    await releaseSyncLease(db, connectionId, syncOwner, newHistoryId, "synced");
    return { success: true, newHistoryId, messagesProcessed: ingestedMsgIds.size };
  } catch (err) {
    console.error(`Push delta sync failed for ${connectionId}:`, err);
    await releaseSyncLease(db, connectionId, syncOwner, null, "error", err.message);
    throw err;
  }
}

/**
 * Recovers from a 404 history ID gap by backfilling messages since last successful sync.
 */
async function recoverHistoryGap(db, connectionId, conn, accessToken, syncOwner, userContacts, env) {
  const lastSyncTime = conn.last_successful_sync_at ? new Date(conn.last_successful_sync_at).getTime() : Date.now() - 7 * 86400000;
  // Use a 24-hour buffer before last sync to avoid edge drops
  const safeBoundaryEpoch = Math.floor((lastSyncTime - 86400000) / 1000);

  const listRes = await gmailListMessages(accessToken, { q: `after:${safeBoundaryEpoch}`, maxResults: 100 }, env);
  const messages = listRes.messages || [];

  for (const ref of messages) {
    try {
      const fullMsg = await gmailGetMessage(accessToken, ref.id, "full", env);
      await processSingleGmailMessage(db, conn, fullMsg, userContacts);
    } catch (_) {}
  }

  // Register fresh watch
  const topicName = env.GOOGLE_PUBSUB_TOPIC || "projects/springboard/topics/gmail-inbox-watch";
  const watchRes = await gmailWatch(accessToken, topicName, env).catch(() => ({ historyId: "100001" }));
  const freshHistoryId = String(watchRes.historyId || "100001");

  await releaseSyncLease(db, connectionId, syncOwner, freshHistoryId, "synced");
  return { recovered: true, freshHistoryId };
}

/**
 * Ingests a single Gmail message into messages or gmail_unmatched_messages.
 */
export async function processSingleGmailMessage(db, conn, gmailMsg, userContacts = []) {
  const parsed = parseGmailHeaders(gmailMsg);
  const matchResult = matchMessageToContacts(parsed, conn.google_email, userContacts);

  if (matchResult.isUnmatched) {
    // 1. Store in Unmatched Inbox Ledger (Lean info)
    const unmatchedId = "unm_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT OR IGNORE INTO gmail_unmatched_messages (
        id, user_id, google_connection_id, gmail_message_id, gmail_thread_id,
        from_email, from_name, to_emails, subject, snippet, received_at, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', datetime('now'))`,
      args: [
        unmatchedId,
        conn.user_id,
        conn.id,
        parsed.gmailMessageId,
        parsed.gmailThreadId,
        parsed.fromEmail,
        parsed.fromName,
        JSON.stringify(parsed.allRecipientEmails),
        parsed.subject,
        parsed.snippet,
        parsed.canonicalDateIso,
      ],
    });
    return { isUnmatched: true };
  }

  const contact = matchResult.matchedContact;
  const direction = matchResult.direction;
  const senderType = matchResult.senderType;

  // 2. Ensure Email Conversation exists for Contact
  let convRes = await db.execute({
    sql: "SELECT id FROM conversations WHERE user_id = ? AND contact_id = ? AND channel = 'email' LIMIT 1",
    args: [conn.user_id, contact.id],
  });

  let conversationId;
  if (convRes.rows && convRes.rows.length > 0) {
    conversationId = convRes.rows[0].id;
    await db.execute({
      sql: "UPDATE conversations SET last_message_at = MAX(COALESCE(last_message_at, ''), ?) WHERE id = ?",
      args: [parsed.canonicalDateIso, conversationId],
    });
  } else {
    conversationId = "conv_" + crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO conversations (id, user_id, contact_id, channel, last_message_at, unread_count, created_at)
            VALUES (?, ?, ?, 'email', ?, 0, datetime('now'))`,
      args: [conversationId, conn.user_id, contact.id, parsed.canonicalDateIso],
    });
  }

  // 3. Conservative Request Attribution (Deterministic only)
  let requestId = null;
  if (direction === "inbound") {
    const attrResult = await classifyRequestAttribution(db, {
      userId: conn.user_id,
      contactId: contact.id,
      gmailThreadId: parsed.gmailThreadId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
    });
    if (attrResult.matched) {
      requestId = attrResult.requestId;
    }
  }

  // 4. Ingest into messages table (Idempotent via unique constraint)
  const messageId = "msg_" + crypto.randomUUID();
  const deliveryStatus = direction === "outbound" ? "delivered" : null;

  const insertRes = await db.execute({
    sql: `INSERT OR IGNORE INTO messages (
      id, conversation_id, contact_id, user_id, request_id,
      direction, channel, sender_type, content, subject, thread_id,
      provider, provider_message_id, delivery_status, google_connection_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'email', ?, ?, ?, ?, 'gmail', ?, ?, ?, ?)`,
    args: [
      messageId,
      conversationId,
      contact.id,
      conn.user_id,
      requestId,
      direction,
      senderType,
      parsed.content || parsed.snippet,
      parsed.subject,
      parsed.gmailThreadId,
      parsed.gmailMessageId,
      deliveryStatus,
      conn.id,
      parsed.canonicalDateIso,
    ],
  });

  const messageInserted = (insertRes?.rowsAffected || 0) > 0;

  // 5. Emit Durable Domain Event
  if (messageInserted) {
    await emitCollectrDomainEvent(db, {
      type: direction === "inbound" ? "EMAIL_RECEIVED" : "EMAIL_SENT",
      userId: conn.user_id,
      contactId: contact.id,
      requestId,
      messageId,
      timestamp: parsed.canonicalDateIso,
      snippet: parsed.snippet,
      subject: parsed.subject,
      direction,
    });
  }

  return { success: true, messageId, matchedContactId: contact.id, requestId };
}
