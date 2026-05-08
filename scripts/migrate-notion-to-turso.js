/**
 * One-time migration script: Notion databases -> Turso
 *
 * Usage:
 *   NOTION_API_KEY=secret_xxx \
 *   TURSO_DATABASE_URL=libsql://... \
 *   TURSO_AUTH_TOKEN=... \
 *   node scripts/migrate-notion-to-turso.js
 */

require('dotenv').config();
const { Client } = require('@notionhq/client');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('fs');
const { join } = require('path');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Notion Database IDs
const DB = {
  movements: '18413ec8894180bca990fccf2854f9d6',
  incidents: '19613ec8894180198e6ef1529ccf057d',
  surveys: '2b413ec8894180e0ae5ee8c3699fa99a',
  visits: '26c13ec8894180eb9802d73158977768',
  inventory: '2c713ec8894180a4a88bc041d92df303',
  insumos: '26113ec8894180b5b140f0d727754f8c',
  sales: '1cf13ec88941807bb208f8f2f5eaf405',
  gastos: '1c313ec8894180ad8ea4c8de4b58aef2',
};

// Helper: get text from Notion rich_text property
function getRichText(prop) {
  if (!prop || !prop.rich_text || prop.rich_text.length === 0) return '';
  return prop.rich_text.map(t => t.plain_text).join('');
}

// Helper: get title text
function getTitle(prop) {
  if (!prop || !prop.title || prop.title.length === 0) return '';
  return prop.title.map(t => t.plain_text).join('');
}

// Helper: get select value
function getSelect(prop) {
  return prop?.select?.name || null;
}

// Helper: get number
function getNumber(prop) {
  return prop?.number ?? 0;
}

// Helper: get date
function getDate(prop) {
  return prop?.date?.start || null;
}

// Helper: get checkbox
function getCheckbox(prop) {
  return prop?.checkbox ? 1 : 0;
}

// Helper: get URL
function getUrl(prop) {
  return prop?.url || null;
}

// Paginate through all pages in a Notion database using REST API directly
async function getAllPages(databaseId) {
  const pages = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Notion query failed for ${databaseId}: ${err}`);
    }

    const data = await response.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function createSchema() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    await turso.execute(stmt);
  }
  console.log('Schema created successfully');
}

async function migrateMovements() {
  console.log('Migrating movements...');
  const pages = await getAllPages(DB.movements);
  console.log(`  Found ${pages.length} movement records`);

  for (const page of pages) {
    const p = page.properties;
    await turso.execute({
      sql: `INSERT INTO movements (movement, type, account, euros, propiedad, mcf_user, date_real, description, icon, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        getTitle(p.movement),
        getSelect(p.type) || 'unknown',
        getSelect(p.account) || 'cash',
        getNumber(p.euros),
        getSelect(p.propiedad),
        getSelect(p.mcf_user),
        getDate(p.date_real) || page.created_time.slice(0, 10),
        null, // description from child blocks not migrated (not critical)
        page.icon?.emoji || '🟡',
        page.created_time,
      ],
    });
  }
  console.log(`  Migrated ${pages.length} movements`);
}

async function migrateIncidents() {
  console.log('Migrating incidents...');
  const pages = await getAllPages(DB.incidents);
  console.log(`  Found ${pages.length} incident records`);

  for (const page of pages) {
    const p = page.properties;
    await turso.execute({
      sql: `INSERT INTO incidents (summary, severity, propiedad, cost, resolution, found, machine, incident_date, icon, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        getTitle(p.summary),
        getSelect(p.severity) || 'media',
        getSelect(p.propiedad),
        getNumber(p.cost),
        getSelect(p.resolution) || 'pendiente',
        getSelect(p.found) || 'otro',
        getSelect(p.machine),
        getDate(p.incident_date) || page.created_time.slice(0, 10),
        page.icon?.emoji || '⚠️',
        page.created_time,
      ],
    });
  }
  console.log(`  Migrated ${pages.length} incidents`);
}

async function migrateSurveys() {
  console.log('Migrating surveys...');
  const pages = await getAllPages(DB.surveys);
  console.log(`  Found ${pages.length} survey records`);

  for (const page of pages) {
    const p = page.properties;
    await turso.execute({
      sql: `INSERT INTO surveys (name, survey_id, propiedad, experience, cleanliness, availability, recommend, comments, survey_date, icon, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        getTitle(p.Name),
        getRichText(p.survey_id),
        getSelect(p.propiedad),
        getSelect(p.experience),
        getSelect(p.cleanliness),
        getSelect(p.availability),
        getSelect(p.recommend),
        null, // comments were stored as child blocks
        getDate(p.survey_date) || page.created_time,
        page.icon?.emoji || '📋',
        page.created_time,
      ],
    });
  }
  console.log(`  Migrated ${pages.length} surveys`);
}

async function migrateVisits() {
  console.log('Migrating visits...');
  const pages = await getAllPages(DB.visits);
  console.log(`  Found ${pages.length} visit records`);

  for (const page of pages) {
    const p = page.properties;

    const result = await turso.execute({
      sql: `INSERT INTO visits (
        visita, visit_id, propiedad, mcf_user, fecha, time_clean,
        superficies_secadoras, superficies_secadoras_atras,
        superficies_lavadoras, superficies_lavadoras_atras,
        tirar_botes, barrer, trapear,
        descarga_billetes, carga_monedas, carga_papel,
        carga_tarjetas_cliente, superficie_billetes, superficie_tarjetas,
        jabon_bodega, suavizante_bodega, oxigeno_bodega,
        jabon_bombas, suavizante_bombas, oxigeno_bombas,
        limpieza_general, limpieza_maquinas, limpieza_basura,
        icon, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        getTitle(p.visita),
        getRichText(p.visit_id),
        getSelect(p.propiedad),
        getSelect(p.mcf_user),
        getDate(p.fecha) || page.created_time.slice(0, 10),
        getNumber(p.time_clean),
        getCheckbox(p.superficies_secadoras),
        getCheckbox(p.superficies_secadoras_atras),
        getCheckbox(p.superficies_lavadoras),
        getCheckbox(p.superficies_lavadoras_atras),
        getCheckbox(p.tirar_botes),
        getCheckbox(p.barrer),
        getCheckbox(p.trapear),
        getCheckbox(p.descarga_billetes),
        getCheckbox(p.carga_monedas),
        getCheckbox(p.carga_papel),
        getCheckbox(p.carga_tarjetas_cliente),
        getCheckbox(p.superficie_billetes),
        getCheckbox(p.superficie_tarjetas),
        getNumber(p.jabon_bodega),
        getNumber(p.suavizante_bodega),
        getNumber(p.oxigeno_bodega),
        getNumber(p.jabon_bombas),
        getNumber(p.suavizante_bombas),
        getNumber(p.oxigeno_bombas),
        getNumber(p.limpieza_general),
        getNumber(p.limpieza_maquinas),
        getNumber(p.limpieza_basura),
        page.icon?.emoji || '🔨',
        page.created_time,
      ],
    });

    // Migrate child database (visit tasks) if present
    const visitDbId = Number(result.lastInsertRowid);
    try {
      const childrenRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
        headers: {
          'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
        },
      });
      const children = await childrenRes.json();
      for (const block of children.results) {
        if (block.type === 'child_database') {
          const taskPages = await getAllPages(block.id);
          for (const taskPage of taskPages) {
            const tp = taskPage.properties;
            await turso.execute({
              sql: `INSERT INTO visit_tasks (visit_id, task_name, status, comments, created_at)
                    VALUES (?, ?, ?, ?, ?)`,
              args: [
                visitDbId,
                getTitle(tp.Task || tp['Task name']),
                getSelect(tp.Status) || 'Complete',
                getRichText(tp.Comments),
                taskPage.created_time,
              ],
            });
          }
        }
      }
    } catch (err) {
      console.warn(`  Warning: could not migrate tasks for visit ${page.id}: ${err.message}`);
    }
  }
  console.log(`  Migrated ${pages.length} visits`);
}

async function migrateInventory() {
  console.log('Migrating inventory...');
  const pages = await getAllPages(DB.inventory);
  console.log(`  Found ${pages.length} inventory records`);

  for (const page of pages) {
    const p = page.properties;
    await turso.execute({
      sql: `INSERT INTO inventory (name, date, propiedad, location, jabon, suavizante, oxigeno, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        getTitle(p.name),
        getDate(p.date) || page.created_time.slice(0, 10),
        getSelect(p.propiedad),
        getSelect(p.location) || 'Bodega',
        getNumber(p.jabon),
        getNumber(p.suavizante),
        getNumber(p.oxigeno),
        page.created_time,
      ],
    });
  }
  console.log(`  Migrated ${pages.length} inventory records`);
}

async function migrateInsumos() {
  console.log('Migrating insumos...');
  const pages = await getAllPages(DB.insumos);
  console.log(`  Found ${pages.length} insumos records`);

  for (const page of pages) {
    const p = page.properties;
    await turso.execute({
      sql: `INSERT INTO insumos (task_name, created_at) VALUES (?, ?)`,
      args: [
        getTitle(p['Task name']),
        page.created_time,
      ],
    });
  }
  console.log(`  Migrated ${pages.length} insumos`);
}

async function migrateSales() {
  console.log('Migrating sales...');
  const pages = await getAllPages(DB.sales);
  console.log(`  Found ${pages.length} sales records`);

  for (const page of pages) {
    const p = page.properties;
    await turso.execute({
      sql: `INSERT INTO sales (movement, type, account, euros, mcf_user, date_real, icon, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        getTitle(p.movement),
        getSelect(p.type) || 'venta',
        getSelect(p.account),
        getNumber(p.euros),
        getSelect(p.mcf_user),
        getDate(p.date_real) || page.created_time.slice(0, 10),
        page.icon?.emoji || '🟢',
        page.created_time,
      ],
    });
  }
  console.log(`  Migrated ${pages.length} sales`);
}

async function migrateGastos() {
  console.log('Migrating gastos...');
  const pages = await getAllPages(DB.gastos);
  console.log(`  Found ${pages.length} gastos records`);

  for (const page of pages) {
    const p = page.properties;
    await turso.execute({
      sql: `INSERT INTO gastos (
        concepto_text, user_name, concepto_mcf, currency, cuenta,
        concepto_proveedor, num_factura, nif_proveedor, razon_social,
        concepto_banco, gasto, importe_iva, importe_irpf, importe_otro,
        recibo_url, is_fiscal, icon, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        getTitle(p.concepto_text),
        getSelect(p.user),
        getSelect(p.concepto_mcf),
        getSelect(p.currency) || 'EUR',
        getSelect(p.cuenta),
        getRichText(p.concepto_proveedor),
        getRichText(p.num_factura),
        getRichText(p.nif_proveedor),
        getRichText(p.razon_social),
        getRichText(p.concepto_banco),
        getNumber(p.gasto),
        getNumber(p.importe_iva),
        getNumber(p.importe_irpf),
        getNumber(p.importe_otro),
        getUrl(p.recibo),
        getCheckbox(p.is_fiscal),
        page.icon?.emoji || '🔴',
        page.created_time,
      ],
    });
  }
  console.log(`  Migrated ${pages.length} gastos`);
}

async function main() {
  console.log('=== MCF Notion -> Turso Migration ===\n');

  // Step 1: Create schema
  console.log('Step 1: Creating schema...');
  await createSchema();

  // Step 2: Migrate each table
  console.log('\nStep 2: Migrating data...\n');
  await migrateMovements();
  await migrateIncidents();
  await migrateSurveys();
  await migrateSales();
  await migrateGastos();
  await migrateInsumos();
  await migrateInventory();
  await migrateVisits(); // Last because it queries child databases

  // Step 3: Validate counts
  console.log('\nStep 3: Validating counts...\n');
  const tables = ['movements', 'incidents', 'surveys', 'visits', 'visit_tasks', 'inventory', 'insumos', 'sales', 'gastos'];
  for (const table of tables) {
    const result = await turso.execute(`SELECT COUNT(*) as count FROM ${table}`);
    console.log(`  ${table}: ${result.rows[0].count} rows`);
  }

  console.log('\n=== Migration complete! ===');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
