-- Collectr Personal CRM Initial Migration

-- 1. Users & Tenancy
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'agent',
  credit_balance INTEGER DEFAULT 900,
  wa_phone_number_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS unq_users_wa_phone_id ON users(wa_phone_number_id) WHERE wa_phone_number_id IS NOT NULL;

-- 2. Contacts (Primary Entity)
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  email TEXT,
  company TEXT,
  notes TEXT,
  last_outbound_at DATETIME,
  last_inbound_at DATETIME,
  last_interaction_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT unq_user_contact_phone UNIQUE(user_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_phone ON contacts(user_id, phone_number);

-- 3. Conversations (One per Contact per Channel)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  last_message_at DATETIME,
  unread_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  CONSTRAINT unq_user_contact_channel UNIQUE(user_id, contact_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);

-- 4. Requests (Things I need from them)
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  due_date DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_requests_contact_status ON requests(contact_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_user_status ON requests(user_id, status);

-- 5. Request Items (Generic Multi-item Checklist)
CREATE TABLE IF NOT EXISTS request_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  file_url TEXT,
  s3_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE
);

-- 6. Message Templates (Clean Generic Registry)
CREATE TABLE IF NOT EXISTS message_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'UTILITY',
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  subject TEXT,
  language TEXT DEFAULT 'en',
  header_type TEXT DEFAULT 'NONE',
  header_text TEXT,
  body_text TEXT NOT NULL,
  footer_text TEXT,
  button_type TEXT DEFAULT 'NONE',
  button_text TEXT,
  button_url TEXT,
  param_mappings JSON,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS unq_system_templates ON message_templates(name) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS unq_user_templates ON message_templates(user_id, name) WHERE user_id IS NOT NULL;

-- 7. Messages (Product-level Conversation Record)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_id TEXT,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  sender_type TEXT NOT NULL,
  content TEXT,
  template_id TEXT,
  provider TEXT NOT NULL DEFAULT 'meta_whatsapp',
  provider_message_id TEXT,
  delivery_status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE SET NULL,
  FOREIGN KEY(template_id) REFERENCES message_templates(id) ON DELETE SET NULL,
  CONSTRAINT chk_message_telemetry CHECK (
    (direction = 'inbound' AND delivery_status IS NULL) OR
    (direction = 'outbound' AND delivery_status IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS unq_messages_provider ON messages(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- 8. WhatsApp Transport & Idempotency Ledger
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  provider_message_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE SET NULL,
  CONSTRAINT unq_wa_msg UNIQUE(user_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS unq_wa_msg_provider_id ON whatsapp_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;

-- 9. Email Transport Ledger
CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT,
  idempotency_key TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  provider_message_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE SET NULL,
  CONSTRAINT unq_email_msg UNIQUE(user_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS unq_email_msg_provider_id ON email_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;

-- 10. Activities (Unified Audit & Human Event Stream)
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  request_id TEXT,
  activity_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  metadata JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id, created_at DESC);

-- 11. Schedules & Occurrences
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  request_id TEXT,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  template_id TEXT,
  message_body TEXT,
  payload_snapshot JSON NOT NULL,
  schedule_type TEXT NOT NULL DEFAULT 'one_off',
  recurrence_interval TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  status TEXT NOT NULL DEFAULT 'active',
  next_run_utc DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  cancelled_at DATETIME,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE SET NULL,
  FOREIGN KEY(template_id) REFERENCES message_templates(id) ON DELETE SET NULL,
  CONSTRAINT chk_schedule_payload_xor CHECK (
    (template_id IS NOT NULL AND message_body IS NULL) OR
    (template_id IS NULL AND message_body IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_schedules_user_status ON schedules(user_id, status);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(status, next_run_utc);

CREATE TABLE IF NOT EXISTS scheduled_occurrences (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  scheduled_for_utc DATETIME NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  recipient_phone TEXT,
  recipient_email TEXT,
  operational_status TEXT NOT NULL DEFAULT 'pending',
  claimed_at DATETIME,
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  message_id TEXT,
  skip_reason TEXT,
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  executed_at DATETIME,
  FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE SET NULL,
  CONSTRAINT unq_occurrence_schedule_key UNIQUE(schedule_id, occurrence_key)
);

CREATE INDEX IF NOT EXISTS idx_occurrences_claim ON scheduled_occurrences(operational_status, scheduled_for_utc, claimed_at);

-- 12. Credits & Ledger
CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  balance_after_paise INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT unq_credit_tx UNIQUE(user_id, reference_id, transaction_type)
);

CREATE TABLE IF NOT EXISTS credit_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  reference_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT unq_reservation_ref UNIQUE(user_id, reference_id)
);
