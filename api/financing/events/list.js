import turso from '../../_lib/turso.js';

/**
 * GET /api/financing/events/list?yyyy=&mm=
 *   - mm optional (year-only listing if omitted)
 *
 * Returns all financing events plus the linked loan's name for display.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const yyyy = parseInt(req.query.yyyy, 10);
    const mm = req.query.mm ? parseInt(req.query.mm, 10) : null;
    if (!yyyy) return res.status(400).json({ error: 'yyyy is required' });

    const sql = mm
      ? `SELECT e.*, l.name AS loan_name, l.lender AS loan_lender
         FROM financing_events e LEFT JOIN loans l ON e.loan_id = l.id
         WHERE e.yyyy = ? AND e.mm = ?
         ORDER BY e.fecha DESC, e.id DESC`
      : `SELECT e.*, l.name AS loan_name, l.lender AS loan_lender
         FROM financing_events e LEFT JOIN loans l ON e.loan_id = l.id
         WHERE e.yyyy = ?
         ORDER BY e.fecha DESC, e.id DESC`;
    const args = mm ? [yyyy, mm] : [yyyy];
    const r = await turso.execute({ sql, args });
    const rows = r.rows.map(row => ({ ...row, euros: Number(row.euros) || 0 }));
    return res.status(200).json({ count: rows.length, rows });
  } catch (err) {
    console.error('financing/events/list error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
