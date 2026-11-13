import { SALES_ACCOUNT, bizDate, denominationDescription, detailRow, saleProblem, saleProduct, salesMovement } from './kiosk-mapping.js';

/**
 * Stores what a kiosk uploads. A repeated upload must change nothing, because the
 * kiosk resends whenever it did not see the answer, including after a commit whose
 * response was lost. A libSQL batch cannot branch on a previous statement's result,
 * so every guard lives in the SQL itself and each step reads the row the previous
 * step left: once a sale is posted, later sends of it are no-ops.
 */

const POSTABLE = `s.status = 'completed' AND s.post_state = 'pending' AND k.post_enabled = 1`;

function upsertSale(kiosk, sale, appVersion) {
  return {
    sql: `INSERT INTO kiosk_sales (sale_id, kiosk_id, receipt_no, kind, machine, description, cycles, price_cents, method, status,
            inserted_cents, change_cents, shortfall_cents, bank_auth, bank_operation, bank_pan, card_uid, card_balance_after, note,
            created_at_local, updated_at_local, biz_date, app_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(sale_id) DO UPDATE SET
            receipt_no = excluded.receipt_no, description = excluded.description, cycles = excluded.cycles,
            price_cents = excluded.price_cents, method = excluded.method, status = excluded.status,
            inserted_cents = excluded.inserted_cents, change_cents = excluded.change_cents, shortfall_cents = excluded.shortfall_cents,
            bank_auth = excluded.bank_auth, bank_operation = excluded.bank_operation, bank_pan = excluded.bank_pan,
            card_uid = excluded.card_uid, card_balance_after = excluded.card_balance_after, note = excluded.note,
            updated_at_local = excluded.updated_at_local, app_version = excluded.app_version
          WHERE kiosk_sales.post_state = 'pending' AND excluded.updated_at_local >= kiosk_sales.updated_at_local`,
    args: [
      sale.id, kiosk.kiosk_id, sale.receipt_no || null, sale.kind, sale.machine || null, sale.description || null,
      sale.cycles ?? null, sale.price_cents, sale.method, sale.status,
      sale.inserted_cents ?? null, sale.change_cents ?? null, sale.shortfall_cents ?? null,
      sale.bank_auth || null, sale.bank_operation || null, sale.bank_pan || null,
      sale.card_uid || null, sale.card_balance_after ?? null, sale.note || null,
      sale.created_at, sale.updated_at, bizDate(sale), appVersion || null,
    ],
  };
}

function insertDetail(sale) {
  const r = detailRow(sale);
  return {
    // OR IGNORE: the partial unique index on movid refuses a second copy without failing the whole batch.
    sql: `INSERT OR IGNORE INTO sales_detail (movid, date, yyyy, mm, dd, time, hr, min, payment, product, euro, company, dayweek, price_list, property)
          SELECT s.receipt_no, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, k.company, ?, k.price_list, k.property
          FROM kiosk_sales s JOIN kiosks k ON k.kiosk_id = s.kiosk_id
          WHERE s.sale_id = ? AND ${POSTABLE}`,
    args: [r.date, r.yyyy, r.mm, r.dd, r.time, r.hr, r.min, r.payment, r.product, r.euro, r.dayweek, sale.id],
  };
}

function markPosted(sale) {
  const r = detailRow(sale);
  return {
    sql: `UPDATE kiosk_sales SET post_state = 'posted', movid = receipt_no, posted_at = datetime('now'),
            product_ok = CASE WHEN kind <> 'machine' THEN 1 ELSE EXISTS (
              SELECT 1 FROM products p JOIN kiosks k ON k.kiosk_id = kiosk_sales.kiosk_id
              WHERE p.product = ? AND p.precio = ? AND p.price_list = k.price_list AND p.property = k.property) END
          WHERE sale_id = ? AND EXISTS (
            SELECT 1 FROM kiosk_sales s JOIN kiosks k ON k.kiosk_id = s.kiosk_id
            WHERE s.sale_id = kiosk_sales.sale_id AND ${POSTABLE})`,
    args: [saleProduct(sale), r.euro, sale.id],
  };
}

/** One row per day and account, recalculated from posted sales, so a repeat can never add to it. */
function rollup(kiosk, date, method) {
  const account = SALES_ACCOUNT[method];
  const movement = salesMovement(date, kiosk.sales_suffix, account);
  return [
    {
      sql: `INSERT INTO sales (movement, type, account, euros, mcf_user, date_real)
            SELECT ?, 'venta', ?, 0, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM sales WHERE movement = ? AND account = ? AND date_real = ?)
              AND EXISTS (SELECT 1 FROM kiosk_sales WHERE kiosk_id = ? AND biz_date = ? AND method = ? AND post_state = 'posted')`,
      args: [movement, account, kiosk.sales_user, date, movement, account, date, kiosk.kiosk_id, date, method],
    },
    {
      sql: `UPDATE sales SET euros = (
              SELECT COALESCE(SUM(price_cents), 0) / 100.0 FROM kiosk_sales
              WHERE kiosk_id = ? AND biz_date = ? AND method = ? AND post_state = 'posted')
            WHERE movement = ? AND account = ? AND date_real = ?`,
      args: [kiosk.kiosk_id, date, method, movement, account, date],
    },
  ];
}

export function saleStatements(kiosk, sales, appVersion) {
  const statements = [];
  const days = new Map();
  for (const sale of sales) {
    statements.push(upsertSale(kiosk, sale, appVersion));
    if (sale.status === 'completed') {
      statements.push(insertDetail(sale), markPosted(sale));
      if (sale.method in SALES_ACCOUNT) days.set(`${bizDate(sale)}|${sale.method}`, [bizDate(sale), sale.method]);
    }
  }
  for (const [date, method] of days.values()) statements.push(...rollup(kiosk, date, method));
  return statements;
}

/** Stores a batch of sales. One sale that fails is reported and does not hold back the others. */
export async function ingestSales(db, kiosk, sales, appVersion) {
  const accepted = [];
  const rejected = [];
  const valid = [];
  for (const sale of sales || []) {
    const problem = saleProblem(sale);
    if (problem) rejected.push({ id: sale?.id ?? null, reason: 'schema', detail: problem });
    else valid.push(sale);
  }
  if (valid.length === 0) return { accepted, rejected };
  try {
    await db.batch(saleStatements(kiosk, valid, appVersion), 'write');
    accepted.push(...valid.map(s => s.id));
  } catch (batchError) {
    if (valid.length === 1) {
      rejected.push({ id: valid[0].id, reason: 'processing', detail: batchError.message });
      return { accepted, rejected };
    }
    for (const sale of valid) {
      const one = await ingestSales(db, kiosk, [sale], appVersion);
      accepted.push(...one.accepted);
      rejected.push(...one.rejected);
    }
  }
  return { accepted, rejected };
}

const CASH_KINDS = { pull: { type: 'transito', title: 'transito' }, coins: { type: 'fondo caja', title: 'fondo caja' } };
const DENOMINATIONS = { b20e: 2000, b10e: 1000, b5e: 500, m2e: 200, m1e: 100, m50e: 50, m20e: 20, m10e: 10, m5e: 5 };

/** Reason a cash operation cannot be stored, or null when it is fine. */
export function cashOpProblem(op) {
  if (!op?.id) return 'id missing';
  if (!CASH_KINDS[op.kind]) return `unknown kind ${op.kind}`;
  if (!op.mcf_user) return 'mcf_user missing';
  if (!/^\d{4}-\d{2}-\d{2} /.test(op.committed_at || '')) return `bad committed_at ${op.committed_at}`;
  let sum = 0;
  for (const [field, cents] of Object.entries(DENOMINATIONS)) {
    if (!Number.isInteger(op[field]) || op[field] < 0) return `bad count ${field}`;
    sum += op[field] * cents;
  }
  if (sum === 0) return 'nothing to record';
  if (sum !== op.total_cents) return `total ${op.total_cents} is not the sum of the counts (${sum})`;
  return null;
}

/** One movements row per operation, however many times it is sent: the insert only runs while posted is still 0. */
function cashOpStatements(kiosk, op) {
  const date = op.committed_at.slice(0, 10);
  const kind = CASH_KINDS[op.kind];
  const counts = Object.fromEntries(Object.keys(DENOMINATIONS).map(f => [f, op[f]]));
  return [
    {
      sql: `INSERT OR IGNORE INTO kiosk_cash_ops (op_id, kiosk_id, kind, mcf_user, created_at_local, committed_at_local, counts, total_cents, expected_cents, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [op.id, kiosk.kiosk_id, op.kind, op.mcf_user, op.created_at || op.committed_at, op.committed_at, JSON.stringify(counts), op.total_cents, op.expected_cents ?? op.total_cents, op.note || null],
    },
    {
      sql: `INSERT INTO movements (movement, type, account, euros, propiedad, mcf_user, date_real, description, icon)
            SELECT ?, ?, 'cash', ?, k.propiedad_label, o.mcf_user, ?, ?, '🟡'
            FROM kiosk_cash_ops o JOIN kiosks k ON k.kiosk_id = o.kiosk_id
            WHERE o.op_id = ? AND o.posted = 0`,
      args: [`Movimiento ${kind.title} - ${date}`, kind.type, op.total_cents / 100, date, denominationDescription(counts), op.id],
    },
    { sql: `UPDATE kiosk_cash_ops SET posted = 1 WHERE op_id = ? AND posted = 0`, args: [op.id] },
  ];
}

/** Stores owners' cash operations one at a time, so one that fails does not hold back the others. */
export async function ingestCashOps(db, kiosk, ops) {
  const accepted = [];
  const rejected = [];
  for (const op of ops || []) {
    const problem = cashOpProblem(op);
    if (problem) { rejected.push({ id: op?.id ?? null, reason: 'schema', detail: problem }); continue; }
    try {
      await db.batch(cashOpStatements(kiosk, op), 'write');
      accepted.push(op.id);
    } catch (err) {
      rejected.push({ id: op.id, reason: 'processing', detail: err.message });
    }
  }
  return { accepted, rejected };
}

const APPEND_ONLY = {
  cash_moves: rows => ({
    sql: `INSERT OR IGNORE INTO kiosk_cash_moves (kiosk_id, db_uuid, local_id, sale_id, at_local, kind, cents) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [rows.kiosk_id, rows.db_uuid, rows.id, rows.sale_id ?? null, rows.at, rows.kind, rows.cents],
  }),
  card_moves: rows => ({
    sql: `INSERT OR IGNORE INTO kiosk_card_moves (kiosk_id, db_uuid, local_id, uid, at_local, kind, cents, balance_after, sale_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [rows.kiosk_id, rows.db_uuid, rows.id, rows.uid, rows.at, rows.kind, rows.cents, rows.balance_after, rows.sale_id ?? null, rows.note ?? null],
  }),
  events: rows => ({
    sql: `INSERT OR IGNORE INTO kiosk_events (kiosk_id, db_uuid, local_id, at_local, type, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [rows.kiosk_id, rows.db_uuid, rows.id, rows.at, rows.type, rows.detail ?? null],
  }),
};

/** Stores append-only rows. Returns, per stream, the highest local id now safe in the cloud. */
export async function ingestAppendOnly(db, kiosk, dbUuid, body) {
  const statements = [];
  const through = {};
  for (const [stream, build] of Object.entries(APPEND_ONLY)) {
    const rows = body[stream];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    for (const row of rows) statements.push(build({ ...row, kiosk_id: kiosk.kiosk_id, db_uuid: dbUuid }));
    through[stream] = Math.max(...rows.map(r => r.id));
  }
  if (statements.length > 0) await db.batch(statements, 'write');
  return through;
}
