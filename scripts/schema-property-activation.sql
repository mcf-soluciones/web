-- Property activation dates.
-- Ingresos in sales/sales_detail BEFORE this date belong to the prior owner
-- and must be excluded from OUR P&L / Cash Flow. They remain in the DB for
-- YoY benchmarking in the Comparar view.
CREATE TABLE IF NOT EXISTS property_activation (
  property TEXT PRIMARY KEY,     -- 'usera', 'hortaleza', 'tbc', ...
  start_date TEXT NOT NULL,       -- ISO YYYY-MM-DD (inclusive)
  label TEXT,                     -- human-readable name for the UI
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
