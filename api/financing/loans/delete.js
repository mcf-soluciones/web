import turso from '../../_lib/turso.js';

/**
 * DELETE /api/financing/loans/delete?id=
 *
 * Refuses if any gastos or financing_events still reference the loan — clean
 * those up first or use a soft status='cancelled' instead.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const id = parseInt(req.query.id || (req.body && req.body.id), 10);
    if (!id) return res.status(400).json({ error: 'id is required' });

    const refs = await turso.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM gastos WHERE loan_id = ?) AS gastos_count,
              (SELECT COUNT(*) FROM financing_events WHERE loan_id = ?) AS events_count`,
      args: [id, id],
    });
    const { gastos_count, events_count } = refs.rows[0];
    if (Number(gastos_count) + Number(events_count) > 0) {
      return res.status(409).json({
        error: 'loan still referenced',
        gastos_count: Number(gastos_count),
        events_count: Number(events_count),
        hint: 'Reasigna o elimina esas filas primero, o cambia el estado a "cancelled".',
      });
    }
    const r = await turso.execute({ sql: `DELETE FROM loans WHERE id = ?`, args: [id] });
    return res.status(200).json({ success: true, rows_changed: Number(r.rowsAffected) || 0 });
  } catch (err) {
    console.error('financing/loans/delete error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
