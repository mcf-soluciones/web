/**
 * Compare Turso `gastos` vs the gastos Google Sheet (source of truth).
 * Reports: rows in sheet missing from Turso, rows in Turso that are
 * stale / not in sheet, amount mismatches, and null-cuenta rows.
 *
 * Usage: node scripts/reconcile-gastos.js
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const { google } = require('googleapis');

const GASTOS_SS = '1wju-dUlIOAA8qFbMX2roH0YcinsbqrXWgjSSNNyN0qs';
const GASTOS_TAB = 'gastos';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function fetchSheet() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: GASTOS_SS,
    range: `${GASTOS_TAB}!A1:V`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = r.data.values || [];
  if (rows.length === 0) return [];
  const [headers, ...body] = rows;
  const norm = headers.map(h => String(h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  return body.map(row => {
    const obj = {};
    norm.forEach((h, i) => { obj[h] = row[i] ?? null; });
    return obj;
  });
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

async function main() {
  console.log('Fetching gastos sheet...');
  const sheet = await fetchSheet();
  console.log(`  ${sheet.length} rows in sheet`);

  console.log('Fetching Turso gastos (with sheet_row_id)...');
  const t = await turso.execute(
    `SELECT id, sheet_row_id, fecha, yyyy, mm, cuenta, concepto_mcf,
            razon_social, importe_total, importe_iva, es_inversion,
            categoria_gastos_mcf
     FROM gastos WHERE sheet_row_id IS NOT NULL`);
  const tMap = new Map(t.rows.map(r => [r.sheet_row_id, r]));
  console.log(`  ${t.rows.length} rows in Turso with sheet_row_id`);

  const tOrphans = await turso.execute(
    `SELECT id, fecha, cuenta, concepto_mcf, importe_total
     FROM gastos WHERE sheet_row_id IS NULL`);
  console.log(`  ${tOrphans.rows.length} rows in Turso WITHOUT sheet_row_id (orphans)`);

  // --- Compare by sheet_row_id --------------------------------------------
  const missingInTurso = [];    // in sheet, not in turso
  const staleInTurso = [];      // in turso, not in sheet
  const amountMismatches = [];  // same id, different importe
  const categoryMismatches = [];// same id, different cuenta
  const sheetIds = new Set();

  for (const s of sheet) {
    const id = s.id;
    if (!id) continue;
    sheetIds.add(id);
    const tr = tMap.get(id);
    const sheetImporte = toNum(s.importe_total);
    const sheetCuenta = s.cuenta_mcf ? String(s.cuenta_mcf).trim() : null;
    const sheetEsInversion = String(s.es_inversion || '').trim().toLowerCase() === 'si' ? 'Si' : 'No';

    if (!tr) {
      missingInTurso.push({ id, fecha: s.fecha, cuenta: sheetCuenta, importe: sheetImporte, razon: s.razon_social });
      continue;
    }

    const tImporte = Number(tr.importe_total) || 0;
    if (sheetImporte !== null && Math.abs(tImporte - sheetImporte) > 0.005) {
      amountMismatches.push({ id, turso: tImporte, sheet: sheetImporte, diff: tImporte - sheetImporte, concepto: s.concepto_mcf });
    }
    if (sheetCuenta && (tr.cuenta || '') !== sheetCuenta) {
      categoryMismatches.push({ id, turso_cuenta: tr.cuenta, sheet_cuenta: sheetCuenta });
    }
    if (sheetEsInversion !== (tr.es_inversion || 'No')) {
      categoryMismatches.push({ id, turso_esInv: tr.es_inversion, sheet_esInv: sheetEsInversion, note: 'es_inversion diff' });
    }
  }

  for (const [id, tr] of tMap) {
    if (!sheetIds.has(id)) {
      staleInTurso.push({ id, cuenta: tr.cuenta, importe: tr.importe_total, fecha: tr.fecha });
    }
  }

  const nullCuenta = Array.from(tMap.values()).filter(r => !r.cuenta || String(r.cuenta).trim() === '');
  const nullYyyy = Array.from(tMap.values()).filter(r => r.yyyy == null);

  // --- Per-month totals comparison ----------------------------------------
  console.log('\n=== Per-month total comparison (importe_total sum, non-investment) ===');
  const sheetByYm = {};
  for (const s of sheet) {
    const esInv = String(s.es_inversion || '').trim().toLowerCase() === 'si';
    if (esInv) continue;
    const yyyy = Number(s.yyyy), mm = Number(s.mm);
    if (!Number.isFinite(yyyy) || !Number.isFinite(mm)) continue;
    const key = `${yyyy}-${String(mm).padStart(2, '0')}`;
    const v = toNum(s.importe_total) || 0;
    sheetByYm[key] = (sheetByYm[key] || 0) + v;
  }
  const tMonthly = await turso.execute(
    `SELECT yyyy, mm, ROUND(SUM(COALESCE(importe_total, gasto, 0)), 2) AS total
     FROM gastos
     WHERE yyyy IS NOT NULL AND COALESCE(es_inversion, 'No') = 'No'
     GROUP BY yyyy, mm ORDER BY yyyy, mm`);
  const tursoByYm = {};
  for (const r of tMonthly.rows) {
    tursoByYm[`${r.yyyy}-${String(r.mm).padStart(2, '0')}`] = Number(r.total) || 0;
  }
  const allKeys = new Set([...Object.keys(sheetByYm), ...Object.keys(tursoByYm)]);
  const keys = Array.from(allKeys).sort();
  for (const k of keys) {
    const s = sheetByYm[k] || 0;
    const t = tursoByYm[k] || 0;
    const diff = t - s;
    const flag = Math.abs(diff) > 0.5 ? ' ⚠' : '';
    console.log(`  ${k}: sheet=${s.toFixed(2).padStart(10)}  turso=${t.toFixed(2).padStart(10)}  diff=${diff.toFixed(2).padStart(9)}${flag}`);
  }

  // --- Summaries ----------------------------------------------------------
  console.log(`\n=== Summary ===`);
  console.log(`  Rows in sheet not in Turso     : ${missingInTurso.length}`);
  console.log(`  Rows in Turso not in sheet     : ${staleInTurso.length}`);
  console.log(`  Amount mismatches              : ${amountMismatches.length}`);
  console.log(`  Category/es_inversion diffs    : ${categoryMismatches.length}`);
  console.log(`  Turso rows with null cuenta    : ${nullCuenta.length}`);
  console.log(`  Turso rows with null yyyy      : ${nullYyyy.length}`);
  console.log(`  Turso orphans (no sheet_row_id): ${tOrphans.rows.length}`);

  if (missingInTurso.length) {
    console.log('\nMissing in Turso (top 10):');
    for (const r of missingInTurso.slice(0, 10)) console.log('  ' + JSON.stringify(r));
  }
  if (staleInTurso.length) {
    console.log('\nStale in Turso (not in sheet):');
    for (const r of staleInTurso.slice(0, 10)) console.log('  ' + JSON.stringify(r));
  }
  if (amountMismatches.length) {
    console.log('\nAmount mismatches (top 10):');
    for (const r of amountMismatches.slice(0, 10)) console.log('  ' + JSON.stringify(r));
  }
  if (categoryMismatches.length) {
    console.log('\nCategory mismatches (top 10):');
    for (const r of categoryMismatches.slice(0, 10)) console.log('  ' + JSON.stringify(r));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
