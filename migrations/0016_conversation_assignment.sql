ALTER TABLE conversations ADD COLUMN ai_resumed_at TEXT;
ALTER TABLE conversations ADD COLUMN assignment_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN ai_reply_lock TEXT;
ALTER TABLE conversations ADD COLUMN ai_reply_lock_until TEXT;
