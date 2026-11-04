CREATE TABLE ai_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  assistant_name TEXT NOT NULL DEFAULT 'Assistente',
  instructions TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_knowledge (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ai_knowledge_org ON ai_knowledge (organization_id);

ALTER TABLE leads ADD COLUMN ai_score INTEGER;
ALTER TABLE leads ADD COLUMN ai_summary TEXT;
ALTER TABLE leads ADD COLUMN ai_handoff_at TEXT;
ALTER TABLE messages ADD COLUMN is_ai INTEGER NOT NULL DEFAULT 0;
