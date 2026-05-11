-- Balance Sheet schema additions
-- Run against Turso mcf database. All statements are idempotent.
--
-- Three tables:
--   1. bs_lines             — dictionary of BS line items (Assets / Liabilities / Equity)
--   2. bs_opening_balances  — single set of opening balances anchoring the roll-forward.
--                             Anything that existed before Turso started capturing data
--                             (e.g., starting cash, AR carryover, fixed assets bought
--                             before the system) is recorded here.
--   3. bs_overrides         — per-(yyyy, mm, line_code) manual override of the derived
--                             value. Used for AR/AP/inventory which the data can't
--                             reconstruct, and for ad-hoc reconciliation adjustments.
--
-- Sign convention: all `amount` values are stored as POSITIVE numbers. Lines with
-- is_contra = 1 (e.g., accumulated depreciation) are subtracted from their section
-- total at render time.

CREATE TABLE IF NOT EXISTS bs_lines (
  code TEXT PRIMARY KEY,
  section TEXT NOT NULL CHECK (section IN ('assets', 'liabilities', 'equity')),
  subsection TEXT,                                   -- intermediate group label (e.g., "Activo corriente")
  label TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  description TEXT,
  is_contra INTEGER DEFAULT 0,
  is_derivable INTEGER DEFAULT 0,
  derivation_note TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
ALTER TABLE bs_lines ADD COLUMN subsection TEXT;
ALTER TABLE bs_lines ADD COLUMN subgroup TEXT;
CREATE INDEX IF NOT EXISTS idx_bs_lines_section ON bs_lines (section, sort_order);

CREATE TABLE IF NOT EXISTS bs_opening_balances (
  line_code TEXT PRIMARY KEY REFERENCES bs_lines(code),
  amount REAL NOT NULL DEFAULT 0,
  as_of_date TEXT NOT NULL,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bs_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  yyyy INTEGER NOT NULL,
  mm INTEGER NOT NULL,
  line_code TEXT NOT NULL REFERENCES bs_lines(code),
  amount REAL NOT NULL,
  notes TEXT,
  user_name TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (yyyy, mm, line_code)
);
CREATE INDEX IF NOT EXISTS idx_bs_overrides_period ON bs_overrides (yyyy, mm);
CREATE INDEX IF NOT EXISTS idx_bs_overrides_line ON bs_overrides (line_code);
