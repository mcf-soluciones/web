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

-- Idempotency for re-uploads: hash(date|importe|concepto_text) is unique across gastos.
ALTER TABLE gastos ADD COLUMN bank_movement_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gastos_bank_hash
  ON gastos (bank_movement_hash) WHERE bank_movement_hash IS NOT NULL;
