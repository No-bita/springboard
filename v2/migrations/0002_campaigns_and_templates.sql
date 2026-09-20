-- 13. Templates & Channel Configurations
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  scope TEXT NOT NULL DEFAULT 'custom' CHECK (scope IN ('system', 'custom')),
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS unq_system_template ON templates(channel, name) WHERE scope = 'system';
CREATE UNIQUE INDEX IF NOT EXISTS unq_user_template ON templates(user_id, channel, name) WHERE scope = 'custom' AND status = 'active';

CREATE TABLE IF NOT EXISTS whatsapp_template_configs (
  template_id TEXT PRIMARY KEY,
  meta_template_name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT 'UTILITY' CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION')),
  header_type TEXT DEFAULT 'NONE' CHECK (header_type IN ('NONE', 'TEXT')),
  header_text TEXT,
  body_text TEXT NOT NULL,
  footer_text TEXT,
  buttons JSON,
  param_mappings JSON,
  FOREIGN KEY(template_id) REFERENCES templates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS email_template_configs (
  template_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  param_mappings JSON,
  FOREIGN KEY(template_id) REFERENCES templates(id) ON DELETE CASCADE
);

-- 14. Campaigns & Message Snapshots
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  channels JSON NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'completed', 'cancelled')),
  target_filter_audit JSON,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  scheduled_for DATETIME,
  local_scheduled_time TEXT,
  total_recipients_snapshot INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  launched_at DATETIME,
  completed_at DATETIME,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_campaigns_user_status ON campaigns(user_id, status);

CREATE TABLE IF NOT EXISTS campaign_messages (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  template_id TEXT,
  template_version_snapshot INTEGER DEFAULT 1,
  template_name_snapshot TEXT NOT NULL,
  subject_snapshot TEXT,
  body_snapshot TEXT NOT NULL,
  header_snapshot TEXT,
  footer_snapshot TEXT,
  buttons_snapshot JSON,
  param_mappings_snapshot JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT unq_campaign_channel UNIQUE (campaign_id, channel)
);

-- 15. Campaign Recipients (Immutable Execution Snapshot)
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  contact_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  recipient_name_snapshot TEXT NOT NULL,
  phone_snapshot TEXT,
  email_snapshot TEXT,
  company_snapshot TEXT,
  custom_vars_snapshot JSON,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  response_status TEXT NOT NULL DEFAULT 'no_reply' CHECK (response_status IN ('no_reply', 'replied')),
  provider_message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  sending_started_at DATETIME,
  sent_at DATETIME,
  delivered_at DATETIME,
  read_at DATETIME,
  replied_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  CONSTRAINT unq_campaign_recipient_channel UNIQUE (campaign_id, id, channel)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients(campaign_id, delivery_status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_response ON campaign_recipients(campaign_id, response_status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_user_phone ON campaign_recipients(user_id, phone_snapshot, channel, delivery_status);
CREATE UNIQUE INDEX IF NOT EXISTS unq_campaign_recp_provider ON campaign_recipients(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_sending ON campaign_recipients(delivery_status, sending_started_at) WHERE delivery_status = 'sending';
