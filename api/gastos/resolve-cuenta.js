import turso from '../_lib/turso.js';

/**
 * GET /api/gastos/resolve-cuenta?concepto_mcf=Alquiler%20(C)&propiedad=usera
 *
 * Input: concepto_mcf (e.g. "Alquiler (C)") + propiedad (short form like
 *   "usera", "hortaleza", "corporate" — or canonical like "(001) Usera").
 * Output: { cuenta, categoria_gastos_mcf, desc, tooltip, propiedad_canonical }
 * If no match: 404 with { error: 'no_match' }.
 *
 * Drives the detailed-entry form's auto-derived cuenta badge.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const conceptoMcf = String(req.query.concepto_mcf || '').trim();
    const propiedadRaw = String(req.query.propiedad || '').trim();
    if (!conceptoMcf || !propiedadRaw) {
      return res.status(400).json({ error: 'concepto_mcf and propiedad are required' });
    }

    // Canonicalize propiedad (short → long form used in catalogo_cuentas)
    const canonical = canonicalizePropiedad(propiedadRaw);

    // First try exact match on the canonical form.
    let rs = await turso.execute({
      sql: `SELECT cuenta_mcf, categoria_gastos_mcf, desc, tooltip, propiedad
            FROM catalogo_cuentas
            WHERE desc = ? AND propiedad = ?
            LIMIT 1`,
      args: [conceptoMcf, canonical],
    });

    // Fall back: case-insensitive substring match on propiedad (covers user
    // typing the raw value like "usera" if canonicalisation ever drifts).
    if (rs.rows.length === 0) {
      rs = await turso.execute({
        sql: `SELECT cuenta_mcf, categoria_gastos_mcf, desc, tooltip, propiedad
              FROM catalogo_cuentas
              WHERE desc = ? AND LOWER(propiedad) LIKE ?
              LIMIT 1`,
        args: [conceptoMcf, `%${propiedadRaw.toLowerCase()}%`],
      });
    }

    if (rs.rows.length === 0) {
      return res.status(404).json({
        error: 'no_match',
        message: `No catalogo_cuentas row for desc="${conceptoMcf}" × propiedad="${propiedadRaw}"`,
      });
    }

    const row = rs.rows[0];
    return res.status(200).json({
      cuenta: row.cuenta_mcf,
      categoria_gastos_mcf: row.categoria_gastos_mcf,
      desc: row.desc,
      tooltip: row.tooltip,
      propiedad_canonical: row.propiedad,
    });
  } catch (err) {
    console.error('gastos/resolve-cuenta error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function canonicalizePropiedad(raw) {
  const s = String(raw).trim().toLowerCase();
  if (/\(001\)|usera/.test(s)) return '(001) Usera';
  if (/\(002\)|hortaleza/.test(s)) return '(002) Hortaleza';
  if (/\(003\)|tbc|compra/.test(s)) return '(003) Compra TBC';
  if (/corporate/.test(s)) return 'Corporate';
  return raw; // last-resort passthrough
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
