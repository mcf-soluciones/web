import turso from '../../_lib/turso.js';

/**
 * GET /api/financing/loans/detail?id=123
 *
 * Returns one loan with derived metrics + every payment (gastos with this loan_id)
 * and every linked financing_event, both in date order with a running balance
 * for the payment timeline.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ error: 'id is required' });

    const [loanR, paymentsR, eventsR] = await Promise.all([
      turso.execute({ sql: `SELECT * FROM loans WHERE id = ? LIMIT 1`, args: [id] }),
      turso.execute({
        sql: `SELECT id, fecha, propiedad, concepto_proveedor, razon_social,
                     COALESCE(importe_total, gasto, 0) AS importe_total,
                     COALESCE(loan_payment_interest, 0)  AS loan_payment_interest,
                     COALESCE(loan_payment_principal, 0) AS loan_payment_principal,
                     recibo_url, num_factura
              FROM gastos
              WHERE loan_id = ?
              ORDER BY fecha ASC, id ASC`,
        args: [id],
      }),
      turso.execute({
        sql: `SELECT id, fecha, event_type, euros, counterparty, notes, recibo_url
              FROM financing_events
              WHERE loan_id = ?
              ORDER BY fecha ASC, id ASC`,
        args: [id],
      }),
    ]);
    if (loanR.rows.length === 0) return res.status(404).json({ error: 'loan not found' });
    const loan = loanR.rows[0];

    // Compute running balance per payment.
    let balance = Number(loan.principal_original) || 0;
    // Add disbursements that pre-date the first payment (and are >= start_date).
    // Simple model: subtract principal as each payment lands.
    const payments = paymentsR.rows.map(p => {
      const principal = Number(p.loan_payment_principal) || 0;
      balance = Math.max(0, balance - principal);
      return {
        ...p,
        importe_total: Number(p.importe_total) || 0,
        loan_payment_interest: Number(p.loan_payment_interest) || 0,
        loan_payment_principal: principal,
        balance_after: balance,
      };
    });

    const events = eventsR.rows.map(e => ({ ...e, euros: Number(e.euros) || 0 }));

    const totalPrincipalPaid = payments.reduce((s, p) => s + p.loan_payment_principal, 0);
    const totalInterestPaid = payments.reduce((s, p) => s + p.loan_payment_interest, 0);
    const totalDisbursed = events
      .filter(e => e.event_type === 'disbursement')
      .reduce((s, e) => s + e.euros, 0);

    return res.status(200).json({
      loan: {
        ...loan,
        principal_original: Number(loan.principal_original) || 0,
        outstanding_principal: Math.max(0, (Number(loan.principal_original) || 0) - totalPrincipalPaid),
        total_principal_paid: totalPrincipalPaid,
        total_interest_paid: totalInterestPaid,
        total_disbursed: totalDisbursed,
        payments_count: payments.length,
        events_count: events.length,
      },
      payments,
      events,
    });
  } catch (err) {
    console.error('financing/loans/detail error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
