import { deriveBalanceSheet } from '../_lib/balance-sheet.js';

/**
 * GET /api/balance-sheet/timeseries?yyyy=&from_mm=1&to_mm=12
 *
 * Month-by-month balance sheet for a single year — drives the wide BS table
 * in the UI (rows = lines, columns = months).
 *
 * Query:
 *   yyyy      required
 *   from_mm   optional, default 1
 *   to_mm     optional, default 12
 *
 * Response:
 *   {
 *     yyyy, from_mm, to_mm,
 *     anchor_date,                                          // global anchor (same for every month)
 *     lines: [{ code, section, label, sort_order, is_contra, is_derivable }],
 *     periods: [
 *       {
 *         yyyy, mm, period_end,
 *         by_code: { [code]: { amount, source, derived, override?: { amount, notes } } },
 *         totals: { assets, liabilities, equity, balance_check }
 *       },
 *       ...
 *     ]
 *   }
 *
 * Notes:
 *   - Calls deriveBalanceSheet once per month. With ~14 SQL queries each, that's
 *     ~12 × 14 = ~170 queries per request. Acceptable for v1; if it gets slow we
 *     can refactor the engine to compute a year in a single pass.
 *   - Each period has the same `lines` metadata, so we only return the dictionary
 *     once at the top level and per-period values keyed by code.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const yyyy = parseInt(req.query.yyyy, 10);
    const fromMm = clampMm(parseInt(req.query.from_mm || '1', 10), 1);
    const toMm = clampMm(parseInt(req.query.to_mm || '12', 10), 12);
    if (!yyyy) return res.status(400).json({ error: 'yyyy is required' });
    if (fromMm > toMm) return res.status(400).json({ error: 'from_mm must be <= to_mm' });

    const periods = [];
    let lineMeta = null;
    let anchorDate = null;

    for (let mm = fromMm; mm <= toMm; mm++) {
      const bs = await deriveBalanceSheet(yyyy, mm);
      anchorDate = bs.anchor_date;
      if (!lineMeta) {
        lineMeta = bs.lines.map(L => ({
          code: L.code, section: L.section,
          subsection: L.subsection || null, subgroup: L.subgroup || null,
          label: L.label, sort_order: L.sort_order,
          is_contra: L.is_contra, is_derivable: L.is_derivable,
          derivation_note: L.derivation_note,
        }));
      }
      const by_code = {};
      for (const L of bs.lines) {
        by_code[L.code] = {
          amount: L.amount,
          source: L.source,
          derived: L.derived,
          opening: L.opening,
          override: L.override,
        };
      }
      periods.push({
        yyyy: bs.period.yyyy,
        mm: bs.period.mm,
        period_end: bs.period.period_end,
        snapshot: bs.snapshot || null,             // includes { closed: boolean } when present
        closed: !!(bs.snapshot && bs.snapshot.closed),
        by_code,
        totals: bs.totals,
      });
    }

    return res.status(200).json({
      yyyy, from_mm: fromMm, to_mm: toMm,
      anchor_date: anchorDate,
      lines: lineMeta || [],
      periods,
    });
  } catch (err) {
    console.error('balance-sheet/timeseries error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function clampMm(v, dflt) {
  if (!Number.isFinite(v) || v < 1 || v > 12) return dflt;
  return v;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
