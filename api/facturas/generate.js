import { buildFacturaPdf } from '../_lib/factura-pdf.js';

/**
 * GET|POST /api/facturas/generate
 *
 * Renders an A4 "factura" PDF (full invoice: customer data + N service lines)
 * and returns it as `application/pdf`. Like /api/tickets/generate, this only
 * prints the document -- nothing is written to the database.
 *
 *   POST JSON: { cliente: { nombre, nif, direccion },
 *                lineas: [{ concepto, detalle?, cantidad?, precio }],
 *                ivaRate?, fecha?, numero?, pago?, footer?,
 *                business?, subtitle?, nif?, address?, download? }
 *
 *   `precio` is the IVA-inclusive unit price (what the customer pays). Both
 *   "8.50" and "8,50" are accepted.
 *
 * The /ticket form submits a regular HTML form (so the PDF opens in a new tab
 * without popup blockers) with the JSON above in a single `payload` field;
 * that is accepted in a POST body (urlencoded or raw) or a GET query string.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let input;
  try {
    input = readInput(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  const cliente = input.cliente || {};
  const missing = ['nombre', 'nif', 'direccion'].filter((k) => !String(cliente[k] ?? '').trim());
  if (missing.length) {
    return res.status(400).json({ error: `cliente.${missing.join(', cliente.')} required for a factura.` });
  }

  if (!Array.isArray(input.lineas) || input.lineas.length === 0) {
    return res.status(400).json({ error: 'lineas must contain at least one service.' });
  }
  const lineas = [];
  for (const [i, l] of input.lineas.entries()) {
    const concepto = String(l?.concepto ?? '').trim();
    const precio = parseAmount(l?.precio);
    const hasCant = l?.cantidad !== undefined && l?.cantidad !== '';
    const cantidad = hasCant ? parseAmount(l.cantidad) : 1;
    if (!concepto) return res.status(400).json({ error: `lineas[${i}].concepto is required.` });
    if (!Number.isFinite(precio) || precio <= 0) {
      return res.status(400).json({ error: `lineas[${i}].precio must be a positive number (euros).` });
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return res.status(400).json({ error: `lineas[${i}].cantidad must be a positive number.` });
    }
    lineas.push({ concepto, detalle: String(l.detalle ?? '').trim(), cantidad, precio });
  }

  const hasRate = input.ivaRate !== undefined && input.ivaRate !== '';
  const ivaRate = hasRate ? parseAmount(input.ivaRate) : undefined;
  if (hasRate && !(ivaRate >= 0)) {
    return res.status(400).json({ error: 'ivaRate must be a number >= 0.' });
  }

  try {
    const pdf = await buildFacturaPdf({ ...input, cliente, lineas, ...(hasRate ? { ivaRate } : {}) });

    const download = input.download === '1' || input.download === true || input.download === 'true';
    const numero = String(input.numero || '').trim();
    const filename = `factura-${slug(numero) || 'mcf'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
    return res.status(200).send(Buffer.from(pdf));
  } catch (err) {
    console.error('facturas/generate error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate factura.' });
  }
}

/** JSON body, urlencoded/raw form body with `payload`, or `?payload=` query. */
function readInput(req) {
  let src = req.method === 'GET' ? req.query : req.body;
  if (typeof src === 'string') src = Object.fromEntries(new URLSearchParams(src));
  src = src || {};
  if (typeof src.payload === 'string') {
    return { ...JSON.parse(src.payload), ...(src.download ? { download: src.download } : {}) };
  }
  return { ...src };
}

/** Accepts "8.50" and the Spanish "8,50" alike. */
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
