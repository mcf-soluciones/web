import { requireReports } from '../_lib/web-auth.js';
import { storesOnSalesOnly } from '../_lib/sales-fallback.js';
import turso from '../_lib/turso.js';
import { MEXICO, esMexico, hermanaDe } from '../_lib/sucursales.js';

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
 *             property, sucursal_real, product_mission, product_size,
 *             product_price, product_mins, capacidad, subproducto }
 *
 * Each Mexican store is analysed as one entity with its Spanish sister: its rows
 * come back with `property` set to the sister and `sucursal_real` keeping the
 * store they came from, so everything grouping by property adds them up.
 * `sister_merge` lists the combinations in this response.
 */
export default async function handler(req, res) {
  if (!requireReports(req, res)) return;
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
      sister_merge: sisterMerge(thisRs, yoyRs),
    };

    // Preliminary: if sales_detail hasn't been synced for the requested month,
    // fall back to the daily-aggregated `sales` table for headline totals.
    // Decided on Spain's rows alone, so Mexico's can't hide a month Spain is still missing.
    if (!thisRs.some(r => !esMexico(r.sucursal_real))) {
      const totals = await fetchSalesFallback(mm, yyyy);
      if (totals.total > 0) {
        payload.preliminary = true;
        payload.preliminary_totals = addToSisters(totals, thisRs);
        // Mexico alone under Usera's name would read as Usera's month. The cards above carry the total.
        payload.this.rows = [];
      }
    } else {
      // A store with the kiosk has daily detail while the other waits for its PDF: the tables below only show the first.
      const stores = await storesOnSalesOnly(turso, yyyy, mm);
      if (stores.length > 0) payload.partial_stores = stores;
    }

    return res.status(200).json(payload);
  } catch (err) {
    console.error('reports/monthly error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Which Mexican stores are inside which Spanish ones in this response, and whether last year's month has them too.
function sisterMerge(thisRows, yoyRows) {
  const inRows = (rows, key) => rows.some(r => r.sucursal_real === key);
  return MEXICO
    .filter(t => inRows(thisRows, t.key) || inRows(yoyRows, t.key))
    .map(t => ({ store: t.hermana, includes: t.label, yoy_comparable: inRows(thisRows, t.key) && inRows(yoyRows, t.key) }));
}

// The fallback totals come from `sales`, which never has Mexico, so its sales are added to each sister here. Same
// count as `sales`: no tarjeta cliente.
function addToSisters(totals, rows) {
  const out = { ...totals, by_property: { ...totals.by_property } };
  for (const r of rows) {
    if (r.payment === 'TARJETA CLIENTE') continue;
    const v = Number(r.euro) || 0;
    out.by_property[r.property] = (out.by_property[r.property] || 0) + v;
    out.total += v;
  }
  return out;
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
  return rs.rows.map(applyOverrides).map(r => ({ ...r, sucursal_real: r.property, property: hermanaDe(r.property) ?? r.property }));
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
