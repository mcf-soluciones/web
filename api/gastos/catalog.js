import turso from '../_lib/turso.js';

/**
 * GET /api/gastos/catalog
 *
 * Returns every valid (concepto × propiedad) combo from catalogo_cuentas that
 * can be used as a gasto entry. Filters out non-gasto categories (Ventas,
 * Margen, etc.) — the user only picks from expense-type rows.
 *
 * The UI uses this to:
 *   - Build the concepto dropdown per propiedad
 *   - Disable concepto dropdown options that don't exist for the current propiedad
 *
 * Response:
 *   {
 *     rows: [ { cuenta, categoria_gastos_mcf, desc, propiedad, tooltip }, ... ],
 *     by_propiedad: { "(001) Usera": ["Alquiler (C)", ...], ... },
 *     all_descs: ["Alquiler (C)", "Operaciones (J)", ...]   (unique, sorted)
 *   }
 */
const GASTOS_CATEGORIES = new Set([
  'Fijos', 'Variables', 'Impuestos', 'Virtuales',
  'Adquisición o Inversiones',   // Z letter — capex (shows in CF Inversión)
]);

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Exclude code families that are informational / derived (not user-entered):
    //   K* — IVA cobrado (computed from ventas × 21%)
    //   L* — IVA pagado (aggregate view over already-entered gastos)
    //   N6, N7 — "IVA o impuestos que debemos" / calculated Impuestos Sociedad
    // Everything else with categoria in Fijos/Variables/Impuestos/Virtuales is a
    // legitimate gasto line the user can enter.
    const rs = await turso.execute(`
      SELECT cuenta_mcf AS cuenta, categoria_gastos_mcf, desc, propiedad, tooltip
      FROM catalogo_cuentas
      WHERE desc IS NOT NULL AND TRIM(desc) <> ''
        AND propiedad IS NOT NULL AND TRIM(propiedad) <> ''
        AND cuenta_mcf NOT LIKE 'K%'
        AND cuenta_mcf NOT LIKE 'L%'
        AND cuenta_mcf NOT IN ('N6', 'N7')
      ORDER BY desc, propiedad
    `);

    const rows = rs.rows.filter(r => GASTOS_CATEGORIES.has(r.categoria_gastos_mcf));

    const byPropiedad = {};
    const allDescs = new Set();
    for (const r of rows) {
      allDescs.add(r.desc);
      if (!byPropiedad[r.propiedad]) byPropiedad[r.propiedad] = [];
      byPropiedad[r.propiedad].push({
        cuenta: r.cuenta,
        desc: r.desc,
        categoria_gastos_mcf: r.categoria_gastos_mcf,
        tooltip: r.tooltip,
      });
    }
    // Sort each propiedad's list by desc
    for (const p in byPropiedad) byPropiedad[p].sort((a, b) => a.desc.localeCompare(b.desc));

    return res.status(200).json({
      rows,
      by_propiedad: byPropiedad,
      all_descs: [...allDescs].sort(),
    });
  } catch (err) {
    console.error('gastos/catalog error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
