import turso from '../../_lib/turso.js';

const VALID_TYPES = new Set([
  'disbursement', 'equity_in', 'equity_out', 'fee_one_time', 'refinance',
]);

/**
 * POST /api/financing/events/create
 *   body: { fecha, event_type, euros, loan_id?, counterparty?, notes?, recibo_url?, user_name? }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};
    if (!b.fecha) return res.status(400).json({ error: 'fecha is required' });
    if (!VALID_TYPES.has(b.event_type)) {
      return res.status(400).json({ error: `event_type must be one of: ${[...VALID_TYPES].join(', ')}` });
    }
    const euros = parseFloat(b.euros);
    if (!Number.isFinite(euros) || euros <= 0) {
      return res.status(400).json({ error: 'euros must be > 0 (sign is derived from event_type)' });
    }
    const d = new Date(b.fecha);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid fecha' });
    const fecha = ymd(d);
    const mm = d.getMonth() + 1;
    const yyyy = d.getFullYear();

    const ins = await turso.execute({
      sql: `INSERT INTO financing_events
              (fecha, mm, yyyy, event_type, euros, loan_id, counterparty,
               notes, recibo_url, user_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        fecha, mm, yyyy,
        b.event_type, euros,
        b.loan_id ? parseInt(b.loan_id, 10) : null,
        b.counterparty || null,
        b.notes || null,
        b.recibo_url || null,
        b.user_name || null,
      ],
    });
    return res.status(200).json({ success: true, id: Number(ins.lastInsertRowid) });
  } catch (err) {
    console.error('financing/events/create error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
