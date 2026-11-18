ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE messages ADD COLUMN content_available INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN referral_json TEXT;
ALTER TABLE messages ADD COLUMN context_json TEXT;
ALTER TABLE messages ADD COLUMN ai_reply_key TEXT;
ALTER TABLE webhook_events ADD COLUMN event_type TEXT;

UPDATE messages
SET origin = CASE
  WHEN direction = 'inbound' THEN 'customer'
  WHEN is_ai = 1 OR sent_by IS NOT NULL THEN 'business_api'
  ELSE 'unknown'
END
WHERE origin = 'unknown';

UPDATE messages
SET content_available = 1
WHERE direction = 'inbound'
  AND type IN ('text','audio','image','video','document','sticker','contacts','button','interactive','location','reaction','order','product')
  AND body IS NOT NULL
  AND trim(body) <> '';

UPDATE messages
SET content_available = 0
WHERE direction = 'inbound'
  AND type IN ('unsupported','errors');

ALTER TABLE deleted_whatsapp_messages
  ADD COLUMN content_available INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deleted_whatsapp_messages
  ADD COLUMN created_at TEXT;

CREATE UNIQUE INDEX idx_messages_ai_reply_key
  ON messages(organization_id, ai_reply_key)
  WHERE ai_reply_key IS NOT NULL;

CREATE TABLE whatsapp_processing_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  inbound_external_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed','needs_review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, inbound_external_id)
);

CREATE INDEX idx_whatsapp_processing_jobs_due
  ON whatsapp_processing_jobs(status, next_attempt_at, locked_until);

CREATE INDEX idx_whatsapp_processing_jobs_org_status
  ON whatsapp_processing_jobs(organization_id, status, updated_at DESC);

CREATE TABLE whatsapp_business_app_contacts (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  parent_user_id TEXT,
  username TEXT,
  phone_e164 TEXT,
  full_name TEXT,
  first_name TEXT,
  is_removed INTEGER NOT NULL DEFAULT 0 CHECK (is_removed IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (integration_id, user_id)
);

CREATE INDEX idx_whatsapp_business_app_contacts_org_phone
  ON whatsapp_business_app_contacts(organization_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;
