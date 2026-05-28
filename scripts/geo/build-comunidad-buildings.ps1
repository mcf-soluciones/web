<#
.SYNOPSIS
  Build a single PMTiles archive of Catastro building footprints for the
  Comunidad de Madrid, filtered by municipality population, for the Mapa
  "Edificios" layer.

.DESCRIPTION
  Pipeline per qualifying municipality (population >= -MinPopulation):
    1. Download the INSPIRE Buildings zip from Catastro (province 28 ATOM feed).
    2. Extract only <code>.building.gml (skips the huge buildingpart.gml).
    3. ogr2ogr -> WGS84 GeoJSONSeq, keeping numberOfDwellings + a few attrs.
    4. Delete the zip + GML (keeps only the slim .geojsonl).
  Then a single tippecanoe run merges every qualifying .geojsonl into
  madrid.pmtiles and copies it to public/geo/buildings/.

  RESUMABLE: a municipality whose .geojsonl already exists is skipped, so a
  re-run with a different -MinPopulation re-tiles instantly without
  re-downloading. To re-threshold WITHOUT re-downloading, keep the
  tmp/buildings/geojsonl folder.

  REQUIRES Docker with:
    - ghcr.io/osgeo/gdal:alpine-small-latest   (ogr2ogr)
    - tippecanoe-local                          (built from felt/tippecanoe;
                                                  see scripts/geo/build-buildings.sh notes)

.PARAMETER MinPopulation
  Minimum municipality population to include. Default 30000 (~28 municipios,
  ~90% of the region's people). Use 0 to include all 179.

.EXAMPLE
  .\scripts\geo\build-comunidad-buildings.ps1 -MinPopulation 30000
  .\scripts\geo\build-comunidad-buildings.ps1 -MinPopulation 20000
  .\scripts\geo\build-comunidad-buildings.ps1 -MinPopulation 0
#>
param(
  [int]$MinPopulation = 30000,
  [string]$Province = "28",
  [int]$MinZoom = 13,
  [int]$MaxZoom = 16
)
$ErrorActionPreference = 'Stop'

$repo    = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$manifest = Join-Path $PSScriptRoot 'madrid-municipios.csv'
$tmp     = Join-Path $repo 'tmp\buildings'
$work    = Join-Path $tmp 'work'
$geojson = Join-Path $tmp 'geojsonl'
$outDir  = Join-Path $repo 'public\geo\buildings'
$gdalImg = 'ghcr.io/osgeo/gdal:alpine-small-latest'
$tipImg  = 'tippecanoe-local'

New-Item -ItemType Directory -Force -Path $work, $geojson, $outDir | Out-Null

# Reuse a Madrid geojsonl that was built standalone in an earlier step.
$strayMadrid = Join-Path $tmp '28900.geojsonl'
if ((Test-Path $strayMadrid) -and -not (Test-Path (Join-Path $geojson '28900.geojsonl'))) {
  Move-Item $strayMadrid (Join-Path $geojson '28900.geojsonl') -Force
}

# --- ATOM feed: code -> download URL ----------------------------------------
$atom = Join-Path $tmp "atom_$Province.xml"
if (-not (Test-Path $atom)) {
  $atomUrl = "https://www.catastro.hacienda.gob.es/INSPIRE/buildings/$Province/ES.SDGC.BU.atom_$Province.xml"
  Write-Host "Downloading ATOM feed..."
  Invoke-WebRequest -Uri $atomUrl -UseBasicParsing -TimeoutSec 120 -OutFile $atom
}
$xml = Get-Content $atom -Raw
$urlByCode = @{}
foreach ($m in [regex]::Matches($xml, 'href="([^"]+A\.ES\.SDGC\.BU\.(\d+)\.zip)"')) {
  $urlByCode[$m.Groups[2].Value] = $m.Groups[1].Value
}

# --- Select municipalities ---------------------------------------------------
$selected = Import-Csv $manifest |
  Where-Object { [int]$_.population -ge $MinPopulation } |
  Sort-Object { [int]$_.population } -Descending

Write-Host "MinPopulation=$MinPopulation -> $($selected.Count) municipios"

$failed = @()
$i = 0
foreach ($row in $selected) {
  $i++
  $code = $row.code
  $gj = Join-Path $geojson "$code.geojsonl"
  $tag = "[$i/$($selected.Count)] $code $($row.name)"

  if (Test-Path $gj) { Write-Host "$tag  cached"; continue }

  $url = $urlByCode[$code]
  if (-not $url) { Write-Warning "$tag  no URL in ATOM feed"; $failed += $code; continue }
  $url = $url -replace ' ', '%20'

  $zip = Join-Path $work "$code.zip"
  $gml = Join-Path $work "A.ES.SDGC.BU.$code.building.gml"
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 600 -OutFile $zip
    # Extract just the building.gml member.
    & tar -xf $zip -C $work "A.ES.SDGC.BU.$code.building.gml" 2>$null
    if (-not (Test-Path $gml)) { throw "building.gml not found in zip" }

    docker run --rm -v "${work}:/in" -v "${geojson}:/out" $gdalImg `
      ogr2ogr -f GeoJSONSeq -t_srs EPSG:4326 -nlt PROMOTE_TO_MULTI `
      -select "gml_id,numberOfDwellings,numberOfFloorsAboveGround,currentUse,beginning,value" `
      "/out/$code.geojsonl" "/in/A.ES.SDGC.BU.$code.building.gml" | Out-Null
    if (-not (Test-Path $gj)) { throw "ogr2ogr produced no output" }

    $mb = [math]::Round((Get-Item $gj).Length/1MB,1)
    Write-Host "$tag  OK ($mb MB)"
  } catch {
    Write-Warning "$tag  FAILED: $($_.Exception.Message)"
    $failed += $code
  } finally {
    Remove-Item $zip, $gml, (Join-Path $work "A.ES.SDGC.BU.$code.building.gfs") -Force -ErrorAction SilentlyContinue
  }
}

if ($failed.Count) { Write-Warning "Failed municipios: $($failed -join ', ')" }

# --- Merge qualifying geojsonl -> PMTiles ------------------------------------
$inputs = $selected | ForEach-Object { "/data/$($_.code).geojsonl" } |
  Where-Object { Test-Path (Join-Path $geojson (Split-Path $_ -Leaf)) }
Write-Host "`nTiling $($inputs.Count) municipios -> madrid.pmtiles ..."

$argList = @(
  'run','--rm','-v',"${geojson}:/data",$tipImg,
  'tippecanoe',"-Z$MinZoom","-z$MaxZoom",
  '--drop-densest-as-needed','--extend-zooms-if-still-dropping',
  '-l','buildings','--name','Comunidad de Madrid buildings',
  '-o','/data/madrid.pmtiles','--force'
) + $inputs
& docker @argList

$built = Join-Path $geojson 'madrid.pmtiles'
if (-not (Test-Path $built)) { throw "tippecanoe did not produce madrid.pmtiles" }
Move-Item $built (Join-Path $outDir 'madrid.pmtiles') -Force
$finalMb = [math]::Round((Get-Item (Join-Path $outDir 'madrid.pmtiles')).Length/1MB,1)

Write-Host "`nDONE  public/geo/buildings/madrid.pmtiles = $finalMb MB ($($inputs.Count) municipios, pop >= $MinPopulation)"
Write-Host "Update public/geo/buildings/index.json to point at madrid.pmtiles."
