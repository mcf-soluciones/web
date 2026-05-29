import turso from '../_lib/turso.js';

/**
 * GET /api/census/values?indicator=renta_media&yyyy=2023[&municipio=28079]
 *
 * Returns a flat object mapping seccion_id → value for the chosen indicator,
 * year, and optional municipio filter. Powers the choropleth fill colors.
 *
 * Response:
 *   {
 *     indicator: 'renta_media',
 *     yyyy: 2023,
 *     count: 5034,
 *     min: 7800, max: 95400,
 *     values: { '2807900101001': 28400, ... }
 *   }
 */
const ALLOWED_INDICATORS = new Set([
  'poblacion', 'renta_media', 'renta_hogar',
  'pct_extranjero', 'hogar_size', 'alquiler_m2', 'alquiler_growth',
]);

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const indicator = String(req.query.indicator || '').trim();
    const yyyy = toInt(req.query.yyyy);
    const municipio = String(req.query.municipio || '').trim() || null;
    if (!indicator || !ALLOWED_INDICATORS.has(indicator)) {
      return res.status(400).json({
        error: `indicator must be one of: ${[...ALLOWED_INDICATORS].join(', ')}`,
      });
    }
    if (!yyyy) return res.status(400).json({ error: 'yyyy is required' });

    const sql = municipio
      ? `SELECT seccion_id, "${indicator}" AS v
         FROM census_indicators
         WHERE yyyy = ? AND municipio_id = ? AND "${indicator}" IS NOT NULL`
      : `SELECT seccion_id, "${indicator}" AS v
         FROM census_indicators
         WHERE yyyy = ? AND "${indicator}" IS NOT NULL`;
    const args = municipio ? [yyyy, municipio] : [yyyy];
    const rs = await turso.execute({ sql, args });

    const values = {};
    let min = Infinity, max = -Infinity;
    for (const row of rs.rows) {
      const v = Number(row.v);
      values[row.seccion_id] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    return res.status(200).json({
      indicator,
      yyyy,
      municipio,
      count: rs.rows.length,
      min: rs.rows.length ? min : null,
      max: rs.rows.length ? max : null,
      values,
    });
  } catch (err) {
    console.error('census/values error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
