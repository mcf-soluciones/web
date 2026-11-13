/**
 * Turns a sale as the kiosk recorded it into the rows the reports read.
 * This is the only place that knows the shape of sales_detail and sales for
 * kiosk stores, so a mistake here can be fixed and replayed without a kiosk release.
 *
 * All dates come from the kiosk's local timestamp text. Never parse it into a
 * JS Date as local time: Vercel runs in UTC.
 */

export const PAYMENT = { cash: 'EFECTIVO', bank: 'TARJETA BANCO', card: 'TARJETA CLIENTE' };

// Accounts of the daily `sales` table. Customer-card sales have none, as in the old pipeline.
export const SALES_ACCOUNT = { cash: 'cash', bank: 'banco' };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const KINDS = ['machine', 'topup', 'card'];

/** Reason the sale cannot be stored, or null when it is fine. */
export function saleProblem(sale) {
  if (!sale || typeof sale !== 'object') return 'not an object';
  if (!sale.id || typeof sale.id !== 'string') return 'id missing';
  if (!KINDS.includes(sale.kind)) return `unknown kind ${sale.kind}`;
  if (!(sale.method in PAYMENT)) return `unknown method ${sale.method}`;
  if (!sale.status || typeof sale.status !== 'string') return 'status missing';
  if (!Number.isInteger(sale.price_cents) || sale.price_cents < 0) return `bad price_cents ${sale.price_cents}`;
  if (!TIMESTAMP.test(sale.created_at || '')) return `bad created_at ${sale.created_at}`;
  if (!TIMESTAMP.test(sale.updated_at || '')) return `bad updated_at ${sale.updated_at}`;
  if (sale.kind === 'machine' && !sale.machine) return 'machine missing';
  if (sale.status === 'completed' && !sale.receipt_no) return 'completed sale without receipt';
  return null;
}

export function saleProduct(sale) {
  if (sale.kind === 'topup') return 'RECARGA';
  if (sale.kind === 'card') return 'TARJETA';
  return sale.machine;
}

/** The sale's day, yyyy-mm-dd, as the customer lived it. */
export function bizDate(sale) {
  return sale.created_at.slice(0, 10);
}

/** Everything sales_detail needs that does not come from the kiosks row. */
export function detailRow(sale) {
  const [, y, m, d, hh, mm, ss] = TIMESTAMP.exec(sale.created_at);
  const yyyy = Number(y);
  const month = Number(m);
  const day = Number(d);
  return {
    movid: sale.receipt_no,
    date: `${y}-${m}-${d}`,
    yyyy,
    mm: month,
    dd: day,
    time: `${hh}:${mm}:${ss}`,
    hr: Number(hh),
    min: Number(mm),
    payment: PAYMENT[sale.method],
    product: saleProduct(sale),
    // Exact division of whole cents, the same double as products.precio, which the reports join on.
    euro: sale.price_cents / 100,
    dayweek: DAYS[new Date(Date.UTC(yyyy, month - 1, day)).getUTCDay()],
  };
}

/** Label of a day in `sales`, e.g. VentasDia041126_223501 [cash]. reconcile.py reads the store from the suffix. */
export function salesMovement(date, suffix, account) {
  const [y, m, d] = date.split('-');
  return `VentasDia${d}${m}${y.slice(2)}_${suffix} [${account}]`;
}

/** Text of a movements row, identical to the website's forms (api/movimientos.js). */
export function denominationDescription(c) {
  return `Count de billetes: 20e = ${c.b20e || 0}, 10e = ${c.b10e || 0}, 5e = ${c.b5e || 0} - Count de Monedas: 2e = ${c.m2e || 0}, 1e = ${c.m1e || 0}, 0.50e = ${c.m50e || 0}, 0.20e = ${c.m20e || 0}, 0.10e = ${c.m10e || 0}, 0.05e = ${c.m5e || 0}`;
}
