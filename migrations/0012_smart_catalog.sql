CREATE TABLE catalog_products (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  version TEXT,
  brand TEXT,
  category TEXT,
  description TEXT,
  specs TEXT NOT NULL DEFAULT '[]',
  price_text TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  authorized_for_sale INTEGER NOT NULL DEFAULT 0,
  availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('unknown','in_stock','out_of_stock')),
  availability_updated_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_catalog_products_org ON catalog_products(organization_id, status);

CREATE TABLE catalog_images (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_catalog_images_product ON catalog_images(organization_id, product_id, position);
