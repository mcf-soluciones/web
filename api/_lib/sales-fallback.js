/**
 * sales_detail can be complete for one store and missing for another in the same month: a store with the new kiosk uploads day by day,
 * while the other waits for its monthly PDF. So whether to fall back to the daily `sales` totals is decided store by store.
 * Deciding it for the whole month would show the store without detail as 0.
 */

export const STORES = ['usera', 'hortaleza'];

/** Stores in scope with no sales_detail this month, and what `sales` says they have sold. */
export async function storesOnSalesOnly(db, yyyy, mm, scope = 'mcf') {
  const stores = scope === 'mcf' ? STORES : [scope];
  const detail = await db.execute({
    sql: `SELECT DISTINCT property FROM sales_detail WHERE company = 'mcf' AND yyyy = ? AND mm = ?`,
    args: [yyyy, mm],
  });
  const have = new Set(detail.rows.map(r => r.property));
  const ym = `${yyyy}-${String(mm).padStart(2, '0')}`;
  const out = [];
  for (const store of stores) {
    if (have.has(store)) continue;
    const rs = await db.execute({
      sql: `SELECT COALESCE(SUM(euros), 0) AS total, MAX(date_real) AS max_day FROM sales WHERE substr(date_real, 1, 7) = ? AND LOWER(mcf_user) LIKE ?`,
      args: [ym, `%${store}%`],
    });
    const total = Number(rs.rows[0]?.total || 0);
    if (total > 0) out.push({ store, total, max_day: rs.rows[0]?.max_day || null });
  }
  return out;
}

/** For the year view: does this store-month come from `sales`? Only when that store has no detail for that month. */
export function detailIndex(detailRows) {
  const have = new Set(detailRows.map(r => `${r.property}|${Number(r.mm)}`));
  return (property, mm) => have.has(`${property}|${Number(mm)}`);
}
