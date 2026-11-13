# Adding a sucursal

Everything that has to change when MCF adds a store, across this repo, the database, AWS, Google and the other MCF repos.

There are two kinds of store, and the work is very different:

| | Foreign store (Monterrey, CDMX) | Spanish store |
|---|---|---|
| In Spain's P&L, balance sheet, cash flow, Hub and taxes | No | Yes |
| The accountant sees it | Never | Yes |
| Sales live in | `sales_detail` only, under `company = 'mcf_mx'` | `sales` and `sales_detail`, under `company = 'mcf'` |
| IVA and Impuesto de Sociedades | None, taxes are paid abroad | Yes |
| Code to change | One list, the label normalizers and a few form options | Dozens of hardcoded places, because Spain's code assumes exactly two stores |

Start with [Names and codes](#names-and-codes), which applies to both. Then follow [Foreign store](#foreign-store) or [Spanish store](#spanish-store), and check [Outside this repo](#outside-this-repo).

---

## Names and codes

Pick these before touching anything.

| Name | Example | Where it is used | Rules |
|---|---|---|---|
| Key | `cdmx` | `sales_detail.property`, `products.property`, form values | Lowercase, no accents or spaces. It must not appear inside another store's name, because the code matches with `includes()` and `LIKE '%key%'` |
| Label | `(004) CDMX` | `gastos.propiedad`, `catalogo_cuentas.propiedad` | `(NNN) Name`, with the next free number. It must contain the key |
| Price list | `mx1` | `sales_detail.price_list`, `products.price_list` | The same value in both tables, because the products join uses it |
| Sales user | `local-getafe` | `sales.mcf_user` | Spanish stores only. Must be `local-<key>`, because the Hub and the fallbacks find stores by it |

### Cuenta codes

`catalogo_cuentas.cuenta_mcf` is the primary key, so a code belongs to one store only. **Codes do not follow a store number: `E4` is Usera's Gas, not store 4's.** To most of the code only the first letter matters: it picks the P&L section, and `Z` marks capex. The exception is `A1`, `A2`, `K1` and `K2`, which Spain's P&L names directly ([Step 3](#step-3-server-reports)).

Never pick codes by hand. This script takes the next free number of each letter, copies Hortaleza's names and categories, adds everything or nothing, and never changes an existing row:

```bash
node scripts/add-sucursal-catalog.mjs "(005) Nombre" --dry-run   # show the codes
node scripts/add-sucursal-catalog.mjs "(005) Nombre"             # foreign store: the 16 spending concepts
node scripts/add-sucursal-catalog.mjs "(005) Nombre" --full      # Spanish store: also A, B, K, L, M (sales, IVA, margin)
```

The names must match the other stores exactly, because a gasto finds its cuenta from (concepto × propiedad). The script takes care of that.

Current spending codes:

| Concept | Usera | Hortaleza | Monterrey | CDMX |
|---|---|---|---|---|
| Alquiler (C) | C1 | C2 | C3 | C4 |
| Financiamiento (D) | D1 | D2 | D3 | D4 |
| Agua, Luz (E) | E1 | E2 | E3 | E10 |
| Gas (E) | E4 | E5 | E6 | E11 |
| Detergentes (E) | E7 | E8 | E9 | E12 |
| Articulos para Vending o Auxiliares (F) | F1 | F2 | F3 | F7 |
| Comissiones Bancarias (F) | F4 | F5 | F6 | F8 |
| Internet (G) | G1 | G2 | G3 | G13 |
| Seguro (G) | G4 | G5 | G6 | G14 |
| Limpieza (G) | G7 | G8 | G9 | G15 |
| Alarma (G) | G10 | G11 | G12 | G16 |
| Adquisición y Marketing (H) | H1 | H2 | H3 | H7 |
| Atención y Retornos (H) | H4 | H5 | H6 | H8 |
| Mantenimiento de Maquinaria y Equipo (I) | I1 | I2 | I3 | I4 |
| Depreciacion | O1 | O2 | O3 | O4 |
| Adquisición o Inversiones | Z1 | Z2 | Z3 | Z5 |

`Z4` belongs to Corporate.

### Products

Reports join sales to `products` on product name, exact euro price, price list and property. For each store:

- One `products` row per machine and exact price. A price with no row loses its mission, size and minutes. If a price in euros moves around, as a converted price can, each value needs a row.
- Machine names unique across all stores. Capacity counts distinct names and assumes 840 minutes a day, so across a sister merge or the MCF total, a repeated name counts as one machine. Usera and Hortaleza already share `LAVADORA 4`.
  - Foreign store: use a prefix, like `MTY LAVADORA 1`.
  - Spanish store with a kiosk: continue the numbering instead (`LAVADORA 8`). `/kiosko` treats only names starting with `SECADORA` as dryers, so `GET SECADORA 1` would lose its multi-cycle prices.
- `product_price = 'publico'` on list prices. Anything else counts as fidelización in Comparar.
- `RECARGA` and `TARJETA` need no rows. `reports/monthly` handles them by name.

A store's first rows are written by hand. After that, `scripts/analyze-product-gaps.js` finds sales with no matching product, and `scripts/propose-product-fills.js` fills new prices for machines that already have a row. It marks them `descuento`, so correct that where it applies. Run it without `--apply` first, because `--apply` reuses `scripts/proposed-product-inserts.json` if the file is there.

---

## Foreign store

Everything is driven by `api/_lib/sucursales.js`. Do steps 7 to 9 in a single deploy: with the toggle hidden, a gasto saved to the store disappears from every list, so the form options must not appear first.

1. **Register it.** Add `{ key, label, hermana }` to `MEXICO` in `api/_lib/sucursales.js`. `hermana` is the Spanish store it is added to in the Resumen. A store in another country goes in this same list, and the screens would then need rewording, since they say "México". This one entry:
   - leaves its gastos out of every Spain read (`sinMexico()`), and a test fails if a new `FROM gastos` in `api/` forgets
   - hides it from the accountant, even if she asks with `mexico=1`
   - adds its sales minus gastos to the P&L's México block, with no IVA or Impuesto de Sociedades
   - merges it into its sister store in the Resumen
   - stops its new gastos writing a `movements` row, so Hub balances and balance sheet cash stay Spain's
2. **Teach the label normalizers.** Add the key and number to `canonicalizePropiedad` in `api/_lib/propiedad.js`, its copy in `api/gastos/resolve-cuenta.js`, and `canonicalizePropiedadClient` and `conceptosForPropiedad` in `public/reporte.html`. Skipped, short spellings are stored as typed, and the gasto modal offers no concepts, so it can't save.
3. **Add its catalog rows** with the script above, without `--full`.
4. **Add its products**, as described above.
5. **Fix `reconcile.py` first.** In `mcf-business/pdf-to-turso/reconcile.py`, add `company = 'mcf'` to the query in `detail_by_day_property`. It reads stores from `sales_detail` and stops mapping unless it finds exactly two, so the first foreign sale breaks it.
6. **Load its sales** directly into `sales_detail`. `pdf_to_turso.py` can't do it: `COMPANY` is fixed to `mcf` and `-p` only accepts Usera and Hortaleza.
   - `company = 'mcf_mx'`, `property` = the key, `price_list` matching its products
   - `movid` not starting with `K`, a prefix with a unique index reserved for kiosks
   - `payment` one of `EFECTIVO`, `TARJETA BANCO`, `TARJETA CLIENTE`, and amounts in euros
   - `date`, `yyyy`, `mm` and `dd` all filled in, because the reports filter on them, and `dayweek` as the full English name (`Saturday`), because Pivot uses it
   - **Check before inserting.** Nothing stops a repeated load, which silently doubles the store's sales
   - **Nothing in `sales`.** Everything reading that table counts as Spain's cash
7. **Add the form options.** `public/gastos.html` (`#location-select`), and in `public/reporte.html` the gastos inline edit select, the new and edit gasto modal select, and Comparar's Propiedad select. In the modal, use the full label as the option's value, because `openGastosModalForEdit` passes it through as it is. A short value leaves the select blank when editing.
8. **Create its Drive folder.** Outside the Spain folder, shared with the `client_email` in `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`, and not shared with the accountant. Set `MEXICO_DRIVE_FOLDER_ID` in `api/_lib/sucursales.js`; foreign stores share it. Until it's set, their facturas are refused rather than filed with Spain's.
9. **Turn on the toggle.** Set `MEXICO_VISIBLE = true`. This shows it for all foreign stores.
10. **Run the tests and deploy**, then check:
    - With the toggle off, every P&L line matches what it showed before
    - With it on, the store appears below the others in Ingresos and each gasto split, its Detalle opens, and the totals and cards include it, with N8 and IVA unchanged
    - A test gasto gets a cuenta, writes no `movements` row, and its factura lands in the new folder
    - The Resumen shows the banner and the sister store's combined numbers
    - Signed in at `/cuentas`, nothing about the store appears anywhere, including the ZIP

### Where Monterrey and CDMX stand

| Step | Monterrey | CDMX |
|---|---|---|
| 1, 2. Registered, normalizers | Done | Done |
| 3. Catalog rows | Its 21 old Compra TBC rows, relabelled by `scripts/rename-compra-tbc.mjs` | Done, 16 rows |
| 4. Products | To do | To do |
| 5. `reconcile.py` | To do, once for both | |
| 6. Sales | To do | To do |
| 7. Form options | To do | To do |
| 8. Drive folder | To do, once for both | |
| 9. Toggle | On since 2026-11-06, ahead of steps 6 to 8, for testing | |

Monterrey's codes have a second job. The Inversión calculator models a store it might buy on them, because they were the Compra TBC placeholder and saved scenarios point at them. `projections/baseline` shows them to it as `Sucursal nueva`, and Monterrey's real gastos never reach it.

### Left off for foreign stores, on purpose

| Area | Why | What enabling it would take |
|---|---|---|
| Retiro, fondo de caja, depósito | Euro denominations, and they write `movements` | A decision on how foreign cash is tracked |
| Tickets | Spanish NIF and 21% IVA in `api/_lib/ticket-pdf.js` | Another fiscal identity |
| Bank import | BBVA Spain's format. `api/gastos/bank-import.js` is right to refuse other stores | A parser for the foreign bank |
| Loans | They feed Spain's balance sheet | A decision on how they are reported |
| Visits, incidents, inventory, surveys | Forms are per store, and visits save an unknown store as `otra` | See the [forms table](#step-5-forms) |
| Staff sign-in | `public/admin.html` lists names by hand | Add the names |
| Kiosk | Redsys and euro cash hardware, and it writes to `sales`, which breaks the rule above | Hardware work, and a change to `api/_lib/kiosk-ingest.js` |
| Map | Census and competitor data are for Madrid | New geo data |

### Known limits

- **Moving a gasto between Spain and a foreign store changes only the `gastos` row.** `gastos/update` and `gastos/bulk` leave its `movements` row in Hub balances, and its factura in the folder the accountant can open. Fix both by hand.
- Dates default to UTC, so an entry after about 18:00 in Mexico gets the next day's date, and on the last day of a month it lands in the next month's P&L.
- Money sent from a foreign store to the Spanish bank has no line, so the balance sheet can't explain it. Decide how to book it the first time it happens.
- Comparar's "Todas" and Pivot include foreign stores. P&L store views don't merge them, and the Quarto report never sees them.

---

## Spanish store

**Spain's code is not driven by a list.** Usera and Hortaleza are written out in dozens of places, and most of them fail silently: the store's money doesn't error, it goes missing or lands on the wrong store. The worst three:

- **`lambda/mcf_dailySales/index.js` books any file that isn't Usera's as Hortaleza.** The new store's daily sales would inflate Hortaleza with no warning.
- **`ingresosByProp` in `api/reports/pnl.js` skips any store not in it.** The P&L loses the revenue, and with it EBITDA, NETO and the tax estimate, while the balance sheet counts it, so the two reports disagree.
- **A kiosk's `ReceiptPrefix` ships as `K1`.** A repeated prefix drops the new store's sales from `sales_detail` while `sales` still counts them.

Do all of this in one go, and before the first sale is loaded. Moving the store list into `api/_lib/sucursales.js` first, as Mexico's is, would make this and the next store much cheaper.

### Step 1: Data

| What | Where | Skipped |
|---|---|---|
| Activation date, the first day MCF owns it | Add to `ACTIVATIONS` in `scripts/seed-property-activation.js` and run it. The upsert also rewrites the other stores' rows from that file | Prior-owner rows mistagged under the store count as MCF's |
| Catalog rows | `node scripts/add-sucursal-catalog.mjs "(005) Nombre" --full` | Gastos save with `cuenta = NULL` and leave the P&L |
| Products | As described in [Products](#products) | Sales lose their mission, size and minutes |
| Sales history from a prior owner | Load it with `company` = the owner's name, as with `cesar` and `edusanferric` | Under `mcf`, it counts as MCF's revenue and inflates retained earnings |
| Map pin | Tick "Es MCF" on its pin in the Mapa tab, or add to `scripts/seed-laundries.js`. Outside Madrid, the competitor search has no coverage (`api/_lib/discover-config.js`) | It shows as a competitor |
| Bank rules | `bank_import_rules`, seeded by `scripts/seed-bank-import-rules.js`, for any rule tied to the store's address | Those lines import unclassified, with `cuenta = NULL` |

### Step 2: Sales pipeline

**Daily totals, from a store on the old POS:**

1. Its POS must email `Fichero de ventas del ...` from its own Gmail account to the mailbox the Lambdas read, `eduardo@enelmargen.org`.
2. Copy `lambda/mcf_gmailReadtoS3_hortaleza` to a new Lambda, change the `from:` in its search, and give it a delay so it doesn't race the others. It uses the `GmailServiceAccount` secret.
3. Add the Lambda as a target of the EventBridge rule `gmailReadSchedule-toRead` (21:45 UTC daily).
4. **Change `mcf_dailySales`.** It has `objectKey.includes('_2215') ? 'local-usera' : 'local-hortaleza'`, where `_2215` is the closing time in Usera's file name (`VentasDia061126_2215...`). Give the store a distinct closing time, map it explicitly, and deploy the Lambda. The `mcf-sales` bucket's trigger has no filter, so every object in it reaches this function.
5. Optional: `lambda/mcf_survivor` emails a "[Usera] Compu Prendida" check, for Usera only.

**Daily totals and detail, from a store with the new kiosk:**

1. Add an entry to `KNOWN` in `scripts/kiosk-create.js`: `company`, `price_list`, `property`, `propiedad_label`, `sales_user` and a distinct `sales_suffix`. Run it, and paste the key it prints once into `set-cloud-key.cmd` on the kiosk.
2. **In the kiosk's `appsettings.json`, set `Site.ReceiptPrefix` to a new value starting with `K`** (`K2`). The package ships `K1`, and receipt numbers restart each day, so a repeat collides with Hortaleza's and the sale is dropped from `sales_detail` while `sales` still counts it. The only signal is the night check's alert. A prefix not starting with `K` also fails: it escapes the unique index, the night check counts no sales, and `pdf_to_turso.py --replace` can delete the rows.
3. Also in `Site`: `TradeName`, `Address`, `Town` and `Phone`, which ship as Hortaleza's. Then `Machines` and the device ports. See `laundry-replacement/kiosk-app/README.md`, including the machine wiring check.
4. Before installing, check whether the bank terminal's merchant setup and `Cards.KeyA` are per store. Neither has been verified.
5. **`/kiosko` can only edit K1.** `settingsRequest` in `api/_lib/kiosk-settings.js` falls back to `body.kiosk_id || 'K1'`, and the page sends no id. It needs a kiosk picker.
6. `scripts/kiosk-seed-discounts.js` and `scripts/kiosk-seed-products.js` are written for K1, so adapt them if you need them.
7. Update the `retiro.html` and `fondo-caja.html` notices, which name Hortaleza as the store whose kiosk records its own cash.

`/estado`, the alerts and owner PINs need nothing: they cover every kiosk.

**Monthly detail, from a store on the old POS:**

1. In `mcf-business/pdf-to-turso/pdf_to_turso.py`, add the key to `PROPERTIES`, and pass `--price-list`, since the default is `mcf1`.
2. In `reconcile.py`, `map_suffix_to_property` gives up unless there are exactly two stores, so it needs generalizing.

### Step 3: Server reports

| File | Change | Skipped |
|---|---|---|
| `api/_lib/propiedad.js`, `api/gastos/resolve-cuenta.js` | Add the store to the normalizers | Non-canonical labels, no concepts in the gasto modal, and bank imports with no cuenta |
| `api/reports/pnl.js` | `normalizeScope` | No store view |
| | `ingresosByProp`, and the total next to it (`ing`) | **Revenue, EBITDA, NETO, N8 and N8a silently understated** |
| | `propertyLabel`, and the `CASE` in `salesAggSql` | Fallback sales land under `unknown` and are lost |
| | `ivaProps`, `ingresosProps` | No IVA or revenue lines, and `year_profit_base` understated |
| | `prop === 'usera' ? 'K1' : 'K2'` and the same for `A1`, `A2`. Use the `K` and `A` codes the script printed | **The store's lines carry Hortaleza's codes** |
| `api/_lib/sales-fallback.js` | `STORES` | A month with no detail yet shows the store at 0 |
| `api/reports/monthly.js` | `CASE` in `fetchSalesFallback` | The store is `unknown` in preliminary months |
| `api/reports/cashflow.js` | `propertyLabel`, the `CASE`, and the `property_activation` join | Cash shows under `unknown`, with no date guard |
| `api/export/month.js` | The `CASE` and `props` | **The accountant's Ventas sheet has no row for it, and no longer adds up to its total** |
| `api/hub.js` | Daily `SUM`s, `emptyStoreBreakdown`, the `IN (...)` list, the store key mapping, the store loop, and `current`, `lastYear`, `byStore` | Missing from the Hub's daily and month-to-date numbers, though its 12-month chart counts it |
| `api/projections/baseline.js`, `api/_lib/projections.js` | `canonProp`; the label lookup and `propLabelMap` | In Inversión, one store becomes two templates: one with sales and no costs, one with costs and no sales |
| `api/gastos/bank-import.js` | The `sucursal` check | Its bank file gets a 400 |
| `api/visitas.js` | The `propiedad` switch, the task map, and the `mcfUser` switch for new staff | Its visits save as `otra`, and its staff as `otro` |
| `api/reports/pnl.js`, `api/_lib/balance-sheet.js` | `O2_MONTHLY`, `O2_RANGE` are Hortaleza's equipment. Add a schedule in both if the new purchase depreciates the same way | No synthetic depreciation |

Nothing to change: balance sheet revenue and cash, `gastos/list`, `gastos/catalog`, `reports/gastos-detail`, `reports/pivot`, `reports/timeseries`, and the accountant's access. The balance sheet reads every `company = 'mcf'` row, and the others don't list stores.

N8, N8a and `year_profit_base` come out right once the `ingresosByProp`, `ing` and `ingresosProps` rows above are done. If a year was closed while the store was missing, its snapshot is wrong, so run `/api/tax-settlements/recalc` for it.

### Step 4: `public/reporte.html`

| Tab | Change |
|---|---|
| Hub | The month-to-date `byStore` template, `hubStat` and `hubTodayVsYesterday` totals, `brandColors` and the daily chart's series, the inventory list, `insumoTotal` |
| Resumen | The preliminary cards' store list, the `porProductoScope` options |
| Comparar | The Propiedad select |
| P&L | The MCF/Usera/Hortaleza toggle, `scopeLabel` in the Excel export, and `ivaInfoSet`, `EXCLUDED_CODES`, `ivaByCodeSrc`, which list `K1`, `K2`, `A1`, `A2` |
| Gastos | The inline edit select, the modal select, `canonicalizePropiedadClient`, `conceptosForPropiedad`, `openGastosModalForEdit` |
| Gastos, bank import | The sucursal buttons |
| Financiamiento | The loan modal's select |
| Inversión | `tplPropMatch` in `applyProjTemplate`, the `existing_adjustments` select. Optional: the `calcScenarios` presets |

Pivot needs nothing, because it reads stores from the data.

### Step 5: Forms

| Page | Change | Skipped |
|---|---|---|
| `gastos.html` | `#location-select` | Can't record its gastos |
| `deposito.html`, `retiro.html` | The store select. `fondo-caja.html` has none | Can't record its cash |
| `incidencias.html` | The select and `machinesByPropiedad` | No machines to choose |
| `inventario.html` | The select. It assumes one bodega and two pumps, as do `locations` in `api/visitas.js` and the summary in `api/hub.js` | Missing from the Hub's supplies |
| `final-visit.html` | The select, the store in the `locations` of every shared `L99...` task, and its own `L0N...` tasks, matched in `api/visitas.js` | **An empty checklist** |
| `encuesta-<key>.html` | Copy a survey page, and change its title, subheader, footer and `location`. Print its QR code, since no menu links to these pages | No customer feedback |
| `ticket.html` | The select and `DEFAULT_SUBTITLE`. For another legal entity, also `FISCAL` in `api/_lib/ticket-pdf.js` and `DEFAULT_FISCAL` here | Can't print its tickets |
| `survey.html` | The select. Its API call is commented out, so this can wait | Nothing |
| `admin.html` | A button for new staff, if any | They can't sign in |

### Step 6: Tests and checks

1. **The tests pass whether or not Steps 3 to 5 are done.** None of them run a third Spanish store through the P&L, Hub, ZIP or cash flow, so add one to the fixtures first. Then run `node --test "tests/kiosk/*.test.js"`.
2. **Search for what this doc missed**, and explain every hit. Run it from this repo, then in `mcf-business` and `laundry-replacement/kiosk-app`. About 60 files here have one:
   ```bash
   grep -rnIiE "usera|hortaleza|canillas|local-|cesar1|\b[KA][12]\b" api public lambda scripts
   ```
3. Run `node scripts/verify-balance-sheet.mjs` before you start and again after. Compare the drift it prints, because it exits 0 even when the sheet doesn't balance.
4. After deploying and loading test data:
   - MCF's Ingresos equal the sum of the store views' Ingresos. Don't compare EBITDA or NETO: J, O and N8 exist only at MCF level, and N1 and N3 come off each store view
   - Cash flow shows the store by name, not `unknown`
   - The ZIP's Ventas rows add up to its total
   - The Hub's cards and daily chart show it
   - Hortaleza's daily sales didn't move

---

## Outside this repo

| Where | What it does | Change |
|---|---|---|
| `mcf-business/mbr/mbr-v9-quarto.qmd` | The Quarto report. It reads Google Sheets (`bd-detalle`, `gastos`), not Turso, so nothing loaded in Turso reaches it | For a Spanish store: its sections, the `%in% c('usera', 'hortaleza')` summary, and the best and worst performer, which assume two stores |
| `mcf-business/create-details-excel-output.R`, `upload-python-generated-excels-to-databases.R`, `create-gastos-summary.R` | The scripts that feed those Sheets. `switch(property, "usera"="A1", "hortaleza"="A2")` returns NULL for a new store, and the upload has only two store slots | A Spanish store only reaches the report once these write it |
| `mcftools/R/propertyList.R`, `mcf-business/functions.R`, `mcftools/R/awsObjectList.R` | Old R tooling. Unknown stores stop with "property does not exist" | Add the store if you still use them |
| `mcf-pos/Backup` | An optional S3 backup from the store's PC, set by `backup-config.json`. Nothing loads it into Turso, and its `company`, `payment` and `dayweek` values differ from `sales_detail`'s | Install it if you want the backup |
| `mcf-go-big`, `mcf-expansion-central` | Old Shiny calculators with templates named Usera and Hortaleza. `/calculador` now redirects to the Inversión tab | Nothing |
| Google Drive | Spanish stores share one facturas folder, which the accountant uses. Her access there is a Google permission | Nothing for a Spanish store |

Nothing to change: `vercel.json`, environment variables (none are per store), the sidebar in `public/js/mcf-shell.js`, the landing page, balance sheet lines, the Telegram alerts, and `mcf_daily_plan-v2`, whose weather is fixed to Madrid and isn't used by the app.
