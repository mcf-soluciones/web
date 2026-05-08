import turso from './_lib/turso.js';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'OPTIONS,GET',
  'Content-Type': 'application/json',
};

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).json({});
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const today = new Date();
    const start = new Date();
    start.setDate(today.getDate() - 6);
    const startStr = formatDate(start);
    const endStr = formatDate(today);

    const salesRs = await turso.execute({
      sql: `SELECT date_real,
                   SUM(CASE WHEN mcf_user = 'local-usera' THEN euros ELSE 0 END) AS usera,
                   SUM(CASE WHEN mcf_user = 'local-hortaleza' THEN euros ELSE 0 END) AS hortaleza
            FROM sales
            WHERE date_real >= ? AND date_real <= ?
            GROUP BY date_real
            ORDER BY date_real ASC`,
      args: [startStr, endStr],
    });

    const byDate = new Map();
    for (const r of salesRs.rows) {
      byDate.set(r.date_real, { usera: Number(r.usera) || 0, hortaleza: Number(r.hortaleza) || 0 });
    }

    const salesByDay = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const ds = formatDate(d);
      const row = byDate.get(ds) || { usera: 0, hortaleza: 0 };
      salesByDay.push({ date: ds, usera: row.usera, hortaleza: row.hortaleza });
    }

    // Last 12 months of sales (from sales_detail which has history since 2024)
    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;
    const curD = now.getDate();

    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(curY, curM - 1 - i, 1);
      months.push({ yyyy: d.getFullYear(), mm: d.getMonth() + 1 });
    }
    const firstY = months[0].yyyy;
    const firstM = months[0].mm;

    const monthlyRs = await turso.execute({
      sql: `SELECT yyyy, mm, SUM(euro) AS total
            FROM sales_detail
            WHERE (yyyy > ? OR (yyyy = ? AND mm >= ?))
              AND (yyyy < ? OR (yyyy = ? AND mm <= ?))
              AND UPPER(COALESCE(payment, '')) NOT LIKE '%CLIENTE%'
            GROUP BY yyyy, mm`,
      args: [firstY, firstY, firstM, curY, curY, curM],
    });
    const monthTotals = new Map();
    for (const r of monthlyRs.rows) {
      monthTotals.set(`${r.yyyy}-${r.mm}`, Number(r.total) || 0);
    }
    // Current month likely lags in sales_detail — top up from sales table (live pipeline)
    const curMonthStart = `${curY}-${String(curM).padStart(2, '0')}-01`;
    const curMonthRs = await turso.execute({
      sql: `SELECT COALESCE(SUM(euros), 0) AS total FROM sales WHERE date_real >= ?`,
      args: [curMonthStart],
    });
    const curMonthLive = Number(curMonthRs.rows[0]?.total) || 0;
    const curKey = `${curY}-${curM}`;
    const curFromDetail = monthTotals.get(curKey) || 0;
    monthTotals.set(curKey, Math.max(curFromDetail, curMonthLive));

    const salesByMonth = months.map(({ yyyy, mm }) => ({
      yyyy, mm,
      total: monthTotals.get(`${yyyy}-${mm}`) || 0,
    }));

    // MTD this year vs same period last year.
    // Find the latest day with actual sales data this month, then compare
    // through that same day last year for an apples-to-apples window.
    const mtdStart = `${curY}-${String(curM).padStart(2, '0')}-01`;
    const lastDayRs = await turso.execute({
      sql: `SELECT MAX(date_real) AS last_date FROM sales WHERE date_real >= ?`,
      args: [mtdStart],
    });
    const lastDate = lastDayRs.rows[0]?.last_date || null;
    const throughDay = lastDate ? Number(lastDate.slice(-2)) : 0;

    const emptyStoreBreakdown = { usera: 0, hortaleza: 0 };
    let mtdCurrentByStore = { ...emptyStoreBreakdown };
    let mtdLastYearByStore = { ...emptyStoreBreakdown };
    if (throughDay > 0) {
      const mtdCurrentRs = await turso.execute({
        sql: `SELECT mcf_user, COALESCE(SUM(euros), 0) AS total FROM sales
              WHERE date_real >= ? AND date_real <= ?
                AND mcf_user IN ('local-usera', 'local-hortaleza')
              GROUP BY mcf_user`,
        args: [mtdStart, lastDate],
      });
      for (const r of mtdCurrentRs.rows) {
        const key = r.mcf_user === 'local-usera' ? 'usera' : 'hortaleza';
        mtdCurrentByStore[key] = Number(r.total) || 0;
      }
      const mtdLastYearRs = await turso.execute({
        sql: `SELECT property, COALESCE(SUM(euro), 0) AS total FROM sales_detail
              WHERE yyyy = ? AND mm = ? AND dd <= ?
                AND UPPER(COALESCE(payment, '')) NOT LIKE '%CLIENTE%'
                AND property IN ('usera', 'hortaleza')
              GROUP BY property`,
        args: [curY - 1, curM, throughDay],
      });
      for (const r of mtdLastYearRs.rows) {
        mtdLastYearByStore[r.property] = Number(r.total) || 0;
      }
    }
    const mtdComparison = {
      month: curM,
      throughDay,
      current: mtdCurrentByStore.usera + mtdCurrentByStore.hortaleza,
      lastYear: mtdLastYearByStore.usera + mtdLastYearByStore.hortaleza,
      byStore: {
        usera: { current: mtdCurrentByStore.usera, lastYear: mtdLastYearByStore.usera },
        hortaleza: { current: mtdCurrentByStore.hortaleza, lastYear: mtdLastYearByStore.hortaleza },
      },
    };

    const movementsRs = await turso.execute({
      sql: `SELECT mcf_user, date_real, type, euros, movement, propiedad
            FROM movements
            WHERE mcf_user IS NOT NULL
              AND mcf_user NOT LIKE 'local-%'
              AND mcf_user != 'unknown'
              AND type IN ('transito', 'gasto', 'deposito', 'fondo caja', 'fondo_caja')
            ORDER BY date_real DESC, id DESC`,
      args: [],
    });

    const byUser = new Map();
    for (const r of movementsRs.rows) {
      const user = r.mcf_user;
      const euros = Number(r.euros) || 0;
      const signed = r.type === 'transito' ? euros : -euros;
      if (!byUser.has(user)) byUser.set(user, { balance: 0, movements: [] });
      const entry = byUser.get(user);
      entry.balance += signed;
      entry.movements.push({
        date: r.date_real,
        type: r.type,
        euros: signed,
        movement: r.movement,
        propiedad: r.propiedad,
      });
    }

    const userBalances = Array.from(byUser.entries())
      .map(([user, v]) => ({ user, balance: v.balance, movements: v.movements }))
      .filter((b) => Math.abs(b.balance) >= 0.01)
      .sort((a, b) => b.balance - a.balance);

    // Inventory snapshot: latest reading per (propiedad, location).
    // Normalize location/propiedad casing so legacy lowercase rows ('bodega', 'bomba 1')
    // collapse onto the current capitalized values ('Bodega', 'Bomba 1') and we don't
    // double-count old readings against current ones.
    const invRs = await turso.execute({
      sql: `SELECT LOWER(propiedad) AS propiedad,
                   CASE LOWER(TRIM(location))
                     WHEN 'bodega'  THEN 'Bodega'
                     WHEN 'bomba 1' THEN 'Bomba 1'
                     WHEN 'bomba1'  THEN 'Bomba 1'
                     WHEN 'bomba 2' THEN 'Bomba 2'
                     WHEN 'bomba2'  THEN 'Bomba 2'
                     ELSE location
                   END AS location,
                   jabon, suavizante, oxigeno, date, visit_id_ref
            FROM inventory
            WHERE id IN (
              SELECT MAX(id) FROM inventory
              GROUP BY LOWER(propiedad), LOWER(TRIM(location))
            )`,
      args: [],
    });

    const visitIds = Array.from(new Set(invRs.rows.map(r => r.visit_id_ref).filter(Boolean)));
    const visitUserMap = new Map();
    if (visitIds.length) {
      const placeholders = visitIds.map(() => '?').join(',');
      const visitsRs = await turso.execute({
        sql: `SELECT visit_id, mcf_user FROM visits WHERE visit_id IN (${placeholders})`,
        args: visitIds,
      });
      for (const r of visitsRs.rows) visitUserMap.set(r.visit_id, r.mcf_user || null);
    }

    const inventario = { byProperty: {} };
    for (const r of invRs.rows) {
      const prop = r.propiedad;
      if (!prop) continue;
      const entry = inventario.byProperty[prop] ||= {
        jabon: 0, suavizante: 0, oxigeno: 0,
        lastDate: null, mcfUser: null, byLocation: [],
      };
      const jabon = Number(r.jabon) || 0;
      const suavizante = Number(r.suavizante) || 0;
      const oxigeno = Number(r.oxigeno) || 0;
      entry.jabon += jabon;
      entry.suavizante += suavizante;
      entry.oxigeno += oxigeno;
      const mcfUser = r.visit_id_ref ? (visitUserMap.get(r.visit_id_ref) || null) : null;
      if (!entry.lastDate || r.date > entry.lastDate) {
        entry.lastDate = r.date;
        entry.mcfUser = mcfUser;
      }
      entry.byLocation.push({
        location: r.location,
        jabon, suavizante, oxigeno,
        date: r.date,
        mcfUser,
      });
    }
    for (const prop of Object.keys(inventario.byProperty)) {
      inventario.byProperty[prop].byLocation.sort((a, b) => a.location.localeCompare(b.location));
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ salesByDay, salesByMonth, mtdComparison, userBalances, inventario });
  } catch (error) {
    console.error('Hub error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
