// Build public/geo/census-points.json for the catchment-ring demographic
// aggregation. Joins section centroids (from public/geo/secciones.geojson)
// with the indicator values (from Turso census_indicators, the authoritative
// copy used by the choropleth API). The browser loads this once and computes
// population-weighted ring aggregates client-side — same static-file pattern
// as centroids.bin, no per-ring API call.
//
// Regenerate after re-importing census data:
//   node scripts/geo/build-census-points.mjs [year=2023]
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const YEAR = parseInt(process.argv[2] || '2023', 10);
const GEOJSON = join(REPO, 'public', 'geo', 'secciones.geojson');
const OUT = join(REPO, 'public', 'geo', 'census-points.json');

function centroid(geom) {
  let sx = 0, sy = 0, n = 0;
  const walk = (a) => {
    if (typeof a[0] === 'number') { sx += a[0]; sy += a[1]; n++; return; }
    for (const c of a) walk(c);
  };
  if (geom && geom.coordinates) walk(geom.coordinates);
  return n ? [sx / n, sy / n] : null;
}
const round = (v, d) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;

const t = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const rs = await t.execute({
  sql: `SELECT seccion_id, poblacion, renta_media, renta_hogar, pct_extranjero, hogar_size, alquiler_m2, alquiler_growth
        FROM census_indicators WHERE yyyy = ?`,
  args: [YEAR],
});
const byId = new Map(rs.rows.map(r => [r.seccion_id, r]));

const geo = JSON.parse(readFileSync(GEOJSON, 'utf8'));
const points = [];
for (const f of geo.features) {
  const cusec = f.properties?.CUSEC;
  const c = centroid(f.geometry);
  if (!cusec || !c) continue;
  const v = byId.get(cusec) || {};
  points.push({
    c: cusec,
    lat: round(c[1], 6), lng: round(c[0], 6),
    pob: v.poblacion == null ? null : Number(v.poblacion),
    rm: v.renta_media == null ? null : Number(v.renta_media),
    rh: v.renta_hogar == null ? null : Number(v.renta_hogar),
    ext: v.pct_extranjero == null ? null : Number(v.pct_extranjero),
    hs: v.hogar_size == null ? null : Number(v.hogar_size),
    alq: v.alquiler_m2 == null ? null : Number(v.alquiler_m2),
    alqg: v.alquiler_growth == null ? null : Number(v.alquiler_growth),
  });
}

writeFileSync(OUT, JSON.stringify({ year: YEAR, count: points.length, points }));
const withData = points.filter(p => p.pob != null).length;
console.log(`OK  ${OUT}  ${points.length} sections (${withData} with population), ${(JSON.stringify({ points }).length / 1e6).toFixed(2)} MB`);
