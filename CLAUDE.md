# MCF Web - Project Reference

## What This App Does

MCF Soluciones operates self-service laundromats in Madrid (locations: **Usera** and **Hortaleza**). This web app is the operational platform used by staff to record daily activities: expenses, deposits, cash counts, incident reports, customer surveys, site visits with cleaning checklists, and inventory tracking. It also has a public-facing landing page at mcfsoluciones.com.

The app is a collection of mobile-first HTML forms that submit data to a Turso (libSQL) database via Vercel serverless functions. There is no authentication framework -- users are identified by a `?user=lalo` URL parameter, and admin access uses a simple password stored client-side.

## Architecture

```
Browser (HTML + jQuery)
  |
  | POST /api/* (JSON)
  v
Vercel Serverless Functions (api/*.js)
  |
  | @libsql/client
  v
Turso Database (libSQL edge SQLite)
  |
  +-- Also: Google Drive (receipt uploads)
  +-- Also: Google Sheets (expense row sync)

AWS Lambda (3 functions still on AWS)
  |
  +-- mcf_gmailReadtoS3 / mcf_gmailReadtoS3_hortaleza
  |     Gmail API -> S3 bucket "mcf-sales" (CSV)
  |
  +-- mcf_dailySales (S3 event trigger)
        Parses CSV -> INSERT into Turso sales table
```

**Hosting**: Vercel (static HTML + serverless API)
**Database**: Turso (libsql://mcf-eflores89.aws-us-west-2.turso.io), database name: `mcf`
**Domain**: mcfsoluciones.com
**AWS Profile**: `eem-personal` (region: us-east-1, account: 367321646348)

## Tech Stack

- **Frontend**: Plain HTML, jQuery 3.6.0, Bootstrap 4.5, Font Awesome, custom CSS variables
- **Backend**: Vercel serverless functions (Node.js, ESM compiled to CJS by Vercel)
- **Database**: Turso (libSQL / edge SQLite) via `@libsql/client`
- **External APIs**: Google Drive API, Google Sheets API via `googleapis`
- **AWS**: S3 (sales CSV intermediary), Lambda (3 functions), no API Gateway needed for new routes

## Directory Structure

```
mcf-web/
  public/                  # Static files served by Vercel
    index.html             # Landing page (inlined from Jekyll layout)
    admin.html             # Admin dashboard (password: mcf2024, users: lalo/oscar/adrian)
    gastos.html            # Expense form -> /api/movimientos + /api/gastos-sheets
    deposito.html          # Deposit form -> /api/movimientos
    retiro.html            # Cash withdrawal (denominations) -> /api/movimientos
    fondo-caja.html        # Cash fund count (denominations) -> /api/movimientos
    incidencias.html       # Incident report -> /api/movimientos
    encuesta-usera.html    # Customer survey (Usera) -> /api/movimientos
    encuesta-hortaleza.html# Customer survey (Hortaleza) -> /api/movimientos
    final-visit.html       # Visit checklist -> /api/visitas
    inventario.html        # Inventory levels -> /api/visitas
    reportar-insumos.html  # Supply request -> /api/visitas
    survey.html            # Generic survey (API call commented out)
    calculador.html        # Redirect to R Shiny app
    session-reset.html     # Clears localStorage/sessionStorage
    movimientos.html       # Empty page (placeholder)
    css/                   # Bootstrap, animate.css, main.css (compiled from SCSS)
    js/                    # jQuery, Bootstrap, creative.js, etc.
    fonts/, font-awesome/, img/

  api/                     # Vercel serverless functions
    _lib/
      turso.js             # Shared Turso client (reads TURSO_DATABASE_URL, TURSO_AUTH_TOKEN)
      google-auth.js       # Google Drive + Sheets auth (two separate service accounts)
    movimientos.js         # Central form router: gasto, deposito,
                           #   incidencia, encuesta, transito, fondo_caja
                           # Routes by body.type field
    visitas.js             # Visit handler: default (visit), inventario, insumos
                           # Routes by body.type field
    gastos.js              # Detailed expense: uploads receipt to Google Drive,
                           #   inserts into gastos table
    gastos-sheets.js       # Appends expense row to Google Sheets spreadsheet

  lambda/                  # AWS Lambda source code (5 functions still deployed on AWS)
    mcf_dailySales/        # S3 trigger -> parses CSV -> INSERT into Turso sales table
    mcf_gmailReadtoS3/     # Scheduled: reads Usera sales emails -> uploads CSV to S3
    mcf_gmailReadtoS3_hortaleza/  # Same for Hortaleza location
    mcf_daily_plan-v2/     # Weather data (Python, no DB interaction)
    mcf_survivor/          # Email alerts (no DB interaction)

  scripts/
    schema.sql             # Turso schema: 9 operational tables
    schema-sales-detail.sql# Turso schema: products + sales_detail tables
    migrate-notion-to-turso.js  # One-time migration script (already run)

  vercel.json              # Vercel config: cleanUrls, CORS headers, output dir
  package.json             # Dependencies: @libsql/client, googleapis
  .env                     # Local env vars (gitignored)
  .env.example             # Template with placeholder values

```

## Database Schema (Turso)

### Operational Tables (from forms)

| Table | Purpose | Written By | Key Columns |
|-------|---------|------------|-------------|
| `movements` | Expenses, deposits, cash fund, transit | `/api/movimientos` | movement, type, euros, propiedad, mcf_user, date_real |
| `incidents` | Operational problems | `/api/movimientos` | summary, severity, propiedad, cost, resolution |
| `surveys` | Customer feedback | `/api/movimientos` | name, survey_id, propiedad, experience, cleanliness |
| `visits` | Site visit checklists (wide table, 29 columns) | `/api/visitas` | visita, visit_id, propiedad, 13 task checkboxes, 6 inventory aggregates, 3 cleanliness scores, raw_payload |
| `visit_tasks` | Individual tasks per visit (1:N) | `/api/visitas` | visit_id (FK -> visits.id), task_name, status, comments |
| `inventory` | Supply levels (3 rows per visit: Bodega, Bomba 1, Bomba 2) | `/api/visitas` | name, propiedad, location, jabon, suavizante, oxigeno |
| `insumos` | Supply purchase requests | `/api/visitas` | task_name |
| `sales` | Daily sales totals (from CSV pipeline) | AWS `mcf_dailySales` Lambda | movement, type, account, euros, mcf_user, date_real |
| `gastos` | Detailed expenses with receipt URLs | `/api/gastos` | concepto_text, user_name, gasto, importe_iva, recibo_url, is_fiscal |

### Analytics Tables (from Excel import)

| Table | Purpose | Rows | Key Columns |
|-------|---------|------|-------------|
| `products` | Product catalog (machines, prices, capacities) | 180 | product, precio, price_list, property, product_mission, product_size, product_mins |
| `sales_detail` | Individual transactions since 2024 | ~90K | movid, date, yyyy, mm, payment, product, euro, price_list, property |

**Join between sales_detail and products**: `sales_detail.product = products.product AND sales_detail.euro = products.precio AND sales_detail.price_list = products.price_list AND sales_detail.property = products.property`

This join enriches transactions with product metadata (mission, size, minutes, capacity) for the monthly business report. Special cases: RECARGA and TARJETA products don't join -- they're handled with hardcoded overrides in the report logic.

## Environment Variables

| Variable | Where Used | Purpose |
|----------|------------|---------|
| `TURSO_DATABASE_URL` | Vercel + AWS Lambda (mcf_dailySales) | libSQL connection URL |
| `TURSO_AUTH_TOKEN` | Vercel + AWS Lambda (mcf_dailySales) | Turso auth token |
| `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` | Vercel (`/api/gastos`) | Service account for receipt uploads (project: mcf-lambda-to-drive-gastos) |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` | Vercel (`/api/gastos-sheets`) | Service account for spreadsheet appends (project: western-evening-264012) |
| `NOTION_API_KEY` | Migration script only | No longer needed in production |

## API Routes

All routes accept POST with JSON body. CORS is open (`*`). Routes return `{ success: true, type, id, message }` on success.

### POST /api/movimientos
Routes by `body.type`:
- `gasto` -> INSERT movements (icon: money_with_wings)
- `deposito` -> INSERT movements (icon: bank) — uses `body.euros` directly (no denominations)
- `incidencia` -> INSERT incidents
- `encuesta` -> INSERT surveys
- default (transito, fondo_caja) -> calculates euros from denomination fields (b20e, b10e, b5e, m2e, m1e, m50e, m20e, m10e, m5e) -> INSERT movements

### POST /api/visitas
Routes by `body.type`:
- `inventario` -> 3x INSERT inventory (bodega, bomba1, bomba2)
- `insumos` -> INSERT insumos
- default (visit) -> INSERT visits + batch INSERT visit_tasks for completed tasks

### Gastos endpoints (Turso-primary; Google Sheet is retired)

All gastos writes flow through Turso; the Google Sheet is a frozen archive.

- **`POST /api/gastos/create`** — single write path for a new gasto. Accepts all columns + optional base64 `file` (factura PDF → Drive folder `1L44fCCmEsOQW0SvxvduC6QthJlt-DC7a`). Inserts into `gastos` AND a matching row into `movements` (so Hub user balances stay correct). Derives `categoria_gastos_mcf` from `catalogo_cuentas` via `cuenta`.
- **`GET /api/gastos/list?yyyy=&mm=`** — full-row list with `catalogo_cuentas` join for the month table.
- **`PATCH /api/gastos/update`** — inline single-row edits; server-side column whitelist in `api/_lib/gastos-editable.js`. Auto-re-derives `mm`/`yyyy` on `fecha` change and `categoria_gastos_mcf` on `cuenta` change.
- **`PATCH /api/gastos/bulk`** — apply same column change to N rows. Only categorical fields are bulk-editable; numeric importes are per-row only.
- **`GET /api/gastos/resolve-cuenta?concepto_mcf=&propiedad=`** — `catalogo_cuentas` lookup. User never picks the cuenta code; the form derives it from (concepto × propiedad). Propiedad is normalized: `usera` → `(001) Usera`, etc.
- **`GET /api/gastos/suggest?cuenta=&field=`** — recent distinct values for `razon_social` / `nif_proveedor` / `concepto_proveedor` / `num_factura` / `concepto_banco` within a cuenta. GROUP BY TRIM(field) to dedupe whitespace variants. Drives the clickable suggestion chips in the detailed-entry modal.
- **`POST /api/gastos/factura`** — re-attach a factura PDF to an existing gasto. Uploads to Drive, updates `recibo_url`.
- **`DELETE /api/gastos/delete?id=`** — hard delete a single row (no soft delete — low-volume table).
- **`GET /api/export/month?yyyy=&mm=`** — streams a ZIP of `mcf-YYYY-MM.xlsx` (2 sheets: Ventas + Gastos with clickable Drive hyperlinks) + `facturas/*.pdf` for every gasto row with a `recibo_url`. Uses `xlsx` + `archiver`.

### Deprecated (410 Gone)
- **`POST /api/gastos`** — split into `create` (new gasto + optional factura) and `factura` (attach to existing).
- **`POST /api/gastos-sheets`** — the Sheet is retired.
- **`POST /api/movimientos` `type=gasto`** — returns 410; use `create` which writes the `movements` row too. Other types (`deposito`, `incidencia`, `encuesta`, denomination movements) still work.

## Sales Pipeline (AWS)

```
Gmail (sales reports) -> mcf_gmailReadtoS3 -> S3 "mcf-sales" bucket
                                                    |
                                                    v (S3 event trigger)
                                              mcf_dailySales -> Turso sales table
```

- Usera emails: from `mcf.usera@gmail.com`, subject contains "Fichero de ventas del"
- Hortaleza emails: from `speedqueencanillas@gmail.com`, same subject pattern
- CSV format: semicolon-delimited, total lines contain "TOTAL" + payment type + amount
- Payment types: efectivo -> "cash", bancaria -> "banco", tarjeta-cliente -> skipped

## Frontend Patterns

- Forms use `$.ajax()` POST with `contentType: "application/json"` to relative URLs (`/api/movimientos`, `/api/visitas`, etc.)
- User context passed via URL param: `?user=lalo`
- Loading overlay: `document.getElementById('loading-overlay').classList.add('active')`
- On success: hides form card, shows completion message
- Mobile-first: max-width 480px containers, CSS custom properties for theming
- Admin auth: sessionStorage key `mcf_admin_session`, password `mcf2024`

## Key Business Concepts

- **Propiedad**: Location (usera, hortaleza)
- **MCF User**: Staff member (lalo, oscar, adrian, kenia)
- **Ventas efectivas**: Sales paid with cash or bank card (excludes client card payments -- fiscal revenue)
- **Ventas demanda**: All sales regardless of payment method (includes client card double-counting)
- **Product mission**: LAVAR (wash), SECAR (dry), RECARGAS (card reloads)
- **Product size**: S, M, L (machine capacity)
- **Price list**: Maps to company/pricing tier (edusanferric1, edusanferric2, speedqueencanillas, etc.)

## Deployment

```bash
# Deploy to Vercel
vercel --yes --scope eduardo-flores-projects-ea4ca166 --prod

# Update mcf_dailySales Lambda
cd lambda/mcf_dailySales
powershell -Command "Compress-Archive -Path index.js,package.json,node_modules -DestinationPath mcf_dailySales.zip -Force"
aws lambda update-function-code --profile eem-personal --region us-east-1 --function-name mcf_dailySales --zip-file fileb://mcf_dailySales.zip

# Trigger sales import manually
aws lambda invoke --profile eem-personal --region us-east-1 --function-name mcf_gmailReadtoS3 out.json
aws lambda invoke --profile eem-personal --region us-east-1 --function-name mcf_gmailReadtoS3_hortaleza out.json
```

## Migration History

This app was migrated from Jekyll (GitHub Pages) + AWS Lambda + Notion databases to Vercel + Turso in April 2026. Legacy Jekyll files and replaced Lambda directories were removed after the migration. The `lambda/` directory only contains the 5 functions still deployed on AWS. The `public/` directory is the active static site.
