CREATE TABLE catalog_delivery_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  inbound_external_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed','needs_review')),
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','delivered','failed')),
  total_approved INTEGER NOT NULL,
  total_selected INTEGER NOT NULL,
  total_included INTEGER NOT NULL,
  total_batches INTEGER NOT NULL,
  excluded_product_ids TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, conversation_id, inbound_external_id)
);

CREATE TABLE catalog_delivery_batches (
  id TEXT PRIMARY KEY,
  delivery_job_id TEXT NOT NULL REFERENCES catalog_delivery_jobs(id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL,
  product_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','accepted','failed','needs_review')),
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','accepted','sent','delivered','read','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (delivery_job_id, batch_index)
);

CREATE INDEX idx_catalog_delivery_jobs_due
  ON catalog_delivery_jobs(status, next_attempt_at, locked_until);

CREATE INDEX idx_catalog_delivery_batches_job_status
  ON catalog_delivery_batches(delivery_job_id, status, batch_index);

CREATE INDEX idx_catalog_delivery_batches_message
  ON catalog_delivery_batches(message_id)
  WHERE message_id IS NOT NULL;
