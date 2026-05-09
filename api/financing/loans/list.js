import turso from '../../_lib/turso.js';

/**
 * GET /api/financing/loans/list
 *
 * Returns all loans with derived metrics:
 *   outstanding_principal = principal_original − Σ loan_payment_principal − net refinance offsets
 *   total_interest_paid   = Σ loan_payment_interest
 *   total_disbursed       = Σ financing_events.euros where event_type='disbursement'
 *   payments_count        = number of loan-payment gastos
 *   last_payment_date     = max(gastos.fecha) among loan payments
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const r = await turso.execute(`
      SELECT
        l.*,
        COALESCE(p.total_principal_paid, 0) AS total_principal_paid,
        COALESCE(p.total_interest_paid, 0)  AS total_interest_paid,
        COALESCE(p.payments_count, 0)       AS payments_count,
        p.last_payment_date,
        COALESCE(d.total_disbursed, 0)      AS total_disbursed
      FROM loans l
      LEFT JOIN (
        SELECT loan_id,
               SUM(COALESCE(loan_payment_principal, 0)) AS total_principal_paid,
               SUM(COALESCE(loan_payment_interest, 0))  AS total_interest_paid,
               COUNT(*) AS payments_count,
               MAX(fecha) AS last_payment_date
        FROM gastos
        WHERE loan_id IS NOT NULL
        GROUP BY loan_id
      ) p ON p.loan_id = l.id
      LEFT JOIN (
        SELECT loan_id,
               SUM(CASE WHEN event_type = 'disbursement' THEN euros ELSE 0 END) AS total_disbursed
        FROM financing_events
        WHERE loan_id IS NOT NULL
        GROUP BY loan_id
      ) d ON d.loan_id = l.id
      ORDER BY l.start_date DESC, l.id DESC
    `);
    const rows = r.rows.map(row => ({
      ...row,
      principal_original: Number(row.principal_original) || 0,
      total_principal_paid: Number(row.total_principal_paid) || 0,
      total_interest_paid: Number(row.total_interest_paid) || 0,
      total_disbursed: Number(row.total_disbursed) || 0,
      payments_count: Number(row.payments_count) || 0,
      outstanding_principal: Math.max(
        0,
        (Number(row.principal_original) || 0) - (Number(row.total_principal_paid) || 0)
      ),
    }));
    return res.status(200).json({ count: rows.length, rows });
  } catch (err) {
    console.error('financing/loans/list error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
