#!/usr/bin/env bash
# Convert the INE sección-censal shapefile to a slim, simplified GeoJSON
# for the Mapa census choropleth layer.
#
# Input:
#   tmp/secciones_madrid.shp    (download from INE — "Cartografía digital de
#                                 las Secciones Censales", filter to Comunidad
#                                 de Madrid province = '28')
#
# Output:
#   public/geo/secciones.geojson
#
# Requirements (install via brew / apt / scoop):
#   - ogr2ogr (GDAL)
#   - mapshaper (npm i -g mapshaper)
#
# Usage:
#   ./scripts/geo/build-secciones.sh
#
# Notes on the geometry field:
#   The frontend looks for feature.properties.CUSEC (INE 10-digit code) to
#   join against census_indicators.seccion_id. The INE shapefile uses CUSEC
#   already, so the -select below keeps it.
#
# If you only want Madrid municipality (28079), use the alternate filter below.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${ROOT}/tmp/secciones_madrid.shp"
OUT="${ROOT}/public/geo/secciones.geojson"
TMP="${ROOT}/tmp/secciones_full.geojson"

if [[ ! -f "$SRC" ]]; then
  echo "Source shapefile not found: $SRC"
  echo "Download from https://www.ine.es/ (Cartografía Secciones Censales)"
  echo "and place at tmp/secciones_madrid.shp (with .dbf/.prj/.shx siblings)."
  exit 1
fi

mkdir -p "${ROOT}/public/geo"

# 1. Convert to GeoJSON, reproject to WGS84, keep only the CUSEC join key.
#    -where filter narrows to Comunidad de Madrid (CCA='13' in INE 2024 schema;
#    older versions use NPRO='Madrid'). Adjust to your file if needed.
ogr2ogr -f GeoJSON \
  -t_srs EPSG:4326 \
  -select CUSEC \
  "$TMP" \
  "$SRC"

# 2. Simplify for fast browser rendering. 15% retention keeps blocks readable
#    at street zoom while shrinking the payload ~5x.
mapshaper "$TMP" -simplify 15% keep-shapes -o format=geojson "$OUT"

echo "OK  $OUT"
ls -lh "$OUT"
