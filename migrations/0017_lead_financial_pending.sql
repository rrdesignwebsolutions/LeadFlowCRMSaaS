ALTER TABLE leads ADD COLUMN financial_pending INTEGER NOT NULL DEFAULT 0 CHECK (financial_pending IN (0,1));
