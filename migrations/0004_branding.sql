CREATE TABLE organization_branding (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  display_name TEXT,
  tagline TEXT,
  primary_color TEXT,
  logo_data TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN avatar_data TEXT;
