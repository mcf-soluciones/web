import turso from '../_lib/turso.js';
import { EDITABLE_FIELDS, coerce } from '../_lib/laundries-editable.js';

/**
 * POST /api/laundries/create
 *   body: { name, lat, lng, ...other editable fields, created_by? }
 *
 * Inserts a new laundry pin. `name`, `lat`, `lng` are required. All other fields
 * pass through the same whitelist used by /update so the validation surface is
 * a single source of truth.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const name = (body.name || '').toString().trim();
    const lat = parseFloat(body.lat);
    const lng = parseFloat(body.lng);
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng must be numbers' });
    }

    const cols = { name, lat, lng };
    for (const [field, raw] of Object.entries(body)) {
      if (field === 'name' || field === 'lat' || field === 'lng') continue;
      if (!EDITABLE_FIELDS.has(field)) continue;
      cols[field] = coerce(field, raw);
    }
    const createdBy = (body.created_by || '').toString().trim() || null;
    if (createdBy) cols.created_by = createdBy;

    const fields = Object.keys(cols);
    const placeholders = fields.map(() => '?').join(', ');
    const quoted = fields.map(quote).join(', ');
    const args = fields.map(f => cols[f]);

    const rs = await turso.execute({
      sql: `INSERT INTO laundries (${quoted}) VALUES (${placeholders})`,
      args,
    });

    const id = Number(rs.lastInsertRowid);
    return res.status(200).json({ success: true, id });
  } catch (err) {
    console.error('laundries/create error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function quote(ident) { return `"${ident.replace(/"/g, '""')}"`; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
