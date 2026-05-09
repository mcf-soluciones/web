import turso from '../../_lib/turso.js';
import { canonicalizePropiedad } from '../../_lib/propiedad.js';

/**
 * POST /api/financing/loans/create
 *   body: { name, lender?, principal_original, start_date, term_months?, interest_rate?, propiedad?, notes?, recibo_url? }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};
    if (!b.name || !b.start_date) {
      return res.status(400).json({ error: 'name and start_date are required' });
    }
    const principal = parseFloat(b.principal_original);
    if (!Number.isFinite(principal) || principal <= 0) {
      return res.status(400).json({ error: 'principal_original must be > 0' });
    }
    const ins = await turso.execute({
      sql: `INSERT INTO loans
              (name, lender, principal_original, start_date, term_months, interest_rate,
               status, propiedad, notes, recibo_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        String(b.name).trim(),
        b.lender || null,
        principal,
        b.start_date,
        b.term_months != null ? parseInt(b.term_months, 10) : null,
        b.interest_rate != null ? parseFloat(b.interest_rate) : null,
        b.status || 'active',
        canonicalizePropiedad(b.propiedad) || null,
        b.notes || null,
        b.recibo_url || null,
      ],
    });
    return res.status(200).json({ success: true, id: Number(ins.lastInsertRowid) });
  } catch (err) {
    console.error('financing/loans/create error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
