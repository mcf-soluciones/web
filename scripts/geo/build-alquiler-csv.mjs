// Extract sección-level rental price + rent growth for one province from the
// SERPAVI database (Ministerio de Vivienda, bd_SERPAVI_2011-2024.xlsx) into a
// CSV for import-census-csv.js.
//
//   alquiler_m2      = ALQM2_LV_M_VC_<latest>  (mean €/m²/month, collective housing)
//   alquiler_growth  = % change ALQM2_LV_M_VC from <base> to <latest>
//
// Keyed to --year (default 2023) so it MERGES into the existing ADRH census
// rows (rent reflects the latest SERPAVI year attached to that census snapshot).
//
// Usage:
//   node scripts/geo/build-alquiler-csv.mjs --xlsx tmp/serpavi.xlsx --prov 28 --year 2023 --out tmp/alquiler_28.csv
import xlsx from 'xlsx';
import { writeFileSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const XLSX = arg('xlsx', 'tmp/serpavi.xlsx');
const PROV = arg('prov', '28');
const YEAR = arg('year', '2023');
const OUT = arg('out', `tmp/alquiler_${PROV}.csv`);
const LATEST = 24, BASE = 19;     // 2024 level, 2019->2024 growth window

const wb = xlsx.readFile(XLSX);
const rows = xlsx.utils.sheet_to_json(wb.Sheets['Secciones censales'], { defval: null });

const out = ['seccion_id,yyyy,alquiler_m2,alquiler_growth'];
let nLevel = 0, nGrowth = 0, nProv = 0;
for (const r of rows) {
  const cusec = String(r.CUSEC || '');
  if (cusec.slice(0, 2) !== PROV) continue;
  nProv++;
  const lvl = r[`ALQM2_LV_M_VC_${LATEST}`];
  const base = r[`ALQM2_LV_M_VC_${BASE}`];
  const alq = (lvl != null && Number.isFinite(+lvl)) ? Math.round(+lvl * 100) / 100 : '';
  let growth = '';
  if (alq !== '' && base != null && +base > 0) {
    growth = Math.round((((+lvl) / (+base)) - 1) * 1000) / 10; // % to 1 decimal
  }
  if (alq !== '') nLevel++;
  if (growth !== '') nGrowth++;
  if (alq === '' && growth === '') continue;
  out.push(`${cusec},${YEAR},${alq},${growth}`);
}
writeFileSync(OUT, out.join('\n') + '\n');
console.log(`prov ${PROV}: ${nProv} sections; ${nLevel} with 20${LATEST} rent; ${nGrowth} with 20${BASE}->20${LATEST} growth`);
console.log(`OK  ${OUT}`);
