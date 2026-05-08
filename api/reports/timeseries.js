import turso from '../_lib/turso.js';

/**
 * GET /api/reports/timeseries
 *   ?property=usera|hortaleza|all
 *   &mission=LAVAR|SECAR|RECARGAS|all
 *   &price_list=edusanferric1|...|all
 *   &metric=ventas|ventas_efectivas|unidades|capacidad_utilizada|precio_prom|precio_x_min|pct_fidel
 *   &start_yyyymm=202503   (inclusive)
 *   &end_yyyymm=202603     (inclusive)
 *
 * Returns monthly aggregates for one chart series:
 *   { series: [{ yyyy, mm, value }], metric, label }
 *
 * Capacidad utilizada formula: minutos_contratados / (840 * dias * maquinas).
 * maquinas excludes TARJETA and RECARGA (per quarto timeseries definition).
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const property = normStr(req.query.property);   // 'all' or one property
    const mission = normStr(req.query.mission);
    const priceList = normStr(req.query.price_list);
    const metric = normStr(req.query.metric) || 'ventas';
    const startYm = toInt(req.query.start_yyyymm);
    const endYm = toInt(req.query.end_yyyymm);

    if (!startYm || !endYm) {
      return res.status(400).json({ error: 'start_yyyymm and end_yyyymm are required (YYYYMM)' });
    }

    // YoY metrics need an extra 12 months of history to compute the prior-year baseline.
    const isYoy = metric === 'ventas_yoy_pct' || metric === 'ventas_efectivas_yoy_pct';
    const queryStartYm = isYoy ? subYearYm(startYm) : startYm;

    const filters = ['(sd.yyyy * 100 + sd.mm) BETWEEN ? AND ?'];
    const args = [queryStartYm, endYm];

    if (property && property !== 'all') { filters.push('sd.property = ?'); args.push(property); }
    if (priceList && priceList !== 'all') { filters.push('sd.price_list = ?'); args.push(priceList); }

    // Mission filter applies to joined products with RECARGA/TARJETA overrides
    const missionFilter = buildMissionFilter(mission);
    if (missionFilter.sql) { filters.push(missionFilter.sql); }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const sql = `
      SELECT
        sd.yyyy AS yyyy,
        sd.mm AS mm,
        COUNT(*) AS unidades,
        SUM(sd.euro) AS ventas,
        SUM(CASE WHEN sd.payment <> 'TARJETA CLIENTE' THEN sd.euro ELSE 0 END) AS ventas_efectivas,
        SUM(CASE WHEN sd.product IN ('RECARGA','TARJETA') THEN 0 ELSE COALESCE(p.product_mins, 0) END) AS minutos,
        COUNT(DISTINCT sd.date) AS dias,
        COUNT(DISTINCT CASE WHEN sd.product IN ('RECARGA','TARJETA') THEN NULL ELSE sd.product END) AS maquinas,
        SUM(CASE WHEN (p.product_price IS NULL OR p.product_price <> 'publico')
                   OR sd.product IN ('TARJETA','RECARGA') THEN sd.euro ELSE 0 END) AS ventas_fidel
      FROM sales_detail sd
      LEFT JOIN products p
        ON sd.product = p.product
       AND sd.euro = p.precio
       AND sd.price_list = p.price_list
       AND sd.property = p.property
      ${whereClause}
      GROUP BY sd.yyyy, sd.mm
      ORDER BY sd.yyyy, sd.mm
    `;

    const rs = await turso.execute({ sql, args });

    const series = rs.rows.map(r => {
      const unidades = Number(r.unidades) || 0;
      const ventas = Number(r.ventas) || 0;
      const ventasEf = Number(r.ventas_efectivas) || 0;
      const minutos = Number(r.minutos) || 0;
      const dias = Number(r.dias) || 0;
      const maquinas = Number(r.maquinas) || 0;
      const ventasFidel = Number(r.ventas_fidel) || 0;
      const minutosDisp = 840 * dias * maquinas;

      let value;
      switch (metric) {
        case 'unidades': value = unidades; break;
        case 'ventas_efectivas': value = ventasEf; break;
        case 'capacidad_utilizada': value = minutosDisp > 0 ? minutos / minutosDisp : 0; break;
        case 'precio_prom': value = unidades > 0 ? ventas / unidades : 0; break;
        case 'precio_x_min': value = minutos > 0 ? ventas / minutos : 0; break;
        case 'pct_fidel': value = ventas > 0 ? ventasFidel / ventas : 0; break;
        case 'ventas':
        default: value = ventas; break;
      }

      return { yyyy: Number(r.yyyy), mm: Number(r.mm), value };
    });

    let outSeries = series;
    if (isYoy) {
      const ventasField = metric === 'ventas_efectivas_yoy_pct' ? 'ventas_efectivas' : 'ventas';
      const baseByYm = new Map();
      for (const r of rs.rows) {
        baseByYm.set(Number(r.yyyy) * 100 + Number(r.mm), Number(r[ventasField]) || 0);
      }
      outSeries = [];
      let y = Math.floor(startYm / 100), m = startYm % 100;
      while (y * 100 + m <= endYm) {
        const ym = y * 100 + m;
        const cur = baseByYm.get(ym);
        const prev = baseByYm.get(subYearYm(ym));
        let value = null;
        if (cur != null && prev != null && prev > 0) value = cur / prev - 1;
        outSeries.push({ yyyy: y, mm: m, value });
        m++; if (m > 12) { m = 1; y++; }
      }
    }

    return res.status(200).json({
      metric,
      label: buildLabel({ property, mission, priceList, metric }),
      series: outSeries,
    });

  } catch (err) {
    console.error('reports/timeseries error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function buildMissionFilter(mission) {
  if (!mission || mission === 'all') return { sql: null };
  if (mission === 'RECARGAS') {
    return { sql: `(sd.product IN ('RECARGA','TARJETA'))` };
  }
  // For LAVAR / SECAR, use products.product_mission and exclude override cases
  return { sql: `(p.product_mission = '${mission.replace(/'/g, "''")}' AND sd.product NOT IN ('RECARGA','TARJETA'))` };
}

function buildLabel({ property, mission, priceList, metric }) {
  const parts = [];
  parts.push(property && property !== 'all' ? property : 'MCF');
  if (mission && mission !== 'all') parts.push(mission);
  if (priceList && priceList !== 'all') parts.push(priceList);
  const metricLabel = metric === 'ventas_yoy_pct' ? 'YoY ventas %'
    : metric === 'ventas_efectivas_yoy_pct' ? 'YoY ventas efectivas %'
    : metric;
  parts.push(metricLabel);
  return parts.join(' · ');
}

function subYearYm(ym) {
  const y = Math.floor(ym / 100), m = ym % 100;
  return (y - 1) * 100 + m;
}

function normStr(v) { return v == null ? null : String(v).trim(); }
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
