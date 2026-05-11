-- Balance-sheet snapshots: replace single-set opening balances with a
-- multi-snapshot model. Each snapshot freezes the BS state at a specific
-- as_of_date. The engine finds the latest snapshot ≤ period_end and uses
-- those values as the opening, rolling flows forward only from there.
--
-- Closed periods (snapshot.as_of_date == period_end) are returned directly
-- with zero flow queries. Open periods derive a small delta on top of the
-- latest snapshot.
--
-- bs_opening_balances (Phase 1) remains in the DB for backwards-compat but
-- is no longer read by the engine. Migrate any existing rows manually if
-- needed (see scripts/migrate-openings-to-snapshot.js — only run if the
-- table actually has rows).

CREATE TABLE IF NOT EXISTS bs_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date TEXT NOT NULL,
  yyyy INTEGER NOT NULL,
  mm INTEGER NOT NULL,
  name TEXT,
  notes TEXT,
  created_by TEXT,
  mode TEXT DEFAULT 'manual',                  -- 'manual' | 'capture'
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bs_snapshots_as_of ON bs_snapshots (as_of_date);
CREATE INDEX IF NOT EXISTS idx_bs_snapshots_period ON bs_snapshots (yyyy, mm);

CREATE TABLE IF NOT EXISTS bs_snapshot_lines (
  snapshot_id INTEGER NOT NULL,
  line_code TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (snapshot_id, line_code)
);
CREATE INDEX IF NOT EXISTS idx_bs_snapshot_lines_snap ON bs_snapshot_lines (snapshot_id);
