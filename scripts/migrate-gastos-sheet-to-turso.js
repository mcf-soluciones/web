/**
 * One-time migration: Google Sheets -> Turso.
 *
 * Sources (matches mcftools::getGastos in R):
 *   - gastos spreadsheet: 1wju-dUlIOAA8qFbMX2roH0YcinsbqrXWgjSSNNyN0qs, tab 'gastos'
 *   - catalog spreadsheet (P&L): 1brwERISPLIXih8nbPbHDpUHU0yBWdt8S6wvNYqs5mN4, tab 'catalogo_cuentas'
 *
 * Joins gastos.cuenta_mcf → catalogo_cuentas.code to derive
 * `categoria_gastos_mcf` (Variables / Fijos / Impuestos / Ventas).
 *
 * Safe to re-run — rows are UPSERTed on sheet_row_id (column A of gastos).
 *
 * Usage:
 *   node scripts/migrate-gastos-sheet-to-turso.js
 */

require('dotenv').config();
const { createClient } = require('@libsql/client');
const { google } = require('googleapis');

const GASTOS_SS = '1wju-dUlIOAA8qFbMX2roH0YcinsbqrXWgjSSNNyN0qs';
const GASTOS_TAB = 'gastos';
const CATALOG_SS = '1brwERISPLIXih8nbPbHDpUHU0yBWdt8S6wvNYqs5mN4';
const CATALOG_TAB = 'catalogo_cuentas';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function sheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function fetchSheet(sheets, spreadsheetId, tab) {
  // UNFORMATTED_VALUE ensures numbers arrive as numbers (not locale-formatted
  // strings like "2.822,91" that naive parsers mangle), and dates arrive as
  // Excel serials so we can convert them deterministically.
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A1:ZZ`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  const rows = r.data.values || [];
  if (rows.length === 0) return { headers: [], rows: [] };
  const [headers, ...body] = rows;
  const norm = headers.map(h => String(h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  const objects = body.map(row => {
    const obj = {};
    norm.forEach((h, i) => { obj[h] = row[i] ?? null; });
    return obj;
  });
  return { headers: norm, rows: objects };
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // String fallback: strip everything but digits / . / , / -; pick the right
  // decimal separator based on which punctuation appears last.
  let s = String(v).trim();
  s = s.replace(/[^\d.,-]/g, '');
  if (s === '' || s === '-' || s === '.' || s === ',') return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot === -1 && lastComma === -1) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  // Decimal separator = whichever punctuation appears last; the other is thousands
  const decSep = lastComma > lastDot ? ',' : '.';
  const thouSep = decSep === ',' ? '.' : ',';
  s = s.split(thouSep).join('');
  if (decSep === ',') s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) { const n = toNumber(v); return n === null ? null : Math.round(n); }

function yesNo(v) {
  if (v === null || v === undefined) return 'No';
  const s = String(v).trim().toLowerCase();
  return (s === 'si' || s === 'sí' || s === 'yes' || s === 'true' || s === '1') ? 'Si' : 'No';
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
  }
  return null;
}

// Parse sheet fecha into ISO "YYYY-MM-DD". Handles:
//   - Excel/Sheets serials (days since 1899-12-30) when value is a number
//   - ISO strings ("2025-08-12")
//   - Day-first strings ("12/8/2025" = 12 August 2025 in Spanish locale)
function parseSheetDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const epoch = Date.UTC(1899, 11, 30);
    const ms = epoch + raw * 86400000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    // Sheet is Spanish locale: day/month/year
    const [, dd, mm, yyRaw] = m;
    const yyyy = yyRaw.length === 2 ? Number(yyRaw) + 2000 : Number(yyRaw);
    return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

async function migrateCatalogo(sheets) {
  console.log(`\n[catalogo_cuentas] fetching ${CATALOG_TAB} from P&L spreadsheet...`);
  const { rows } = await fetchSheet(sheets, CATALOG_SS, CATALOG_TAB);
  console.log(`  read ${rows.length} rows`);

  let upserted = 0;
  for (const r of rows) {
    const code = pickFirst(r, ['code', 'cuenta_mcf']);
    if (!code) continue;
    const property = pickFirst(r, ['property', 'propiedad']);
    const desc = pickFirst(r, ['desc', 'descripcion', 'description', 'human_desc']);
    const categoria = pickFirst(r, ['categoria_gastos_mcf', 'categoria']);
    const humanDesc = pickFirst(r, ['human_desc']);
    // No dedicated tooltip column in the sheet — compose one from desc + property
    const tooltip = [desc, property].filter(Boolean).join(' · ') || humanDesc || null;

    await turso.execute({
      sql: `INSERT INTO catalogo_cuentas (cuenta_mcf, categoria_gastos_mcf, desc, tooltip, propiedad, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(cuenta_mcf) DO UPDATE SET
              categoria_gastos_mcf = excluded.categoria_gastos_mcf,
              desc = excluded.desc,
              tooltip = excluded.tooltip,
              propiedad = excluded.propiedad,
              updated_at = datetime('now')`,
      args: [String(code).trim(), categoria, desc, tooltip, property],
    });
    upserted++;
  }
  console.log(`  upserted ${upserted} catalog rows`);
}

async function migrateGastos(sheets) {
  console.log(`\n[gastos] fetching from sheet '${GASTOS_TAB}'...`);
  const { rows } = await fetchSheet(sheets, GASTOS_SS, GASTOS_TAB);
  console.log(`  read ${rows.length} rows`);

  // Load catalog for categoria fallback
  const catRs = await turso.execute(`SELECT cuenta_mcf, categoria_gastos_mcf FROM catalogo_cuentas`);
  const catMap = new Map();
  for (const row of catRs.rows) catMap.set(String(row.cuenta_mcf).trim(), row.categoria_gastos_mcf);

  let inserted = 0, updated = 0, skipped = 0;
  const seenIds = new Map();  // rawId -> occurrence count
  const duplicates = [];

  for (const r of rows) {
    const rawId = pickFirst(r, ['id']);
    if (!rawId) { skipped++; continue; }
    // Duplicate IDs: keep both rows by suffixing the 2nd+ occurrences
    const occ = seenIds.get(rawId) || 0;
    seenIds.set(rawId, occ + 1);
    const sheetRowId = occ === 0 ? String(rawId) : `${rawId}#${occ + 1}`;
    if (occ > 0) duplicates.push({ id: rawId, suffixed: sheetRowId });

    const fechaRaw = pickFirst(r, ['fecha']);
    const fecha = parseSheetDate(fechaRaw);
    const yyyy = toInt(pickFirst(r, ['yyyy', 'year'])) || (fecha ? Number(fecha.slice(0, 4)) : null);
    const mm = toInt(pickFirst(r, ['mm', 'month'])) || (fecha ? Number(fecha.slice(5, 7)) : null);
    const propiedad = pickFirst(r, ['propiedad', 'property']);
    const conceptoMcf = pickFirst(r, ['concepto_mcf']);
    const cuentaMcf = pickFirst(r, ['cuenta_mcf', 'cuenta']);
    const conceptoProveedor = pickFirst(r, ['concepto_proveedor']);
    const nif = pickFirst(r, ['nif_proveedor', 'nif']);
    const razonSocial = pickFirst(r, ['razon_social']);
    const numFactura = pickFirst(r, ['num_factura']);
    const isFiscal = yesNo(pickFirst(r, ['is_fiscal', 'fiscal']));
    const mcfUser = pickFirst(r, ['mcf_user', 'pagado_por', 'user_name', 'user']);
    const importeTotal = toNumber(pickFirst(r, ['importe_total', 'importe', 'gasto']));
    const importeIva = toNumber(pickFirst(r, ['importe_iva', 'iva']));
    const importeIrpf = toNumber(pickFirst(r, ['importe_irpf', 'irpf']));
    const importeOtros = toNumber(pickFirst(r, ['importe_otros', 'importe_otro', 'otros']));
    const currency = pickFirst(r, ['currency', 'moneda']) || 'EUR';
    const conceptoBanco = pickFirst(r, ['concepto_banco']);
    const esInversion = yesNo(pickFirst(r, ['es_inversion', 'inversion']));
    const factura = pickFirst(r, ['factura']);

    const categoriaGastosMcf = pickFirst(r, ['categoria_gastos_mcf', 'categoria'])
      || (cuentaMcf ? catMap.get(String(cuentaMcf).trim()) : null);

    const title = `Gasto ${propiedad || '-'} - ${conceptoMcf || '-'} - ${fecha || ''}`;

    const existing = await turso.execute({
      sql: `SELECT id FROM gastos WHERE sheet_row_id = ? LIMIT 1`,
      args: [sheetRowId],
    });

    if (existing.rows.length > 0) {
      await turso.execute({
        sql: `UPDATE gastos SET
                concepto_text = ?, user_name = ?, concepto_mcf = ?, currency = ?,
                cuenta = ?, concepto_proveedor = ?, num_factura = ?, nif_proveedor = ?,
                razon_social = ?, concepto_banco = ?, gasto = ?, importe_iva = ?,
                importe_irpf = ?, importe_otro = ?, is_fiscal = ?,
                categoria_gastos_mcf = ?, es_inversion = ?, fecha = ?, mm = ?, yyyy = ?,
                importe_total = ?, propiedad = ?, recibo_url = ?
              WHERE sheet_row_id = ?`,
        args: [
          title, mcfUser, conceptoMcf, currency, cuentaMcf, conceptoProveedor,
          numFactura, nif, razonSocial, conceptoBanco, importeTotal || 0,
          importeIva || 0, importeIrpf || 0, importeOtros || 0,
          isFiscal === 'Si' ? 1 : 0, categoriaGastosMcf, esInversion,
          fecha, mm, yyyy, importeTotal, propiedad, factura, sheetRowId,
        ],
      });
      updated++;
    } else {
      await turso.execute({
        sql: `INSERT INTO gastos (
                concepto_text, user_name, concepto_mcf, currency, cuenta,
                concepto_proveedor, num_factura, nif_proveedor, razon_social,
                concepto_banco, gasto, importe_iva, importe_irpf, importe_otro,
                is_fiscal, categoria_gastos_mcf, es_inversion, fecha, mm, yyyy,
                importe_total, propiedad, recibo_url, sheet_row_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          title, mcfUser, conceptoMcf, currency, cuentaMcf, conceptoProveedor,
          numFactura, nif, razonSocial, conceptoBanco, importeTotal || 0,
          importeIva || 0, importeIrpf || 0, importeOtros || 0,
          isFiscal === 'Si' ? 1 : 0, categoriaGastosMcf, esInversion,
          fecha, mm, yyyy, importeTotal, propiedad, factura, sheetRowId,
        ],
      });
      inserted++;
    }
  }

  console.log(`  inserted ${inserted}, updated ${updated}, skipped (no id) ${skipped}`);
  if (duplicates.length) {
    console.log(`\n  ⚠ ${duplicates.length} duplicate IDs in sheet — each was imported with a "#n" suffix so no rows are lost.`);
    console.log(`    Consider fixing the sheet so IDs are unique. Duplicates:`);
    for (const d of duplicates) console.log(`      ${d.id} → ${d.suffixed}`);
  }
}

async function main() {
  for (const name of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON']) {
    if (!process.env[name]) {
      console.error(`Missing env var: ${name}`);
      process.exit(1);
    }
  }
  const sheets = sheetsClient();
  await migrateCatalogo(sheets);
  await migrateGastos(sheets);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
