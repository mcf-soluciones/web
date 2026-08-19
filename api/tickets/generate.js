import { buildTicketPdf } from '../_lib/ticket-pdf.js';

/**
 * GET|POST /api/tickets/generate
 *
 * Generates a simplified-receipt ("ticket") PDF for MCF laundromats and returns
 * it as `application/pdf`.
 *
 *   POST  body (JSON): { business?, subtitle?, nif?, address?, concepto?,
 *                        descripcion?, cantidad?, total, ivaRate?, fecha?,
 *                        hora?, pago?, numero?, footer? }
 *   GET   query params: same keys (handy for recurrent/programmatic links), e.g.
 *         /api/tickets/generate?concepto=Lavado&total=8&ivaRate=21&pago=Efectivo
 *
 * By default the PDF is returned inline (opens in the browser). Pass
 * `?download=1` (or `download: true` in the body) to force a download.
 *
 * `total` is required and must be a positive number. All other fields fall back
 * to MCF defaults (see api/_lib/ticket-pdf.js).
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const input = req.method === 'GET' ? { ...req.query } : { ...(req.body || {}) };

    const total = parseAmount(input.total);
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: 'total is required and must be a positive number (euros).' });
    }

    const hasRate = input.ivaRate !== undefined && input.ivaRate !== '';
    const ivaRate = hasRate ? parseAmount(input.ivaRate) : undefined;
    if (hasRate && !(ivaRate >= 0)) {
      return res.status(400).json({ error: 'ivaRate must be a number >= 0.' });
    }

    const pdf = await buildTicketPdf({ ...input, total, ...(hasRate ? { ivaRate } : {}) });

    const download = input.download === '1' || input.download === true || input.download === 'true';
    const numero = (input.numero || '').toString().trim();
    const filename = `ticket-${slug(numero) || 'mcf'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
    );
    return res.status(200).send(Buffer.from(pdf));
  } catch (err) {
    console.error('tickets/generate error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate ticket.' });
  }
}

/** Accepts "8.50" and the Spanish "8,50" alike (staff type the comma). */
function parseAmount(v) {
  if (typeof v === 'number') return v;
  return Number(String(v ?? '').trim().replace(/\s/g, '').replace(',', '.'));
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
