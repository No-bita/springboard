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
