ALTER TABLE integrations
  ADD COLUMN history_sync_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK (history_sync_status IN ('not_started','requesting','requested','completed','declined','failed'));

ALTER TABLE integrations
  ADD COLUMN history_sync_requested_at TEXT;

ALTER TABLE integrations
  ADD COLUMN history_sync_request_id TEXT;

ALTER TABLE integrations
  ADD COLUMN history_sync_progress INTEGER NOT NULL DEFAULT 0
  CHECK (history_sync_progress BETWEEN 0 AND 100);

ALTER TABLE integrations
  ADD COLUMN history_sync_error TEXT;
