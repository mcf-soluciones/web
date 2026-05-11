import turso from './turso.js';

/**
 * Balance sheet derivation engine.
 *
 *   deriveBalanceSheet(yyyy, mm)
 *     -> { period, lines[], totals: { assets, liabilities, equity, balance_check } }
 *
 * "Hybrid" model:
 *   - Lines flagged is_derivable = 1 are computed from sales / movements / gastos /
 *     loans / financing_events plus opening balances.
 *   - Lines flagged is_derivable = 0 default to opening balance (or 0).
 *   - bs_overrides for the same (yyyy, mm, line_code) — or any earlier period —
 *     replace the derived value. The most recent at-or-before-period override wins.
 *
 * Sign convention: every value is stored POSITIVE. Lines with is_contra = 1 are
 * subtracted from their section total (e.g., A.41.accumulated_depreciation).
 *
 * Cash split caveat: gastos has no payment-account column, so by default ALL
 * gastos cash outflows are attributed to A.11.bank. Petty-cash gastos exist in
 * reality (~€60k of movements rows tagged 'gasto') but they mirror gastos rows
 * for hub-balance tracking — counting them again would double-charge. If a user
 * wants a more accurate cash/bank split for a given period, they override.
 */

// =============================================================================
// Synthetic depreciation schedule (mirrors api/reports/pnl.js)
// =============================================================================

const O2_MONTHLY = 1800 / 12;                                                // €150/mo
const O2_RANGE = { start_yyyy: 2025, start_mm: 8, end_yyyy: 2032, end_mm: 8 };

function o2Monthly(yyyy, mm) {
  const t = yyyy * 12 + mm;
  const start = O2_RANGE.start_yyyy * 12 + O2_RANGE.start_mm;
  const end = O2_RANGE.end_yyyy * 12 + O2_RANGE.end_mm;
  return (t >= start && t <= end) ? O2_MONTHLY : 0;
}

function o2AccumulatedThrough(yyyy, mm) {
  const t = yyyy * 12 + mm;
  const start = O2_RANGE.start_yyyy * 12 + O2_RANGE.start_mm;
  const end = O2_RANGE.end_yyyy * 12 + O2_RANGE.end_mm;
  if (t < start) return 0;
  const upTo = Math.min(t, end);
  return (upTo - start + 1) * O2_MONTHLY;
}

// Synthetic IS (Impuesto sobre Sociedades) estimate, mirrors pnl.js N8.
// 20% of max(0, monthly EBITDA − depreciation). Reduces net income (E.30)
// and accrues into taxes_payable (L.20) — keeping the BS balanced AND
// agreeing with P&L's `neto.by_month` figures.
const N8_RATE = 0.20;
function n8Monthly(monthlyRevenue, monthlyExpenses, monthlyDepreciation) {
  // EBITDA = revenue − operating expenses (excludes depreciation, which is
  // already excluded from monthlyExpenses in this engine since the gastos
  // table contains no O-letter rows in practice; if it did, we'd subtract
  // them here too).
  const ebitda = monthlyRevenue - monthlyExpenses;
  return Math.max(0, ebitda - monthlyDepreciation) * N8_RATE;
}

// =============================================================================
// Tax cuenta classification — must match api/reports/pnl.js
// =============================================================================
//
// Passthrough cuentas reduce CASH but NOT P&L net income:
//   - N2 (Impuestos Sociedad): IS payments — accrued via N8/N8a, not by deducting
//     the N2 row itself. Counting both would double-charge the IS expense.
//   - N4, N5 (IVA pagado / IRPF retenido): cycle-net taxes that flow through.
//
// They still hit gastos.importe_total → A.11.bank derivation deducts them as
// real cash outflows. They just don't enter the NI calculation, and N2 in
// particular reduces the L.20.taxes_payable accrual built up by N8/N8a.

const PASSTHROUGH_TAX_CODES = new Set(['N2', 'N4', 'N5']);

// =============================================================================
// CFF event_type → bank-side sign + flag for which equity sub-line they affect
// =============================================================================

const FIN_BANK_SIGN = {
  disbursement: +1,                                                           // bank up; matched by loan liability
  equity_in: +1,                                                              // bank up; capital up
  equity_out: -1,                                                             // bank down; capital down
  fee_one_time: -1,                                                           // bank down; expensed (P&L)
  refinance: 0,                                                               // treated as cash-neutral for v1
};

// =============================================================================
// Period helpers
// =============================================================================

function periodEndDate(yyyy, mm) {
  // Last day of the given month, ISO yyyy-mm-dd
  const d = new Date(Date.UTC(yyyy, mm, 0));
  return d.toISOString().slice(0, 10);
}

function ymKey(y, m) { return `${y}-${m}`; }

// =============================================================================
// Main
// =============================================================================

export async function deriveBalanceSheet(yyyy, mm) {
  if (!yyyy || !mm || mm < 1 || mm > 12) {
    throw new Error('deriveBalanceSheet requires valid yyyy and mm (1-12)');
  }

  const periodEnd = periodEndDate(yyyy, mm);

  // Find the anchoring snapshot: latest snapshot with as_of_date <= period_end.
  // - If snapshot.as_of_date == period_end exactly → closed period: short-
  //   circuit and return snapshot values directly (with overrides on top).
  // - Else → use snapshot lines as openings + roll flows forward from
  //   (snapshot.as_of_date, period_end].
  // - No snapshot at all → derive everything from data start.
  const [linesRs, snapshotRs] = await Promise.all([
    turso.execute(
      `SELECT code, section, subsection, subgroup, label, sort_order, is_contra, is_derivable, derivation_note
       FROM bs_lines ORDER BY section, sort_order`
    ),
    turso.execute({
      sql: `SELECT id, as_of_date, yyyy AS s_yyyy, mm AS s_mm, name, notes, mode
            FROM bs_snapshots
            WHERE as_of_date <= ?
            ORDER BY as_of_date DESC
            LIMIT 1`,
      args: [periodEnd],
    }),
  ]);

  let snapshot = null;
  let snapLinesByCode = {};
  if (snapshotRs.rows.length > 0) {
    snapshot = snapshotRs.rows[0];
    const snapLinesRs = await turso.execute({
      sql: `SELECT line_code, amount FROM bs_snapshot_lines WHERE snapshot_id = ?`,
      args: [snapshot.id],
    });
    for (const r of snapLinesRs.rows) {
      snapLinesByCode[r.line_code] = Number(r.amount) || 0;
    }
  }

  // Anchor: snapshot.as_of_date if present, else no anchor (full history).
  const anchorDate = snapshot ? snapshot.as_of_date : '';
  const [anchorYyyy, anchorMm] = anchorDate
    ? anchorDate.slice(0, 7).split('-').map(Number)
    : [0, 0];

  // Inline gate clauses appended to each query's WHERE.
  // For date-string columns (sales.date_real, movements.date_real):
  //   "AND date_real > anchorDate"
  // For (yyyy, mm) pairs:
  //   "AND (yyyy > anchorY OR (yyyy = anchorY AND mm > anchorM))"
  // The matching args are conditionally spread.
  const gDate = anchorDate ? `AND date_real > '${anchorDate}'` : '';
  const gMonth = (yCol = 'yyyy', mCol = 'mm') => anchorDate
    ? `AND (${yCol} > ${anchorYyyy} OR (${yCol} = ${anchorYyyy} AND ${mCol} > ${anchorMm}))`
    : '';

  // Load overrides early — they're needed for both the closed-period short-
  // circuit AND the open-period derivation path.
  const overridesRs = await turso.execute({
    sql: `SELECT yyyy, mm, line_code, amount, notes, user_name, updated_at
          FROM bs_overrides
          WHERE (yyyy < ?) OR (yyyy = ? AND mm <= ?)`,
    args: [yyyy, yyyy, mm],
  });

  // ---------------------------------------------------------------------------
  // Closed-period short-circuit: if the snapshot date == period_end, the BS
  // is exactly the snapshot's lines (with overrides applied on top). Skip the
  // ~14 flow queries entirely.
  // ---------------------------------------------------------------------------
  if (snapshot && snapshot.as_of_date === periodEnd) {
    return buildClosedResponse({
      lines: linesRs.rows,
      snapLinesByCode,
      overridesRs,
      yyyy, mm, periodEnd, snapshot,
    });
  }

  const [
    cashSalesRs,
    bancoSalesRs,
    depositoRs,
    operGastosRs,
    capexRs,
    loanCashRs,
    principalByLoanRs,
    financingRs,
    loansRs,
    revenueByMonthRs,
    expensesByMonthRs,
    n2PaidRs,
    settlementsRs,
  ] = await Promise.all([
    // ---- Cash & bank flows (cumulative through period end, post-anchor) ----
    turso.execute({
      sql: `SELECT COALESCE(SUM(s.euros), 0) AS total
            FROM sales s
            WHERE s.account = 'cash' AND s.date_real <= ? ${gDate}`,
      args: [periodEnd],
    }),
    turso.execute({
      sql: `SELECT COALESCE(SUM(s.euros), 0) AS total
            FROM sales s
            WHERE s.account = 'banco' AND s.date_real <= ? ${gDate}`,
      args: [periodEnd],
    }),
    turso.execute({
      sql: `SELECT COALESCE(SUM(euros), 0) AS total
            FROM movements
            WHERE type = 'deposito' AND date_real <= ? ${gDate}`,
      args: [periodEnd],
    }),

    // ---- Gastos (operating, capex, loan-payment) ---------------------------
    turso.execute({
      sql: `SELECT COALESCE(SUM(COALESCE(importe_total, gasto, 0)), 0) AS total
            FROM gastos
            WHERE COALESCE(es_inversion, 'No') = 'No'
              AND loan_id IS NULL
              AND yyyy IS NOT NULL
              AND ((yyyy < ?) OR (yyyy = ? AND mm <= ?))
              ${gMonth()}`,
      args: [yyyy, yyyy, mm],
    }),
    turso.execute({
      sql: `SELECT COALESCE(SUM(COALESCE(importe_total, gasto, 0)), 0) AS total
            FROM gastos
            WHERE es_inversion = 'Si'
              AND yyyy IS NOT NULL
              AND ((yyyy < ?) OR (yyyy = ? AND mm <= ?))
              ${gMonth()}`,
      args: [yyyy, yyyy, mm],
    }),
    // Total bank cash spent on loan payments (interest + principal — bank is
    // debited for the full row, even though only interest hits P&L).
    turso.execute({
      sql: `SELECT COALESCE(SUM(
                     COALESCE(loan_payment_interest, 0)
                   + COALESCE(loan_payment_principal, 0)
                   ), 0) AS total
            FROM gastos
            WHERE loan_id IS NOT NULL
              AND yyyy IS NOT NULL
              AND ((yyyy < ?) OR (yyyy = ? AND mm <= ?))
              ${gMonth()}`,
      args: [yyyy, yyyy, mm],
    }),
    // Per-loan principal paid to date (for outstanding-balance calc).
    // No anchor gate here: outstanding is a balance, not a flow — pre-anchor
    // payments must still reduce the loan balance.
    turso.execute({
      sql: `SELECT loan_id, COALESCE(SUM(COALESCE(loan_payment_principal, 0)), 0) AS principal_paid
            FROM gastos
            WHERE loan_id IS NOT NULL
              AND yyyy IS NOT NULL
              AND ((yyyy < ?) OR (yyyy = ? AND mm <= ?))
            GROUP BY loan_id`,
      args: [yyyy, yyyy, mm],
    }),

    // ---- Financing events (cumulative, by type) ----------------------------
    turso.execute({
      sql: `SELECT event_type, COALESCE(SUM(euros), 0) AS total
            FROM financing_events
            WHERE ((yyyy < ?) OR (yyyy = ? AND mm <= ?))
              ${gMonth()}
            GROUP BY event_type`,
      args: [yyyy, yyyy, mm],
    }),
    turso.execute(
      `SELECT id, name, principal_original, term_months, interest_rate, start_date, status
       FROM loans`
    ),

    // ---- Net-income inputs -------------------------------------------------
    // Revenue by (yyyy, mm) from sales_detail. Filters:
    //   - sd.company = 'mcf'       — exclude prior owners (edusanferric, cesar)
    //   - payment <> 'TARJETA CLIENTE' — exclude non-fiscal client-card payments
    //   - property_activation       — belt-and-suspenders date guard
    turso.execute({
      sql: `SELECT sd.yyyy, sd.mm, COALESCE(SUM(sd.euro), 0) AS revenue
            FROM sales_detail sd
            LEFT JOIN property_activation pa ON sd.property = pa.property
            WHERE sd.company = 'mcf'
              AND sd.payment <> 'TARJETA CLIENTE'
              AND (pa.start_date IS NULL OR sd.date >= pa.start_date)
              AND ((sd.yyyy < ?) OR (sd.yyyy = ? AND sd.mm <= ?))
              ${gMonth('sd.yyyy', 'sd.mm')}
            GROUP BY sd.yyyy, sd.mm`,
      args: [yyyy, yyyy, mm],
    }),
    // Operating + interest expense by (yyyy, mm) for NI calculation. Excludes:
    //   - capex (es_inversion='Si') — already on BS, not P&L
    //   - passthrough cuentas (N2/N4/N5) — they hit cash directly, not NI
    //   - loan principal rows (only interest is a P&L expense)
    // The passthrough exclusion mirrors api/reports/pnl.js so BS NI matches
    // P&L NI within the depreciation-add-back convention difference.
    turso.execute({
      sql: `SELECT g.yyyy, g.mm,
                   COALESCE(SUM(
                     CASE
                       WHEN g.loan_id IS NOT NULL THEN COALESCE(g.loan_payment_interest, 0)
                       ELSE COALESCE(g.importe_total, g.gasto, 0)
                     END
                   ), 0) AS expenses
            FROM gastos g
            WHERE COALESCE(g.es_inversion, 'No') = 'No'
              AND g.yyyy IS NOT NULL
              AND (g.cuenta IS NULL OR g.cuenta NOT IN ('N2', 'N4', 'N5'))
              AND ((g.yyyy < ?) OR (g.yyyy = ? AND g.mm <= ?))
              ${gMonth('g.yyyy', 'g.mm')}
            GROUP BY g.yyyy, g.mm`,
      args: [yyyy, yyyy, mm],
    }),

    // ---- Cumulative passthrough taxes paid (post-anchor) -------------------
    // N2 (IS), N4 (IVA), N5 (IRPF) are passthrough on the P&L side — they hit
    // cash but not net income. Each cash outflow already debited A.11.bank
    // via operGastosRs above; the offsetting credit must hit a liability,
    // otherwise the BS won't balance.
    //
    // We sweep all three into L.20.taxes_payable for v1. N2 settles the N8/N8a
    // accrual cleanly (sum of accruals over a closed year = sum of N2 paid).
    // N4/N5 don't have explicit accruals modeled yet — for them, L.20 acts as
    // a placeholder; if it goes negative the user should add an IVA/IRPF
    // accrual via override or wait for a future engine version that models
    // the full IVA cobrado / IVA pagado cycle.
    turso.execute({
      sql: `SELECT cuenta, COALESCE(SUM(COALESCE(importe_total, gasto, 0)), 0) AS total
            FROM gastos
            WHERE cuenta IN ('N2', 'N4', 'N5')
              AND COALESCE(es_inversion, 'No') = 'No'
              AND yyyy IS NOT NULL
              AND ((yyyy < ?) OR (yyyy = ? AND mm <= ?))
              ${gMonth()}
            GROUP BY cuenta`,
      args: [yyyy, yyyy, mm],
    }),

    // ---- tax_settlements: closed years use N8a (allocated actual_is) -------
    // For each closed year, monthly accrual = actual_is × monthBase[m] / Σ
    // monthBase, where monthBase = max(0, rev − exp − dep). Total per closed
    // year sums to actual_is exactly.
    turso.execute(`SELECT yyyy, actual_is, year_profit_base FROM tax_settlements`),
  ]);

  // ---------------------------------------------------------------------------
  // Build derivation
  // ---------------------------------------------------------------------------

  const lines = linesRs.rows;
  // Openings come from the anchoring snapshot's lines (or 0 if no snapshot).
  const openingByCode = snapLinesByCode;
  const op = (code) => openingByCode[code] || 0;

  // Most recent at-or-before-period override per line
  const overridesByCode = {};
  for (const r of overridesRs.rows) {
    const t = Number(r.yyyy) * 12 + Number(r.mm);
    const cur = overridesByCode[r.line_code];
    if (!cur || cur._t < t) {
      overridesByCode[r.line_code] = {
        yyyy: Number(r.yyyy), mm: Number(r.mm),
        amount: Number(r.amount),
        notes: r.notes, user_name: r.user_name, updated_at: r.updated_at,
        _t: t,
      };
    }
  }

  // ---- Financing aggregates ------------------------------------------------
  let bankFromFinancing = 0;
  let equityFromEvents = 0;
  for (const r of financingRs.rows) {
    const sign = FIN_BANK_SIGN[r.event_type] ?? 0;
    const v = sign * Number(r.total || 0);
    bankFromFinancing += v;
    if (r.event_type === 'equity_in' || r.event_type === 'equity_out') {
      equityFromEvents += v;
    }
  }

  const cashSales = Number(cashSalesRs.rows[0]?.total || 0);
  const bancoSales = Number(bancoSalesRs.rows[0]?.total || 0);
  const depositoTotal = Number(depositoRs.rows[0]?.total || 0);
  const operGastos = Number(operGastosRs.rows[0]?.total || 0);
  const capex = Number(capexRs.rows[0]?.total || 0);
  const loanCashPaid = Number(loanCashRs.rows[0]?.total || 0);

  // ---- Cash & bank (combined → A-C-7 Efectivo y otros activos líquidos) ----
  // The new PGC chart has a single liquid-asset line. Old A.10.cash + A.11.bank
  // are summed; the cash↔bank "deposito" transfer is internal and nets to 0.
  const derivedLiquid = op('A-C-7')
                      + cashSales + bancoSales
                      - operGastos - capex - loanCashPaid + bankFromFinancing;

  // ---- Fixed assets (net book value → A-NC-2 Inmovilizado material) --------
  // PGC reports net (gross − accumulated depreciation) on one line; we track
  // the components only internally.
  const o2Acc = o2AccumulatedThrough(yyyy, mm);
  const fixedAssetsNet = op('A-NC-2') + capex - o2Acc;

  // ---- Loans current / non-current ----------------------------------------
  const principalPaidByLoan = Object.fromEntries(
    principalByLoanRs.rows.map(r => [r.loan_id, Number(r.principal_paid || 0)])
  );
  let loansCurrent = 0;
  let loansNonCurrent = 0;
  for (const l of loansRs.rows) {
    if ((l.status || 'active') !== 'active') continue;
    const paid = principalPaidByLoan[l.id] || 0;
    const outstanding = Math.max(0, Number(l.principal_original) - paid);
    if (outstanding === 0) continue;
    const term = Number(l.term_months) || 60;
    const startStr = String(l.start_date || '').slice(0, 7);
    const [sy, sm] = startStr.split('-').map(Number);
    const monthsElapsed = Math.max(0, (yyyy * 12 + mm) - (sy * 12 + sm));
    const monthsRemaining = Math.max(0, term - monthsElapsed);
    if (monthsRemaining === 0) {
      loansCurrent += outstanding;
    } else {
      // Linear-amortization approximation for v1 (good enough at the BS level).
      const monthlyPrincipal = outstanding / monthsRemaining;
      const next12 = Math.min(12, monthsRemaining);
      const cur = Math.min(outstanding, monthlyPrincipal * next12);
      loansCurrent += cur;
      loansNonCurrent += outstanding - cur;
    }
  }

  // ---- Net income (RE + current earnings) ---------------------------------
  const revByMonth = Object.fromEntries(
    revenueByMonthRs.rows.map(r => [ymKey(Number(r.yyyy), Number(r.mm)), Number(r.revenue) || 0])
  );
  const expByMonth = Object.fromEntries(
    expensesByMonthRs.rows.map(r => [ymKey(Number(r.yyyy), Number(r.mm)), Number(r.expenses) || 0])
  );
  const ymKeys = new Set([...Object.keys(revByMonth), ...Object.keys(expByMonth)]);

  // ---- N8 vs N8a: tax_settlements per year -------------------------------
  // For closed years, replace the N8 estimate with allocated N8a so that
  // Σ_m N8a[m] equals actual_is exactly. We need full-year monthBase data
  // to allocate proportionally; the existing revByMonth/expByMonth queries
  // are gated by period_end, so for closed years that we may be querying
  // mid-year, we need an extra full-year lookup.
  const settlementsByYear = {};
  for (const r of settlementsRs.rows) {
    settlementsByYear[Number(r.yyyy)] = {
      actual_is: Number(r.actual_is) || 0,
      year_profit_base: Number(r.year_profit_base) || 0,
    };
  }
  const closedYears = Object.keys(settlementsByYear).map(Number);
  // monthBase[y][m] = max(0, rev[y,m] − exp[y,m] − dep[y,m]); plus year_total
  const fullYearBases = {};
  if (closedYears.length > 0) {
    const placeholders = closedYears.map(() => '?').join(',');
    const [fullRevRs, fullExpRs] = await Promise.all([
      turso.execute({
        sql: `SELECT sd.yyyy, sd.mm, COALESCE(SUM(sd.euro), 0) AS revenue
              FROM sales_detail sd
              LEFT JOIN property_activation pa ON sd.property = pa.property
              WHERE sd.company = 'mcf'
                AND sd.payment <> 'TARJETA CLIENTE'
                AND (pa.start_date IS NULL OR sd.date >= pa.start_date)
                AND sd.yyyy IN (${placeholders})
              GROUP BY sd.yyyy, sd.mm`,
        args: closedYears,
      }),
      turso.execute({
        sql: `SELECT g.yyyy, g.mm,
                     COALESCE(SUM(
                       CASE WHEN g.loan_id IS NOT NULL THEN COALESCE(g.loan_payment_interest, 0)
                            ELSE COALESCE(g.importe_total, g.gasto, 0) END
                     ), 0) AS expenses
              FROM gastos g
              WHERE COALESCE(g.es_inversion, 'No') = 'No'
                AND (g.cuenta IS NULL OR g.cuenta NOT IN ('N2', 'N4', 'N5'))
                AND g.yyyy IN (${placeholders})
              GROUP BY g.yyyy, g.mm`,
        args: closedYears,
      }),
    ]);
    const yrRev = {};
    for (const r of fullRevRs.rows) yrRev[ymKey(Number(r.yyyy), Number(r.mm))] = Number(r.revenue) || 0;
    const yrExp = {};
    for (const r of fullExpRs.rows) yrExp[ymKey(Number(r.yyyy), Number(r.mm))] = Number(r.expenses) || 0;
    for (const y of closedYears) {
      const months = {};
      let total = 0;
      for (let m = 1; m <= 12; m++) {
        const rev = yrRev[ymKey(y, m)] || 0;
        const exp = yrExp[ymKey(y, m)] || 0;
        const base = Math.max(0, rev - exp - o2Monthly(y, m));
        months[m] = base;
        total += base;
      }
      fullYearBases[y] = { months, total };
    }
  }

  // n8Resolved(y, m) — picks N8a (closed year) or N8 (open year) per month.
  function n8Resolved(y, m, rev, exp, dep) {
    const settled = settlementsByYear[y];
    if (settled && settled.actual_is > 0 && fullYearBases[y]?.total > 0) {
      const base = fullYearBases[y].months[m] || 0;
      return settled.actual_is * (base / fullYearBases[y].total);
    }
    return n8Monthly(rev, exp, dep);
  }

  let priorYearsNI = 0;
  let ytdNI = 0;
  let priorYearsN8 = 0;
  let ytdN8 = 0;
  for (const k of ymKeys) {
    const [y, m] = k.split('-').map(Number);
    if (y > yyyy || (y === yyyy && m > mm)) continue;
    const rev = revByMonth[k] || 0;
    const exp = expByMonth[k] || 0;
    const dep = o2Monthly(y, m);
    const n8 = n8Resolved(y, m, rev, exp, dep);
    const ni = rev - exp - dep - n8;
    if (y < yyyy) { priorYearsNI += ni; priorYearsN8 += n8; }
    else { ytdNI += ni; ytdN8 += n8; }
  }

  // Year-boundary handling for retained / current earnings:
  //   - Snapshot in a PRIOR year: its E.30 (last year's full NI) rolls into
  //     E.20 retained earnings, and current-year E.30 starts fresh from
  //     post-snapshot ytdNI.
  //   - Snapshot in the SAME year: its E.30 already represents YTD NI through
  //     the snapshot date; carry it forward and add post-snapshot ytdNI.
  // Equity year-rollover: the running result line is E-FP-7-2. Prior-year
  // running results roll into E-FP-5 Resultados de Ejercicios Anteriores.
  const snapshotYyyy = snapshot ? Number(snapshot.s_yyyy) : null;
  const sameYearSnap = snapshotYyyy === yyyy;
  const carryForwardE30 = sameYearSnap ? op('E-FP-7-2') : 0;
  const rolledOverE30 = (snapshotYyyy != null && snapshotYyyy < yyyy)
    ? op('E-FP-7-2') : 0;

  const retainedEarnings = op('E-FP-5') + rolledOverE30 + priorYearsNI;
  const currentEarnings = carryForwardE30 + ytdNI;
  const capital = op('E-FP-1-1') + equityFromEvents;

  // L-C-5-3 Otros Acreedores = opening + N8/N8a accruals − N2/N4/N5 paid.
  // Each passthrough payment also debits A-C-7 via operGastos, so the
  // offsetting credit on L-C-5-3 keeps the balance check whole.
  const passthroughPaidByCuenta = {};
  for (const r of n2PaidRs.rows) {
    passthroughPaidByCuenta[r.cuenta] = Number(r.total) || 0;
  }
  const n2Paid = passthroughPaidByCuenta.N2 || 0;
  const n4Paid = passthroughPaidByCuenta.N4 || 0;
  const n5Paid = passthroughPaidByCuenta.N5 || 0;
  const totalPassthroughPaid = n2Paid + n4Paid + n5Paid;
  const taxesPayableDerived = op('L-C-5-3')
    + priorYearsN8 + ytdN8
    - totalPassthroughPaid;

  // ---- Per-line derivation registry --------------------------------------
  // Single source of truth: a line is derivable iff it appears here. The DB's
  // is_derivable flag is informational; the engine uses this map.
  //
  // Each entry: { value, breakdown, note }. The `note` overrides the line's
  // catalog description in the response so the UI tooltip can explain exactly
  // what the engine summed.
  const derivedByCode = {
    'A-C-7': {
      value: derivedLiquid,
      note: 'Opening (A-C-7) + ventas en efectivo + ventas con tarjeta banco − gastos operativos − capex − pagos de préstamos + eventos de financiamiento, todo desde el último snapshot. (Combina caja y bancos en una sola línea según PGC.)',
      breakdown: {
        opening: op('A-C-7'),
        sales_cash: cashSales,
        sales_banco: bancoSales,
        operating_gastos: -operGastos,
        capex: -capex,
        loan_payments_cash: -loanCashPaid,
        financing_events_net: bankFromFinancing,
      },
    },
    'A-NC-2': {
      value: fixedAssetsNet,
      note: 'Opening (A-NC-2, valor neto) + nuevos capex (es_inversion = "Si") − amortización del periodo. Mostrado como valor neto contable según convención PGC.',
      breakdown: {
        opening: op('A-NC-2'),
        capex,
        depreciation: -o2Acc,
      },
    },
    'L-C-3-1': {
      value: loansCurrent,
      note: 'Suma del principal programado para los próximos 12 meses por préstamo activo, limitado al saldo pendiente. Amortización lineal aproximada.',
      breakdown: { method: 'linear-amortization-next12m', loans_count: loansRs.rows.length },
    },
    'L-NC-2': {
      value: loansNonCurrent,
      note: 'Saldo pendiente total de préstamos activos − porción corriente (L-C-3-1).',
      breakdown: { method: 'outstanding − current', loans_count: loansRs.rows.length },
    },
    'L-C-5-3': {
      value: taxesPayableDerived,
      note: 'Opening (L-C-5-3) + acumulación N8/N8a (estimación 20% sobre EBITDA − depreciación, o IS real prorrateado cuando el año está cerrado) − pagos N2 (IS) − N4 (IVA) − N5 (IRPF). Override esta celda para ajustes manuales.',
      breakdown: {
        opening: op('L-C-5-3'),
        prior_years_n8: priorYearsN8,
        ytd_n8: ytdN8,
        n2_paid: -n2Paid,
        n4_paid: -n4Paid,
        n5_paid: -n5Paid,
      },
    },
    'E-FP-1-1': {
      value: capital,
      note: 'Opening (E-FP-1-1) + eventos de financiamiento equity_in − equity_out.',
      breakdown: { opening: op('E-FP-1-1'), equity_events_net: equityFromEvents },
    },
    'E-FP-5': {
      value: retainedEarnings,
      note: 'Opening (E-FP-5) + resultado del año anterior trasladado al cerrarse + net income acumulado de años estrictamente anteriores al año actual.',
      breakdown: {
        opening: op('E-FP-5'),
        rolled_over_prior_year_e30: rolledOverE30,
        prior_years_net_income: priorYearsNI,
      },
    },
    'E-FP-7-2': {
      value: currentEarnings,
      note: 'Net income acumulado desde el inicio del año fiscal hasta el periodo, antes del cierre. Al cerrar el año se traslada manualmente a E-FP-5 o E-FP-7-1 (Cuenta 129).',
      breakdown: {
        carry_forward_from_snapshot: carryForwardE30,
        post_snapshot_ytd_net_income: ytdNI,
      },
    },
  };

  // ---- Output --------------------------------------------------------------
  // is_derivable is determined by the engine map (single source of truth).
  // derivation_note comes from the engine for derived lines, from the catalog
  // (xlsx description) for everything else.
  const outLines = lines.map(L => {
    const code = L.code;
    const def = derivedByCode[code];
    const isDerivable = !!def;
    const opening = op(code);
    const derived = isDerivable ? def.value : opening;
    const ov = overridesByCode[code];
    const amount = ov ? Number(ov.amount) : derived;
    const source = ov ? 'override' : (isDerivable ? 'derived' : 'opening');
    return {
      code,
      section: L.section,
      subsection: L.subsection || null,
      subgroup: L.subgroup || null,
      label: L.label,
      sort_order: Number(L.sort_order) || 0,
      is_contra: !!L.is_contra,
      is_derivable: isDerivable,
      derivation_note: isDerivable ? def.note : (L.derivation_note || null),
      opening,
      derived,
      amount,
      source,
      override: ov ? {
        amount: Number(ov.amount),
        notes: ov.notes,
        yyyy: ov.yyyy,
        mm: ov.mm,
        user_name: ov.user_name,
        updated_at: ov.updated_at,
      } : null,
      breakdown: def?.breakdown ?? null,
    };
  });

  // Section totals (apply contra sign within section)
  const totals = { assets: 0, liabilities: 0, equity: 0 };
  for (const L of outLines) {
    const signed = L.is_contra ? -L.amount : L.amount;
    if (L.section === 'assets') totals.assets += signed;
    else if (L.section === 'liabilities') totals.liabilities += signed;
    else if (L.section === 'equity') totals.equity += signed;
  }
  totals.balance_check = totals.assets - totals.liabilities - totals.equity;

  return {
    period: { yyyy, mm, period_end: periodEnd },
    anchor_date: anchorDate || null,
    snapshot: snapshot ? {
      id: snapshot.id, as_of_date: snapshot.as_of_date, name: snapshot.name,
      mode: snapshot.mode, closed: false,
    } : null,
    lines: outLines,
    totals,
  };
}

// Closed-period response: snapshot.as_of_date == period_end exactly.
// Lines come straight from snapshot, overrides for the matching (yyyy, mm)
// replace those values. No flow derivation needed.
function buildClosedResponse({ lines, snapLinesByCode, overridesRs, yyyy, mm, periodEnd, snapshot }) {
  const overridesByCode = {};
  for (const r of overridesRs.rows) {
    if (Number(r.yyyy) !== yyyy || Number(r.mm) !== mm) continue;
    overridesByCode[r.line_code] = {
      yyyy: Number(r.yyyy), mm: Number(r.mm),
      amount: Number(r.amount),
      notes: r.notes, user_name: r.user_name, updated_at: r.updated_at,
    };
  }

  const outLines = lines.map(L => {
    const code = L.code;
    const snapAmount = snapLinesByCode[code] ?? 0;
    const ov = overridesByCode[code];
    const amount = ov ? Number(ov.amount) : snapAmount;
    const source = ov ? 'override' : 'snapshot';
    return {
      code,
      section: L.section,
      subsection: L.subsection || null,
      subgroup: L.subgroup || null,
      label: L.label,
      sort_order: Number(L.sort_order) || 0,
      is_contra: !!L.is_contra,
      is_derivable: !!L.is_derivable,
      derivation_note: L.derivation_note,
      opening: snapAmount,
      derived: snapAmount,
      amount,
      source,
      override: ov || null,
      breakdown: { from_snapshot: snapAmount, snapshot_id: snapshot.id, snapshot_date: snapshot.as_of_date },
    };
  });

  const totals = { assets: 0, liabilities: 0, equity: 0 };
  for (const L of outLines) {
    const signed = L.is_contra ? -L.amount : L.amount;
    if (L.section === 'assets') totals.assets += signed;
    else if (L.section === 'liabilities') totals.liabilities += signed;
    else if (L.section === 'equity') totals.equity += signed;
  }
  totals.balance_check = totals.assets - totals.liabilities - totals.equity;

  return {
    period: { yyyy, mm, period_end: periodEnd },
    anchor_date: snapshot.as_of_date,
    snapshot: {
      id: snapshot.id, as_of_date: snapshot.as_of_date, name: snapshot.name,
      mode: snapshot.mode, closed: true,
    },
    lines: outLines,
    totals,
  };
}

export default deriveBalanceSheet;
