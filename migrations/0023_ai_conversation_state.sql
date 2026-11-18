ALTER TABLE conversations
  ADD COLUMN ai_state TEXT NOT NULL DEFAULT 'IA_ATIVA'
    CHECK (ai_state IN ('IA_ATIVA','HUMANO'));

ALTER TABLE conversations
  ADD COLUMN ai_catalog_status TEXT NOT NULL DEFAULT 'PENDENTE'
    CHECK (ai_catalog_status IN ('PENDENTE','ENVIANDO','ENVIADO','FALHOU'));

ALTER TABLE conversations ADD COLUMN ai_catalog_source_external_id TEXT;
ALTER TABLE conversations ADD COLUMN ai_catalog_updated_at TEXT;

UPDATE conversations
SET ai_state='HUMANO'
WHERE EXISTS (
  SELECT 1 FROM messages m
  WHERE m.organization_id=conversations.organization_id
    AND m.conversation_id=conversations.id
    AND m.direction='outbound'
    AND m.is_ai=0
    AND m.status<>'failed'
    AND (
      conversations.ai_resumed_at IS NULL
      OR julianday(COALESCE(m.external_created_at,m.created_at))
        > julianday(conversations.ai_resumed_at)
    )
);

UPDATE conversations
SET ai_catalog_status='ENVIADO',
    ai_catalog_updated_at=CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM messages m
  WHERE m.organization_id=conversations.organization_id
    AND m.conversation_id=conversations.id
    AND m.direction='inbound'
);
