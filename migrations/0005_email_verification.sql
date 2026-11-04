-- Contas existentes e convidados já são considerados verificados.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

UPDATE users SET email_verified_at = COALESCE(created_at, CURRENT_TIMESTAMP);

CREATE TABLE email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_email_verifications_user ON email_verifications (user_id, created_at DESC);
