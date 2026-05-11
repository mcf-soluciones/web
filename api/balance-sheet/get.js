import { deriveBalanceSheet } from '../_lib/balance-sheet.js';

/**
 * GET /api/balance-sheet/get?yyyy=&mm=
 *
 * Single-period balance sheet (derived + overrides applied), as produced by
 * api/_lib/balance-sheet.js#deriveBalanceSheet.
 *
 * Response shape:
 *   {
 *     period: { yyyy, mm, period_end },
 *     anchor_date: string|null,
 *     lines: [{
 *       code, section, label, sort_order,
 *       is_contra, is_derivable, derivation_note,
 *       opening, derived, amount, source,                  // 'opening' | 'derived' | 'override'
 *       override: { amount, notes, yyyy, mm, ... } | null,
 *       breakdown: { ... } | null
 *     }],
 *     totals: { assets, liabilities, equity, balance_check }
 *   }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const yyyy = parseInt(req.query.yyyy, 10);
    const mm = parseInt(req.query.mm, 10);
    if (!yyyy || !mm || mm < 1 || mm > 12) {
      return res.status(400).json({ error: 'yyyy and mm (1-12) are required' });
    }
    const bs = await deriveBalanceSheet(yyyy, mm);
    return res.status(200).json(bs);
  } catch (err) {
    console.error('balance-sheet/get error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
