CREATE TABLE gmail_oauth_states (
  state_hash TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE gmail_accounts (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  history_id TEXT,
  history_page_token TEXT,
  initial_sync_done INTEGER NOT NULL DEFAULT 0 CHECK (initial_sync_done IN (0,1)),
  initial_sync_page_token TEXT,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','disconnected')),
  error_summary TEXT,
  connected_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE email_threads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  gmail_thread_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT,
  from_address TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  last_message_at TEXT NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id,gmail_thread_id),
  UNIQUE (organization_id,id)
);

CREATE INDEX idx_email_threads_inbox
  ON email_threads(organization_id,status,last_message_at DESC);

CREATE TABLE email_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  rfc_message_id TEXT,
  in_reply_to TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','accepted','failed')),
  sent_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id,gmail_message_id),
  FOREIGN KEY (thread_id,organization_id)
    REFERENCES email_threads(id,organization_id) ON DELETE CASCADE
);

CREATE INDEX idx_email_messages_thread
  ON email_messages(organization_id,thread_id,created_at);
