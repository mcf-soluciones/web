import turso from '../_lib/turso.js';

/**
 * GET /api/reports/monthly?mm=3&yyyy=2026&yoy_mm=3&yoy_yyyy=2025
 *
 * Returns raw sales_detail rows for the current month + yoy month, joined
 * to products, with RECARGA/TARJETA overrides applied. Frontend computes
 * all pivots from this payload.
 *
 * Response shape:
 *   {
 *     this:  { mm, yyyy, rows: [...] },
 *     yoy:   { mm, yyyy, rows: [...] }
 *   }
 * Each row: { date, yyyy, mm, dd, time, payment, product, euro, price_list,
 *             property, product_mission, product_size, product_price,
 *             product_mins, capacidad, subproducto }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const mm = toInt(req.query.mm);
    const yyyy = toInt(req.query.yyyy);
    const yoyMm = toInt(req.query.yoy_mm) || mm;
    const yoyYyyy = toInt(req.query.yoy_yyyy) || (yyyy ? yyyy - 1 : null);

    if (!mm || !yyyy) {
      return res.status(400).json({ error: 'mm and yyyy are required' });
    }

    const [thisRs, yoyRs] = await Promise.all([
      fetchMonth(mm, yyyy),
      fetchMonth(yoyMm, yoyYyyy),
    ]);

    const payload = {
      this: { mm, yyyy, rows: thisRs },
      yoy: { mm: yoyMm, yyyy: yoyYyyy, rows: yoyRs },
      preliminary: false,
      preliminary_totals: null,
    };

    // Preliminary: if sales_detail hasn't been synced for the requested month,
    // fall back to the daily-aggregated `sales` table for headline totals.
    if (thisRs.length === 0) {
      const totals = await fetchSalesFallback(mm, yyyy);
      if (totals.total > 0) {
        payload.preliminary = true;
        payload.preliminary_totals = totals;
      }
    }

    return res.status(200).json(payload);
  } catch (err) {
    console.error('reports/monthly error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchSalesFallback(mm, yyyy) {
  const ym = `${yyyy}-${String(mm).padStart(2, '0')}`;
  const rs = await turso.execute({
    sql: `SELECT
            CASE
              WHEN mcf_user LIKE '%hortaleza%' THEN 'hortaleza'
              WHEN mcf_user LIKE '%usera%'     THEN 'usera'
              ELSE 'unknown'
            END AS property,
            COALESCE(SUM(euros), 0) AS euros,
            COUNT(*) AS n,
            MAX(date_real) AS max_day,
            MIN(date_real) AS min_day
          FROM sales
          WHERE substr(date_real, 1, 7) = ?
          GROUP BY property`,
    args: [ym],
  });
  const byProperty = {};
  let total = 0, maxDay = null, minDay = null;
  for (const r of rs.rows) {
    const v = Number(r.euros) || 0;
    byProperty[r.property] = v;
    total += v;
    if (!maxDay || (r.max_day && r.max_day > maxDay)) maxDay = r.max_day;
    if (!minDay || (r.min_day && r.min_day < minDay)) minDay = r.min_day;
  }
  return { total, by_property: byProperty, max_day: maxDay, min_day: minDay };
}

async function fetchMonth(mm, yyyy) {
  if (!mm || !yyyy) return [];
  const rs = await turso.execute({
    sql: `
      SELECT
        sd.date, sd.yyyy, sd.mm, sd.dd, sd.time, sd.payment, sd.product,
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
  return rs.rows.map(applyOverrides);
}

// Port of d_this_h RECARGA/TARJETA overrides from mbr-v9-quarto.qmd:78-131
function applyOverrides(row) {
  const r = { ...row };
  if (r.product === 'RECARGA') {
    r.product_price = 'fidelizacion';
    r.product_size = 'TODAS';
    r.product_mins = 0;
    r.product_mission = 'RECARGAS';
    r.subproducto = 'RECARGAS';
    r.capacidad = 0;
  } else if (r.product === 'TARJETA') {
    r.product_price = 'fidelizacion';
    r.product_size = 'TODAS';
    r.product_mins = 0;
    r.product_mission = 'RECARGAS';
    r.subproducto = 'TARJETA NUEVA';
    r.capacidad = 0;
  }
  return r;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
