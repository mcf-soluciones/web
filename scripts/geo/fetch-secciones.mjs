// Fetch sección-censal polygons for one province from the INE GeoServer
// OGC API Features endpoint, slim to just the CUSEC join key, drop the
// district aggregate rows (CSEC = 000), and write a raw GeoJSON to tmp/.
// A separate simplify step (mapshaper) produces public/geo/secciones.geojson.
//
// Usage:
//   node scripts/geo/fetch-secciones.mjs [province=28] [year=2023]
//
// Output: tmp/secciones_<province>_full.geojson  (WGS84 / CRS84)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROVINCE = process.argv[2] || '28';
const YEAR = process.argv[3] || '2023';
const OUT = join(REPO, 'tmp', `secciones_${PROVINCE}_full.geojson`);

const COLL = `WMS_INE_SECCIONES_G01:Secciones_${YEAR}`;
const BASE = `https://www.ine.es/geoserver/ogc/features/v1/collections/${COLL}/items`;
const PAGE = 1000;

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const filter = encodeURIComponent(`CPRO='${PROVINCE}'`);
  const features = [];
  const seen = new Set();
  let matched = null;
  // Follow the server's own `next` links — INE GeoServer paginates with
  // startIndex (it ignores `offset`), so constructing our own paging param
  // is fragile. Start from page 1 and chase rel=next until it's gone.
  let url = `${BASE}?f=application/json&limit=${PAGE}`
    + `&filter-lang=cql2-text&filter=${filter}`;
  let fetched = 0;

  while (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
    const j = await r.json();
    if (matched === null) {
      matched = j.numberMatched;
      console.log(`numberMatched=${matched}; sample coord ${flattenFirst(j.features?.[0]?.geometry?.coordinates)}`);
    }
    for (const f of j.features) {
      const cusec = f.properties?.CUSEC;
      if (!cusec || cusec.endsWith('000') || seen.has(cusec)) continue; // skip districts + dups
      seen.add(cusec);
      features.push({ type: 'Feature', properties: { CUSEC: cusec }, geometry: f.geometry });
    }
    fetched += j.numberReturned;
    console.log(`  fetched ${fetched}/${matched} (kept ${features.length})`);
    const next = (j.links || []).find(l => l.rel === 'next');
    url = (next && j.numberReturned > 0) ? next.href : null;
  }

  writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`\nOK  ${OUT}  ${features.length} secciones`);
}

function flattenFirst(coords) {
  let a = coords;
  while (Array.isArray(a) && Array.isArray(a[0])) a = a[0];
  return Array.isArray(a) ? a.join(',') : String(a);
}

main().catch(e => { console.error(e); process.exit(1); });
