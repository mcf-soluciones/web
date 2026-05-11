import turso from '../../_lib/turso.js';
import { deriveBalanceSheet } from '../../_lib/balance-sheet.js';

/**
 * POST /api/balance-sheet/snapshots/create
 *   body: {
 *     as_of_date: "YYYY-MM-DD",          // required, must be a real month-end
 *     name?: string,
 *     notes?: string,
 *     created_by?: string,
 *     mode: 'manual' | 'capture',         // required
 *     lines?: [{ line_code, amount }]    // required when mode='manual'
 *   }
 *
 * mode='manual': line values come from the request body. Used for the very
 *   first opening (e.g. 2024-12-31) where derivation isn't possible — data
 *   for that date doesn't exist yet.
 *
 * mode='capture': server runs deriveBalanceSheet() for the (yyyy, mm)
 *   matching as_of_date and persists every line's `amount` value (post-
 *   override). Used to "close" a month or quarter once the actuals are in.
 *
 * The endpoint refuses to create a duplicate snapshot for the same as_of_date
 * (UNIQUE constraint). To replace, DELETE first then create.
 *
 * Gating: like /api/auth/cuentas, this endpoint is unauthenticated. UI is
 * expected to gate behind adminMode.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};
    const asOfDate = String(b.as_of_date || '').trim();
    const mode = String(b.mode || '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      return res.status(400).json({ error: 'as_of_date must be YYYY-MM-DD' });
    }
    const [y, m, d] = asOfDate.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d !== lastDay) {
      return res.status(400).json({ error: `as_of_date must be a month-end (got ${asOfDate}; expected ${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')})` });
    }
    if (mode !== 'manual' && mode !== 'capture') {
      return res.status(400).json({ error: 'mode must be "manual" or "capture"' });
    }

    // Reject duplicate
    const dup = await turso.execute({
      sql: `SELECT id FROM bs_snapshots WHERE as_of_date = ?`,
      args: [asOfDate],
    });
    if (dup.rows.length > 0) {
      return res.status(409).json({
        error: `snapshot already exists for ${asOfDate}`,
        existing_id: Number(dup.rows[0].id),
        hint: 'DELETE first if you want to replace it.',
      });
    }

    // Build line values
    let lineValues;                                  // [{ line_code, amount }]
    if (mode === 'manual') {
      const reqLines = Array.isArray(b.lines) ? b.lines : null;
      if (!reqLines) {
        return res.status(400).json({ error: 'lines[] required when mode="manual"' });
      }
      lineValues = await validateAndCoerceManualLines(reqLines);
    } else {
      // capture: run engine, take post-override amounts
      const bs = await deriveBalanceSheet(y, m);
      lineValues = bs.lines.map(L => ({ line_code: L.code, amount: Number(L.amount) || 0 }));
    }

    // Insert snapshot + lines
    const ins = await turso.execute({
      sql: `INSERT INTO bs_snapshots (as_of_date, yyyy, mm, name, notes, created_by, mode)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [asOfDate, y, m, b.name || null, b.notes || null, b.created_by || null, mode],
    });
    const snapshotId = Number(ins.lastInsertRowid);

    for (const L of lineValues) {
      await turso.execute({
        sql: `INSERT INTO bs_snapshot_lines (snapshot_id, line_code, amount) VALUES (?, ?, ?)`,
        args: [snapshotId, L.line_code, L.amount],
      });
    }

    return res.status(200).json({
      success: true,
      snapshot: {
        id: snapshotId, as_of_date: asOfDate, yyyy: y, mm: m,
        mode, name: b.name || null, notes: b.notes || null,
        line_count: lineValues.length,
      },
    });
  } catch (err) {
    console.error('balance-sheet/snapshots/create error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function validateAndCoerceManualLines(reqLines) {
  // Validate each line_code exists; coerce amount to a finite number.
  const codesRs = await turso.execute(`SELECT code FROM bs_lines`);
  const validCodes = new Set(codesRs.rows.map(r => r.code));
  const out = [];
  for (const L of reqLines) {
    const code = String(L.line_code || '').trim();
    const amount = Number(L.amount);
    if (!code || !validCodes.has(code)) {
      throw new Error(`unknown line_code: ${code}`);
    }
    if (!Number.isFinite(amount)) {
      throw new Error(`amount for ${code} must be a finite number`);
    }
    out.push({ line_code: code, amount });
  }
  return out;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
