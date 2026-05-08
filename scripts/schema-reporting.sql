-- Reporting suite schema additions
-- Run against Turso mcf database. All statements are idempotent where possible.

-- Extend gastos with reporting columns
ALTER TABLE gastos ADD COLUMN categoria_gastos_mcf TEXT;
ALTER TABLE gastos ADD COLUMN es_inversion TEXT DEFAULT 'No';
ALTER TABLE gastos ADD COLUMN fecha TEXT;
ALTER TABLE gastos ADD COLUMN mm INTEGER;
ALTER TABLE gastos ADD COLUMN yyyy INTEGER;
ALTER TABLE gastos ADD COLUMN importe_total REAL;
ALTER TABLE gastos ADD COLUMN propiedad TEXT;
ALTER TABLE gastos ADD COLUMN sheet_row_id TEXT;

CREATE INDEX IF NOT EXISTS idx_gastos_period ON gastos (yyyy, mm);
CREATE INDEX IF NOT EXISTS idx_gastos_sheet_row_id ON gastos (sheet_row_id);

-- Catalog of accounts: tooltip source for P&L + resolve-cuenta lookup
CREATE TABLE IF NOT EXISTS catalogo_cuentas (
  cuenta_mcf TEXT PRIMARY KEY,
  categoria_gastos_mcf TEXT,
  desc TEXT,
  tooltip TEXT,
  propiedad TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Add propiedad if the table predates it (idempotent)
ALTER TABLE catalogo_cuentas ADD COLUMN propiedad TEXT;

-- Support (desc + propiedad) → cuenta resolution
CREATE INDEX IF NOT EXISTS idx_catalogo_desc_propiedad ON catalogo_cuentas (desc, propiedad);
