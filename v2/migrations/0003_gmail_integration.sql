-- Collectr Personal CRM — 0003 Gmail Read-Only Connectivity Integration

-- 1. Google Connections (No plaintext access_token, encrypted refresh_token at rest)
CREATE TABLE IF NOT EXISTS google_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  google_subject_id TEXT NOT NULL,
  google_email TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  history_id TEXT,
  watch_expiration_at DATETIME,
  sync_lease_until DATETIME,
  sync_owner TEXT,
  last_synced_at DATETIME,
  last_successful_sync_at DATETIME,
  sync_status TEXT DEFAULT 'idle',
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT unq_global_google_email UNIQUE(google_email)
);

CREATE INDEX IF NOT EXISTS idx_google_connections_user ON google_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_google_connections_lease ON google_connections(sync_lease_until);

-- 2. Unmatched Inbound Emails Ledger
CREATE TABLE IF NOT EXISTS gmail_unmatched_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  google_connection_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_emails JSON,
  subject TEXT,
  snippet TEXT,
  received_at DATETIME NOT NULL,
  status TEXT DEFAULT 'unresolved',
  linked_contact_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(google_connection_id) REFERENCES google_connections(id) ON DELETE CASCADE,
  FOREIGN KEY(linked_contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  CONSTRAINT unq_conn_unmatched_msg UNIQUE(google_connection_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_gmail_unmatched_user_status ON gmail_unmatched_messages(user_id, status);

-- 3. Add Mailbox Connection & RFC Threading Telemetry to Messages
ALTER TABLE messages ADD COLUMN google_connection_id TEXT REFERENCES google_connections(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN subject TEXT;
ALTER TABLE messages ADD COLUMN thread_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS unq_messages_conn_provider_msg ON messages(google_connection_id, provider_message_id) WHERE google_connection_id IS NOT NULL;
