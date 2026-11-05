-- Teste grátis de 7 dias + acesso condicionado ao pagamento.
-- period_ends_at = fim do teste (trialing) ou do período pago (active).
ALTER TABLE subscriptions ADD COLUMN reminder_stage INTEGER NOT NULL DEFAULT 0;

-- Contas já existentes ganham 7 dias a partir desta migração.
UPDATE subscriptions SET period_ends_at = datetime('now', '+7 days') WHERE period_ends_at IS NULL;

CREATE TABLE billing_orders (
  order_nsu TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  transaction_nsu TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);
CREATE INDEX idx_billing_orders_org ON billing_orders(organization_id);
