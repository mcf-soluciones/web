/**
 * One-off: Compra TBC is now Monterrey, so its catalog rows take the store's label. Their cuenta codes don't change, so
 * saved Inversión scenarios keep working: projections/baseline shows these rows to the calculator as "Sucursal nueva".
 * Stops if any gasto already uses the old label. Safe to run twice.
 *
 * Usage:
 *   node scripts/rename-compra-tbc.mjs
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const OLD = '(003) Compra TBC';
const NEW = '(003) Monterrey';

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

const used = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM gastos WHERE propiedad = ?', args: [OLD] });
if (Number(used.rows[0].n) > 0) {
  console.error(`${used.rows[0].n} gastos use "${OLD}". Nothing was changed, so decide what they should be first.`);
  process.exit(1);
}

const done = await db.execute({
  sql: `UPDATE catalogo_cuentas SET propiedad = ?, tooltip = REPLACE(tooltip, ?, ?), updated_at = datetime('now') WHERE propiedad = ?`,
  args: [NEW, OLD, NEW, OLD],
});
console.log(`${done.rowsAffected} catalog rows now say "${NEW}".`);
process.exit(0);
