import turso from '../_lib/turso.js';

/**
 * GET /api/reports/pivot?mm=3&yyyy=2026
 *
 * Single-month enriched rows for the Pivot Libre view. Same shape as
 * /api/reports/monthly but only one month and slimmer (no YoY wrapper).
 *
 * Response: { mm, yyyy, rows: [...] }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const mm = toInt(req.query.mm);
    const yyyy = toInt(req.query.yyyy);
    if (!mm || !yyyy) return res.status(400).json({ error: 'mm and yyyy are required' });

    const rs = await turso.execute({
      sql: `
        SELECT
          sd.date, sd.yyyy, sd.mm, sd.dd, sd.dayweek, sd.payment, sd.product,
          sd.euro, sd.price_list, sd.property,
          p.capacidad, p.product_price, p.product_size, p.product_mins,
          p.product_mission, p.subproducto
        FROM sales_detail sd
        LEFT JOIN products p
          ON sd.product = p.product
         AND sd.euro = p.precio
         AND sd.price_list = p.price_list
         AND sd.property = p.property
        WHERE sd.yyyy = ? AND sd.mm = ?
      `,
      args: [yyyy, mm],
    });

    const rows = rs.rows.map(row => {
      const r = { ...row };
      if (r.product === 'RECARGA') {
        r.product_mission = 'RECARGAS';
        r.product_size = 'TODAS';
        r.subproducto = 'RECARGAS';
        r.product_mins = 0;
      } else if (r.product === 'TARJETA') {
        r.product_mission = 'RECARGAS';
        r.product_size = 'TODAS';
        r.subproducto = 'TARJETA NUEVA';
        r.product_mins = 0;
      }
      return r;
    });

    return res.status(200).json({ mm, yyyy, rows });
  } catch (err) {
    console.error('reports/pivot error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
