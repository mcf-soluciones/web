import turso from '../_lib/turso.js';

/**
 * DELETE /api/tax-settlements/delete?yyyy=2024   (also accepts POST { yyyy })
 *
 * Reopens a fiscal year. The P&L falls back to the synthetic N8 estimate for
 * that year on subsequent loads.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const yyyy = parseInt(req.query.yyyy ?? req.body?.yyyy, 10);
    if (!Number.isFinite(yyyy)) {
      return res.status(400).json({ error: 'yyyy is required' });
    }

    const rs = await turso.execute({
      sql: `DELETE FROM tax_settlements WHERE yyyy = ?`,
      args: [yyyy],
    });

    return res.status(200).json({
      success: true,
      yyyy,
      rows_deleted: Number(rs.rowsAffected) || 0,
    });
  } catch (err) {
    console.error('tax-settlements/delete error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
