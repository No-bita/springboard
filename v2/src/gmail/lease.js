/**
 * Per-Mailbox Synchronization Lease (Checkpoint Mutex)
 * Springboard V2 — Gmail Integration
 * 
 * Invariant: At most one worker may actively synchronize a mailbox and mutate
 * its history_id checkpoint at a time.
 */

/**
 * Attempts to acquire an atomic synchronization lease for a connection.
 * @param {object} db D1 database client
 * @param {string} connectionId Google connection ID
 * @param {number} leaseTtlSeconds Lease validity in seconds (default 120s)
 * @returns {Promise<{ acquired: boolean, syncOwner?: string }>}
 */
export async function acquireSyncLease(db, connectionId, leaseTtlSeconds = 120) {
  const syncOwner = "lease_" + crypto.randomUUID();
  
  const res = await db.execute({
    sql: `UPDATE google_connections
          SET sync_lease_until = datetime('now', '+' || ? || ' seconds'),
              sync_owner = ?
          WHERE id = ? AND (sync_lease_until IS NULL OR sync_lease_until < datetime('now'))`,
    args: [leaseTtlSeconds, syncOwner, connectionId],
  });

  const acquired = (res?.rowsAffected || 0) > 0;
  if (!acquired) {
    return { acquired: false };
  }

  return { acquired: true, syncOwner };
}

/**
 * Releases the synchronization lease and optionally advances the history checkpoint.
 * @param {object} db D1 database client
 * @param {string} connectionId Google connection ID
 * @param {string} syncOwner The unique owner token from acquireSyncLease
 * @param {string|null} newHistoryId New history ID checkpoint (if successful)
 * @param {string} syncStatus Status to persist ('synced', 'idle', 'error')
 * @param {string|null} errorMessage Optional error message if sync failed
 */
export async function releaseSyncLease(
  db,
  connectionId,
  syncOwner,
  newHistoryId = null,
  syncStatus = "synced",
  errorMessage = null
) {
  let sql = `UPDATE google_connections
             SET sync_lease_until = NULL,
                 sync_owner = NULL,
                 sync_status = ?,
                 error_message = ?,
                 updated_at = datetime('now')`;

  const args = [syncStatus, errorMessage];

  if (newHistoryId) {
    sql += `, history_id = ?, last_successful_sync_at = datetime('now'), last_synced_at = datetime('now')`;
    args.push(newHistoryId);
  } else {
    sql += `, last_synced_at = datetime('now')`;
  }

  sql += ` WHERE id = ? AND sync_owner = ?`;
  args.push(connectionId, syncOwner);

  await db.execute({ sql, args });
}

/**
 * Extends the synchronization lease for long-running batch ingestion.
 */
export async function extendSyncLease(db, connectionId, syncOwner, additionalSeconds = 120) {
  const res = await db.execute({
    sql: `UPDATE google_connections
          SET sync_lease_until = datetime('now', '+' || ? || ' seconds')
          WHERE id = ? AND sync_owner = ?`,
    args: [additionalSeconds, connectionId, syncOwner],
  });

  return (res?.rowsAffected || 0) > 0;
}
