CREATE TABLE public_checkout_orders (
  order_nsu TEXT PRIMARY KEY,
  plan TEXT NOT NULL CHECK (plan IN ('essencial','pro','scale')),
  amount_cents INTEGER NOT NULL,
  period_days INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  transaction_nsu TEXT,
  claimed_organization_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  claimed_at TEXT
);

CREATE INDEX idx_public_checkout_orders_status
  ON public_checkout_orders(status, claimed_organization_id);

CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_email TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT
);

CREATE INDEX idx_support_messages_user_created
  ON support_messages(organization_id, user_id, created_at);
