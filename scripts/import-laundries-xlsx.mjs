// Standardize + import the laundromat prospect book (Notion export) into the
// laundries table. Cleans names, derives MCF ownership, formats phones, maps
// columns to the schema, drops rows without valid Madrid coordinates, dedupes,
// and (with --replace) wipes the table first.
//
// Usage:
//   node scripts/import-laundries-xlsx.mjs "C:/path/laundrybook.xlsx" --replace
//   node scripts/import-laundries-xlsx.mjs "C:/path/laundrybook.xlsx"            (append/upsert by place_id)
import 'dotenv/config';
import xlsx from 'xlsx';
import { createClient } from '@libsql/client';

const FILE = process.argv.find(a => /\.xlsx$/i.test(a));
const REPLACE = process.argv.includes('--replace');
if (!FILE) { console.error('pass the .xlsx path'); process.exit(1); }

const t = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// ---- helpers ----------------------------------------------------------------
const numOrNull = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const intOrNull = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : null; };
const posIntOrNull = (v) => { const x = intOrNull(v); return x && x > 0 ? x : null; };  // 0 here means "unknown"
const str = (v) => { if (v == null) return null; const s = String(v).trim(); return s === '' ? null : s; };

// Brand markers used as name prefixes in the Notion export.
const PREFIX_BRAND = { SQ: 'Speed Queen', CE: 'Colada Express', LE: 'Lavaexpress', LA: 'La Wash', IW: 'iwash', OT: null };

function cleanName(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^\[[A-Z]{2}\]\s*/, '');   // strip [SQ] / [CE] / ... marker
  s = s.replace(/^MCF\s*-\s*/i, 'MCF ');   // "MCF - Usera" -> "MCF Usera"
  return s.trim();
}
function brandFrom(row) {
  const m = String(row.name || '').match(/^\[([A-Z]{2})\]/);
  const fromPrefix = m ? PREFIX_BRAND[m[1]] : null;
  return str(row.marca) || fromPrefix || null;
}
function formatTel(v) {
  if (v == null) return null;
  let s = String(v).replace(/\D/g, '');
  if (!s) return null;
  if (s.length === 11 && s.startsWith('34')) s = s.slice(2);       // 34XXXXXXXXX -> 9 digits
  if (s.length === 9) return `+34 ${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}`;
  return '+' + s;
}
function isMcf(row) {
  return /MCF\s*-/.test(String(row.name || '')) ? 1 : 0;
}

// ---- read + map -------------------------------------------------------------
const wb = xlsx.readFile(FILE);
const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });

const mapped = [];
let dropped = 0;
const seenPid = new Set();
const seenCoord = new Set();
for (const r of rows) {
  const lat = numOrNull(r.latitud), lng = numOrNull(r.longitud);
  if (lat == null || lng == null || lat < 39.5 || lat > 41.3 || lng < -4.8 || lng > -3.0) { dropped++; continue; }
  const pid = str(r.google_placeid);
  if (pid && seenPid.has(pid)) { dropped++; continue; }
  const coordKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (!pid && seenCoord.has(coordKey)) { dropped++; continue; }
  if (pid) seenPid.add(pid); else seenCoord.add(coordKey);

  const rating = numOrNull(r.estrellas_reviews);
  mapped.push({
    name: cleanName(r.name) || '(sin nombre)',
    brand: brandFrom(r),
    address: str(r.direccion),
    lat, lng,
    propiedad_mcf: isMcf(r),
    tel: formatTel(r.tel),
    google_rating: rating && rating > 0 ? rating : null,
    google_review_count: posIntOrNull(r.n_reviews_google),
    google_place_id: pid,
    num_lavadoras: posIntOrNull(r.n_lavadoras),
    num_secadoras: posIntOrNull(r.n_secadoras),
    precio_lavado_15kg: str(r.precios_15kglavado),
    precio_secado_15kg: str(r.precios_15kgsecado),
    marca_maquinas: str(r.marca_maquinas),
    estado_limpieza: str(r.estado_limpieza),
    years_aprox: str(r.years_aprox),
    clientes_estim: posIntOrNull(r.clientes),
    interes_venta: str(r.interes_venta),
    status2025: str(r.status2025),
    prioridad: str(r.prioridad),
    modelo2: str(r.modelo2),
    sq_link: str(r.sq_link),
    call_notes: str(r.resumen_llamadas),
    category: 'lavanderia',
    source: 'import',
    created_by: 'import',
  });
}

console.log(`read ${rows.length}; mapped ${mapped.length}; dropped ${dropped} (no/invalid coords or dup)`);
console.log(`  MCF rows: ${mapped.filter(m => m.propiedad_mcf).map(m => m.name).join(', ')}`);

const COLS = Object.keys(mapped[0]);
async function insertRow(m) {
  const placeholders = COLS.map(() => '?').join(', ');
  await t.execute({ sql: `INSERT INTO laundries (${COLS.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`, args: COLS.map(c => m[c]) });
}

if (REPLACE) {
  console.log('--replace: wiping laundries (cascades to notes/photos/files)…');
  await t.execute('DELETE FROM laundries');
}
let ins = 0;
for (const m of mapped) { await insertRow(m); ins++; if (ins % 100 === 0) console.log(`  ${ins}/${mapped.length}`); }
console.log(`OK inserted ${ins} laundries`);
