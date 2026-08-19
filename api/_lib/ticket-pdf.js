import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Ticket (simplified receipt) PDF generator for MCF laundromats.
 *
 * Produces an 80mm thermal-style ticket as a single-page PDF. Pure JS via
 * pdf-lib so it runs on Vercel serverless with no native/chromium deps and
 * still renders the euro sign and Spanish accents (WinAnsi encoding).
 *
 * The layout is driven by a tiny top-down cursor: every draw* helper pushes an
 * op measured from the top of the page and advances the cursor. Once the whole
 * ticket is laid out we know its height, create the page, and replay the ops
 * converting each top-based y into pdf-lib's bottom-left origin.
 */

// ---- geometry (points; 1mm ~= 2.8346pt, 80mm ~= 226.77pt) ------------------
const PAGE_W = 226.77;
const MARGIN_X = 18;
const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 18;
const CENTER_X = PAGE_W / 2;
const RIGHT_X = PAGE_W - MARGIN_X;

// ---- colors ----------------------------------------------------------------
const C = {
  ink: rgb(0.1, 0.1, 0.1),
  gray: rgb(0.42, 0.42, 0.42),
  muted: rgb(0.6, 0.6, 0.6),
  faint: rgb(0.72, 0.72, 0.72),
  rule: rgb(0.74, 0.74, 0.74),
  box: rgb(0.95, 0.95, 0.95),
};

// ---- Spanish helpers -------------------------------------------------------
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function pad2(n) { return String(n).padStart(2, '0'); }

/** Round to 2 decimals avoiding binary float drift. */
export function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

/** Split an IVA-inclusive total into base + IVA for the given rate (%). */
export function computeAmounts(total, ivaRate) {
  const t = round2(total);
  const rate = Number(ivaRate) || 0;
  const base = round2(t / (1 + rate / 100));
  const iva = round2(t - base);
  return { base, iva, total: t, rate };
}

/** Spanish currency: 1234.5 -> "1.234,50 €" (plain space before €). */
export function formatEur(n) {
  const fixed = Math.abs(round2(n)).toFixed(2);
  let [int, dec] = fixed.split('.');
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}${int},${dec} €`;
}

// WinAnsi cannot encode arbitrary unicode; keep ASCII + Latin-1 + €, and
// transliterate the common "smart" punctuation people paste in.
const TRANSLIT = {
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '–': '-', '—': '-', '…': '...', ' ': ' ',
};
function sanitize(str) {
  return String(str ?? '')
    .replace(/[‘’“”–—… ]/g, (m) => TRANSLIT[m])
    .split('')
    .map((ch) => {
      if (ch === '€') return ch;                 // €
      const c = ch.codePointAt(0);
      if (c >= 0x20 && c <= 0x7e) return ch;          // ASCII printable
      if (c >= 0xa1 && c <= 0xff) return ch;          // Latin-1 (accents, ñ, º, ¿, ¡)
      return '';                                       // drop emoji/CJK/control
    })
    .join('');
}

/**
 * Build the ticket PDF.
 * @param {object} data
 * @param {string} [data.business]    header business name
 * @param {string} [data.subtitle]    header subtitle line
 * @param {string} [data.nif]         NIF/CIF (optional)
 * @param {string} [data.address]     address (optional)
 * @param {string} [data.concepto]    line-item label
 * @param {string} [data.descripcion] small line under the concepto
 * @param {number} [data.cantidad]    quantity (default 1)
 * @param {number} data.total         IVA-inclusive total (euros)
 * @param {number} [data.ivaRate]     IVA rate % (default 21)
 * @param {string} [data.fecha]       YYYY-MM-DD (default today)
 * @param {string} [data.hora]        HH:MM (default now)
 * @param {string} [data.pago]        payment method (default Efectivo)
 * @param {string} [data.numero]      ticket number (default from date+time)
 * @param {string|string[]} [data.footer] footer note(s)
 * @returns {Promise<Uint8Array>}
 */
export async function buildTicketPdf(data = {}) {
  const doc = await PDFDocument.create();
  const model = normalize(data);
  doc.setTitle(`Ticket ${model.numero}`.trim());
  doc.setProducer('MCF Soluciones');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // ---- layout pass: push ops, track cursor from the top ----
  const ops = [];
  let ty = TOP_MARGIN;

  const gap = (h) => { ty += h; };

  const text = (str, { size, f = font, color = C.ink, align = 'left', x = MARGIN_X, lh = 1.35 } = {}) => {
    ops.push({ kind: 'text', str: sanitize(str), size, f, color, align, x, baselineTop: ty + size });
    ty += size * lh;
  };

  // label left + value right on the same baseline
  const row = (label, value, { size = 8, labelColor = C.muted, valueColor = C.ink, labelFont = font, valueFont = font } = {}) => {
    const baselineTop = ty + size;
    ops.push({ kind: 'text', str: sanitize(label), size, f: labelFont, color: labelColor, align: 'left', x: MARGIN_X, baselineTop });
    ops.push({ kind: 'text', str: sanitize(value), size, f: valueFont, color: valueColor, align: 'right', x: RIGHT_X, baselineTop });
    ty += size * 1.5;
  };

  const rule = () => {
    gap(5);
    ops.push({ kind: 'rule', ty });
    gap(6);
  };

  // ---- header ----
  text(model.business, { size: 15, f: bold, align: 'center' });
  if (model.subtitle) text(model.subtitle.toUpperCase(), { size: 7, color: C.muted, align: 'center' });
  if (model.nif) text(model.nif, { size: 7.5, color: C.gray, align: 'center' });
  if (model.address) text(model.address, { size: 7.5, color: C.gray, align: 'center' });

  gap(6);
  text('TICKET DE COMPRA', { size: 8, color: C.gray, align: 'center' });
  rule();

  // ---- meta ----
  row('Nº ticket', model.numero);
  row('Fecha', model.fechaTxt);
  row('Hora', model.hora);
  rule();

  // ---- line item table ----
  const CANT_X = RIGHT_X - 52;
  const hBaseline = ty + 7;
  ops.push({ kind: 'text', str: 'CONCEPTO', size: 7, f: font, color: C.muted, align: 'left', x: MARGIN_X, baselineTop: hBaseline });
  ops.push({ kind: 'text', str: 'CANT.', size: 7, f: font, color: C.muted, align: 'right', x: CANT_X, baselineTop: hBaseline });
  ops.push({ kind: 'text', str: 'IMPORTE', size: 7, f: font, color: C.muted, align: 'right', x: RIGHT_X, baselineTop: hBaseline });
  ty += 7 * 1.7;

  const itemBaseline = ty + 9;
  ops.push({ kind: 'text', str: sanitize(model.concepto), size: 9, f: font, color: C.ink, align: 'left', x: MARGIN_X, baselineTop: itemBaseline });
  ops.push({ kind: 'text', str: String(model.cantidad), size: 9, f: font, color: C.ink, align: 'right', x: CANT_X, baselineTop: itemBaseline });
  ops.push({ kind: 'text', str: formatEur(model.total), size: 9, f: font, color: C.ink, align: 'right', x: RIGHT_X, baselineTop: itemBaseline });
  ty += 9 * 1.35;
  if (model.descripcion) text(model.descripcion, { size: 7, color: C.muted });

  gap(4);
  ops.push({ kind: 'rule', ty });
  gap(6);

  // ---- amounts ----
  row('Base imponible', formatEur(model.base), { size: 8.5, labelColor: C.gray });
  row(`IVA (${trimRate(model.rate)}%)`, formatEur(model.iva), { size: 8.5, labelColor: C.gray });

  // ---- total ----
  gap(4);
  ops.push({ kind: 'thickrule', ty });
  gap(7);
  row('TOTAL', formatEur(model.total), { size: 13, labelColor: C.ink, valueColor: C.ink, labelFont: bold, valueFont: bold });

  // ---- payment box ----
  gap(8);
  const paySize = 9;
  const payPad = 6;
  const boxH = paySize * 1.35 + payPad * 2;
  ops.push({ kind: 'box', ty, height: boxH });
  ops.push({
    kind: 'text',
    str: `Forma de pago:  ${sanitize(model.pago).toUpperCase()}`,
    size: paySize, f: font, color: C.ink, align: 'center', x: 0,
    baselineTop: ty + payPad + paySize,
  });
  ty += boxH;

  // ---- footer ----
  rule();
  for (const line of model.footer) text(line, { size: 7, color: C.muted, align: 'center', lh: 1.5 });

  // ---- render pass ----
  const pageH = ty + BOTTOM_MARGIN;
  const page = doc.addPage([PAGE_W, pageH]);
  const yOf = (topY) => pageH - topY;

  for (const op of ops) {
    if (op.kind === 'text') {
      if (!op.str) continue;
      let x = op.x;
      const w = op.f.widthOfTextAtSize(op.str, op.size);
      if (op.align === 'center') x = CENTER_X - w / 2;
      else if (op.align === 'right') x = op.x - w;
      page.drawText(op.str, { x, y: yOf(op.baselineTop), size: op.size, font: op.f, color: op.color });
    } else if (op.kind === 'rule') {
      page.drawLine({
        start: { x: MARGIN_X, y: yOf(op.ty) }, end: { x: RIGHT_X, y: yOf(op.ty) },
        thickness: 0.6, color: C.rule, dashArray: [1.6, 1.6],
      });
    } else if (op.kind === 'thickrule') {
      page.drawLine({
        start: { x: MARGIN_X, y: yOf(op.ty) }, end: { x: RIGHT_X, y: yOf(op.ty) },
        thickness: 1.4, color: C.ink,
      });
    } else if (op.kind === 'box') {
      page.drawRectangle({
        x: MARGIN_X, y: yOf(op.ty + op.height), width: PAGE_W - 2 * MARGIN_X, height: op.height,
        color: C.box,
      });
    }
  }

  return doc.save();
}

// ---- input normalization ---------------------------------------------------
function trimRate(rate) {
  const r = Number(rate) || 0;
  return Number.isInteger(r) ? String(r) : String(r).replace('.', ',');
}

function normalize(data) {
  const now = new Date();
  let fecha = (data.fecha || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    fecha = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }
  let hora = (data.hora || '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(hora)) {
    hora = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }
  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm] = hora.split(':').map(Number);
  hora = `${pad2(hh)}:${pad2(mm)}`;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const fechaTxt = `${WEEKDAYS[dow]}, ${pad2(d)}/${pad2(m)}/${y}`;

  const total = round2(Number(data.total) || 0);
  const ivaRate = data.ivaRate === undefined || data.ivaRate === '' ? 21 : Number(data.ivaRate);
  const { base, iva, rate } = computeAmounts(total, ivaRate);

  const numero = (data.numero || '').toString().trim() || `${y}${pad2(m)}${pad2(d)}-${pad2(hh)}${pad2(mm)}`;

  const footerRaw = data.footer;
  const footer = Array.isArray(footerRaw)
    ? footerRaw.map(String)
    : footerRaw
      ? String(footerRaw).split('\n')
      : ['IVA incluido en el precio.', 'Gracias por su confianza.'];

  return {
    business: (data.business || 'MCF Lavandería').toString().trim(),
    subtitle: data.subtitle !== undefined ? String(data.subtitle).trim() : 'Autoservicio de lavandería',
    nif: (data.nif || '').toString().trim(),
    address: (data.address || '').toString().trim(),
    concepto: (data.concepto || 'Lavado').toString().trim(),
    descripcion: data.descripcion !== undefined ? String(data.descripcion).trim() : 'Servicio de lavandería',
    cantidad: Number(data.cantidad) > 0 ? Number(data.cantidad) : 1,
    total, base, iva, rate,
    fechaTxt, hora, numero,
    pago: (data.pago || 'Efectivo').toString().trim(),
    footer,
  };
}

export default buildTicketPdf;
