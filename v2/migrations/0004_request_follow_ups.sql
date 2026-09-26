-- Migration: 0004_request_follow_ups.sql
-- Request-Centric 1-Click Follow-Up Reminders Engine

CREATE TABLE IF NOT EXISTS request_follow_ups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  scheduled_for_utc DATETIME NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'cancelled', 'skipped')),
  skip_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  executed_at DATETIME,
  cancelled_at DATETIME,

  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE
);

-- Invariant: At most ONE pending follow-up per request
CREATE UNIQUE INDEX IF NOT EXISTS unq_active_request_follow_up
ON request_follow_ups(request_id)
WHERE status = 'pending';

-- Fast Cron scan index
CREATE INDEX IF NOT EXISTS idx_follow_ups_due
ON request_follow_ups(status, scheduled_for_utc);
