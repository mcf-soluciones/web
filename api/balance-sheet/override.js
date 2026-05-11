import turso from '../_lib/turso.js';

/**
 * POST /api/balance-sheet/override
 *   body: { yyyy, mm, line_code, amount, notes?, user_name? }
 * Sets or replaces the override for (yyyy, mm, line_code). Upsert on the
 * unique (yyyy, mm, line_code) constraint.
 *
 * DELETE /api/balance-sheet/override?yyyy=&mm=&line_code=
 * (also accepts POST body for browsers that can't send DELETE)
 * Clears the override for (yyyy, mm, line_code).
 *
 * Both methods validate that line_code exists in bs_lines.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') return handleUpsert(req, res);
  if (req.method === 'DELETE') return handleDelete(req, res);

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleUpsert(req, res) {
  try {
    const b = req.body || {};
    const yyyy = parseInt(b.yyyy, 10);
    const mm = parseInt(b.mm, 10);
    const lineCode = String(b.line_code || '').trim();
    const amount = Number(b.amount);

    if (!yyyy || !mm || mm < 1 || mm > 12) {
      return res.status(400).json({ error: 'yyyy and mm (1-12) are required' });
    }
    if (!lineCode) {
      return res.status(400).json({ error: 'line_code is required' });
    }
    if (!Number.isFinite(amount)) {
      return res.status(400).json({ error: 'amount must be a finite number' });
    }

    // Validate line_code exists
    const lineCheck = await turso.execute({
      sql: `SELECT code FROM bs_lines WHERE code = ?`,
      args: [lineCode],
    });
    if (lineCheck.rows.length === 0) {
      return res.status(404).json({ error: `unknown line_code: ${lineCode}` });
    }

    await turso.execute({
      sql: `INSERT INTO bs_overrides (yyyy, mm, line_code, amount, notes, user_name, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(yyyy, mm, line_code) DO UPDATE SET
              amount = excluded.amount,
              notes = excluded.notes,
              user_name = excluded.user_name,
              updated_at = datetime('now')`,
      args: [yyyy, mm, lineCode, amount, b.notes || null, b.user_name || null],
    });

    return res.status(200).json({
      success: true,
      override: { yyyy, mm, line_code: lineCode, amount, notes: b.notes || null },
    });
  } catch (err) {
    console.error('balance-sheet/override POST error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDelete(req, res) {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const yyyy = parseInt(src.yyyy, 10);
    const mm = parseInt(src.mm, 10);
    const lineCode = String(src.line_code || '').trim();

    if (!yyyy || !mm || mm < 1 || mm > 12) {
      return res.status(400).json({ error: 'yyyy and mm (1-12) are required' });
    }
    if (!lineCode) {
      return res.status(400).json({ error: 'line_code is required' });
    }

    const r = await turso.execute({
      sql: `DELETE FROM bs_overrides WHERE yyyy = ? AND mm = ? AND line_code = ?`,
      args: [yyyy, mm, lineCode],
    });
    return res.status(200).json({
      success: true,
      rows_changed: Number(r.rowsAffected) || 0,
    });
  } catch (err) {
    console.error('balance-sheet/override DELETE error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
