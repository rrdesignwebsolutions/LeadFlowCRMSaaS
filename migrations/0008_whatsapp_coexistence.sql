ALTER TABLE integrations
  ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'cloud_api'
  CHECK (connection_mode IN ('cloud_api', 'coexistence'));
