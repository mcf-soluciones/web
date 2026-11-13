-- Kiosk v3: tables fed by the store kiosks through /api/kiosk/*.
-- Purely additive. sales_detail, sales, movements and products keep their columns.

CREATE TABLE IF NOT EXISTS kiosks (
  kiosk_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  price_list TEXT NOT NULL,
  property TEXT NOT NULL,
  propiedad_label TEXT NOT NULL,
  sales_user TEXT NOT NULL,
  sales_suffix TEXT NOT NULL,
  post_enabled INTEGER NOT NULL DEFAULT 1,
  silenced_until TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Every sale as the kiosk recorded it, including what sales_detail has no column for.
-- sales_detail and sales are derived from this table.
CREATE TABLE IF NOT EXISTS kiosk_sales (
  sale_id TEXT PRIMARY KEY,
  kiosk_id TEXT NOT NULL,
  receipt_no TEXT,
  kind TEXT NOT NULL,
  machine TEXT,
  description TEXT,
  cycles INTEGER,
  price_cents INTEGER NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  inserted_cents INTEGER,
  change_cents INTEGER,
  shortfall_cents INTEGER,
  bank_auth TEXT,
  bank_operation TEXT,
  bank_pan TEXT,
  card_uid TEXT,
  card_balance_after INTEGER,
  note TEXT,
  created_at_local TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  biz_date TEXT NOT NULL,
  app_version TEXT,
  post_state TEXT NOT NULL DEFAULT 'pending',
  movid TEXT,
  posted_at TEXT,
  product_ok INTEGER,
  received_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kiosk_sales_day ON kiosk_sales (kiosk_id, biz_date, method, post_state);

CREATE TABLE IF NOT EXISTS kiosk_cash_moves (
  kiosk_id TEXT NOT NULL,
  db_uuid TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  sale_id TEXT,
  at_local TEXT NOT NULL,
  kind TEXT NOT NULL,
  cents INTEGER NOT NULL,
  received_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (kiosk_id, db_uuid, local_id)
);

CREATE TABLE IF NOT EXISTS kiosk_card_moves (
  kiosk_id TEXT NOT NULL,
  db_uuid TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  uid TEXT NOT NULL,
  at_local TEXT NOT NULL,
  kind TEXT NOT NULL,
  cents INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  sale_id TEXT,
  note TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (kiosk_id, db_uuid, local_id)
);

CREATE TABLE IF NOT EXISTS kiosk_events (
  kiosk_id TEXT NOT NULL,
  db_uuid TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  at_local TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (kiosk_id, db_uuid, local_id)
);

-- Owners' cash pulls and coin loads. Each one creates exactly one movements row.
CREATE TABLE IF NOT EXISTS kiosk_cash_ops (
  op_id TEXT PRIMARY KEY,
  kiosk_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mcf_user TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  committed_at_local TEXT NOT NULL,
  counts TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  expected_cents INTEGER NOT NULL,
  note TEXT,
  posted INTEGER NOT NULL DEFAULT 0,
  received_at TEXT DEFAULT (datetime('now'))
);

-- What /kiosko sends down to a kiosk. Only the fields the kiosk allows: never ports, wiring or card keys.
CREATE TABLE IF NOT EXISTS kiosk_settings (
  kiosk_id TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);

-- Customer-card discounts. Card number and percentage only, no customer data.
CREATE TABLE IF NOT EXISTS kiosk_card_discounts (
  kiosk_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  percent INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (kiosk_id, uid)
);

CREATE TABLE IF NOT EXISTS kiosk_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kiosk_id TEXT,
  mcf_user TEXT,
  action TEXT NOT NULL,
  detail TEXT
);

-- Latest heartbeat per kiosk.
CREATE TABLE IF NOT EXISTS kiosk_status (
  kiosk_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  next_due_at TEXT NOT NULL,
  app_version TEXT,
  mode TEXT,
  off_until TEXT,
  clock_skew_s REAL,
  payload TEXT NOT NULL,
  recon_ok_through TEXT,
  last_daily_date TEXT
);

-- Result of the night check, one row per kiosk and day.
CREATE TABLE IF NOT EXISTS kiosk_recon (
  kiosk_id TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (kiosk_id, date)
);

-- One row per alert episode, from when the condition was first seen until it cleared.
CREATE TABLE IF NOT EXISTS kiosk_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kiosk_id TEXT NOT NULL,
  code INTEGER NOT NULL,
  message TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  notified_at TEXT,
  last_sent_at TEXT,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_kiosk_alerts_open ON kiosk_alerts (kiosk_id, closed_at);

-- People who can unlock money screens. No username: a PIN identifies its owner.
CREATE TABLE IF NOT EXISTS kiosk_users (
  mcf_user TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'owner',
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_iterations INTEGER NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kiosk_pin_guard (
  scope TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- Guards against a kiosk sale reaching sales_detail twice. Legacy movids (01101...) are not affected.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_detail_kiosk_movid ON sales_detail (movid) WHERE substr(movid, 1, 1) = 'K';
