import turso from '../../_lib/turso.js';

/**
 * DELETE /api/balance-sheet/snapshots/delete?id=
 * (also accepts POST body for browsers that can't send DELETE)
 *
 * Removes the snapshot row and all its bs_snapshot_lines (manual cascade).
 * Use this to "reopen" a closed period — the engine will fall back to the
 * previous snapshot (or no snapshot) and re-derive flows accordingly.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const id = parseInt(src.id, 10);
    if (!id) return res.status(400).json({ error: 'id is required' });

    const exists = await turso.execute({
      sql: `SELECT id, as_of_date, name FROM bs_snapshots WHERE id = ?`,
      args: [id],
    });
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: `snapshot ${id} not found` });
    }

    // Manual cascade: delete lines first, then the snapshot row.
    await turso.execute({
      sql: `DELETE FROM bs_snapshot_lines WHERE snapshot_id = ?`,
      args: [id],
    });
    const r = await turso.execute({
      sql: `DELETE FROM bs_snapshots WHERE id = ?`,
      args: [id],
    });

    return res.status(200).json({
      success: true,
      deleted: {
        id,
        as_of_date: exists.rows[0].as_of_date,
        name: exists.rows[0].name,
      },
      rows_changed: Number(r.rowsAffected) || 0,
    });
  } catch (err) {
    console.error('balance-sheet/snapshots/delete error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
