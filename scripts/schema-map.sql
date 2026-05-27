-- Map module: laundries (MCF + competitors), photos, census indicators.
-- See api/laundries/* and the `mapa` view in public/reporte.html.

-- 1. Laundries master. Pins on the map.
--    propiedad_mcf = 1 means it's a location we own/operate; 0 = competitor or prospect.
CREATE TABLE IF NOT EXISTS laundries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  address TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  propiedad_mcf INTEGER NOT NULL DEFAULT 0,
  tel TEXT,
  google_rating REAL,
  google_review_count INTEGER,
  google_place_id TEXT,
  num_lavadoras INTEGER,
  num_secadoras INTEGER,
  precio_lavado_15kg TEXT,
  precio_secado_15kg TEXT,
  marca_maquinas TEXT,
  estado_limpieza TEXT,
  years_aprox TEXT,
  clientes_estim INTEGER,
  interes_venta TEXT,
  status2025 TEXT,
  prioridad TEXT,
  modelo2 TEXT,
  sq_link TEXT,
  call_notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_laundries_propiedad ON laundries(propiedad_mcf);
CREATE INDEX IF NOT EXISTS idx_laundries_brand     ON laundries(brand);

-- 2. Photos per laundry. Stored in Google Drive; we keep the public URL.
CREATE TABLE IF NOT EXISTS laundry_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  laundry_id INTEGER NOT NULL REFERENCES laundries(id) ON DELETE CASCADE,
  drive_url TEXT NOT NULL,
  caption TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_laundry_photos_laundry ON laundry_photos(laundry_id);

-- 3. Census indicators per sección censal per year. Drives the choropleth layer.
CREATE TABLE IF NOT EXISTS census_indicators (
  seccion_id TEXT NOT NULL,          -- INE CUSEC: 10-digit code
  barrio_id TEXT,
  municipio_id TEXT,
  yyyy INTEGER NOT NULL,
  poblacion INTEGER,
  renta_media REAL,
  renta_hogar REAL,
  pct_extranjero REAL,
  hogar_size REAL,
  alquiler_m2 REAL,
  PRIMARY KEY (seccion_id, yyyy)
);
CREATE INDEX IF NOT EXISTS idx_census_municipio ON census_indicators(municipio_id, yyyy);
