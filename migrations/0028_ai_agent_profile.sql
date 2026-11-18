ALTER TABLE ai_settings ADD COLUMN response_style TEXT NOT NULL DEFAULT 'balanced'
  CHECK (response_style IN ('conservative','balanced','creative'));
ALTER TABLE ai_settings ADD COLUMN business_description TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN language TEXT NOT NULL DEFAULT 'pt-BR';

ALTER TABLE ai_knowledge ADD COLUMN source_type TEXT NOT NULL DEFAULT 'pdf'
  CHECK (source_type IN ('pdf','faq','website','text'));
ALTER TABLE ai_knowledge ADD COLUMN source_url TEXT;
ALTER TABLE ai_knowledge ADD COLUMN question TEXT;
ALTER TABLE ai_knowledge ADD COLUMN answer TEXT;
