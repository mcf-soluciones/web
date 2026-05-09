-- Financing module: loans master + financing_events fact + loan-payment fields on gastos.
-- See api/financing/* and the cash-flow report's CFF section.

-- 1. Loans master (one row per loan).
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lender TEXT,
  principal_original REAL NOT NULL,
  start_date TEXT NOT NULL,
  term_months INTEGER,
  interest_rate REAL,
  status TEXT DEFAULT 'active',
  propiedad TEXT,
  notes TEXT,
  recibo_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 2. Non-payment financing cash events (disbursements, equity, fees, refinance).
-- Loan PAYMENTS live in gastos so the bank statement reconciles row-for-row.
CREATE TABLE IF NOT EXISTS financing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  mm INTEGER NOT NULL,
  yyyy INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  euros REAL NOT NULL,
  loan_id INTEGER REFERENCES loans(id),
  counterparty TEXT,
  notes TEXT,
  recibo_url TEXT,
  bank_movement_hash TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  user_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_financing_events_period ON financing_events (yyyy, mm);
CREATE INDEX IF NOT EXISTS idx_financing_events_loan ON financing_events (loan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_financing_events_bank_hash
  ON financing_events (bank_movement_hash) WHERE bank_movement_hash IS NOT NULL;

-- 3. Loan-payment fields on gastos. NULL for regular gastos. When loan_id is set,
-- importe_total = loan_payment_interest + loan_payment_principal (validated at API).
ALTER TABLE gastos ADD COLUMN loan_id INTEGER REFERENCES loans(id);
ALTER TABLE gastos ADD COLUMN loan_payment_interest REAL;
ALTER TABLE gastos ADD COLUMN loan_payment_principal REAL;
CREATE INDEX IF NOT EXISTS idx_gastos_loan ON gastos (loan_id);
