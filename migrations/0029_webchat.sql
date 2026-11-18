CREATE TABLE webchat_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  display_name TEXT NOT NULL DEFAULT 'Atendimento',
  color TEXT NOT NULL DEFAULT '#1769e0',
  welcome_message TEXT NOT NULL DEFAULT 'Oi! Como podemos ajudar?',
  allowed_domains_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,public_key)
);

CREATE TABLE webchat_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  visitor_token_hash TEXT NOT NULL UNIQUE,
  visitor_name TEXT,
  visitor_email TEXT,
  origin_domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  ai_state TEXT NOT NULL DEFAULT 'IA_ATIVA' CHECK (ai_state IN ('IA_ATIVA','HUMANO')),
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id,organization_id),
  FOREIGN KEY (organization_id,public_key)
    REFERENCES webchat_settings(organization_id,public_key) ON DELETE CASCADE
);

CREATE INDEX idx_webchat_sessions_inbox
  ON webchat_sessions(organization_id,status,last_message_at DESC);

CREATE TABLE webchat_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES webchat_sessions(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('customer','ai','agent')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','accepted','read','failed')),
  reply_to_message_id TEXT,
  sent_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,reply_to_message_id),
  FOREIGN KEY (session_id,organization_id)
    REFERENCES webchat_sessions(id,organization_id) ON DELETE CASCADE
);

CREATE INDEX idx_webchat_messages_session
  ON webchat_messages(organization_id,session_id,created_at);

CREATE TABLE webchat_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES webchat_sessions(id) ON DELETE CASCADE,
  inbound_message_id TEXT NOT NULL UNIQUE REFERENCES webchat_messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_webchat_jobs_ready
  ON webchat_jobs(status,next_attempt_at,locked_until);
