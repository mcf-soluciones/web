/**
 * Projection compute engine. Pure function — no DB writes.
 *
 *   computeProjection(baseline, payload)
 *     -> { months, pnl, cashflow, balance_sheet, investment_metrics }
 *
 * Inputs:
 *   baseline   the response object from /api/projections/baseline
 *   payload    user scenario (see baseline.md / docstring on schema)
 *
 * Output (per statement):
 *   pnl: {
 *     months: [{yyyy, mm}, ...12],                                          // baseline window
 *     forward_months: [{yyyy, mm}, ...12],                                  // M+1 .. M+12
 *     by_cuenta: [{ cuenta, label, letter, baseline[12], projected[12], delta[12] }],
 *     totals: {
 *       revenue:     { baseline[12], projected[12], delta[12] },
 *       expenses:    { baseline[12], projected[12], delta[12] },
 *       depreciation:{ baseline[12], projected[12], delta[12] },
 *       net_income:  { baseline[12], projected[12], delta[12] },
 *     },
 *   }
 *   cashflow: { rows[], totals }
 *   balance_sheet: { months[12], lines[] }
 *   investment_metrics: { npv, irr, payback_period, roi, cash_on_cash, ... }
 *
 * Conventions:
 *   - All forward 12 months derived from baseline by replicating the same
 *     month index from the T12M window (month-of-year matched, plus a price-
 *     increase factor compounded yearly). E.g. forward Jun 2026 mirrors
 *     baseline Jun 2025, scaled by (1 + price_increase_rate)^1.
 *   - "Baseline" arrays in output = MCF as-is (no adjustments, no new sucursal).
 *   - "Projected" = baseline + adjustments + new sucursal + capex effects + new loans.
 *   - "Delta" = projected − baseline.
 */

// =============================================================================
// Helpers
// =============================================================================

const ZERO12 = () => Array.from({ length: 12 }, () => 0);
const sum = (arr) => arr.reduce((s, v) => s + v, 0);

function ymKey(y, m) { return `${y}-${m}`; }

function addMonths(yyyy, mm, n) {
  const t = yyyy * 12 + mm - 1 + n;
  return { yyyy: Math.floor(t / 12), mm: (t % 12) + 1 };
}

// Linear-amortization PMT (for new loans)
function pmt(principal, annualRatePct, months) {
  const r = (annualRatePct / 100) / 12;
  if (!r) return principal / months;
  return principal * r / (1 - Math.pow(1 + r, -months));
}

// Build amortization schedule: [{ month, interest, principal, balance }, ...months]
function amortSchedule(principal, annualRatePct, months) {
  const r = (annualRatePct / 100) / 12;
  const monthlyPay = pmt(principal, annualRatePct, months);
  const out = [];
  let balance = principal;
  for (let i = 0; i < months; i++) {
    const interest = balance * r;
    const princ = Math.min(balance, monthlyPay - interest);
    balance = Math.max(0, balance - princ);
    out.push({ month: i + 1, interest, principal: princ, balance });
  }
  return out;
}

// Net Present Value
function npv(rate, cashflows) {
  let v = 0;
  for (let t = 0; t < cashflows.length; t++) {
    v += cashflows[t] / Math.pow(1 + rate, t);
  }
  return v;
}

// Internal Rate of Return — bisection
function irr(cashflows) {
  let lo = -0.99, hi = 10;
  let nLo = npv(lo, cashflows);
  let nHi = npv(hi, cashflows);
  if (nLo * nHi > 0) return null;                                             // no sign change
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const nMid = npv(mid, cashflows);
    if (Math.abs(nMid) < 0.01) return mid;
    if (nLo * nMid < 0) { hi = mid; nHi = nMid; }
    else { lo = mid; nLo = nMid; }
  }
  return (lo + hi) / 2;
}

// =============================================================================
// Main
// =============================================================================

export function computeProjection(baseline, payload) {
  const p = normalizePayload(payload);
  const baseMonths = baseline.window.months;                                  // 12 baseline months
  const { yyyy: anchorY, mm: anchorM } = baseline.period;

  // Inclusion rule for the new-sucursal list:
  //   - kind = 'new_sucursal' or unset → include all sucursales in the array
  //   - kind = 'mixto'                  → include all (no per-sucursal toggle)
  //   - other kinds                     → ignore the list
  const sucursales = (() => {
    const k = p.kind || 'new_sucursal';
    if (k === 'new_sucursal' || k === 'mixto') return Array.isArray(p.new_sucursales) ? p.new_sucursales : [];
    return [];
  })();

  // Forward window: starts at the EARLIEST sucursal start_month set in any
  // sucursal. If none has one, falls back to anchor + 1. This guarantees the
  // 12-month horizon covers the first sucursal's first year of operation.
  let forwardStart = null;
  for (const ns of sucursales) {
    if (!ns.start_month) continue;
    const m = String(ns.start_month).match(/^(\d{4})-(\d{2})$/);
    if (!m) continue;
    const yy = Number(m[1]), mm = Number(m[2]);
    if (!forwardStart || (yy * 12 + mm) < (forwardStart.yyyy * 12 + forwardStart.mm)) {
      forwardStart = { yyyy: yy, mm };
    }
  }
  if (!forwardStart) forwardStart = addMonths(anchorY, anchorM, 1);
  const forwardMonths = [];
  for (let i = 0; i < 12; i++) {
    forwardMonths.push(addMonths(forwardStart.yyyy, forwardStart.mm, i));
  }

  const priceFactor = 1 + ((p.investment.price_increase_rate || 0) / 100);
  const inflationFactor = 1 + ((p.investment.inflation_rate || 0) / 100);

  // ---- Build baseline monthly series for revenue + expenses by cuenta -----
  // Each forward month is matched to its calendar-equivalent in the T12M
  // window (e.g., forward Jun 26 → baseline Jun 25). When the T12M month has
  // no data (e.g., anchor = current month, partial data, or the line wasn't
  // touched in that month), we fall back to the same calendar month in the
  // most recent prior year that does have data. The fallback is tracked
  // per-line per-forward-month so the UI can display a "*" indicator.
  const baselineRevByMonth = ZERO12();
  const baselineExpByCuenta = {};
  const baselineExpByLetter = {};
  const baselineRevByPropiedadByMonth = {};
  const baselineExpByCuentaByPropiedad = {};
  const fallbackByCuenta = {};                                                // { cuenta: [bool x 12] }
  const fallbackByPropiedad = {};                                             // { propiedad: [bool x 12] }

  // T12M's calendar → key (e.g., 6 → '2025-6'). Engine uses as primary lookup.
  const t12KeyByMonth = {};
  for (const t of baseMonths) t12KeyByMonth[t.mm] = ymKey(t.yyyy, t.mm);

  // Cache per-line monthly averages so we don't recompute for every (line, month).
  // Used as the LAST-RESORT fallback for short-history lines (e.g., Hortaleza
  // C2 rent — only ~9 months of data, so no May/Jun/Jul in the window even
  // looking back years).
  const avgCache = new WeakMap();
  function monthlyAverage(byMonthMap) {
    if (avgCache.has(byMonthMap)) return avgCache.get(byMonthMap);
    const vals = [];
    for (const k of Object.keys(byMonthMap)) {
      const v = byMonthMap[k];
      if (typeof v === 'number' && v > 0) vals.push(v);
    }
    const avg = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    avgCache.set(byMonthMap, avg);
    return avg;
  }

  // Fallback chain for the calendar lookup, applied per-line:
  //   1. Primary: T12M's match for this calendar month.
  //   2. Same calendar month in any prior year within the wider window.
  //   3. Monthly average across all non-zero data for this line.
  function pickByCalendar(byMonthMap, calMonth) {
    const primaryKey = t12KeyByMonth[calMonth];
    const primaryYear = primaryKey ? Number(primaryKey.split('-')[0]) : null;
    const primaryVal = primaryKey ? (byMonthMap[primaryKey] || 0) : 0;
    if (primaryVal > 0 || !primaryYear) return { value: primaryVal, fallback: false };
    // Tier 2: prior years' same calendar month
    for (let y = primaryYear - 1; y >= primaryYear - 5; y--) {
      const k = `${y}-${calMonth}`;
      const v = byMonthMap[k] || 0;
      if (v > 0) return { value: v, fallback: true };
    }
    // Tier 3: line-level monthly average (covers short-history lines like
    // Hortaleza, whose pre-Aug-2025 months simply don't exist in any year).
    const avg = monthlyAverage(byMonthMap);
    if (avg > 0) return { value: avg, fallback: true };
    return { value: 0, fallback: false };
  }

  for (let i = 0; i < 12; i++) {
    const calMonth = forwardMonths[i].mm;
    // Revenue total + per propiedad
    for (const prop of Object.keys(baseline.pnl.revenue_by_propiedad)) {
      const { value, fallback } = pickByCalendar(baseline.pnl.revenue_by_propiedad[prop], calMonth);
      baselineRevByMonth[i] += value;
      if (!baselineRevByPropiedadByMonth[prop]) baselineRevByPropiedadByMonth[prop] = ZERO12();
      baselineRevByPropiedadByMonth[prop][i] += value;
      if (fallback && value > 0) {
        if (!fallbackByPropiedad[prop]) fallbackByPropiedad[prop] = Array(12).fill(false);
        fallbackByPropiedad[prop][i] = true;
      }
    }
    // Expenses
    for (const code of Object.keys(baseline.pnl.expenses_by_cuenta)) {
      const exp = baseline.pnl.expenses_by_cuenta[code];
      const { value, fallback } = pickByCalendar(exp.by_month, calMonth);
      if (!baselineExpByCuenta[code]) baselineExpByCuenta[code] = ZERO12();
      baselineExpByCuenta[code][i] += value;
      const letter = exp.letter;
      if (!baselineExpByLetter[letter]) baselineExpByLetter[letter] = ZERO12();
      baselineExpByLetter[letter][i] += value;
      if (fallback && value > 0) {
        if (!fallbackByCuenta[code]) fallbackByCuenta[code] = Array(12).fill(false);
        fallbackByCuenta[code][i] = true;
      }
      // Per propiedad
      for (const prop of Object.keys(exp.by_propiedad || {})) {
        const { value: vp } = pickByCalendar(exp.by_propiedad[prop], calMonth);
        if (!baselineExpByCuentaByPropiedad[code]) baselineExpByCuentaByPropiedad[code] = {};
        if (!baselineExpByCuentaByPropiedad[code][prop]) baselineExpByCuentaByPropiedad[code][prop] = ZERO12();
        baselineExpByCuentaByPropiedad[code][prop][i] += vp;
      }
    }
  }

  // ---- Build PROJECTED revenue per month ----------------------------------
  // Start: baseline (price-scaled). Apply each existing-sucursal sales
  // adjustment from its start_month onward.
  const projectedRevByPropiedad = {};
  for (const prop of Object.keys(baselineRevByPropiedadByMonth)) {
    projectedRevByPropiedad[prop] = baselineRevByPropiedadByMonth[prop].map(v => v * priceFactor);
  }
  for (const adj of (p.existing_adjustments || [])) {
    if (adj.kind !== 'sales_pct') continue;
    const target = String(adj.propiedad || '').toLowerCase();
    if (!projectedRevByPropiedad[target]) continue;
    const startIdx = adj.start_month ? monthIndex(forwardMonths, adj.start_month) : 0;
    const factor = 1 + ((Number(adj.value) || 0) / 100);
    for (let i = startIdx; i < 12; i++) {
      projectedRevByPropiedad[target][i] *= factor;
    }
  }

  // ---- New sucursales revenue per month -----------------------------------
  // Each sucursal contributes its own revenue stream from its start_month.
  // Seasonality is stored as percentages by CALENDAR month (idx 0 = Jan).
  const newSucursalRevByMonth = ZERO12();
  const sucursalRevByIdx = sucursales.map(() => ZERO12());                    // for per-sucursal investment metrics
  for (let si = 0; si < sucursales.length; si++) {
    const ns = sucursales[si];
    const annualSales = Number(ns.annual_sales) || 0;
    const pct = (ns.monthly_seasonality && ns.monthly_seasonality.length === 12)
      ? ns.monthly_seasonality.map(Number)
      : Array.from({ length: 12 }, () => 100/12);
    const pctSum = sum(pct) || 100;
    const startIdx = ns.start_month ? monthIndex(forwardMonths, ns.start_month) : 0;
    for (let i = 0; i < 12; i++) {
      const calMonth = forwardMonths[i].mm;
      const weight = pct[calMonth - 1] || 0;
      const monthly = annualSales * (weight / pctSum);
      const v = i >= startIdx ? monthly : 0;
      sucursalRevByIdx[si][i] = v;
      newSucursalRevByMonth[i] += v;
    }
  }

  // ---- Build PROJECTED expenses per cuenta --------------------------------
  // Start: baseline (inflation-scaled). Then add new-sucursal cost lines.
  // No adjustment kind for "cost change on existing" in v1 per user.
  const projectedExpByCuenta = {};
  for (const code of Object.keys(baselineExpByCuenta)) {
    projectedExpByCuenta[code] = baselineExpByCuenta[code].map(v => v * inflationFactor);
  }
  // Add cost lines from every sucursal in the scenario
  for (const ns of sucursales) {
    if (!Array.isArray(ns.cost_lines)) continue;
    const startIdx = ns.start_month ? monthIndex(forwardMonths, ns.start_month) : 0;
    for (const line of ns.cost_lines) {
      const code = line.cuenta;
      if (!code) continue;
      const monthlyAmt = Number(line.monthly) || 0;
      if (!projectedExpByCuenta[code]) projectedExpByCuenta[code] = ZERO12();
      for (let i = startIdx; i < 12; i++) projectedExpByCuenta[code][i] += monthlyAmt;
    }
  }

  // ---- Capex events: depreciation rows + cash impact ----------------------
  // Capex events create synthetic O.PROJ.{i} depreciation rows and reduce cash on event month.
  const capexEvents = (p.capex_events || []).map((ev, i) => ({
    id: i + 1,
    description: ev.description || `Capex #${i + 1}`,
    amount: Number(ev.amount) || 0,
    date: ev.date || null,
    depreciation_years: Math.max(1, Number(ev.depreciation_years) || 7),
  })).filter(e => e.amount > 0);

  const capexByMonth = ZERO12();                                              // cash out
  const capexDepreciationByEvent = {};                                        // { eventId: ZERO12() }
  let totalCapexDepreciationByMonth = ZERO12();
  for (const ev of capexEvents) {
    const mIdx = monthIndex(forwardMonths, ev.date);
    if (mIdx >= 0 && mIdx < 12) capexByMonth[mIdx] += ev.amount;
    const monthlyDep = ev.amount / (ev.depreciation_years * 12);
    const evDep = ZERO12();
    const startIdx = mIdx >= 0 ? mIdx : 0;
    for (let i = startIdx; i < 12; i++) evDep[i] = monthlyDep;
    capexDepreciationByEvent[ev.id] = evDep;
    totalCapexDepreciationByMonth = totalCapexDepreciationByMonth.map((v, i) => v + evDep[i]);
  }

  // ---- New loans: amortization schedule -----------------------------------
  // Each loan creates a CFS inflow at start (disbursement), monthly principal
  // and interest payments thereafter, and a liability balance.
  const extraLoans = (p.extra_loans || []).map((l, i) => ({
    id: i + 1,
    name: l.name || `Préstamo #${i + 1}`,
    principal: Number(l.principal) || 0,
    start_month: l.start_month || null,
    term_months: Math.max(1, Number(l.term_months) || 60),
    interest_rate: Number(l.interest_rate) || 0,
  })).filter(l => l.principal > 0);

  const loanInflowByMonth = ZERO12();
  const loanInterestByMonth = ZERO12();
  const loanPrincipalByMonth = ZERO12();
  const loanBalances = extraLoans.map(l => {
    const startIdx = monthIndex(forwardMonths, l.start_month);
    const sched = amortSchedule(l.principal, l.interest_rate, l.term_months);
    const balanceByMonth = ZERO12();
    if (startIdx >= 0 && startIdx < 12) loanInflowByMonth[startIdx] += l.principal;
    for (let i = 0; i < 12; i++) {
      const schedIdx = i - startIdx;                                          // 0-based after start
      if (schedIdx >= 0 && schedIdx < sched.length) {
        loanInterestByMonth[i] += sched[schedIdx].interest;
        loanPrincipalByMonth[i] += sched[schedIdx].principal;
        balanceByMonth[i] = sched[schedIdx].balance;
      } else if (schedIdx < 0) {
        balanceByMonth[i] = 0;                                                 // not started yet
      } else {
        balanceByMonth[i] = 0;                                                // paid off
      }
    }
    return { ...l, balance_by_month: balanceByMonth };
  });

  // ---- Investment financing (the main "purchase" loan from investment block)
  const inv = p.investment || {};
  const purchasePrice = Number(inv.purchase_price) || 0;
  const downPaymentPct = Number(inv.down_payment_pct) || 100;
  const investLoanPrincipal = purchasePrice * (1 - downPaymentPct / 100);
  const investSched = investLoanPrincipal > 0 && (inv.loan_term || 0) > 0
    ? amortSchedule(investLoanPrincipal, Number(inv.interest_rate) || 0, Number(inv.loan_term) * 12)
    : [];
  // The investment loan starts at the earliest sucursal start_month (matches
  // the forward window). If no sucursales, starts at month 0.
  const invStartIdx = sucursales.length > 0 && forwardStart
    ? 0                                                                       // forwardStart already = earliest sucursal start
    : 0;
  const investInterestByMonth = ZERO12();
  const investPrincipalByMonth = ZERO12();
  for (let i = 0; i < 12; i++) {
    const sIdx = i - invStartIdx;
    if (sIdx >= 0 && sIdx < investSched.length) {
      investInterestByMonth[i] = investSched[sIdx].interest;
      investPrincipalByMonth[i] = investSched[sIdx].principal;
    }
  }

  // ---- Project P&L by cuenta ---------------------------------------------
  // Build the full set of cuenta codes (existing + new from cost_lines + synthetic O/D)
  const cuentaSet = new Set([...Object.keys(baselineExpByCuenta), ...Object.keys(projectedExpByCuenta)]);
  for (const ns of sucursales) {
    if (!Array.isArray(ns.cost_lines)) continue;
    for (const line of ns.cost_lines) cuentaSet.add(line.cuenta);
  }

  // Catalog lookups for labels
  const catalog = baseline.pnl.catalog || {};

  const pnlByCuenta = [];
  for (const code of cuentaSet) {
    const meta = catalog[code] || {};
    const baselineArr = baselineExpByCuenta[code] || ZERO12();
    const projectedArr = projectedExpByCuenta[code] || ZERO12();
    const deltaArr = projectedArr.map((v, i) => v - baselineArr[i]);
    // Disambiguate property variants in label (E1 Usera vs E2 Hortaleza vs E3 Compra TBC)
    const propLabel = (() => {
      const p = String(meta.propiedad || '').toLowerCase();
      if (p.includes('usera')) return 'Usera';
      if (p.includes('hortaleza')) return 'Hortaleza';
      if (p.includes('compra tbc')) return 'Sucursal nueva';
      if (p.includes('corporate')) return 'Corporate';
      return '';
    })();
    const desc = meta.desc || code;
    pnlByCuenta.push({
      cuenta: code,
      letter: code.charAt(0).toUpperCase(),
      label: propLabel ? `${desc} — ${propLabel}` : desc,
      baseline: baselineArr,
      projected: projectedArr,
      delta: deltaArr,
      baseline_fallback: fallbackByCuenta[code] || Array(12).fill(false),
    });
  }
  // Add synthetic depreciation rows for each new sucursal (linear monthly).
  for (let si = 0; si < sucursales.length; si++) {
    const ns = sucursales[si];
    const depAnnual = Number(ns.depreciation_annual) || 0;
    if (!depAnnual) continue;
    const startIdx = ns.start_month ? monthIndex(forwardMonths, ns.start_month) : 0;
    const monthly = depAnnual / 12;
    const arr = ZERO12();
    for (let i = startIdx; i < 12; i++) arr[i] = monthly;
    pnlByCuenta.push({
      cuenta: `O.PROJ.S${si + 1}`,
      letter: 'O',
      label: `Depreciación — ${ns.name || ('Sucursal #' + (si + 1))}`,
      baseline: ZERO12(),
      projected: arr,
      delta: arr.slice(),
      synthetic: 'new_sucursal_depreciation',
    });
  }
  // Add synthetic capex depreciation rows
  for (const ev of capexEvents) {
    const code = `O.PROJ.${ev.id}`;
    const projectedArr = capexDepreciationByEvent[ev.id];
    pnlByCuenta.push({
      cuenta: code,
      letter: 'O',
      label: `Depreciación capex — ${ev.description}`,
      baseline: ZERO12(),
      projected: projectedArr,
      delta: projectedArr.slice(),
      synthetic: 'capex_depreciation',
    });
  }
  // Add synthetic D rows for extra loans + investment loan interest
  for (const l of loanBalances) {
    const code = `D.PROJ.${l.id}`;
    const projectedArr = ZERO12();
    const startIdx = monthIndex(forwardMonths, l.start_month);
    const sched = amortSchedule(l.principal, l.interest_rate, l.term_months);
    for (let i = 0; i < 12; i++) {
      const sIdx = i - startIdx;
      if (sIdx >= 0 && sIdx < sched.length) projectedArr[i] = sched[sIdx].interest;
    }
    pnlByCuenta.push({
      cuenta: code,
      letter: 'D',
      label: `Interés — ${l.name}`,
      baseline: ZERO12(),
      projected: projectedArr,
      delta: projectedArr.slice(),
      synthetic: 'extra_loan_interest',
    });
  }
  if (investLoanPrincipal > 0) {
    pnlByCuenta.push({
      cuenta: 'D.PROJ.investment',
      letter: 'D',
      label: 'Interés — Financiamiento inversión',
      baseline: ZERO12(),
      projected: investInterestByMonth,
      delta: investInterestByMonth.slice(),
      synthetic: 'investment_loan_interest',
    });
  }
  // Sort by cuenta code
  pnlByCuenta.sort((a, b) => a.cuenta.localeCompare(b.cuenta));

  // ---- P&L totals ---------------------------------------------------------
  const baselineRevenueArr = ZERO12();
  for (const prop of Object.keys(baselineRevByPropiedadByMonth)) {
    for (let i = 0; i < 12; i++) baselineRevenueArr[i] += baselineRevByPropiedadByMonth[prop][i];
  }
  const projectedRevenueArr = ZERO12();
  for (const prop of Object.keys(projectedRevByPropiedad)) {
    for (let i = 0; i < 12; i++) projectedRevenueArr[i] += projectedRevByPropiedad[prop][i];
  }
  for (let i = 0; i < 12; i++) projectedRevenueArr[i] += newSucursalRevByMonth[i];

  const baselineExpensesTotal = ZERO12();
  const projectedExpensesTotal = ZERO12();
  let baselineDepArr = ZERO12();
  let projectedDepArr = ZERO12();

  for (const row of pnlByCuenta) {
    if (row.letter === 'O') {
      for (let i = 0; i < 12; i++) {
        baselineDepArr[i] += row.baseline[i];
        projectedDepArr[i] += row.projected[i];
      }
    } else {
      for (let i = 0; i < 12; i++) {
        baselineExpensesTotal[i] += row.baseline[i];
        projectedExpensesTotal[i] += row.projected[i];
      }
    }
  }

  const baselineNiArr = baselineRevenueArr.map((r, i) => r - baselineExpensesTotal[i] - baselineDepArr[i]);
  const projectedNiArr = projectedRevenueArr.map((r, i) => r - projectedExpensesTotal[i] - projectedDepArr[i]);

  // ---- Revenue rows by source (existing propiedades + new sucursales) -----
  // Each row has the same shape as pnlByCuenta items so the UI can render
  // them with the same fmtEstadosCell helper.
  const propLabelMap = { usera: 'Usera', hortaleza: 'Hortaleza', corporate: 'Corporate' };
  const revenueRows = [];
  for (const prop of Object.keys(baselineRevByPropiedadByMonth)) {
    const baseline = baselineRevByPropiedadByMonth[prop] || ZERO12();
    const projected = projectedRevByPropiedad[prop] || baseline.slice();
    revenueRows.push({
      key: 'prop:' + prop,
      label: propLabelMap[prop] || prop,
      kind: 'existing',
      baseline,
      projected,
      delta: projected.map((v, i) => v - baseline[i]),
      baseline_fallback: fallbackByPropiedad[prop] || Array(12).fill(false),
    });
  }
  for (let si = 0; si < sucursales.length; si++) {
    const ns = sucursales[si];
    const projected = sucursalRevByIdx[si];
    revenueRows.push({
      key: 'new:' + si,
      label: (ns.name || 'Sucursal #' + (si + 1)) + ' (nueva)',
      kind: 'new',
      baseline: ZERO12(),
      projected,
      delta: projected.slice(),
      baseline_fallback: Array(12).fill(false),
    });
  }

  const pnl = {
    months: baseMonths,
    forward_months: forwardMonths,
    by_cuenta: pnlByCuenta,
    revenue_rows: revenueRows,
    totals: {
      revenue: {
        baseline: baselineRevenueArr,
        projected: projectedRevenueArr,
        delta: projectedRevenueArr.map((v, i) => v - baselineRevenueArr[i]),
        baseline_fallback: anyFallbackByMonth(fallbackByPropiedad),
      },
      expenses: {
        baseline: baselineExpensesTotal,
        projected: projectedExpensesTotal,
        delta: projectedExpensesTotal.map((v, i) => v - baselineExpensesTotal[i]),
        baseline_fallback: anyFallbackByMonth(fallbackByCuenta),
      },
      depreciation: {
        baseline: baselineDepArr,
        projected: projectedDepArr,
        delta: projectedDepArr.map((v, i) => v - baselineDepArr[i]),
      },
      net_income: {
        baseline: baselineNiArr,
        projected: projectedNiArr,
        delta: projectedNiArr.map((v, i) => v - baselineNiArr[i]),
        baseline_fallback: anyFallbackByMonth({ ...fallbackByPropiedad, ...fallbackByCuenta }),
      },
    },
  };

  // ---- Cash Flow Statement ------------------------------------------------
  // Build baseline + projected for each section.
  const baselineCfo = baselineNiArr.slice();                                  // simple proxy: NI ≈ CFO for v1
  const baselineCfi = ZERO12();                                               // no historical capex modeled forward
  const baselineCff = ZERO12();
  const baselineNetCash = baselineCfo.map((v, i) => v + baselineCfi[i] + baselineCff[i]);

  const projectedCfo = projectedNiArr.map((v, i) => v + projectedDepArr[i]);  // NI + depreciation (non-cash)
  const projectedCfi = ZERO12().map((_, i) => -capexByMonth[i]);
  const projectedCff = ZERO12();
  for (let i = 0; i < 12; i++) {
    projectedCff[i] += loanInflowByMonth[i];                                  // disbursements
    projectedCff[i] -= loanPrincipalByMonth[i];                               // principal repayment (extra loans)
    projectedCff[i] -= investPrincipalByMonth[i];                             // principal repayment (invest loan)
    if (investLoanPrincipal > 0 && i === invStartIdx) projectedCff[i] += investLoanPrincipal;
  }
  const projectedNetCash = projectedCfo.map((v, i) => v + projectedCfi[i] + projectedCff[i]);

  const cashflow = {
    months: forwardMonths,
    rows: [
      { key: 'cfo', label: 'Operativo (CFO)', baseline: baselineCfo, projected: projectedCfo, delta: projectedCfo.map((v,i)=>v-baselineCfo[i]) },
      { key: 'cfi', label: 'Inversión (CFI)', baseline: baselineCfi, projected: projectedCfi, delta: projectedCfi.map((v,i)=>v-baselineCfi[i]) },
      { key: 'cff', label: 'Financiamiento (CFF)', baseline: baselineCff, projected: projectedCff, delta: projectedCff.map((v,i)=>v-baselineCff[i]) },
      { key: 'net', label: 'Cambio neto en caja', baseline: baselineNetCash, projected: projectedNetCash, delta: projectedNetCash.map((v,i)=>v-baselineNetCash[i]) },
    ],
  };

  // ---- Balance Sheet roll-forward ----------------------------------------
  // Start from baseline.balance_sheet (the closing BS at the anchor period).
  const bsLines = baseline.balance_sheet.lines;
  const bsByCode = {};
  for (const L of bsLines) bsByCode[L.code] = L.amount;

  // Track BS values per forward month: { code: ZERO12 }
  const bsTimeseries = {};
  for (const code of Object.keys(bsByCode)) bsTimeseries[code] = ZERO12();

  // We track baseline BS as well (= flat at anchor values, since we have no
  // prediction logic for the as-is case; treats next 12 months as static).
  const bsBaselineTimeseries = {};
  for (const code of Object.keys(bsByCode)) bsBaselineTimeseries[code] = Array.from({ length: 12 }, () => bsByCode[code] || 0);

  // Track derived lines under the new PGC codes (see api/_lib/balance-sheet.js
  // for the BS-engine's matching derivation). Any line not in this dynamic set
  // gets copied verbatim from the anchor BS (static — override-only lines).
  const DYNAMIC_CODES = new Set([
    'A-C-7', 'A-NC-2', 'L-C-3-1', 'L-NC-2', 'E-FP-5', 'E-FP-7-2',
  ]);
  // Ensure each dynamic code has a series even if not present in the anchor BS.
  for (const code of DYNAMIC_CODES) {
    if (!bsTimeseries[code]) bsTimeseries[code] = ZERO12();
    if (!bsBaselineTimeseries[code]) {
      bsBaselineTimeseries[code] = Array.from({ length: 12 }, () => bsByCode[code] || 0);
    }
  }

  // Roll-forward state (single liquid-asset + net fixed-assets, per new PGC).
  let liquid = bsByCode['A-C-7'] || 0;
  let fixedNet = bsByCode['A-NC-2'] || 0;
  let loansCurr = bsByCode['L-C-3-1'] || 0;
  let loansNon = bsByCode['L-NC-2'] || 0;
  let retEarn = bsByCode['E-FP-5'] || 0;
  let curEarn = bsByCode['E-FP-7-2'] || 0;

  // Treat the anchor period as fiscal year-end-equivalent: current_earnings
  // rolls into retained on month 0 of the forward window, then accumulates fresh.
  retEarn += curEarn;
  curEarn = 0;

  for (let i = 0; i < 12; i++) {
    const ni = projectedNiArr[i];
    curEarn += ni;
    // Cash flow into the single liquid-asset line
    liquid += projectedNetCash[i];
    // Fixed-assets net: capex up, depreciation down
    fixedNet += capexByMonth[i] - projectedDepArr[i];
    // Loan balance roll: combine extra-loan balances + invest-loan balance
    let extraBal = 0;
    for (const l of loanBalances) extraBal += l.balance_by_month[i];
    let investBal = 0;
    if (investSched.length > 0) {
      const sIdx = i - invStartIdx;
      if (sIdx >= 0 && sIdx < investSched.length) investBal = investSched[sIdx].balance;
      else if (sIdx >= investSched.length) investBal = 0;
      else investBal = investLoanPrincipal;
    }
    const totalLoanBal = extraBal + investBal;
    let currentPart = 0;
    for (const l of loanBalances) {
      const startIdx = monthIndex(forwardMonths, l.start_month);
      const sched = amortSchedule(l.principal, l.interest_rate, l.term_months);
      for (let j = 1; j <= 12; j++) {
        const sIdx = i + j - startIdx;
        if (sIdx >= 0 && sIdx < sched.length) currentPart += sched[sIdx].principal;
      }
    }
    if (investSched.length > 0) {
      for (let j = 1; j <= 12; j++) {
        const sIdx = i + j - invStartIdx;
        if (sIdx >= 0 && sIdx < investSched.length) currentPart += investSched[sIdx].principal;
      }
    }
    loansCurr = Math.min(totalLoanBal, currentPart);
    loansNon = totalLoanBal - loansCurr;

    bsTimeseries['A-C-7'][i] = liquid;
    bsTimeseries['A-NC-2'][i] = fixedNet;
    bsTimeseries['L-C-3-1'][i] = loansCurr;
    bsTimeseries['L-NC-2'][i] = loansNon;
    bsTimeseries['E-FP-5'][i] = retEarn;
    bsTimeseries['E-FP-7-2'][i] = curEarn;
    // Static lines (override-only or other) keep their anchor value
    for (const code of Object.keys(bsByCode)) {
      if (DYNAMIC_CODES.has(code)) continue;
      bsTimeseries[code][i] = bsByCode[code] || 0;
    }
  }

  const bsResult = {
    months: forwardMonths,
    lines: bsLines.map(L => ({
      code: L.code,
      section: L.section,
      subsection: L.subsection || null,
      subgroup: L.subgroup || null,
      label: L.label,
      sort_order: L.sort_order,
      is_contra: L.is_contra,
      baseline: bsBaselineTimeseries[L.code],
      projected: bsTimeseries[L.code],
      delta: bsTimeseries[L.code].map((v, i) => v - bsBaselineTimeseries[L.code][i]),
    })),
  };

  // ---- Investment metrics (combined across all new sucursales) -----------
  // Build cash flows specific to the new sucursales group: -down_payment at
  // t=0, then monthly net cash from operations − loan service. Sums all
  // sucursales' contributions for combined NPV/IRR/payback.
  const sucursalAnnualCash = ZERO12();
  for (let si = 0; si < sucursales.length; si++) {
    const ns = sucursales[si];
    const startIdx = ns.start_month ? monthIndex(forwardMonths, ns.start_month) : 0;
    let costsMonthly = 0;
    for (const line of (ns.cost_lines || [])) costsMonthly += Number(line.monthly) || 0;
    const depMonthly = (Number(ns.depreciation_annual) || 0) / 12;
    for (let i = startIdx; i < 12; i++) {
      sucursalAnnualCash[i] += sucursalRevByIdx[si][i] - costsMonthly - depMonthly;
    }
  }
  const annualOperatingCash = sum(sucursalAnnualCash);
  const initialOutflow = -((purchasePrice * (downPaymentPct / 100)));
  const analysisYears = Math.max(1, Number(inv.analysis_period) || 5);
  const discountRate = (Number(inv.discount_rate) || 5) / 100;
  const terminalValue = Number(inv.terminal_value) || 0;
  const annualLoanService = sum(investInterestByMonth) + sum(investPrincipalByMonth);
  const annualNetCash = annualOperatingCash - annualLoanService;
  const cashflows = [initialOutflow];
  for (let y = 1; y <= analysisYears; y++) {
    cashflows.push(annualNetCash + (y === analysisYears ? terminalValue : 0));
  }
  const npvVal = npv(discountRate, cashflows);
  const irrVal = irr(cashflows);
  const cashOnCash = (initialOutflow !== 0) ? (annualNetCash / Math.abs(initialOutflow)) : 0;
  const roi = ((sum(cashflows) - 0) / Math.abs(initialOutflow || 1)) * 100;
  // Payback: years to recover initial outflow
  let cum = initialOutflow;
  let payback = NaN;
  for (let y = 1; y <= analysisYears; y++) {
    cum += annualNetCash + (y === analysisYears ? terminalValue : 0);
    if (cum >= 0 && isNaN(payback)) {
      payback = y - (cum - (annualNetCash + (y === analysisYears ? terminalValue : 0))) / (annualNetCash + (y === analysisYears ? terminalValue : 0));
      break;
    }
  }

  const investmentMetrics = {
    purchase_price: purchasePrice,
    down_payment: Math.abs(initialOutflow),
    loan_principal: investLoanPrincipal,
    annual_operating_cash: annualOperatingCash,
    annual_loan_service: annualLoanService,
    annual_net_income: annualNetCash,
    annual_cash_flow: annualNetCash,
    debt_service: annualLoanService,
    npv: npvVal,
    irr: irrVal,
    cash_on_cash: cashOnCash,
    roi,
    payback_period: payback,
    cashflows,
  };

  return {
    months: forwardMonths,
    pnl,
    cashflow,
    balance_sheet: bsResult,
    investment_metrics: investmentMetrics,
  };
}

// =============================================================================
// Helpers
// =============================================================================

// Aggregate per-month fallback flags across many source lines: result[i] = true
// if ANY source line used a fallback at month i.
function anyFallbackByMonth(maps) {
  const out = Array(12).fill(false);
  for (const key of Object.keys(maps || {})) {
    const arr = maps[key];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < 12; i++) if (arr[i]) out[i] = true;
  }
  return out;
}

function monthIndex(months, ymOrYyyyMm) {
  // Accept "YYYY-MM" string. Return 0-based index in months array, or -1.
  if (!ymOrYyyyMm) return 0;
  const s = String(ymOrYyyyMm).slice(0, 7);
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (!m) return 0;
  const y = Number(m[1]); const mm = Number(m[2]);
  for (let i = 0; i < months.length; i++) {
    if (months[i].yyyy === y && months[i].mm === mm) return i;
  }
  return 0;
}

function normalizePayload(p) {
  // Migrate legacy single new_sucursal → array form so old saved payloads
  // continue to work without a separate migration pass.
  let sucursales = Array.isArray(p.new_sucursales) ? p.new_sucursales : null;
  if (!sucursales && p.new_sucursal && typeof p.new_sucursal === 'object') {
    sucursales = [p.new_sucursal];
  }
  return {
    investment: p.investment || {},
    new_sucursales: sucursales || [],
    existing_adjustments: p.existing_adjustments || [],
    capex_events: p.capex_events || [],
    extra_loans: p.extra_loans || [],
    kind: p.kind || 'new_sucursal',
  };
}

export default computeProjection;
