ALTER TABLE conversations
  ADD COLUMN priority INTEGER NOT NULL DEFAULT 0
  CHECK (priority IN (0, 1));
