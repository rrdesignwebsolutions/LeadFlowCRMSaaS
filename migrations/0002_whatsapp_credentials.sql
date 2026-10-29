ALTER TABLE integrations ADD COLUMN access_token_enc TEXT;

CREATE UNIQUE INDEX idx_conversations_contact_integration ON conversations(organization_id, contact_id, integration_id);
CREATE INDEX idx_messages_external ON messages(organization_id, external_id);
