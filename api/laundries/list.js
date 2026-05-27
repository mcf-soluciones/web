import turso from '../_lib/turso.js';

/**
 * GET /api/laundries/list
 *
 * Returns every laundry row. Low-volume table (hundreds, not thousands),
 * so no pagination. Used by the `mapa` view to render all pins at once.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const rs = await turso.execute({
      sql: `SELECT id, name, brand, address, lat, lng, propiedad_mcf,
                   tel, google_rating, google_review_count, google_place_id,
                   num_lavadoras, num_secadoras,
                   precio_lavado_15kg, precio_secado_15kg,
                   marca_maquinas, estado_limpieza, years_aprox, clientes_estim,
                   interes_venta, status2025, prioridad, modelo2,
                   sq_link, call_notes,
                   created_by, created_at, updated_at
            FROM laundries
            ORDER BY propiedad_mcf DESC, name ASC`,
      args: [],
    });

    const rows = rs.rows.map(r => ({
      ...r,
      propiedad_mcf: Number(r.propiedad_mcf) === 1,
      lat: Number(r.lat),
      lng: Number(r.lng),
    }));

    return res.status(200).json({ count: rows.length, rows });
  } catch (err) {
    console.error('laundries/list error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
