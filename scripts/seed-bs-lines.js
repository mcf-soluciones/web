/**
 * Seed / update the bs_lines dictionary. Re-run any time you add a new BS line
 * or change a label — UPSERT on code.
 *
 * Sign convention: all amounts are stored positive. is_contra = 1 means the
 * line is subtracted from its section total at render time (e.g., accumulated
 * depreciation, drawing accounts).
 *
 * Usage:
 *   node scripts/seed-bs-lines.js
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Standard chart of accounts for the BS. Codes use a stable prefix scheme:
//   A.NN.<slug>   assets
//   L.NN.<slug>   liabilities
//   E.NN.<slug>   equity
// NN gives ordering room; <slug> is the stable id used by the engine.
//
// is_derivable = 1 means the BS engine has logic to compute this line from the
// underlying tables (sales, gastos, loans, etc.). Lines marked 0 must come from
// bs_opening_balances + bs_overrides only (e.g., AR/AP/inventory, which the
// transactional data can't reconstruct without manual input).
// Each line has a `subsection` for hierarchical rendering (P&L-style):
//   Activos
//     Activo corriente              ← subsection
//       A.10.cash                   ← line
//       A.11.bank
//       ...
//       [Subtotal: Activo corriente]
//     Activo no corriente
//       A.40.fixed_assets_gross
//       A.41.accumulated_depreciation (contra)
//       [Subtotal: Activo no corriente]
//     [Total: Activos]
//
// To customize the hierarchy: edit `subsection` and `sort_order` here, then
// re-run `node scripts/seed-bs-lines.js`. The Balance UI groups by subsection
// in sort_order. Add new subsections by typing a new label here — no schema
// change needed.
const LINES = [
  // ----- Assets -----
  { code: 'A.10.cash',                    section: 'assets',      subsection: 'Activo corriente',     label: 'Efectivo en caja',                 sort_order: 10, is_contra: 0, is_derivable: 1,
    description: 'Cash on hand at the locations.',
    derivation_note: 'opening + cumulative cash movements (sales cash + deposits − retiros − fondo_caja transfers) through (yyyy, mm).' },
  { code: 'A.11.bank',                    section: 'assets',      subsection: 'Activo corriente',     label: 'Bancos',                           sort_order: 11, is_contra: 0, is_derivable: 1,
    description: 'Bank account balances (cuenta bancaria).',
    derivation_note: 'opening + cumulative bank movements (sales banco + transferencias − gastos pagados desde banco − loan principal payments + financing_events).' },
  { code: 'A.20.ar',                      section: 'assets',      subsection: 'Activo corriente',     label: 'Cuentas por cobrar',               sort_order: 20, is_contra: 0, is_derivable: 0,
    description: 'Accounts receivable (mostly N/A for laundromat — manual override only).',
    derivation_note: 'override only.' },
  { code: 'A.30.inventory',               section: 'assets',      subsection: 'Activo corriente',     label: 'Inventario',                       sort_order: 30, is_contra: 0, is_derivable: 0,
    description: 'Consumables on site (jabón, suavizante, oxígeno).',
    derivation_note: 'override only (could later wire to inventory snapshots × unit cost).' },
  { code: 'A.40.fixed_assets_gross',      section: 'assets',      subsection: 'Activo no corriente',  label: 'Inmovilizado material (bruto)',    sort_order: 40, is_contra: 0, is_derivable: 1,
    description: 'Gross book value of equipment, leasehold improvements, etc.',
    derivation_note: 'opening + cumulative gastos.es_inversion = "Si" (capex) through (yyyy, mm).' },
  { code: 'A.41.accumulated_depreciation', section: 'assets',     subsection: 'Activo no corriente',  label: 'Amortización acumulada',           sort_order: 41, is_contra: 1, is_derivable: 1,
    description: 'Accumulated depreciation (contra-asset, subtracted from gross fixed assets).',
    derivation_note: 'opening + cumulative O-letter expenses (P&L depreciation rows incl. synthetic O2) through (yyyy, mm).' },
  { code: 'A.50.other_assets',            section: 'assets',      subsection: 'Activo no corriente',  label: 'Otros activos',                    sort_order: 50, is_contra: 0, is_derivable: 0,
    description: 'Deposits, prepaid expenses, other.',
    derivation_note: 'override only.' },

  // ----- Liabilities -----
  { code: 'L.10.ap',                      section: 'liabilities', subsection: 'Pasivo corriente',     label: 'Cuentas por pagar',                sort_order: 10, is_contra: 0, is_derivable: 0,
    description: 'Accounts payable to suppliers.',
    derivation_note: 'override only.' },
  { code: 'L.20.taxes_payable',           section: 'liabilities', subsection: 'Pasivo corriente',     label: 'Impuestos por pagar',              sort_order: 20, is_contra: 0, is_derivable: 1,
    description: 'IS (Impuesto sobre Sociedades) accrued but not yet paid. Plus override capacity for IVA/IRPF.',
    derivation_note: 'Cumulative N8 estimate (20% of post-anchor monthly EBITDA − depreciation, floored at 0). Override to absorb actual IS payments or to add IVA/IRPF accruals.' },
  { code: 'L.30.loans_current',           section: 'liabilities', subsection: 'Pasivo corriente',     label: 'Préstamos a corto plazo',          sort_order: 30, is_contra: 0, is_derivable: 1,
    description: 'Loan principal due within 12 months.',
    derivation_note: 'sum of next-12-months scheduled principal across active loans, capped at outstanding balance.' },
  { code: 'L.31.loans_noncurrent',        section: 'liabilities', subsection: 'Pasivo no corriente',  label: 'Préstamos a largo plazo',          sort_order: 31, is_contra: 0, is_derivable: 1,
    description: 'Loan principal due beyond 12 months.',
    derivation_note: 'outstanding balance − loans_current.' },
  { code: 'L.40.other_liabilities',       section: 'liabilities', subsection: 'Pasivo no corriente',  label: 'Otros pasivos',                    sort_order: 40, is_contra: 0, is_derivable: 0,
    description: 'Deposits received, accrued expenses, other.',
    derivation_note: 'override only.' },

  // ----- Equity -----
  { code: 'E.10.capital',                 section: 'equity',      subsection: 'Capital',              label: 'Capital social',                   sort_order: 10, is_contra: 0, is_derivable: 1,
    description: 'Owner contributions / paid-in capital.',
    derivation_note: 'opening + cumulative financing_events (equity_in − equity_out) through (yyyy, mm).' },
  { code: 'E.20.retained_earnings',       section: 'equity',      subsection: 'Resultados',           label: 'Resultados acumulados',            sort_order: 20, is_contra: 0, is_derivable: 1,
    description: 'Cumulative net income from prior years.',
    derivation_note: 'opening + sum of net_income for all months strictly before the current fiscal year (yyyy).' },
  { code: 'E.30.current_earnings',        section: 'equity',      subsection: 'Resultados',           label: 'Resultado del ejercicio',          sort_order: 30, is_contra: 0, is_derivable: 1,
    description: 'Net income YTD for the current fiscal year (current period).',
    derivation_note: 'sum of net_income for months 1..mm of the current yyyy.' },
];

async function main() {
  // Verify schema exists
  try {
    await turso.execute('SELECT 1 FROM bs_lines LIMIT 1');
  } catch (err) {
    console.error('bs_lines table not found. Run scripts/run-schema-balance-sheet.js first.');
    console.error('  underlying error:', err.message);
    process.exit(1);
  }

  for (const L of LINES) {
    await turso.execute({
      sql: `INSERT INTO bs_lines (code, section, subsection, label, sort_order, description, is_contra, is_derivable, derivation_note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(code) DO UPDATE SET
              section          = excluded.section,
              subsection       = excluded.subsection,
              label            = excluded.label,
              sort_order       = excluded.sort_order,
              description      = excluded.description,
              is_contra        = excluded.is_contra,
              is_derivable     = excluded.is_derivable,
              derivation_note  = excluded.derivation_note,
              updated_at       = datetime('now')`,
      args: [L.code, L.section, L.subsection || null, L.label, L.sort_order, L.description, L.is_contra, L.is_derivable, L.derivation_note],
    });
    console.log(`  upserted ${L.code.padEnd(34)} ${L.section.padEnd(12)} ${(L.subsection || '').padEnd(22)} ${L.label}`);
  }

  console.log('\nFinal bs_lines:');
  const r = await turso.execute(
    'SELECT section, code, label, is_contra, is_derivable FROM bs_lines ORDER BY section, sort_order'
  );
  let lastSection = '';
  for (const row of r.rows) {
    if (row.section !== lastSection) {
      console.log(`\n[${row.section}]`);
      lastSection = row.section;
    }
    const flags = [
      row.is_contra ? 'contra' : null,
      row.is_derivable ? 'derived' : 'override-only',
    ].filter(Boolean).join(', ');
    console.log(`  ${String(row.code).padEnd(34)} ${row.label}  (${flags})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
