/**
 * One-shot migration:
 *   1) Add catalogo_cuentas rows for the new Z letter
 *        Z1 · (001) Usera         · Adquisición o Inversiones
 *        Z2 · (002) Hortaleza      · Adquisición o Inversiones
 *        Z3 · (003) Compra TBC     · Adquisición o Inversiones
 *        Z4 · Corporate            · Adquisición o Inversiones
 *   2) Re-home 7 mis-tagged gastos to Z (keeping es_inversion='Si'):
 *        ids 194, 195          → Z2 (were C2 Alquiler Hortaleza)
 *        ids 315, 276          → Z2 (were G11 Securitas Hortaleza)
 *        ids 243, 211, 248     → Z4 (were J1 Operaciones Corporate)
 *   3) Un-flag 2 gas rows (they were mis-tagged as inversion):
 *        ids 269, 271  →  es_inversion = 'No'  (cuenta stays E5)
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

const NEW_CATALOG_ROWS = [
  { code: 'Z1', property: '(001) Usera',     desc: 'Adquisición o Inversiones' },
  { code: 'Z2', property: '(002) Hortaleza', desc: 'Adquisición o Inversiones' },
  { code: 'Z3', property: '(003) Compra TBC', desc: 'Adquisición o Inversiones' },
  { code: 'Z4', property: 'Corporate',        desc: 'Adquisición o Inversiones' },
];

const REHOME_TO_Z = [
  { ids: [194, 195], new_cuenta: 'Z2', reason: 'was C2 Alquiler — belongs in capex' },
  { ids: [315, 276], new_cuenta: 'Z2', reason: 'was G11 Securitas — belongs in capex' },
  { ids: [243, 211, 248], new_cuenta: 'Z4', reason: 'was J1 Operaciones — belongs in capex' },
];

const UNFLAG_AS_OPERATING = {
  ids: [269, 271],
  reason: 'E5 Gas — mis-tagged as inversion, should be operating',
};

async function main() {
  // ---- 1. Insert new catalog rows ----------------------------------------
  console.log('\n=== Inserting new Z catalog rows ===');
  for (const row of NEW_CATALOG_ROWS) {
    const tooltip = `${row.desc} · ${row.property}`;
    const rs = await turso.execute({
      sql: `INSERT INTO catalogo_cuentas (cuenta_mcf, categoria_gastos_mcf, desc, tooltip, propiedad, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(cuenta_mcf) DO UPDATE SET
              categoria_gastos_mcf = excluded.categoria_gastos_mcf,
              desc = excluded.desc,
              tooltip = excluded.tooltip,
              propiedad = excluded.propiedad,
              updated_at = datetime('now')`,
      args: [row.code, 'Adquisición o Inversiones', row.desc, tooltip, row.property],
    });
    console.log(`  upserted ${row.code}  ${row.property}  ${row.desc}`);
  }

  // ---- 2. Re-home the mis-tagged rows to Z --------------------------------
  console.log('\n=== Re-homing 7 gastos to Z ===');
  for (const group of REHOME_TO_Z) {
    for (const id of group.ids) {
      const rs = await turso.execute({
        sql: `UPDATE gastos
              SET cuenta = ?,
                  categoria_gastos_mcf = 'Adquisición o Inversiones',
                  concepto_mcf = 'Adquisición o Inversiones'
              WHERE id = ?`,
        args: [group.new_cuenta, id],
      });
      console.log(`  id=${id} → cuenta=${group.new_cuenta}  (${group.reason})`);
    }
  }

  // ---- 3. Un-flag the gas rows -------------------------------------------
  console.log('\n=== Un-flagging 2 gas rows (now operating) ===');
  for (const id of UNFLAG_AS_OPERATING.ids) {
    await turso.execute({
      sql: `UPDATE gastos SET es_inversion = 'No' WHERE id = ?`,
      args: [id],
    });
    console.log(`  id=${id} → es_inversion='No'  (${UNFLAG_AS_OPERATING.reason})`);
  }

  // ---- 4. Verify ---------------------------------------------------------
  console.log('\n=== Verification: all es_inversion=Si rows after migration ===');
  const v = await turso.execute(`
    SELECT id, fecha, cuenta, categoria_gastos_mcf, concepto_mcf, importe_total, es_inversion
    FROM gastos
    WHERE COALESCE(es_inversion,'No') = 'Si'
    ORDER BY fecha, id
  `);
  console.log(`  ${v.rows.length} rows flagged as inversion`);
  for (const r of v.rows) {
    console.log(`    id=${r.id}  ${r.fecha}  ${String(r.cuenta||'-').padEnd(5)}  ${String(r.categoria_gastos_mcf||'-').padEnd(28)}  €${r.importe_total}`);
  }

  const total = v.rows.reduce((s, r) => s + (Number(r.importe_total) || 0), 0);
  console.log(`\n  TOTAL: €${total.toFixed(2)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
