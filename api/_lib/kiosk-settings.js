import { checkPin } from './kiosk-pin.js';

/**
 * What can be changed on a kiosk from the website, and the rules it must pass. The kiosk checks the same rules again
 * and keeps its last good settings if they fail. Ports, machine wiring and the card key are not here, so they cannot be sent at all.
 */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MINUTES_PER_CYCLE = 10;
export const MAX_DRYER_CYCLES = 5; // same limit as the kiosk

const isCents = (n, step) => Number.isInteger(n) && n >= 0 && n % step === 0;

/** Same rule as the old kiosk: the discount is taken from the card price and rounded up to the next 5 cents. */
export function discountedCents(cents, percent) {
  if (percent >= 100) return 0;
  return Math.ceil((cents * (100 - percent)) / 500) * 5;
}

export function settingsProblem(s, machineNames) {
  if (!s || typeof s !== 'object') return 'no hay ajustes';
  if (s.hours !== undefined) {
    if (!Array.isArray(s.hours) || s.hours.length !== 7) return 'el horario debe tener 7 días';
    for (const [i, d] of s.hours.entries()) {
      for (const f of ['open', 'last_wash', 'last_sale', 'close']) if (!TIME.test(d[f] ?? '')) return `horario día ${i + 1}: hora no válida en ${f}`;
      if (!(d.open < d.last_wash && d.last_wash <= d.last_sale && d.last_sale <= d.close)) return `horario día ${i + 1}: las horas deben ir en orden (abre, última lavadora, última venta, cierre)`;
    }
  }
  // Empty = the screen never goes black.
  if (s.black_screen_from !== undefined && (typeof s.black_screen_from !== 'string' || (s.black_screen_from !== '' && !TIME.test(s.black_screen_from)))) return 'hora de la pantalla negra no válida';
  if (s.prices !== undefined) {
    for (const [machine, windows] of Object.entries(s.prices)) {
      if (!machineNames.includes(machine)) return `máquina desconocida: ${machine}`;
      if (!Array.isArray(windows) || windows.length === 0) return `${machine}: sin precios`;
      let last = null;
      for (const w of windows) {
        if (!TIME.test(w.from ?? '') || !TIME.test(w.to ?? '') || w.from > w.to) return `${machine}: tramo horario no válido`;
        if (last !== null && w.from <= last) return `${machine}: los tramos horarios se solapan`;
        last = w.to;
        if (!isCents(w.cents, 50) || w.cents === 0) return `${machine}: el precio debe ser múltiplo de 0,50 €, para poder devolver el cambio`;
        if (!isCents(w.card_cents, 5) || w.card_cents > w.cents) return `${machine}: el precio con tarjeta debe ser múltiplo de 0,05 € y no mayor que el precio normal`;
      }
    }
  }
  if (s.max_cycles !== undefined && !(Number.isInteger(s.max_cycles) && s.max_cycles >= 1 && s.max_cycles <= MAX_DRYER_CYCLES)) return `máximo de ciclos entre 1 y ${MAX_DRYER_CYCLES}`;
  if (s.card !== undefined) {
    if (!isCents(s.card.price_cents, 50) || s.card.price_cents === 0) return 'el precio de la tarjeta debe ser múltiplo de 0,50 €';
    if (!isCents(s.card.initial_balance_cents, 5) || s.card.initial_balance_cents > s.card.price_cents) return 'el saldo inicial no puede superar el precio de la tarjeta';
    if (!Array.isArray(s.card.topup_amounts) || s.card.topup_amounts.length === 0 || s.card.topup_amounts.some(a => !isCents(a, 50) || a === 0 || a > 2000)) return 'las recargas deben ser múltiplos de 0,50 € y como máximo 20 €';
  }
  if (s.timeouts !== undefined) {
    for (const f of ['inactivity_seconds', 'cash_gap_seconds', 'done_screen_seconds']) {
      if (!(Number.isInteger(s.timeouts[f]) && s.timeouts[f] >= 5 && s.timeouts[f] <= 600)) return `${f} entre 5 y 600 segundos`;
    }
  }
  if (s.cloud !== undefined) {
    for (const f of ['upload_minutes', 'heartbeat_day_minutes', 'heartbeat_night_minutes']) {
      if (!(Number.isInteger(s.cloud[f]) && s.cloud[f] >= 1 && s.cloud[f] <= 1440)) return `${f} entre 1 y 1440 minutos`;
    }
    if (typeof s.cloud.telemetry_enabled !== 'boolean') return 'telemetry_enabled debe ser sí o no';
    if (!TIME.test(s.cloud.night_check_at ?? '')) return 'hora de la revisión nocturna no válida';
    if (!(Number.isInteger(s.cloud.temp_alert_c) && s.cloud.temp_alert_c >= 40 && s.cloud.temp_alert_c <= 120)) return 'temperatura de aviso entre 40 y 120 °C';
    if (typeof s.cloud.low_coins !== 'object' || Object.values(s.cloud.low_coins ?? {}).some(n => !Number.isInteger(n) || n < 0)) return 'mínimos de monedas no válidos';
  }
  if (s.min_change_in_hopper_cents !== undefined && !isCents(s.min_change_in_hopper_cents, 5)) return 'cambio mínimo no válido';
  if (s.home_notice !== undefined && (typeof s.home_notice !== 'string' || s.home_notice.length > 140)) return 'el aviso admite hasta 140 caracteres';
  return null;
}

export function discountProblem(d) {
  if (!d?.uid || typeof d.uid !== 'string' || !/^[0-9A-Fa-f]{4,32}$/.test(d.uid)) return `número de tarjeta no válido: ${d?.uid}`;
  if (!(Number.isInteger(d.percent) && d.percent >= 1 && d.percent <= 100)) return `descuento no válido en ${d.uid}: entre 1 y 100`;
  return null;
}

/**
 * Every (product, price) the kiosk can charge with these settings, in the shape of a products row.
 * A dryer sale is one row with the total for all its cycles, and a discount applies to that total.
 */
export function chargeableProducts(settings, discounts = []) {
  const keys = new Map();
  const percents = [...new Set(discounts.map(d => d.percent))];
  const add = (product, cents, kind, cycles) => {
    const key = `${product}|${cents}`;
    if (!keys.has(key)) keys.set(key, { product, cents, kind, cycles });
  };
  for (const [machine, windows] of Object.entries(settings.prices || {})) {
    const dryer = machine.startsWith('SECADORA');
    const maxCycles = dryer ? (settings.max_cycles ?? MAX_DRYER_CYCLES) : 1;
    for (const w of windows) {
      for (let n = 1; n <= maxCycles; n++) {
        add(machine, w.cents * n, 'publico', n);
        add(machine, w.card_cents * n, 'fidelizacion', n);
        for (const pct of percents) add(machine, discountedCents(w.card_cents * n, pct), 'descuento', n);
      }
    }
  }
  return [...keys.values()];
}

/** Rows to add to products so these prices join in the reports. Copies a sibling of the same machine and drying time. Existing rows are never changed. */
export async function missingProducts(db, kiosk, settings, discounts) {
  const rows = (await db.execute({ sql: 'SELECT * FROM products WHERE price_list = ? AND property = ?', args: [kiosk.price_list, kiosk.property] })).rows;
  const missing = [];
  const noSibling = [];
  for (const key of chargeableProducts(settings, discounts)) {
    const euro = key.cents / 100;
    const siblings = rows.filter(r => r.product === key.product);
    if (siblings.some(r => Number(r.precio) === euro)) continue;
    if (siblings.length === 0) { noSibling.push(key.product); continue; }
    const dryer = key.product.startsWith('SECADORA');
    const minutes = dryer ? key.cycles * MINUTES_PER_CYCLE : Number(siblings[0].product_mins);
    const sibling = siblings.find(r => Number(r.product_mins) === minutes) || siblings[0];
    missing.push({
      product: key.product, precio: euro, capacidad: sibling.capacidad, product_price: key.kind, product_size: sibling.product_size, product_mins: minutes,
      product_mission: sibling.product_mission, subproducto: sibling.subproducto, day_subproduct_capacity: sibling.day_subproduct_capacity,
      day_product_capacity: sibling.day_product_capacity, notes: 'Kiosk v3: precio añadido al guardar ajustes', price_list: kiosk.price_list, property: kiosk.property,
    });
  }
  return { missing, noSibling: [...new Set(noSibling)] };
}

/** Saves everything in one transaction: a price never reaches the kiosk without the products row the reports need. */
export async function saveSettings(db, kiosk, user, settings, discounts, machineNames, nowIso = new Date().toISOString()) {
  const problem = settingsProblem(settings, machineNames) || (discounts || []).map(discountProblem).find(Boolean);
  if (problem) return { ok: false, problem };
  const { missing, noSibling } = await missingProducts(db, kiosk, settings, discounts);
  if (noSibling.length) return { ok: false, problem: `No hay ninguna fila en products para ${noSibling.join(', ')}, de la que copiar los datos` };

  const statements = missing.map(p => ({
    sql: `INSERT INTO products (product, precio, capacidad, product_price, product_size, product_mins, product_mission, subproducto, day_subproduct_capacity, day_product_capacity, notes, price_list, property)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM products WHERE product = ? AND precio = ? AND price_list = ? AND property = ?)`,
    args: [p.product, p.precio, p.capacidad ?? null, p.product_price, p.product_size ?? null, p.product_mins ?? 0, p.product_mission ?? null, p.subproducto ?? null,
      p.day_subproduct_capacity ?? 0, p.day_product_capacity ?? 0, p.notes, p.price_list, p.property, p.product, p.precio, p.price_list, p.property],
  }));
  statements.push({
    sql: `INSERT INTO kiosk_settings (kiosk_id, settings, updated_by, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(kiosk_id) DO UPDATE SET settings = excluded.settings, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    args: [kiosk.kiosk_id, JSON.stringify(settings), user, nowIso],
  });
  statements.push({ sql: 'DELETE FROM kiosk_card_discounts WHERE kiosk_id = ?', args: [kiosk.kiosk_id] });
  for (const d of discounts || []) {
    statements.push({
      sql: 'INSERT INTO kiosk_card_discounts (kiosk_id, uid, percent, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [kiosk.kiosk_id, d.uid.toUpperCase(), d.percent, user, nowIso],
    });
  }
  statements.push({
    sql: 'INSERT INTO kiosk_audit (at, kiosk_id, mcf_user, action, detail) VALUES (?, ?, ?, ?, ?)',
    args: [nowIso, kiosk.kiosk_id, user, 'settings.save', JSON.stringify({ settings, discounts: discounts || [], products_added: missing.map(p => `${p.product} ${p.precio}`) })],
  });
  await db.batch(statements, 'write');
  return { ok: true, products_added: missing.map(p => ({ product: p.product, precio: p.precio })) };
}

export async function loadSettings(db, kiosk) {
  const saved = (await db.execute({ sql: 'SELECT settings, updated_by, updated_at FROM kiosk_settings WHERE kiosk_id = ?', args: [kiosk.kiosk_id] })).rows[0];
  const status = (await db.execute({ sql: 'SELECT payload FROM kiosk_status WHERE kiosk_id = ?', args: [kiosk.kiosk_id] })).rows[0];
  let reported = {};
  try { reported = JSON.parse(status?.payload || '{}'); } catch { reported = {}; }
  const discounts = (await db.execute({ sql: 'SELECT uid, percent FROM kiosk_card_discounts WHERE kiosk_id = ? ORDER BY uid', args: [kiosk.kiosk_id] })).rows
    .map(d => ({ uid: d.uid, percent: Number(d.percent) }));
  // The page starts from what the kiosk says it is using now, with whatever has been saved on top, so every section is always there to edit.
  const savedSettings = saved ? JSON.parse(saved.settings) : null;
  return {
    settings: reported.settings || savedSettings ? { ...reported.settings, ...savedSettings } : null,
    saved: !!saved,
    updated_by: saved?.updated_by ?? null,
    updated_at: saved?.updated_at ?? null,
    machines: Object.keys(reported.settings?.prices ?? {}),
    discounts,
    applied_rev: reported.config_rev ?? null,
    config_problem: reported.config_problem ?? null,
  };
}

/** The handler behind /api/kiosk/settings, apart from HTTP. Only owners: signed in, or their PIN is checked on every call. */
export async function settingsRequest(db, body, signedIn = null) {
  const check = signedIn ? { ok: true, user: signedIn } : body?.pin ? await checkPin(db, body.pin) : { ok: false };
  if (check.locked) return { status: 429, json: { error: 'Demasiados intentos. Espere unos minutos.' } };
  if (!check.ok) return { status: 401, json: { error: 'PIN incorrecto' } };
  const kiosk = (await db.execute({ sql: 'SELECT * FROM kiosks WHERE kiosk_id = ?', args: [body.kiosk_id || 'K1'] })).rows[0];
  if (!kiosk) return { status: 404, json: { error: 'Kiosco desconocido' } };
  const current = await loadSettings(db, kiosk);
  if (body.action !== 'save') return { status: 200, json: { user: check.user, kiosk_id: kiosk.kiosk_id, name: kiosk.name, ...current } };
  const machines = current.machines.length ? current.machines : Object.keys(body.settings?.prices ?? {});
  const result = await saveSettings(db, kiosk, check.user, body.settings, body.discounts, machines);
  return { status: result.ok ? 200 : 400, json: result.ok ? result : { error: result.problem } };
}
