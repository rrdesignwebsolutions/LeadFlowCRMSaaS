ALTER TABLE ai_settings
ADD COLUMN media_processing_enabled INTEGER NOT NULL DEFAULT 0
CHECK (media_processing_enabled IN (0,1));
