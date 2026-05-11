-- Projections: saved 12-month forward scenarios on top of MCF's T12M baseline.
--
-- Each row holds an entire scenario (investment params + new-sucursal cost
-- lines + adjustments + capex events + extra loans) as a JSON payload, plus
-- a cached compute result so the UI can re-open instantly.
--
-- Schema is deliberately simple: one row per scenario. Versioning happens
-- via "save as new". The baseline_yyyy_mm anchors the projection to a
-- specific T12M window so re-opening years later still shows the original
-- analysis (you can also recompute against today's data).

CREATE TABLE IF NOT EXISTS projections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  baseline_yyyy_mm TEXT NOT NULL,                                            -- e.g. '2026-04'
  payload TEXT NOT NULL,                                                     -- JSON
  owner TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projections_updated ON projections (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projections_baseline ON projections (baseline_yyyy_mm);
