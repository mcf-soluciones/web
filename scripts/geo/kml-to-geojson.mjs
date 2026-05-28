/**
 * Convert a Google MyMaps KML export to GeoJSON for the Mapa view.
 *
 * MyMaps exports use a slightly idiosyncratic KML structure (StyleMap, ExtendedData,
 * gx:Track, etc.). We delegate to @tmcw/togeojson which handles all of that, then
 * write the result to public/geo/zonas-comerciales.geojson.
 *
 * Usage:
 *   node scripts/geo/kml-to-geojson.mjs <input.kml> [output.geojson]
 *
 * Defaults:
 *   - output path: public/geo/zonas-comerciales.geojson
 *
 * After generating: redeploy (or push to trigger Vercel) and toggle the
 * "Zonas comerciales" layer in the Mapa view.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'xmldom';
import { kml } from '@tmcw/togeojson';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node scripts/geo/kml-to-geojson.mjs <input.kml> [output.geojson]');
  process.exit(1);
}

const inputPath = resolve(args[0]);
const outputPath = args[1]
  ? resolve(args[1])
  : resolve(REPO_ROOT, 'public', 'geo', 'zonas-comerciales.geojson');

const xml = readFileSync(inputPath, 'utf8');
const doc = new DOMParser().parseFromString(xml, 'application/xml');
const fc = kml(doc);

// Strip any feature with no geometry (MyMaps occasionally exports orphan
// description rows) so Leaflet doesn't trip on them.
const cleaned = {
  type: 'FeatureCollection',
  features: (fc.features || []).filter(f => f && f.geometry),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(cleaned));
console.log(`OK  ${cleaned.features.length} features → ${outputPath}`);
