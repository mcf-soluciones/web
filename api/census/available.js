import turso from '../_lib/turso.js';

/**
 * GET /api/census/available
 *
 * Returns the (yyyy, indicator) combinations with at least one non-null value.
 * The frontend uses this to populate the year dropdown and disable indicators
 * that have no data yet.
 */
const INDICATORS = [
  'poblacion', 'renta_media', 'renta_hogar',
  'pct_extranjero', 'hogar_size', 'alquiler_m2', 'alquiler_growth',
];

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Build a single SQL that returns one row per yyyy with a COUNT for each
    // indicator. Fewer round trips than asking per (yyyy, indicator).
    const countCols = INDICATORS.map(k => `SUM(CASE WHEN "${k}" IS NOT NULL THEN 1 ELSE 0 END) AS ${k}`).join(', ');
    const rs = await turso.execute(
      `SELECT yyyy, COUNT(*) AS total, ${countCols}
       FROM census_indicators
       GROUP BY yyyy
       ORDER BY yyyy DESC`
    );

    const years = rs.rows.map(r => {
      const indicators = {};
      for (const k of INDICATORS) indicators[k] = Number(r[k]) || 0;
      return {
        yyyy: Number(r.yyyy),
        total: Number(r.total) || 0,
        indicators,
      };
    });

    return res.status(200).json({ indicators: INDICATORS, years });
  } catch (err) {
    console.error('census/available error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
