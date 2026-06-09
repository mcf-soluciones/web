-- Bank Excel import: rule-based auto-classification of bank movements into gastos.
-- See api/gastos/bank-import.js.

CREATE TABLE IF NOT EXISTS bank_import_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,                 -- JS regex source, matched case-insensitively against concepto_text
  concepto_mcf TEXT,                     -- catalogo_cuentas.desc — drives cuenta derivation
  cuenta_mcf TEXT,                       -- direct cuenta override (used only if concepto_mcf is NULL or no propiedad match)
  razon_social TEXT,
  nif_proveedor TEXT,
  propiedad_override TEXT,               -- 'usera' | 'hortaleza' | 'Corporate' | NULL (= use upload sucursal)
  is_fiscal INTEGER DEFAULT 1,
  notes TEXT,
  priority INTEGER DEFAULT 100,          -- ascending; lower runs first; first match wins
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_import_rules_priority ON bank_import_rules (priority);

-- bank_movement_hash now only flags a row as bank-imported in the UI
-- (list.js: bank_movement_hash != null). It is NOT unique: the import trusts
-- every uploaded row and allows duplicates (the user deletes any later). The
-- former UNIQUE index idx_gastos_bank_hash is dropped — see
-- scripts/drop-bank-hash-unique-index.js.
ALTER TABLE gastos ADD COLUMN bank_movement_hash TEXT;
DROP INDEX IF EXISTS idx_gastos_bank_hash;
