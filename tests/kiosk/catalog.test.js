import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conditions } from '../../api/_lib/kiosk-alerts.js';

const catalog = JSON.parse(readFileSync(new URL('../../public/data/kiosk-errors.json', import.meta.url), 'utf8'));
const known = new Set(catalog.map(e => e.code));

test('every alert code is in the published catalog', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const devices = Object.fromEntries(['bank', 'coins', 'notes', 'cards', 'machines', 'printer'].map(k => [k, { ok: false, status: 'x' }]));
  const payload = {
    selling: true, devices, coins_low: [50], unfinished_paid: 1, ui_tick_age_s: 300, pc: { temp_c: 99 }, outbox: { oldest_age_s: 9 * 3600, parked: 1 },
  };
  const alive = { received_at: new Date(now).toISOString(), next_due_at: new Date(now + 300000).toISOString(), mode: 'on', clock_skew_s: 999, payload: JSON.stringify(payload) };
  const codes = conditions({}, alive, now, { reconBad: ['2026-11-03'], unmatchedProducts: 2 }).map(c => c.code);
  const silent = { ...alive, next_due_at: new Date(now - 3600000).toISOString() };
  codes.push(...conditions({}, silent, now).map(c => c.code), 805);
  assert.ok(codes.length > 12);
  assert.deepEqual(codes.filter(c => !known.has(c)), []);
});

test('entries are complete enough to act on', () => {
  for (const e of catalog) {
    for (const field of ['area', 'severity', 'message', 'meaning', 'how']) assert.ok(e[field], `${e.code} ${field}`);
    for (const field of ['causes', 'fix', 'source']) assert.ok(e[field].length > 0, `${e.code} ${field}`);
    assert.ok(['error', 'warn'].includes(e.severity), `${e.code} severity`);
  }
  assert.equal(known.size, catalog.length, 'codes must be unique');
});
