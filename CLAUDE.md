# MCF Web - Project Reference

## What This App Does

MCF Soluciones operates self-service laundromats in Madrid (locations: **Usera** and **Hortaleza**). This web app is the operational platform used by staff to record daily activities: expenses, deposits, cash counts, incident reports, customer surveys, site visits with cleaning checklists, and inventory tracking. It also has a public-facing landing page at mcfsoluciones.com.

The app is a collection of mobile-first HTML forms that submit data to a Turso (libSQL) database via Vercel serverless functions. Owners sign in with a personal 6-digit PIN checked on the server (`api/auth/pin.js`, `api/_lib/web-auth.js`), the same PIN as on the kiosk. Hub and every route only `/reporte` uses ask for the PIN a second time. Joanna and Kenia pick their name, and their forms stay open and take `?user=` from the URL. The accountant signs in at `/cuentas` with her own password and gets read-only Gastos and P&L, always Spain only.

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

- **Frontend**: Plain HTML, jQuery 3.6.0. Every page except `/reporte` shares `public/css/mcf.css` and `public/js/mcf-shell.js` and has no `<style>` of its own; `/reporte` uses Tailwind and `css/reporte.css`
- **Backend**: Vercel serverless functions (Node.js, ESM compiled to CJS by Vercel)
- **Database**: Turso (libSQL / edge SQLite) via `@libsql/client`
- **External APIs**: Google Drive API, Google Sheets API via `googleapis`
- **AWS**: S3 (sales CSV intermediary), Lambda (3 functions), no API Gateway needed for new routes

## Directory Structure

```
mcf-web/
  public/                  # Static files served by Vercel
    index.html             # Landing page
    admin.html             # Sign-in (Admin with PIN, Joanna, Kenia) and Inicio
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
    ticket.html            # Ticket de compra / Factura PDF -> /api/tickets/generate, /api/facturas/generate
    survey.html            # Generic survey (API call commented out)
    calculador.html        # Redirect to /reporte#calculator
    session-reset.html     # Clears localStorage/sessionStorage
    cuentas.html           # The accountant's sign-in -> /api/auth/cuentas, then read-only /reporte
    movimientos.html       # Empty page (placeholder)
    css/                   # mcf.css (colours and components), reporte.css; Bootstrap, animate.css, main.css are unused leftovers
    js/                    # mcf-shell.js (sidebar, top bar, the navigation list); jQuery, Bootstrap, creative.js etc. are unused leftovers
    fonts/, font-awesome/, img/

  api/                     # Vercel serverless functions
    _lib/
      turso.js             # Shared Turso client (reads TURSO_DATABASE_URL, TURSO_AUTH_TOKEN)
      sucursales.js        # The Mexican stores, and sinMexico() which keeps them out of Spain's numbers
      google-auth.js       # Google Drive + Sheets auth (two separate service accounts)
      ticket-pdf.js        # 80mm ticket PDF builder (pdf-lib, no native deps)
      factura-pdf.js       # A4 factura PDF builder (cliente + N service lines)
    movimientos.js         # Central form router: gasto, deposito,
                           #   incidencia, encuesta, transito, fondo_caja
                           # Routes by body.type field
    visitas.js             # Visit handler: default (visit), inventario, insumos
                           # Routes by body.type field
    gastos.js              # Detailed expense: uploads receipt to Google Drive,
                           #   inserts into gastos table
    gastos-sheets.js       # Appends expense row to Google Sheets spreadsheet
    tickets/generate.js    # Ticket (simplified receipt) PDF -> application/pdf
    facturas/generate.js   # Factura (full invoice) PDF -> application/pdf

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

  docs/
    adding-a-sucursal.md   # Runbook: every surface a new store touches

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
| `tax_settlements` | Closed fiscal years (real IS paid, snapshot of profit base) | low | yyyy (PK), actual_is, year_profit_base, notes, filed_at |

**Join between sales_detail and products**: `sales_detail.product = products.product AND sales_detail.euro = products.precio AND sales_detail.price_list = products.price_list AND sales_detail.property = products.property`

This join enriches transactions with product metadata (mission, size, minutes, capacity) for the monthly business report. Special cases: RECARGA and TARJETA products don't join -- they're handled with hardcoded overrides in the report logic.

## Environment Variables

| Variable | Where Used | Purpose |
|----------|------------|---------|
| `TURSO_DATABASE_URL` | Vercel + AWS Lambda (mcf_dailySales) | libSQL connection URL |
| `TURSO_AUTH_TOKEN` | Vercel + AWS Lambda (mcf_dailySales) | Turso auth token |
| `MCF_SESSION_SECRET` | Optional, local only | Signs the sign-in cookies when there is no `TURSO_AUTH_TOKEN`, as on a file database |
| `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` | Vercel (`/api/gastos`) | Service account for receipt uploads (project: mcf-lambda-to-drive-gastos) |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` | Vercel (`/api/gastos-sheets`) | Service account for spreadsheet appends (project: western-evening-264012) |
| `KIOSK_WATCH_SECRET` | Vercel + AWS Lambda (mcf_kioskWatch) | Shared secret for `POST /api/kiosk/watch-tick`. Generated once and never stored elsewhere, so to change it, set a new value on both sides |
| `KIOSK_WATCH_URL` | AWS Lambda (mcf_kioskWatch) | The website's watch-tick address |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Vercel + AWS Lambda (mcf_kioskWatch) | The kiosk alerts group. **Not set yet**: until they are, alerts stay open and retry, and nobody is told |
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

### Tickets (simplified receipts)

- **`GET|POST /api/tickets/generate`** — renders an 80mm thermal-style "ticket de compra" PDF and returns it as `application/pdf` (inline by default, `download=1` for an attachment). Pure `pdf-lib`, no DB write — this only prints a receipt, it does not record a sale.
  - Only `total` is required (positive euros; accepts both `8.50` and the Spanish `8,50`). Everything else falls back to MCF defaults: `business`, `subtitle`, `nif`, `address`, `concepto`, `descripcion`, `cantidad`, `ivaRate` (default 21), `fecha` (today), `hora` (now), `pago` (Efectivo), `numero` (auto `YYYYMMDD-HHMM`), `footer`.
  - `total` is IVA-*inclusive*; the PDF back-computes base + IVA so the two always re-add to the total exactly.
  - Layout/format logic lives in `api/_lib/ticket-pdf.js` (WinAnsi encoding, so `€` and Spanish accents render; emoji/CJK are stripped).
  - Fiscal identity is hardcoded in `api/_lib/ticket-pdf.js` (`FISCAL`): NIF `B19971613`, dirección `San Julio 5, 1D Madrid 28002` — the same company and registered address for both sucursales. The header prints a single `NIF: X` line even when the caller passes its own `NIF`/`CIF` prefix.
  - UI at `/ticket` (`public/ticket.html`), linked from `/admin` → Otros → "Ticket de Compra". The fiscal fields come pre-filled from the same constants (mirrored in `DEFAULT_FISCAL`); an edit there is an override cached per propiedad in `localStorage` under `mcf_ticket_fiscal_v1`, never stored server-side. **Changing the real NIF/dirección means editing both places.**

### Facturas (full invoices)

- **`GET|POST /api/facturas/generate`** — renders an A4 factura PDF (`application/pdf`, `download=1` for an attachment). Also print-only, no DB write.
  - Body: `{ cliente: { nombre, nif, direccion }, lineas: [{ concepto, detalle?, cantidad?, precio }], ivaRate?, fecha?, numero?, pago?, footer?, business?, subtitle?, nif?, address? }`. All three `cliente` fields and ≥1 línea are required.
  - `precio` is the IVA-*inclusive* unit price (what the customer pays). Per line the PDF shows precio unitario + importe **sin IVA** (back-computed); invoice base = Σ line bases, IVA = total − base, so they re-add to the total exactly.
  - Emisor identity is the same `FISCAL` constant as the ticket (`api/_lib/factura-pdf.js` imports it from `ticket-pdf.js`).
  - `numero` defaults to `F-YYYYMMDD-HHMM` in the API, but the `/ticket` form requires it: staff type it by hand in the "Nº de factura" field. The form pre-fills a suggestion (last number used on this device + 1, stored in `localStorage` under `mcf_factura_ultimo_numero_v1`). There is no server-side correlative series.
  - The `/ticket` form submits a real HTML form (new tab, no popup blocker) with the JSON in a single `payload` field — the endpoint accepts that (urlencoded or raw body, or `?payload=`) as well as a plain JSON body.
  - UI: `/ticket` → "Factura" switch (deep link `/ticket?tipo=factura`). Customers are remembered per device in `localStorage` under `mcf_factura_clientes_v1` (keyed by NIF) and autofill from the name field.

### Deprecated (410 Gone)
- **`POST /api/gastos`** — split into `create` (new gasto + optional factura) and `factura` (attach to existing).
- **`POST /api/gastos-sheets`** — the Sheet is retired.
- **`POST /api/movimientos` `type=gasto`** — returns 410; use `create` which writes the `movements` row too. Other types (`deposito`, `incidencia`, `encuesta`, denomination movements) still work.

### Tax settlements (Cerrar año fiscal)

Spanish IS (Impuesto Sociedades) is paid as quarterly *pagos a cuenta* + an annual settlement, all under cuenta `N2`. Those payments are **passthrough** in the P&L (cash out, but they don't reduce net income — like `N4` IVA Neto and `N5` IRPF retención). The P&L instead carries IS as a synthetic monthly accrual:
- **`N8`** (default) — `20% × max(0, EBITDA − Depreciación)` per month. An estimate so the P&L isn't lumpy.
- **`N8a`** — when a fiscal year is closed via the endpoints below, `N8a` replaces `N8` for that year. The actual IS owed is allocated across months proportionally to each month's `(EBITDA − Depreciación)`. Year-total then matches reality.

Endpoints under `/api/tax-settlements/*`:
- **`GET /list`** — all closed years, newest first.
- **`POST /upsert`** — `{ yyyy, actual_is, notes? }`. Snapshots `year_profit_base = Σ max(0, ebitda[m] − dep[m])` for the year.
- **`POST /recalc`** — `{ yyyy }`. Re-snapshots `year_profit_base` for an existing closed year (use after editing prior-year gastos).
- **`DELETE /delete?yyyy=`** — reopens the year; P&L falls back to the `N8` estimate.

UI lives at `/reporte` → Configuración tab (admin-only). Schema in `scripts/schema-tax-settlements.sql`, applied by `node scripts/run-schema-tax-settlements.js`.

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
- Owner auth: signed HttpOnly cookies, `mcf_session` (12 h) and `mcf_reports` (second PIN, lapses after 30 min idle), signed with a key derived from `TURSO_AUTH_TOKEN`, so changing that token signs everyone out (`MCF_SESSION_SECRET` overrides it, for local work on a file database). sessionStorage key `mcf_admin_authenticated` only decides which menu shows. `public/js/mcf-gate.js` asks for the PIN on `/reporte` and the money forms. A new route must call `requireReports`, or be added on purpose to the open list in `tests/kiosk/web-auth.test.js`. The accountant has her own cookie, covered under Accountant Access below.

## Key Business Concepts

- **Propiedad**: Location (usera, hortaleza; monterrey and cdmx are planned, see Mexico Sucursales)
- **MCF User**: Staff member (lalo, oscar, adrian, kenia)
- **Ventas efectivas**: Sales paid with cash or bank card (excludes client card payments -- fiscal revenue)
- **Ventas demanda**: All sales regardless of payment method (includes client card double-counting)
- **Product mission**: LAVAR (wash), SECAR (dry), RECARGAS (card reloads)
- **Product size**: S, M, L (machine capacity)
- **Price list**: Maps to company/pricing tier (edusanferric1, edusanferric2, speedqueencanillas, etc.)

## Accountant Access

- **Login**: `/cuentas`, with a password hashed in `kiosk_users` under `role = 'accountant'`, which neither the owner PIN check nor the kiosks read. Set or replace it with `node scripts/set-accountant-password.mjs <nombre>`, run in your own terminal because it prints the password. Wrong tries have their own lockout scope, so they can't lock owners out. Sign-ins go to `kiosk_audit`.
- **Session**: a signed `mcf_accountant` cookie naming her, with the same limits as `mcf_reports`. A session already open survives a password change until it lapses (30 idle minutes, 12 hours at most).
- **What she reaches**: only the routes using `requireReader`, all GET: `reports/pnl`, `reports/gastos-detail`, `gastos/list`, `gastos/catalog`, `gastos/drive-folder`, `export/month`. Everything else keeps `requireReports` or `requireOwner` and refuses her. Adding a route to her list means switching it to `requireReader` and updating `ACCOUNTANT_ROUTES` in `tests/kiosk/web-auth.test.js`.
- **Client**: `mcf-gate.js` never shows her a PIN prompt and sends her to `/cuentas` when her session lapses. `/reporte` takes `accountantMode` from the server, so a new tab stays locked, and hides the write controls.
- **Outside the app**: what she can do in the Drive folder behind "Ir a Drive" is a Google permission.

## Mexico Sucursales (not live yet)

Monterrey (sucursal 3) and CDMX (sucursal 4), defined in `api/_lib/sucursales.js`. Amounts are entered in euros. Taxes are already paid in Mexico, so no IVA or Impuesto de Sociedades is ever computed on them.

- **Spain-only, always**: balance sheet, cash flow, Hub, the monthly ZIP, the Inversión baseline, N8, N8a and `year_profit_base`. The accountant never sees Mexico.
- **Sales** live only in `sales_detail` under `company = 'mcf_mx'`, never in `sales`. That alone keeps them out of everything filtering `company = 'mcf'` or reading `sales`.
- **Gastos** share the `gastos` table with `propiedad` set to the store's label. Every Spain read adds `sinMexico()`, and a test fails if a new `FROM gastos` forgets it or isn't listed as exempt. They write no `movements` row, so Hub balances and balance sheet cash stay Spain's.
- **Toggle** (partners, off on each page load): `mexico=1` on `reports/pnl` puts the stores in the same rows as any other, in Ingresos and each gasto split, gross, and the totals and cards include them. N8, N8a and IVA stay Spain's. On `gastos/list` it includes the rows, and on `reports/gastos-detail` it opens their Detalle. All ignore the flag for the accountant.
- **Resumen**: `reports/monthly` returns each Mexican row with `property` set to its Spanish sister (Usera + Monterrey, Hortaleza + CDMX) and `sucursal_real` keeping the original. The Quarto report, P&L store views, Pivot and Comparar don't merge.
- **Inversión**: Monterrey's cuentas were the Compra TBC placeholder, and saved scenarios point at them, so the calculator still models a store it might buy on those codes. `projections/baseline` labels them `Sucursal nueva`, and Monterrey's real gastos never reach it. If Spain buys another store, its real gastos need their own catalog rows.

**Adding a store, or taking these two live:** follow `docs/adding-a-sucursal.md`, which covers both foreign and Spanish stores and every place they touch. Cuenta codes come from `scripts/add-sucursal-catalog.mjs`, never by hand, because a code belongs to one store only (`E4` is Usera's Gas).

## Tests

```bash
node --test "tests/kiosk/*.test.js"
```

They run on temporary file databases and never reach production.

## Deployment

```bash
# Deploy to Vercel
vercel --yes --scope eduardo-flores-projects-ea4ca166 --prod

# Update mcf_dailySales Lambda
cd lambda/mcf_dailySales
powershell -Command "Compress-Archive -Path index.js,package.json,node_modules -DestinationPath mcf_dailySales.zip -Force"
aws lambda update-function-code --profile eem-personal --region us-east-1 --function-name mcf_dailySales --zip-file fileb://mcf_dailySales.zip

# Update mcf_kioskWatch Lambda (EventBridge rule mcf_kioskWatch-every-5-min, role mcf_kioskWatch-role, retries off)
cd lambda/mcf_kioskWatch
powershell -Command "Compress-Archive -Path index.js,package.json -DestinationPath mcf_kioskWatch.zip -Force"
aws lambda update-function-code --profile eem-personal --region us-east-1 --function-name mcf_kioskWatch --zip-file fileb://mcf_kioskWatch.zip

# Trigger sales import manually
aws lambda invoke --profile eem-personal --region us-east-1 --function-name mcf_gmailReadtoS3 out.json
aws lambda invoke --profile eem-personal --region us-east-1 --function-name mcf_gmailReadtoS3_hortaleza out.json
```

## Migration History

This app was migrated from Jekyll (GitHub Pages) + AWS Lambda + Notion databases to Vercel + Turso in April 2026. Legacy Jekyll files and replaced Lambda directories were removed after the migration. The `lambda/` directory only contains the 5 functions still deployed on AWS. The `public/` directory is the active static site.
