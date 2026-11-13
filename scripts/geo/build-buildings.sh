#!/usr/bin/env bash
# Convert one Catastro INSPIRE Buildings GML file to a PMTiles archive for
# the Mapa "Edificios" layer.
#
# Input:
#   tmp/buildings/A.ES.SDGC.BU.<municipio>.building.gml
#
# Output:
#   public/geo/buildings/<municipio>.pmtiles
#
# Requirements:
#   - ogr2ogr (GDAL, with GML driver)
#   - tippecanoe (Mapbox's vector tile builder)
#   - pmtiles convert (https://github.com/protomaps/PMTiles)
#
# Usage:
#   ./scripts/geo/build-buildings.sh 28900     # Madrid municipality
#
# What gets kept:
#   - geometry (footprint polygon)
#   - numberOfDwellings  (drives the choropleth color)
#   - numberOfFloorsAboveGround
#   - currentUse
#   - beginning (construction year)
# All other Catastro attributes are dropped to keep tile size manageable.
#
# Tile config (tippecanoe):
#   -zg                            : auto pick max zoom from feature density
#   --drop-densest-as-needed       : when a tile overflows, drop the densest
#                                    features to fit; keeps the layer responsive
#                                    in dense urban blocks
#   --extend-zooms-if-still-dropping : push max zoom if we're still over budget
#   -l buildings                   : single layer named "buildings"
#                                    (frontend references this name)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CODE="${1:-}"
if [[ -z "$CODE" ]]; then
  echo "Usage: ./scripts/geo/build-buildings.sh <municipio_code>"
  echo "Example: ./scripts/geo/build-buildings.sh 28900"
  exit 1
fi

GML="${ROOT}/tmp/buildings/A.ES.SDGC.BU.${CODE}.building.gml"
GEOJSONL="${ROOT}/tmp/buildings/${CODE}.geojsonl"
MBTILES="${ROOT}/tmp/buildings/${CODE}.mbtiles"
PMTILES="${ROOT}/public/geo/buildings/${CODE}.pmtiles"

if [[ ! -f "$GML" ]]; then
  echo "GML not found: $GML"
  echo "Download per-municipality buildings from sede.catastro.gob.es"
  echo "(Servicios → Cartografía → INSPIRE → Buildings)"
  exit 1
fi

mkdir -p "${ROOT}/public/geo/buildings"

# 1. GML → newline-delimited GeoJSON, slim attributes, reproject to WGS84.
ogr2ogr -f GeoJSONSeq -t_srs EPSG:4326 \
  -select "gml_id,numberOfDwellings,numberOfFloorsAboveGround,currentUse,beginning" \
  "$GEOJSONL" \
  "$GML"

# 2. Tile it.
tippecanoe -zg --drop-densest-as-needed --extend-zooms-if-still-dropping \
  -l buildings \
  -o "$MBTILES" \
  --force \
  "$GEOJSONL"

# 3. Convert MBTiles → PMTiles for static hosting.
pmtiles convert "$MBTILES" "$PMTILES"

echo "OK  $PMTILES"
ls -lh "$PMTILES"
