import turso from '../_lib/turso.js';
import { deriveBalanceSheet } from '../_lib/balance-sheet.js';

/**
 * GET /api/projections/baseline?yyyy_mm=2026-04
 *
 * Returns everything a projection needs as input:
 *   - period:           { yyyy, mm } (anchor)
 *   - pnl:              T12M revenue + expenses by (yyyy, mm) × cuenta
 *   - cashflow:         T12M cash inflows/outflows by (yyyy, mm) × bucket
 *   - balance_sheet:    closing BS at the anchor (whole bs/get response)
 *   - sucursal_templates: per-property cost mix + monthly seasonality + annualized totals
 *
 * Time window: 12 months ending at (yyyy, mm) inclusive.
 *   from = (yyyy, mm) − 11 months
 *   to   = (yyyy, mm)
 *
 * The pnl + cashflow data uses the same filters as the existing reports
 * (company='mcf', payment <> 'TARJETA CLIENTE', property_activation guard,
 * passthrough cuentas excluded for NI). Sucursal templates derive from the
 * window so seasonality and cost mix reflect the most recent year.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const ym = String(req.query.yyyy_mm || '').trim();
    const m = ym.match(/^(\d{4})-(\d{2})$/);
    if (!m) return res.status(400).json({ error: 'yyyy_mm required (format YYYY-MM)' });
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);

    // Fetch wider window (24 months) so the engine can fall back to a prior
    // year when the primary T12M calendar month has no data (e.g., anchor is
    // the current month with partial-month data).
    const t12From = subMonths(yyyy, mm, 11);
    const from = subMonths(yyyy, mm, 23);                                    // 24-month inclusive window

    const [revRs, expRs, cashInRs, cashOutRs, capexRs, loanCashRs, finEvRs, propActRs, catalogRs, bs] =
      await Promise.all([
        // Revenue per (yyyy, mm, propiedad)
        turso.execute({
          sql: `SELECT sd.yyyy, sd.mm, sd.property AS propiedad,
                       COALESCE(SUM(sd.euro), 0) AS revenue
                FROM sales_detail sd
                LEFT JOIN property_activation pa ON sd.property = pa.property
                WHERE sd.company = 'mcf'
                  AND sd.payment <> 'TARJETA CLIENTE'
                  AND (pa.start_date IS NULL OR sd.date >= pa.start_date)
                  AND (sd.yyyy*100 + sd.mm) BETWEEN ? AND ?
                GROUP BY sd.yyyy, sd.mm, sd.property`,
          args: [from.yyyy*100 + from.mm, yyyy*100 + mm],
        }),
        // Expenses per (yyyy, mm, cuenta, propiedad) — non-capex, passthroughs excluded.
        // Loan rows: only interest portion is the P&L-relevant expense.
        turso.execute({
          sql: `SELECT g.yyyy, g.mm, g.cuenta, g.propiedad,
                       COALESCE(SUM(
                         CASE WHEN g.loan_id IS NOT NULL THEN COALESCE(g.loan_payment_interest, 0)
                              ELSE COALESCE(g.importe_total, g.gasto, 0) END
                       ), 0) AS amount
                FROM gastos g
                WHERE COALESCE(g.es_inversion, 'No') = 'No'
                  AND (g.cuenta IS NULL OR g.cuenta NOT IN ('N2','N4','N5'))
                  AND g.yyyy IS NOT NULL
                  AND (g.yyyy*100 + g.mm) BETWEEN ? AND ?
                GROUP BY g.yyyy, g.mm, g.cuenta, g.propiedad`,
          args: [from.yyyy*100 + from.mm, yyyy*100 + mm],
        }),
        // Cash inflows from sales table (cash + banco) — this is the actual money received
        turso.execute({
          sql: `SELECT CAST(substr(s.date_real, 1, 4) AS INTEGER) AS yyyy,
                       CAST(substr(s.date_real, 6, 2) AS INTEGER) AS mm,
                       s.account,
                       COALESCE(SUM(s.euros), 0) AS amount
                FROM sales s
                WHERE (CAST(substr(s.date_real, 1, 4) AS INTEGER) * 100
                       + CAST(substr(s.date_real, 6, 2) AS INTEGER)) BETWEEN ? AND ?
                GROUP BY yyyy, mm, s.account`,
          args: [from.yyyy*100 + from.mm, yyyy*100 + mm],
        }),
        // Cash outflows = ALL gastos (incl passthroughs) by month for cash flow
        turso.execute({
          sql: `SELECT g.yyyy, g.mm, g.cuenta,
                       COALESCE(SUM(COALESCE(g.importe_total, g.gasto, 0)), 0) AS amount
                FROM gastos g
                WHERE COALESCE(g.es_inversion, 'No') = 'No'
                  AND g.loan_id IS NULL
                  AND g.yyyy IS NOT NULL
                  AND (g.yyyy*100 + g.mm) BETWEEN ? AND ?
                GROUP BY g.yyyy, g.mm, g.cuenta`,
          args: [from.yyyy*100 + from.mm, yyyy*100 + mm],
        }),
        // Capex by month
        turso.execute({
          sql: `SELECT g.yyyy, g.mm,
                       COALESCE(SUM(COALESCE(g.importe_total, g.gasto, 0)), 0) AS amount
                FROM gastos g
                WHERE g.es_inversion = 'Si'
                  AND g.yyyy IS NOT NULL
                  AND (g.yyyy*100 + g.mm) BETWEEN ? AND ?
                GROUP BY g.yyyy, g.mm`,
          args: [from.yyyy*100 + from.mm, yyyy*100 + mm],
        }),
        // Loan cash (interest + principal) by month
        turso.execute({
          sql: `SELECT g.yyyy, g.mm,
                       COALESCE(SUM(COALESCE(g.loan_payment_interest, 0)), 0) AS interest,
                       COALESCE(SUM(COALESCE(g.loan_payment_principal, 0)), 0) AS principal
                FROM gastos g
                WHERE g.loan_id IS NOT NULL
                  AND g.yyyy IS NOT NULL
                  AND (g.yyyy*100 + g.mm) BETWEEN ? AND ?
                GROUP BY g.yyyy, g.mm`,
          args: [from.yyyy*100 + from.mm, yyyy*100 + mm],
        }),
        // Financing events by month
        turso.execute({
          sql: `SELECT yyyy, mm, event_type, COALESCE(SUM(euros), 0) AS amount
                FROM financing_events
                WHERE (yyyy*100 + mm) BETWEEN ? AND ?
                GROUP BY yyyy, mm, event_type`,
          args: [from.yyyy*100 + from.mm, yyyy*100 + mm],
        }),
        turso.execute(`SELECT property, start_date FROM property_activation`),
        turso.execute(
          `SELECT cuenta_mcf, categoria_gastos_mcf, desc, propiedad, tooltip FROM catalogo_cuentas`
        ),
        deriveBalanceSheet(yyyy, mm),
      ]);

    // ---- T12M months array (for indexing seasonality) ----------------------
    const t12 = [];
    for (let i = 11; i >= 0; i--) {
      const d = subMonths(yyyy, mm, i);
      t12.push({ yyyy: d.yyyy, mm: d.mm, key: `${d.yyyy}-${d.mm}` });
    }

    // ---- P&L baseline structure --------------------------------------------
    // pnl: { months: [{ yyyy, mm }], revenue_by_propiedad: { propiedad: by_month{} },
    //        expenses_by_cuenta: { cuenta: { meta, by_month, by_propiedad } } }
    const revenueByPropiedad = {};                                            // { propiedad: { '2025-5': X, ... } }
    for (const r of revRs.rows) {
      const prop = canonProp(r.propiedad);
      if (!revenueByPropiedad[prop]) revenueByPropiedad[prop] = {};
      revenueByPropiedad[prop][`${r.yyyy}-${r.mm}`] = Number(r.revenue) || 0;
    }

    const catalog = {};
    for (const r of catalogRs.rows) {
      catalog[r.cuenta_mcf] = {
        cuenta: r.cuenta_mcf,
        categoria: r.categoria_gastos_mcf,
        desc: r.desc,
        propiedad: r.propiedad,
        tooltip: r.tooltip,
      };
    }

    const expensesByCuenta = {};
    for (const r of expRs.rows) {
      const code = String(r.cuenta || '').trim();
      if (!code) continue;
      const prop = canonProp(r.propiedad);
      if (!expensesByCuenta[code]) {
        const meta = catalog[code] || { cuenta: code };
        expensesByCuenta[code] = {
          cuenta: code,
          letter: code.charAt(0).toUpperCase(),
          desc: meta.desc || code,
          categoria: meta.categoria,
          by_month: {},
          by_propiedad: {},                                                   // { propiedad: { '2025-5': X, ... } }
        };
      }
      const k = `${r.yyyy}-${r.mm}`;
      const v = Number(r.amount) || 0;
      expensesByCuenta[code].by_month[k] = (expensesByCuenta[code].by_month[k] || 0) + v;
      if (!expensesByCuenta[code].by_propiedad[prop]) expensesByCuenta[code].by_propiedad[prop] = {};
      expensesByCuenta[code].by_propiedad[prop][k] = (expensesByCuenta[code].by_propiedad[prop][k] || 0) + v;
    }

    // ---- Cashflow buckets --------------------------------------------------
    const cashflow = {
      months: t12.map(t => ({ yyyy: t.yyyy, mm: t.mm })),
      inflows_by_account: {},                                                 // 'cash' | 'banco' → by_month
      outflows_by_letter: {},                                                 // 'C'..'J' → by_month
      capex_by_month: {},
      loan_interest_by_month: {},
      loan_principal_by_month: {},
      financing_by_event: {},                                                 // event_type → by_month
    };
    for (const r of cashInRs.rows) {
      const acc = r.account || 'unknown';
      if (!cashflow.inflows_by_account[acc]) cashflow.inflows_by_account[acc] = {};
      cashflow.inflows_by_account[acc][`${r.yyyy}-${r.mm}`] = Number(r.amount) || 0;
    }
    for (const r of cashOutRs.rows) {
      const code = String(r.cuenta || '').trim();
      const letter = code.charAt(0).toUpperCase() || 'X';
      if (!cashflow.outflows_by_letter[letter]) cashflow.outflows_by_letter[letter] = {};
      const k = `${r.yyyy}-${r.mm}`;
      cashflow.outflows_by_letter[letter][k] = (cashflow.outflows_by_letter[letter][k] || 0) + (Number(r.amount) || 0);
    }
    for (const r of capexRs.rows) {
      cashflow.capex_by_month[`${r.yyyy}-${r.mm}`] = Number(r.amount) || 0;
    }
    for (const r of loanCashRs.rows) {
      cashflow.loan_interest_by_month[`${r.yyyy}-${r.mm}`] = Number(r.interest) || 0;
      cashflow.loan_principal_by_month[`${r.yyyy}-${r.mm}`] = Number(r.principal) || 0;
    }
    for (const r of finEvRs.rows) {
      const t = r.event_type;
      if (!cashflow.financing_by_event[t]) cashflow.financing_by_event[t] = {};
      cashflow.financing_by_event[t][`${r.yyyy}-${r.mm}`] = Number(r.amount) || 0;
    }

    // ---- Sucursal templates ------------------------------------------------
    // For each propiedad with revenue in the window:
    //   annual_sales: sum of monthly revenue
    //   monthly_seasonality: 12 normalized multipliers (sum to 12.0 → average month = 1.0)
    //   buckets: per-letter aggregation with per-cuenta breakdown
    const sucursalTemplates = {};
    const propsSeen = new Set([...Object.keys(revenueByPropiedad)]);
    // Also include propiedades in expenses
    for (const code of Object.keys(expensesByCuenta)) {
      for (const p of Object.keys(expensesByCuenta[code].by_propiedad)) propsSeen.add(p);
    }

    for (const prop of propsSeen) {
      const revByMonth = revenueByPropiedad[prop] || {};
      // Build calendar-month-aligned seasonality so [0] = January, [11] = December.
      // Primary source: T12M. If a calendar month has no T12M data (e.g.,
      // anchor = current month, partial data), fall back to the same calendar
      // month in older years (scan back up to ~5 years).
      const calMonthly = Array.from({ length: 12 }, () => 0);
      const calCount = Array.from({ length: 12 }, () => 0);
      for (const t of t12) {
        const v = revByMonth[t.key] || 0;
        if (v > 0) {
          calMonthly[t.mm - 1] += v;
          calCount[t.mm - 1] += 1;
        }
      }
      // Fallback tier 2: scan older years for the same calendar month.
      for (let cm = 1; cm <= 12; cm++) {
        if (calCount[cm - 1] > 0) continue;
        const t12Entry = t12.find(t => t.mm === cm);
        const startY = t12Entry ? t12Entry.yyyy - 1 : yyyy - 1;
        for (let y = startY; y >= startY - 4; y--) {
          const k = `${y}-${cm}`;
          const v = revByMonth[k] || 0;
          if (v > 0) {
            calMonthly[cm - 1] = v;
            calCount[cm - 1] = 1;
            break;
          }
        }
      }
      // Fallback tier 3: line-level monthly average (for short-history props
      // like Hortaleza). Fills any remaining 0 with the average of non-zero
      // months across the entire fetched window.
      const propNonZero = Object.values(revByMonth).filter(v => typeof v === 'number' && v > 0);
      if (propNonZero.length > 0) {
        const propAvg = propNonZero.reduce((s, v) => s + v, 0) / propNonZero.length;
        for (let cm = 1; cm <= 12; cm++) {
          if (calCount[cm - 1] === 0) {
            calMonthly[cm - 1] = propAvg;
            calCount[cm - 1] = 1;
          }
        }
      }
      for (let m = 0; m < 12; m++) {
        if (calCount[m] > 1) calMonthly[m] /= calCount[m];                    // average if multiple years overlap
      }
      const annualSales = calMonthly.reduce((s, v) => s + v, 0);
      const avgMonthly = annualSales / 12 || 1;
      const seasonality = calMonthly.map(v => annualSales > 0 ? (v / avgMonthly) : 1);

      // Buckets by letter, with by_cuenta breakdown
      const bucketsByLetter = {};
      for (const code of Object.keys(expensesByCuenta)) {
        const exp = expensesByCuenta[code];
        const propMonths = exp.by_propiedad[prop];
        if (!propMonths) continue;
        const letter = exp.letter;
        const annualForCuenta = t12.reduce((s, t) => s + (propMonths[t.key] || 0), 0);
        if (annualForCuenta === 0) continue;
        if (!bucketsByLetter[letter]) {
          bucketsByLetter[letter] = { letter, monthly_total: 0, by_cuenta: [] };
        }
        bucketsByLetter[letter].by_cuenta.push({
          cuenta: code,
          label: exp.desc,
          monthly: annualForCuenta / 12,
        });
      }
      // Compute monthly_total per bucket and ratios
      for (const b of Object.values(bucketsByLetter)) {
        b.monthly_total = b.by_cuenta.reduce((s, c) => s + c.monthly, 0);
        for (const c of b.by_cuenta) {
          c.ratio = b.monthly_total > 0 ? c.monthly / b.monthly_total : 0;
        }
        b.by_cuenta.sort((a, b2) => a.cuenta.localeCompare(b2.cuenta));
      }

      sucursalTemplates[prop] = {
        propiedad: prop,
        annual_sales: annualSales,
        monthly_seasonality: seasonality,
        buckets: bucketsByLetter,
      };
    }

    return res.status(200).json({
      period: { yyyy, mm, ym },
      window: { from, to: { yyyy, mm }, months: t12.map(t => ({ yyyy: t.yyyy, mm: t.mm })) },
      pnl: {
        revenue_by_propiedad: revenueByPropiedad,
        expenses_by_cuenta: expensesByCuenta,
        catalog,
      },
      cashflow,
      balance_sheet: bs,
      sucursal_templates: sucursalTemplates,
    });
  } catch (err) {
    console.error('projections/baseline error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function subMonths(yyyy, mm, n) {
  const t = yyyy * 12 + mm - 1 - n;                                           // 0-based month index
  const ny = Math.floor(t / 12);
  const nm = (t % 12) + 1;
  return { yyyy: ny, mm: nm };
}

function canonProp(p) {
  if (!p) return 'unknown';
  const s = String(p).toLowerCase();
  if (s.includes('usera')) return 'usera';
  if (s.includes('hortaleza')) return 'hortaleza';
  if (s.includes('corporate')) return 'corporate';
  return s;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
