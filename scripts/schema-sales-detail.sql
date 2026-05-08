-- Products catalog
-- Join key to sales_detail: product + precio/euro + price_list + property
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  precio REAL NOT NULL,
  capacidad TEXT,
  product_price TEXT,
  product_size TEXT,
  product_mins INTEGER DEFAULT 0,
  product_mission TEXT,
  subproducto TEXT,
  day_subproduct_capacity INTEGER DEFAULT 0,
  day_product_capacity INTEGER DEFAULT 0,
  notes TEXT,
  price_list TEXT NOT NULL,
  property TEXT NOT NULL
);

-- Detailed sales transactions
CREATE TABLE sales_detail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movid TEXT NOT NULL,
  date TEXT NOT NULL,
  yyyy INTEGER NOT NULL,
  mm INTEGER NOT NULL,
  dd INTEGER NOT NULL,
  time TEXT,
  hr INTEGER,
  min INTEGER,
  payment TEXT,
  product TEXT,
  euro REAL DEFAULT 0,
  company TEXT,
  dayweek TEXT,
  price_list TEXT,
  property TEXT
);

-- Index for common queries: filter by month/year, join to products
CREATE INDEX idx_sales_detail_period ON sales_detail (yyyy, mm, property);
CREATE INDEX idx_sales_detail_product_join ON sales_detail (product, euro, price_list, property);
CREATE INDEX idx_products_join ON products (product, precio, price_list, property);
