// Merge INE ADRH "renta" + "demografía" jaxiT3 CSV exports into one tidy
// census CSV keyed by sección censal (CUSEC), ready for import-census-csv.js.
//
// Source files are per-province ADRH table downloads, e.g. for Madrid (prov 28):
//   renta:      https://www.ine.es/jaxiT3/files/t/es/csv_bdsc/31097.csv?nocab=1
//   demografía: https://www.ine.es/jaxiT3/files/t/es/csv_bdsc/31105.csv?nocab=1
// (Find a province's table IDs via TABLAS_OPERACION/353 — the families
//  "Indicadores de renta media y mediana" and "Indicadores demográficos" each
//  list 54 tables in province-alphabetical order. See scripts/geo/README.md.)
//
// Usage:
//   node scripts/geo/build-census-csv.mjs --renta tmp/renta_28.csv --demo tmp/demo_28.csv --year 2023 --out tmp/census_madrid_2023.csv
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const RENTA = arg('renta');
const DEMO = arg('demo');
const YEAR = arg('year', '2023');
const OUT = arg('out', 'tmp/census_madrid_' + YEAR + '.csv');
if (!RENTA || !DEMO) { console.error('need --renta and --demo'); process.exit(1); }

// Spanish number: dots are thousands separators, comma is the decimal mark.
function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '' || t === '..' || t === '.' || t === '-') return null;
  const v = parseFloat(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}
const cusecOf = (secciones) => {
  const m = String(secciones || '').match(/^(\d{10})\b/);
  return m ? m[1] : null;
};

// rows[cusec] = { ...indicators }
const rows = new Map();
const get = (c) => { let r = rows.get(c); if (!r) { r = { seccion_id: c, municipio_id: c.slice(0, 5) }; rows.set(c, r); } return r; };

async function parse(file, indicatorCol, mapping) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    const f = line.split(';');
    if (!header) { header = f; continue; }
    // columns: Municipios;Distritos;Secciones;<indicator>;Periodo;Total
    const secciones = f[2];
    const indicator = f[3];
    const periodo = f[4];
    const total = f[5];
    if (!secciones) continue;            // keep only section-level rows
    if (periodo !== YEAR) continue;
    const field = mapping[indicator];
    if (!field) continue;
    const c = cusecOf(secciones);
    if (!c) continue;
    const r = get(c);
    r[field] = num(total);
  }
}

const RENTA_MAP = {
  'Renta neta media por persona': 'renta_media',
  'Renta neta media por hogar': 'renta_hogar',
};
const DEMO_MAP = {
  'Población': 'poblacion',
  'Tamaño medio del hogar': 'hogar_size',
  'Porcentaje de población española': '_pct_espanola',
};

await parse(RENTA, 3, RENTA_MAP);
await parse(DEMO, 3, DEMO_MAP);

// Derive pct_extranjero = 100 - % española.
for (const r of rows.values()) {
  if (r._pct_espanola != null) r.pct_extranjero = Math.round((100 - r._pct_espanola) * 10) / 10;
  delete r._pct_espanola;
}

const COLS = ['seccion_id', 'yyyy', 'municipio_id', 'poblacion', 'renta_media', 'renta_hogar', 'pct_extranjero', 'hogar_size'];
const out = [COLS.join(',')];
let withRenta = 0;
for (const r of [...rows.values()].sort((a, b) => a.seccion_id.localeCompare(b.seccion_id))) {
  r.yyyy = YEAR;
  if (r.renta_media != null) withRenta++;
  out.push(COLS.map(c => r[c] ?? '').join(','));
}
writeFileSync(OUT, out.join('\n') + '\n');
console.log(`OK  ${OUT}  ${rows.size} secciones (${withRenta} with renta)`);
