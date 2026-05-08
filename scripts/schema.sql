-- MCF Web - Turso Database Schema
-- Replaces 8 Notion databases with 9 relational tables

-- Table 1: movements
-- Source: mcf_movimientosForm-v3 (gasto, deposito, deposito_simple, transito, fondo_caja)
-- Replaces Notion DB 18413ec8894180bca990fccf2854f9d6
CREATE TABLE movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movement TEXT NOT NULL,
  type TEXT NOT NULL,
  account TEXT DEFAULT 'cash',
  euros REAL NOT NULL DEFAULT 0,
  propiedad TEXT,
  mcf_user TEXT,
  date_real TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT '🟡',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Table 2: incidents
-- Source: mcf_movimientosForm-v3 (incidencia)
-- Replaces Notion DB 19613ec8894180198e6ef1529ccf057d
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL,
  severity TEXT DEFAULT 'media',
  propiedad TEXT,
  cost REAL DEFAULT 0,
  resolution TEXT DEFAULT 'pendiente',
  found TEXT DEFAULT 'otro',
  machine TEXT,
  incident_date TEXT NOT NULL,
  icon TEXT DEFAULT '⚠️',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Table 3: surveys
-- Source: mcf_movimientosForm-v3 (encuesta)
-- Replaces Notion DB 2b413ec8894180e0ae5ee8c3699fa99a
CREATE TABLE surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  survey_id TEXT,
  propiedad TEXT,
  experience TEXT,
  cleanliness TEXT,
  availability TEXT,
  recommend TEXT,
  comments TEXT,
  survey_date TEXT NOT NULL,
  icon TEXT DEFAULT '📋',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Table 4: visits
-- Source: mcf_visitas (default visit type)
-- Replaces Notion DB 26c13ec8894180eb9802d73158977768
CREATE TABLE visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visita TEXT NOT NULL,
  visit_id TEXT,
  propiedad TEXT NOT NULL,
  mcf_user TEXT,
  fecha TEXT NOT NULL,
  time_clean INTEGER DEFAULT 0,
  -- Common cleaning tasks (L99xxx checkboxes)
  superficies_secadoras INTEGER DEFAULT 0,
  superficies_secadoras_atras INTEGER DEFAULT 0,
  superficies_lavadoras INTEGER DEFAULT 0,
  superficies_lavadoras_atras INTEGER DEFAULT 0,
  tirar_botes INTEGER DEFAULT 0,
  barrer INTEGER DEFAULT 0,
  trapear INTEGER DEFAULT 0,
  descarga_billetes INTEGER DEFAULT 0,
  carga_monedas INTEGER DEFAULT 0,
  carga_papel INTEGER DEFAULT 0,
  carga_tarjetas_cliente INTEGER DEFAULT 0,
  superficie_billetes INTEGER DEFAULT 0,
  superficie_tarjetas INTEGER DEFAULT 0,
  -- Inventory aggregates
  jabon_bodega REAL DEFAULT 0,
  suavizante_bodega REAL DEFAULT 0,
  oxigeno_bodega REAL DEFAULT 0,
  jabon_bombas REAL DEFAULT 0,
  suavizante_bombas REAL DEFAULT 0,
  oxigeno_bombas REAL DEFAULT 0,
  -- Cleanliness scores
  limpieza_general REAL DEFAULT 0,
  limpieza_maquinas REAL DEFAULT 0,
  limpieza_basura REAL DEFAULT 0,
  -- Full payload for audit
  raw_payload TEXT,
  icon TEXT DEFAULT '🔨',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Table 5: visit_tasks
-- Replaces dynamically-created child databases per visit in Notion
CREATE TABLE visit_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  task_name TEXT NOT NULL,
  status TEXT DEFAULT 'Complete',
  comments TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Table 6: inventory
-- Source: mcf_visitas (inventario type)
-- Replaces Notion DB 2c713ec8894180a4a88bc041d92df303
-- 3 rows per visit: Bodega, Bomba 1, Bomba 2
CREATE TABLE inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  propiedad TEXT,
  location TEXT NOT NULL,
  jabon REAL DEFAULT 0,
  suavizante REAL DEFAULT 0,
  oxigeno REAL DEFAULT 0,
  visit_id_ref TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Table 7: insumos
-- Source: mcf_visitas (insumos type)
-- Replaces Notion DB 26113ec8894180b5b140f0d727754f8c
CREATE TABLE insumos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Table 8: sales
-- Source: mcf_dailySales (S3 trigger, stays on AWS)
-- Replaces Notion DB 1cf13ec88941807bb208f8f2f5eaf405
CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movement TEXT NOT NULL,
  type TEXT DEFAULT 'venta',
  account TEXT,
  euros REAL NOT NULL DEFAULT 0,
  mcf_user TEXT,
  date_real TEXT NOT NULL,
  icon TEXT DEFAULT '🟢',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Table 9: gastos
-- Source: mcf_gastos (detailed expenses with receipts) + Google Sheet mirror
-- Replaces Notion DB 1c313ec8894180ad8ea4c8de4b58aef2
CREATE TABLE gastos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concepto_text TEXT NOT NULL,
  user_name TEXT,
  concepto_mcf TEXT,
  currency TEXT DEFAULT 'EUR',
  cuenta TEXT,
  concepto_proveedor TEXT,
  num_factura TEXT,
  nif_proveedor TEXT,
  razon_social TEXT,
  concepto_banco TEXT,
  gasto REAL DEFAULT 0,
  importe_iva REAL DEFAULT 0,
  importe_irpf REAL DEFAULT 0,
  importe_otro REAL DEFAULT 0,
  recibo_url TEXT,
  is_fiscal INTEGER DEFAULT 0,
  icon TEXT DEFAULT '🔴',
  created_at TEXT DEFAULT (datetime('now')),
  -- Reporting suite columns (see schema-reporting.sql)
  categoria_gastos_mcf TEXT,
  es_inversion TEXT DEFAULT 'No',
  fecha TEXT,
  mm INTEGER,
  yyyy INTEGER,
  importe_total REAL,
  propiedad TEXT,
  sheet_row_id TEXT
);
CREATE INDEX idx_gastos_period ON gastos (yyyy, mm);
CREATE INDEX idx_gastos_sheet_row_id ON gastos (sheet_row_id);

-- Table 10: catalogo_cuentas
-- Source: Google Sheet 1wju-dU... sheet "catalogo_cuentas"
-- Provides category + tooltip metadata for P&L reporting
CREATE TABLE catalogo_cuentas (
  cuenta_mcf TEXT PRIMARY KEY,
  categoria_gastos_mcf TEXT,
  desc TEXT,
  tooltip TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
