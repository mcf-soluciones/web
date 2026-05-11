-- tax_settlements: closed fiscal years for IS (Impuesto sobre Sociedades).
--
-- When a year is "closed" (annual return filed and we know the real IS owed),
-- store the actual amount here. The P&L then replaces the monthly N8 estimate
-- (20% × profit) with the actual IS allocated by each month's share of the
-- year's taxable profit, so the year-total matches reality.
--
-- year_profit_base = SUM over months m of MAX(0, ebitda[m] - depreciacion[m])
-- It's snapshotted at close time so monthly P&L pages don't recompute it.
-- Use the "Recalcular" action if prior-year gastos are edited later.

CREATE TABLE IF NOT EXISTS tax_settlements (
  yyyy             INTEGER PRIMARY KEY,
  actual_is        REAL NOT NULL,
  year_profit_base REAL NOT NULL,
  notes            TEXT,
  filed_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
