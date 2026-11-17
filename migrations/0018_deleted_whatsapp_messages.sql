CREATE TABLE deleted_whatsapp_messages (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  external_created_at TEXT,
  PRIMARY KEY (organization_id, external_id)
);
