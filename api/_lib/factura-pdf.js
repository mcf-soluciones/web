import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { FISCAL, pad2, round2, formatEur, sanitize, trimRate } from './ticket-pdf.js';

/**
 * Factura (full invoice) PDF generator for MCF laundromats.
 *
 * Sibling of the 80mm ticket in ./ticket-pdf.js: same emisor identity (FISCAL),
 * same WinAnsi sanitizing and Spanish number formatting, but an A4 page with the
 * customer's details (nombre / NIF / dirección) and a table of N services.
 *
 * Amounts: staff type what the customer pays, i.e. IVA-*inclusive* unit prices.
 * Per line we back-compute the base (sin IVA), because a factura has to show the
 * precio unitario sin impuesto. The invoice base is the sum of the line bases and
 * IVA is `total - base`, so base + IVA always re-adds to the total exactly.
 */

// ---- geometry (A4 in points) ----------------------------------------------
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MX = 50;                 // horizontal margin
const TOP = 50;                // top margin
const BOTTOM = 60;             // keep clear for the page footer
const RIGHT = PAGE_W - MX;
const CONTENT_W = RIGHT - MX;

// table columns (x = left edge for left-aligned, right edge for right-aligned)
const COL = {
  concepto: MX + 8,
  detalle: MX + 190,
  cantR: RIGHT - 190,
  precioR: RIGHT - 95,
  importeR: RIGHT - 8,
};
const CONCEPTO_W = COL.detalle - COL.concepto - 10;
const DETALLE_W = COL.cantR - 40 - COL.detalle;

const C = {
  ink: rgb(0.1, 0.1, 0.1),
  gray: rgb(0.4, 0.4, 0.4),
  muted: rgb(0.58, 0.58, 0.58),
  rule: rgb(0.82, 0.82, 0.82),
  head: rgb(0.94, 0.95, 0.96),
  accent: rgb(0.02, 0.57, 0.7),
};

/** Unit prices may need more than 2 decimals to multiply back to the line amount. */
function formatUnit(unit, qty, lineBase) {
  if (round2(round2(unit) * qty) === lineBase) return formatEur(unit);
  const s = (Math.round(unit * 10000) / 10000).toFixed(4).replace(/0{1,2}$/, '');
  const [int, dec] = s.split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec} €`;
}

/**
 * Compute line + invoice amounts from IVA-inclusive unit prices.
 * @param {{concepto:string, detalle?:string, cantidad:number, precio:number}[]} lineas
 * @param {number} ivaRate percent
 */
export function computeFactura(lineas, ivaRate) {
  const rate = Number(ivaRate) || 0;
  const k = 1 + rate / 100;
  let total = 0;
  let base = 0;
  const lines = lineas.map((l) => {
    const cantidad = Number(l.cantidad) > 0 ? Number(l.cantidad) : 1;
    const lineTotal = round2(cantidad * Number(l.precio));
    const lineBase = round2(lineTotal / k);
    total = round2(total + lineTotal);
    base = round2(base + lineBase);
    return {
      concepto: String(l.concepto ?? '').trim(),
      detalle: String(l.detalle ?? '').trim(),
      cantidad,
      precio: Number(l.precio),
      lineTotal,
      lineBase,
      unitBase: lineBase / cantidad,
    };
  });
  return { lines, base, iva: round2(total - base), total, rate };
}

/** Greedy word-wrap to a max width; hard-splits words that are too long. */
function wrap(str, font, size, maxW) {
  const words = sanitize(str).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  const fits = (s) => font.widthOfTextAtSize(s, size) <= maxW;
  for (let w of words) {
    while (!fits(w)) {
      let i = w.length - 1;
      while (i > 1 && !fits(w.slice(0, i))) i--;
      if (cur) { out.push(cur); cur = ''; }
      out.push(w.slice(0, i));
      w = w.slice(i);
    }
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next)) cur = next;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/**
 * Build the factura PDF.
 * @param {object} data
 * @param {string} [data.business]  emisor name
 * @param {string} [data.subtitle]  line under the emisor name
 * @param {string} [data.nif]       emisor NIF (default FISCAL.nif)
 * @param {string} [data.address]   emisor address (default FISCAL.address)
 * @param {{nombre:string, nif:string, direccion:string}} data.cliente
 * @param {{concepto:string, detalle?:string, cantidad?:number, precio:number}[]} data.lineas
 *        precio = IVA-inclusive unit price (euros)
 * @param {number} [data.ivaRate]   IVA % (default 21)
 * @param {string} [data.fecha]     YYYY-MM-DD (default today)
 * @param {string} [data.numero]    invoice number (default F-YYYYMMDD-HHMM)
 * @param {string} [data.pago]      payment method (default Efectivo)
 * @param {string|string[]} [data.footer] footer note(s)
 * @returns {Promise<Uint8Array>}
 */
export async function buildFacturaPdf(data = {}) {
  const m = normalize(data);
  const doc = await PDFDocument.create();
  doc.setTitle(`Factura ${m.numero}`);
  doc.setProducer('MCF Soluciones');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page;
  let ty; // cursor, measured from the top of the current page
  const pages = [];

  const draw = (str, { x, size, f = font, color = C.ink, align = 'left', top }) => {
    const s = sanitize(str);
    if (!s) return;
    const w = f.widthOfTextAtSize(s, size);
    const dx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(s, { x: dx, y: PAGE_H - (top ?? ty) - size, size, font: f, color });
  };
  const hline = (y, { thickness = 0.6, color = C.rule, x1 = MX, x2 = RIGHT } = {}) => {
    page.drawLine({ start: { x: x1, y: PAGE_H - y }, end: { x: x2, y: PAGE_H - y }, thickness, color });
  };
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    ty = TOP;
  };

  newPage();

  // ---- header: emisor (left) + FACTURA block (right) ----
  const headTop = ty;
  draw(m.business, { x: MX, size: 18, f: bold });
  ty += 24;
  if (m.subtitle) { draw(m.subtitle, { x: MX, size: 9, color: C.gray }); ty += 13; }
  draw(`NIF: ${m.nif}`, { x: MX, size: 9, color: C.gray }); ty += 13;
  for (const line of wrap(m.address, font, 9, CONTENT_W / 2)) {
    draw(line, { x: MX, size: 9, color: C.gray }); ty += 13;
  }
  const leftBottom = ty;

  ty = headTop;
  draw('FACTURA', { x: RIGHT, size: 22, f: bold, color: C.accent, align: 'right' });
  ty += 30;
  const metaRow = (label, value) => {
    draw(label, { x: RIGHT - 120, size: 9, color: C.muted, align: 'right' });
    draw(value, { x: RIGHT, size: 9, f: bold, align: 'right' });
    ty += 14;
  };
  metaRow('Nº factura', m.numero);
  metaRow('Fecha', m.fechaTxt);
  ty = Math.max(ty, leftBottom) + 18;

  hline(ty);
  ty += 16;

  // ---- cliente ----
  draw('FACTURAR A', { x: MX, size: 8, color: C.muted });
  ty += 14;
  for (const line of wrap(m.cliente.nombre, bold, 11, CONTENT_W)) {
    draw(line, { x: MX, size: 11, f: bold }); ty += 15;
  }
  draw(`NIF/CIF: ${m.cliente.nif}`, { x: MX, size: 9, color: C.gray }); ty += 13;
  for (const raw of m.cliente.direccion.split('\n')) {
    for (const line of wrap(raw, font, 9, CONTENT_W)) {
      draw(line, { x: MX, size: 9, color: C.gray }); ty += 13;
    }
  }
  ty += 18;

  // ---- services table ----
  const tableHeader = () => {
    const h = 20;
    page.drawRectangle({ x: MX, y: PAGE_H - ty - h, width: CONTENT_W, height: h, color: C.head });
    const top = ty + 6.5;
    draw('CONCEPTO', { x: COL.concepto, size: 7.5, color: C.gray, top });
    draw('DETALLE', { x: COL.detalle, size: 7.5, color: C.gray, top });
    draw('CANT.', { x: COL.cantR, size: 7.5, color: C.gray, align: 'right', top });
    draw('PRECIO (sin IVA)', { x: COL.precioR, size: 7.5, color: C.gray, align: 'right', top });
    draw('IMPORTE', { x: COL.importeR, size: 7.5, color: C.gray, align: 'right', top });
    ty += h + 6;
  };
  tableHeader();

  for (const l of m.lines) {
    const cLines = wrap(l.concepto, font, 9.5, CONCEPTO_W);
    const dLines = l.detalle ? wrap(l.detalle, font, 9, DETALLE_W) : [];
    const rowH = Math.max(cLines.length, dLines.length, 1) * 13 + 8;
    if (ty + rowH > PAGE_H - BOTTOM) {
      newPage();
      tableHeader();
    }
    const top = ty;
    cLines.forEach((s, i) => draw(s, { x: COL.concepto, size: 9.5, top: top + i * 13 }));
    dLines.forEach((s, i) => draw(s, { x: COL.detalle, size: 9, color: C.gray, top: top + i * 13 + 0.5 }));
    draw(trimRate(l.cantidad), { x: COL.cantR, size: 9.5, align: 'right', top });
    draw(formatUnit(l.unitBase, l.cantidad, l.lineBase), { x: COL.precioR, size: 9.5, align: 'right', top });
    draw(formatEur(l.lineBase), { x: COL.importeR, size: 9.5, align: 'right', top });
    ty += rowH;
    hline(ty - 4);
  }

  // ---- totals (kept together on one page) ----
  const totalsH = 14 * 2 + 40 + 40;
  if (ty + totalsH > PAGE_H - BOTTOM) newPage();
  ty += 12;
  const LABEL_R = RIGHT - 110;
  const totalRow = (label, value, size = 10, f = font, color = C.gray) => {
    draw(label, { x: LABEL_R, size, f, color, align: 'right' });
    draw(value, { x: COL.importeR, size, f, color: C.ink, align: 'right' });
    ty += size + 6;
  };
  totalRow('Base imponible', formatEur(m.base));
  totalRow(`IVA (${trimRate(m.rate)}%)`, formatEur(m.iva));
  ty += 4;
  hline(ty, { thickness: 1.4, color: C.ink, x1: RIGHT - 230 });
  ty += 8;
  totalRow('TOTAL', formatEur(m.total), 14, bold, C.ink);

  ty += 14;
  draw(`Forma de pago: ${m.pago}`, { x: MX, size: 9, color: C.gray });
  ty += 13;
  for (const line of m.footer) {
    draw(line, { x: MX, size: 8.5, color: C.muted }); ty += 12;
  }

  // ---- page footer on every page ----
  pages.forEach((p, i) => {
    page = p;
    const footer = `${m.business} · NIF ${m.nif} · Factura ${m.numero}`
      + (pages.length > 1 ? ` · Página ${i + 1} de ${pages.length}` : '');
    draw(footer, { x: PAGE_W / 2, size: 7.5, color: C.muted, align: 'center', top: PAGE_H - 34 });
  });

  return doc.save();
}

// ---- input normalization ---------------------------------------------------
function normalize(data) {
  const now = new Date();
  let fecha = String(data.fecha || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    fecha = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }
  const [y, mo, d] = fecha.split('-').map(Number);

  const ivaRate = data.ivaRate === undefined || data.ivaRate === '' ? 21 : Number(data.ivaRate);
  const { lines, base, iva, total, rate } = computeFactura(data.lineas || [], ivaRate);

  const numero = String(data.numero || '').trim()
    || `F-${y}${pad2(mo)}${pad2(d)}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;

  const footerRaw = data.footer;
  const footer = Array.isArray(footerRaw)
    ? footerRaw.map(String)
    : footerRaw
      ? String(footerRaw).split('\n')
      : ['Gracias por su confianza.'];

  const cliente = data.cliente || {};
  return {
    business: String(data.business || 'MCF Lavandería').trim(),
    subtitle: data.subtitle !== undefined ? String(data.subtitle).trim() : 'Autoservicio de lavandería',
    nif: String(data.nif || FISCAL.nif).trim().replace(/^\s*(nif|cif)\s*[:.]?\s*/i, ''),
    address: String(data.address || FISCAL.address).trim(),
    cliente: {
      nombre: String(cliente.nombre || '').trim(),
      nif: String(cliente.nif || '').trim().replace(/^\s*(nif|cif)\s*[:.]?\s*/i, ''),
      direccion: String(cliente.direccion || '').trim(),
    },
    lines, base, iva, total, rate,
    fechaTxt: `${pad2(d)}/${pad2(mo)}/${y}`,
    numero,
    pago: String(data.pago || 'Efectivo').trim(),
    footer,
  };
}

export default buildFacturaPdf;
