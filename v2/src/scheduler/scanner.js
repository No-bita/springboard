/**
 * Scheduler Cron Scanner
 * Scans D1 for due or orphaned claimed occurrences and enqueues them for processing.
 * 
 * Crash window recovery guarantee:
 * An occurrence claimed by a worker that subsequently crashes before queue enqueue
 * is reclaimed after its 10-minute lease expires (claimed_at < datetime('now', '-10 minutes')).
 */

export async function scanAndClaimDueOccurrences(db, queue = null, limit = 50, inlineConsumer = null) {
  // 1. Fetch candidates (due pending occurrences OR expired claimed leases)
  const candidateRes = await db.execute({
    sql: `
      SELECT id, schedule_id, scheduled_for_utc, operational_status, attempts
      FROM scheduled_occurrences
      WHERE (operational_status = 'pending' AND scheduled_for_utc <= datetime('now'))
         OR (operational_status = 'claimed' AND claimed_at < datetime('now', '-10 minutes'))
      ORDER BY scheduled_for_utc ASC
      LIMIT ?
    `,
    args: [limit]
  });

  const candidates = candidateRes.rows || [];
  const claimedOccurrences = [];

  for (const item of candidates) {
    // 2. Atomic claim with lease timestamp and RETURNING id
    const claimRes = await db.execute({
      sql: `
        UPDATE scheduled_occurrences
        SET operational_status = 'claimed',
            claimed_at = datetime('now'),
            attempts = attempts + 1
        WHERE id = ?
          AND (
            operational_status = 'pending' 
            OR (operational_status = 'claimed' AND claimed_at < datetime('now', '-10 minutes'))
          )
        RETURNING id
      `,
      args: [item.id]
    });

    // Check if the atomic UPDATE affected exactly one row
    const isAcquired = (claimRes?.rows && claimRes.rows.length === 1) ||
                       (claimRes?.changes === 1) ||
                       (claimRes?.meta?.changes === 1);

    if (!isAcquired) {
      // Row was claimed concurrently by another execution or lease was refreshed; skip
      continue;
    }

    claimedOccurrences.push(item);

      // 3. Dispatch to Queue or inline consumer fallback
      const payload = {
        occurrenceId: item.id,
        scheduleId: item.schedule_id
      };

      if (queue && typeof queue.send === "function") {
        try {
          await queue.send(payload);
        } catch (enqueueErr) {
          console.error(`[SCHEDULER CRON] Failed enqueuing occurrence ${item.id}:`, enqueueErr);
          // Note: Leased occurrence remains claimed and will be reclaimed by scanner after 10 minutes
        }
      } else if (typeof inlineConsumer === "function") {
        // Fallback for local testing or configurations without Cloudflare Queue binding
        try {
          await inlineConsumer(payload);
        } catch (err) {
          console.error(`[SCHEDULER INLINE] Execution error for occurrence ${item.id}:`, err);
        }
      }
    }

  // 4. Scan for scheduled campaigns reaching due time
  try {
    const dueCmpRes = await db.execute({
      sql: `
        SELECT id, user_id, scheduled_for
        FROM campaigns
        WHERE status = 'scheduled' AND scheduled_for <= datetime('now')
        LIMIT ?
      `,
      args: [limit]
    });

    const dueCampaigns = dueCmpRes?.rows || [];
    for (const cmp of dueCampaigns) {
      const claimCmp = await db.execute({
        sql: `
          UPDATE campaigns
          SET status = 'running', launched_at = datetime('now')
          WHERE id = ? AND status = 'scheduled'
          RETURNING id
        `,
        args: [cmp.id]
      });

      const isAcquired = (claimCmp?.rows && claimCmp.rows.length === 1) ||
                         (claimCmp?.changes === 1) ||
                         (claimCmp?.meta?.changes === 1);

      if (isAcquired) {
        await db.execute({
          sql: `UPDATE campaign_recipients SET delivery_status = 'queued' WHERE campaign_id = ? AND delivery_status = 'pending'`,
          args: [cmp.id]
        });

        const cmpPayload = {
          type: "campaign_dispatch",
          campaign_id: cmp.id,
          user_id: cmp.user_id
        };

        if (queue && typeof queue.send === "function") {
          try {
            await queue.send(cmpPayload);
          } catch (enqueueErr) {
            console.error(`[SCHEDULER CRON] Failed enqueuing campaign ${cmp.id}:`, enqueueErr);
          }
        } else if (typeof inlineConsumer === "function") {
          try {
            await inlineConsumer(cmpPayload);
          } catch (err) {
            console.error(`[SCHEDULER INLINE] Execution error for campaign ${cmp.id}:`, err);
          }
        }
      }
    }
  } catch (cmpErr) {
    console.warn("[SCHEDULER CRON] Error scanning scheduled campaigns:", cmpErr);
  }

  return {
    scanned: candidates.length,
    claimed: claimedOccurrences.length,
    items: claimedOccurrences
  };
}

/**
 * Scans for Gmail connections approaching watch expiration and renews push subscriptions.
 */
export async function scanAndRenewExpiringWatches(db, env = {}) {
  try {
    const expiring = await db.execute({
      sql: `SELECT id, google_email FROM google_connections
            WHERE watch_expiration_at IS NOT NULL
              AND watch_expiration_at <= datetime('now', '+24 hours')`,
    });

    const { getEphemeralAccessToken } = await import("../gmail/auth.js");
    const { gmailWatch } = await import("../gmail/client.js");

    for (const conn of expiring.rows || []) {
      try {
        const { accessToken } = await getEphemeralAccessToken(db, conn.id, env);
        const topicName = env.GOOGLE_PUBSUB_TOPIC || "projects/springboard/topics/gmail-inbox-watch";
        const watchRes = await gmailWatch(accessToken, topicName, env);
        if (watchRes.expiration) {
          const newExp = new Date(Number(watchRes.expiration)).toISOString();
          await db.execute({
            sql: "UPDATE google_connections SET watch_expiration_at = ?, updated_at = datetime('now') WHERE id = ?",
            args: [newExp, conn.id],
          });
        }
      } catch (err) {
        console.error(`Failed to renew watch for connection ${conn.id}:`, err);
      }
    }
  } catch (err) {
    // Non-blocking catch
  }
}

/**
 * Scans for due request follow-ups and transitions eligible requests to 'needs_follow_up'.
 * Enforces race-safe conditional transitions and idempotent completion.
 */
export async function scanAndExecuteDueFollowUps(db, limit = 50) {
  try {
    // 1. Fetch due pending follow-ups
    const dueRes = await db.execute({
      sql: `SELECT id, request_id, user_id, contact_id, preset, scheduled_for_utc
            FROM request_follow_ups
            WHERE status = 'pending' AND scheduled_for_utc <= datetime('now')
            ORDER BY scheduled_for_utc ASC
            LIMIT ?`,
      args: [limit],
    });

    const candidates = dueRes.rows || [];
    let completedCount = 0;

    for (const item of candidates) {
      // 2. Atomic transition of follow-up record to completed
      const claimRes = await db.execute({
        sql: `UPDATE request_follow_ups
              SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
              WHERE id = ? AND status = 'pending'
              RETURNING id`,
        args: [item.id],
      });

      const isClaimed = (claimRes?.rows && claimRes.rows.length === 1) ||
                        (claimRes?.changes === 1) ||
                        (claimRes?.meta?.changes === 1) ||
                        (claimRes?.rowsAffected === 1);

      if (!isClaimed) {
        continue;
      }

      completedCount++;

      // 3. Inspect request state
      const reqRes = await db.execute({
        sql: `SELECT id, title, status FROM requests WHERE id = ? LIMIT 1`,
        args: [item.request_id],
      });

      if (!reqRes.rows || reqRes.rows.length === 0) {
        continue;
      }

      const req = reqRes.rows[0];

      // 4. If request is waiting_on_them or open, transition to needs_follow_up
      if (["waiting_on_them", "open"].includes(req.status)) {
        const updateRes = await db.execute({
          sql: `UPDATE requests 
                SET status = 'needs_follow_up', updated_at = datetime('now')
                WHERE id = ? AND status IN ('waiting_on_them', 'open')`,
          args: [req.id],
        });

        const reqUpdated = (updateRes?.changes === 1) ||
                           (updateRes?.meta?.changes === 1) ||
                           (updateRes?.rowsAffected === 1);

        if (reqUpdated) {
          // Log Activity Event
          const actId = "act_" + crypto.randomUUID();
          await db.execute({
            sql: `INSERT INTO activities (
                    id, user_id, contact_id, request_id, activity_type, title, description, metadata, created_at
                  ) VALUES (?, ?, ?, ?, 'request_needs_follow_up', 'Follow-Up Due', ?, ?, datetime('now'))`,
            args: [
              actId,
              item.user_id,
              item.contact_id,
              item.request_id,
              `Follow-up due for: ${req.title}`,
              JSON.stringify({ followUpId: item.id, preset: item.preset, previousStatus: req.status }),
            ],
          });
        }
      } else if (["completed", "cancelled"].includes(req.status)) {
        // Mark skip reason on the completed follow-up for audit trail
        await db.execute({
          sql: `UPDATE request_follow_ups SET skip_reason = ? WHERE id = ?`,
          args: [req.status === "completed" ? "request_completed" : "request_cancelled", item.id],
        });
      }
    }

    return {
      scanned: candidates.length,
      completed: completedCount,
    };
  } catch (err) {
    console.error("[SCHEDULER CRON] Error scanning due follow-ups:", err);
    return { error: err.message };
  }
}
