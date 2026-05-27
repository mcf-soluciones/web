// Builds a print-friendly HTML memo summarizing the Alcorcón / Prosperidad
// acquisition analysis. Open in browser → File → Print → Save as PDF, or
// open in Word and save as .docx. No external dependencies.
import fs from 'node:fs';
import path from 'node:path';
import turso from '../api/_lib/turso.js';
import { computeProjection } from '../api/_lib/projections.js';
import baselineHandler from '../api/projections/baseline.js';

function captureHandler(h, req) {
  return new Promise((resolve, reject) => {
    const fakeRes = {
      _status: 200, _body: null, _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      status(c) { this._status = c; return this; },
      json(o) { this._body = o; resolve({ status: this._status, body: o }); },
      end() { resolve({ status: this._status, body: null }); },
    };
    Promise.resolve(h(req, fakeRes)).catch(reject);
  });
}

const baseline = (await captureHandler(baselineHandler, { method: 'GET', query: { yyyy_mm: '2026-04' }, body: null })).body;
const r = await turso.execute('SELECT id, payload FROM projections WHERE id IN (5,6,7,8)');
const saved = {};
for (const row of r.rows) saved[row.id] = JSON.parse(row.payload);

// Correct insurance (G6) to 30 €/mo per location to match MCF's real precedent
// (Usera ~30 €/mo, Hortaleza ~33 €/mo). Saved values of 40-60 €/mo were
// overstated by ~1.5-2×. Applied in-memory; saved scenarios in DB unchanged.
const G6_REAL = 30;
function fixInsurance(payload) {
  const p = JSON.parse(JSON.stringify(payload));
  for (const ns of (p.new_sucursales || [])) {
    if (!Array.isArray(ns.cost_lines)) continue;
    for (const line of ns.cost_lines) {
      if (line.cuenta === 'G6') line.monthly = G6_REAL;
    }
  }
  return p;
}
for (const id of Object.keys(saved)) saved[id] = fixInsurance(saved[id]);

const alc1Tpl = saved[7].new_sucursales[0];
const alc2Tpl = saved[7].new_sucursales[1];
const prosTpl = saved[8].new_sucursales[0];

const IVA_ELIGIBLE = new Set(['C', 'E', 'F', 'G', 'H', 'I', 'J']);
const isVar = (c) => ['E', 'F', 'H'].includes(String(c || '').charAt(0).toUpperCase());

function scaleSucursal(ns, salesFactor, variableCostFactor) {
  const out = JSON.parse(JSON.stringify(ns));
  out.annual_sales = Math.round(ns.annual_sales * salesFactor);
  for (const line of out.cost_lines) {
    const cf = isVar(line.cuenta) ? variableCostFactor : 1;
    line.monthly = Math.round(line.monthly * cf);
  }
  return out;
}

function makePayload(opts) {
  return {
    kind: 'new_sucursal',
    investment: {
      purchase_price: opts.price, down_payment_pct: opts.dpPct,
      interest_rate: opts.rate, loan_term: opts.term,
      discount_rate: 6, analysis_period: 7, terminal_value: opts.terminal ?? 15000,
      inflation_rate: 0.5, price_increase_rate: 0.2,
    },
    new_sucursales: opts.sucursales,
    existing_adjustments: [], capex_events: opts.capex || [], extra_loans: opts.loans || [],
  };
}

const sce = [
  { tag: 'E1', name: 'Alcorcón 69K @ 6.6%/6yr (guardado)', payload: saved[5] },
  { tag: 'E2', name: 'Alcorcón 59K @ 6.6%/6yr (guardado)', payload: saved[6] },
  { tag: 'E3', name: 'Alcorcón 69K @ 8.5%/7yr (guardado)', payload: saved[7] },
  { tag: 'E4', name: 'Prosperidad 65K, 85% cash (guardado)', payload: saved[8] },
  { tag: 'A1', name: 'Alcorcón 59K — 100% cash', payload: makePayload({ price: 59000, dpPct: 100, rate: 0, term: 0, sucursales: [alc1Tpl, alc2Tpl] }) },
  { tag: 'A2', name: 'Alcorcón 69K — 100% cash', payload: makePayload({ price: 69000, dpPct: 100, rate: 0, term: 0, sucursales: [alc1Tpl, alc2Tpl] }) },
  { tag: 'P1', name: 'Prosperidad 65K — 100% cash', payload: makePayload({ price: 65000, dpPct: 100, rate: 0, term: 0, sucursales: [prosTpl] }) },
  { tag: 'P2', name: 'Prosperidad 55K — 100% cash (oferta baja)', payload: makePayload({ price: 55000, dpPct: 100, rate: 0, term: 0, sucursales: [prosTpl] }) },
  { tag: 'B1', name: 'AMBAS: Alc 69K (préstamo) + Pros 65K (cash)', payload: makePayload({ price: 134000, dpPct: 65000 / 134000 * 100, rate: 8.5, term: 7, sucursales: [alc1Tpl, alc2Tpl, prosTpl] }) },
  { tag: 'B2', name: 'AMBAS: Alc 59K (préstamo) + Pros 65K (cash)', payload: makePayload({ price: 124000, dpPct: 65000 / 124000 * 100, rate: 8.5, term: 7, sucursales: [alc1Tpl, alc2Tpl, prosTpl] }) },
  { tag: 'B3', name: 'AMBAS: Alc 59K + Pros 55K (ofertas bajas)', payload: makePayload({ price: 114000, dpPct: 65000 / 114000 * 100, rate: 8.5, term: 7, sucursales: [alc1Tpl, alc2Tpl, prosTpl] }) },
  { tag: 'D1', name: 'CAÍDA −30%: Alc 69K @ 8.5%', payload: makePayload({ price: 69000, dpPct: 20, rate: 8.5, term: 7, sucursales: [scaleSucursal(alc1Tpl, 0.70, 0.85), scaleSucursal(alc2Tpl, 0.70, 0.85)] }) },
  { tag: 'D2', name: 'CAÍDA −30%: Pros 65K, 85% cash', payload: makePayload({ price: 65000, dpPct: 85, rate: 8.5, term: 7, sucursales: [scaleSucursal(prosTpl, 0.70, 0.85)] }) },
  { tag: 'D3', name: 'CAÍDA −30%: Ambas (Alc69K + Pros65K)', payload: makePayload({ price: 134000, dpPct: 65000 / 134000 * 100, rate: 8.5, term: 7, sucursales: [scaleSucursal(alc1Tpl, 0.70, 0.85), scaleSucursal(alc2Tpl, 0.70, 0.85), scaleSucursal(prosTpl, 0.70, 0.85)] }) },
];
// Improvement
const alc1B10 = { ...JSON.parse(JSON.stringify(alc1Tpl)), annual_sales: Math.round(alc1Tpl.annual_sales * 1.10) };
const alc2B10 = { ...JSON.parse(JSON.stringify(alc2Tpl)), annual_sales: Math.round(alc2Tpl.annual_sales * 1.10) };
sce.push({ tag: 'I1', name: 'Alc 69K + 8K mejora (ventas +10%)', payload: makePayload({ price: 69000, dpPct: 20, rate: 8.5, term: 7, sucursales: [alc1B10, alc2B10], capex: [{ date: '2026-10', description: 'Mejora equipo Alcorcón', amount: 8000, depreciation_years: 7 }] }) });
const alc1B05 = { ...JSON.parse(JSON.stringify(alc1Tpl)), annual_sales: Math.round(alc1Tpl.annual_sales * 1.05) };
const alc2B05 = { ...JSON.parse(JSON.stringify(alc2Tpl)), annual_sales: Math.round(alc2Tpl.annual_sales * 1.05) };
sce.push({ tag: 'I2', name: 'Alc 69K + 8K mejora (ventas +5%)', payload: makePayload({ price: 69000, dpPct: 20, rate: 8.5, term: 7, sucursales: [alc1B05, alc2B05], capex: [{ date: '2026-10', description: 'Mejora equipo Alcorcón', amount: 8000, depreciation_years: 7 }] }) });
// Personnel sensitivity
const alc1Full = JSON.parse(JSON.stringify(alc1Tpl));
alc1Full.cost_lines = alc1Full.cost_lines.map(l => l.cuenta === 'G9' ? { ...l, monthly: l.monthly + 400 } : l);
const alc2Full = JSON.parse(JSON.stringify(alc2Tpl));
alc2Full.cost_lines = alc2Full.cost_lines.map(l => l.cuenta === 'G9' ? { ...l, monthly: l.monthly + 400 } : l);
sce.push({ tag: 'S1', name: 'Alc 69K @ 8.5% — persona 100% cargada (+800/mes)', payload: makePayload({ price: 69000, dpPct: 20, rate: 8.5, term: 7, sucursales: [alc1Full, alc2Full] }) });

const fmt = (n) => (Math.round(n) || 0).toLocaleString('es-ES');
const fmtPct = (n, decimals = 0) => (n == null ? '—' : (n * 100).toFixed(decimals) + '%');

const rows = sce.map(s => {
  const result = computeProjection(baseline, s.payload);
  const im = result.investment_metrics;
  const price = s.payload.investment.purchase_price;
  const dpPct = s.payload.investment.down_payment_pct;
  const cashOut = price * dpPct / 100;
  const loan = price - cashOut;
  return {
    tag: s.tag, name: s.name, price, cashOut, loan,
    annual_op_cash: im.annual_operating_cash,
    annual_debt_svc: im.annual_loan_service,
    annual_net_cash: im.annual_cash_flow,
    npv: im.npv, irr: im.irr, payback: im.payback_period, roi: im.roi,
  };
});

const today = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>MCF Soluciones — Análisis de Inversión: Alcorcón y Prosperidad</title>
  <style>
    @page { size: A4; margin: 2cm 2cm 2.5cm 2cm; }
    body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #1a1a1a; max-width: 850px; margin: 24px auto; padding: 0 24px; }
    h1 { font-size: 22pt; color: #1f3a5f; border-bottom: 2px solid #1f3a5f; padding-bottom: 6px; margin-top: 0; }
    h2 { font-size: 14pt; color: #1f3a5f; margin-top: 28px; border-bottom: 1px solid #d0d7e2; padding-bottom: 4px; }
    h3 { font-size: 12pt; color: #2d4a72; margin-top: 18px; margin-bottom: 6px; }
    h4 { font-size: 11pt; color: #2d4a72; margin-top: 12px; margin-bottom: 4px; }
    .meta { color: #555; font-size: 9.5pt; margin-bottom: 18px; }
    .summary-box { background: #f5f8fc; border-left: 4px solid #1f3a5f; padding: 12px 16px; margin: 14px 0; }
    .warn-box { background: #fef7e0; border-left: 4px solid #c9a227; padding: 12px 16px; margin: 14px 0; }
    .ok-box { background: #e8f5ea; border-left: 4px solid #2d8a4e; padding: 12px 16px; margin: 14px 0; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0 18px; font-size: 9.5pt; }
    th, td { border: 1px solid #c5cdd9; padding: 5px 8px; text-align: left; vertical-align: top; }
    th { background: #1f3a5f; color: white; font-weight: 600; text-align: center; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: "Consolas", monospace; }
    tr.highlight td { background: #e8f5ea; font-weight: 600; }
    tr.warn td { background: #fef7e0; }
    .tag { display: inline-block; background: #e2e8f1; color: #1f3a5f; padding: 1px 6px; border-radius: 3px; font-family: Consolas, monospace; font-size: 9pt; font-weight: 600; }
    code { background: #eef1f5; padding: 1px 4px; border-radius: 2px; font-family: Consolas, monospace; font-size: 10pt; }
    .formula { display: block; margin: 6px 0; padding: 6px 10px; background: #f5f8fc; border-left: 3px solid #1f3a5f; font-family: Consolas, monospace; font-size: 10pt; }
    ul { margin: 4px 0; padding-left: 22px; }
    li { margin: 2px 0; }
    .small { font-size: 9pt; color: #666; }
    @media print {
      body { margin: 0; max-width: none; padding: 0; }
      h2 { page-break-after: avoid; }
      table { page-break-inside: avoid; }
    }
  </style>
</head>
<body>

<h1>MCF Soluciones — Análisis de Inversión</h1>
<div class="meta"><strong>Oportunidad:</strong> Compra de lavanderías en Alcorcón y/o Prosperidad &nbsp;·&nbsp; <strong>Fecha del análisis:</strong> ${today} &nbsp;·&nbsp; <strong>Período base:</strong> Abril 2026 (T12M)</div>

<div class="summary-box">
  <h3 style="margin-top:0">Resumen ejecutivo</h3>
  <p>MCF Soluciones tiene la oportunidad de adquirir <strong>dos lavanderías en Alcorcón</strong> (~80K€ de ventas anuales combinadas, maquinaria de +13 años) y <strong>una lavandería en Prosperidad</strong> (~60K€ de ventas anuales, maquinaria de 2.5 años). Disponemos de <strong>65.000 € en caja</strong> y una oferta de <strong>préstamo bancario de 100.000 € a 8.5% / 7 años</strong>.</p>
  <p><strong>Recomendación:</strong> Comprar ambas. La opción <span class="tag">B3</span> (Alcorcón a 59K + Prosperidad a 55K) maximiza el NPV (177K€) y mantiene resiliencia ante caídas de ventas. Si solo es posible una, <strong>Prosperidad es la más segura</strong> por su mejor cushion en escenarios bajistas. El análisis ya incorpora IVA (cobrado y deducible al 21%) e Impuesto Sociedades (N8, estimado al 20%).</p>
</div>

<h2>1. Situación y supuestos</h2>

<h3>Caja y financiamiento</h3>
<ul>
  <li><strong>Caja disponible:</strong> 65.000 €</li>
  <li><strong>Préstamo bancario ofrecido:</strong> 100.000 € · 8.5% interés anual · 7 años</li>
  <li><strong>Preferencia:</strong> Minimizar deuda, pero usable cuando habilita una operación rentable.</li>
</ul>

<h3>Las lavanderías</h3>
<ul>
  <li><strong>Alcorcón (2 locales):</strong> Ventas combinadas ~80K€/año (Local 1: 41.056€, Local 2: 40.715€). Maquinaria de más de 13 años. Requiere contratar una persona nueva (~1.600€/mes) para limpieza/operación, que puede compartirse con otras sucursales. Potencial de mejora con 8K€ adicionales de inversión, con incremento de ventas estimado del 5–15%. Estacionalidad: pico Nov–Feb, valle May–Oct.</li>
  <li><strong>Prosperidad:</strong> Ventas ~60K€/año. Maquinaria de 2.5 años (depreciable). No requiere contratar persona nueva. Estacionalidad: pico Nov–Feb más marcado.</li>
</ul>

<h3>Heurística de precio (basada en histórico MCF)</h3>
<ul>
  <li>Rango típico de oferta: <strong>0.6× – 1.5× ventas anuales</strong>.</li>
  <li>Maquinaria más antigua → extremo bajo del rango (más riesgo de capex futuro).</li>
  <li>Alcorcón (+13 años): 49–65K (0.6–0.8× ventas)</li>
  <li>Prosperidad (2.5 años): 60–79K (1.0–1.3× ventas)</li>
</ul>

<h3>Ajuste de seguros (G6)</h3>
<p>Los escenarios originalmente cargaban entre 40 y 60 €/mes de seguro por local nuevo (cuenta G6). Al cruzarlo con el histórico real de MCF (Usera ~30 €/mes equivalente, Hortaleza ~33 €/mes equivalente, ambos con pago anual a GES Seguros), detectamos que estaba sobrestimado. <strong>Este informe usa 30 €/mes por local</strong>, alineado con el precedente real. El impacto en NPV es modesto (+1.3K a +3K€ por escenario) y no cambia el ranking, pero afina las cifras hacia la realidad operativa.</p>

<h2>2. Metodología y tratamiento fiscal</h2>

<p>Las cifras de este análisis están <strong>después de impuestos</strong>. El motor de proyecciones aplica el mismo tratamiento fiscal que el P&amp;L oficial de MCF para que los flujos de caja sean realistas y comparables.</p>

<h3>Tratamiento del IVA (21%)</h3>
<ul>
  <li><strong>IVA Cobrado:</strong> Se descuenta automáticamente de los ingresos. Las cifras de ingresos en este informe son <strong>netas de IVA</strong>.</li>
  <li><strong>IVA Deducible:</strong> Se descuenta de los gastos operativos en cuentas C, E, F, G, H, I, J (alquiler, consumibles, fijos, clientes, mantenimiento, corporate). La cuenta D (intereses financieros) está exenta.</li>
  <li><strong>IVA Neto a AEAT:</strong> La diferencia (IVA cobrado − IVA deducible) ya está incorporada al trabajar con valores netos en ambos lados.</li>
</ul>

<h3>Impuesto Sociedades (N8, estimado)</h3>
<span class="formula">N8 mensual = 20% × max(0, EBITDA − Depreciación)</span>
<p>Se calcula mes a mes y se acumula al año. Los intereses financieros (cuenta D) <strong>no</strong> se deducen de la base imponible en este modelo (criterio conservador, alineado con el P&amp;L principal).</p>

<h3>Depreciación e intereses</h3>
<ul>
  <li><strong>Depreciación:</strong> Reduce la base imponible (escudo fiscal) pero <strong>no es flujo de caja</strong>. Se mantiene en P&amp;L como gasto deducible y se excluye del cash flow operativo.</li>
  <li><strong>Intereses (D):</strong> Sí son flujo de caja real. Aparecen como gasto en P&amp;L y como salida en el servicio de deuda (NPV/IRR). En este modelo no reciben escudo fiscal.</li>
</ul>

<h3>Métricas de inversión</h3>
<span class="formula">Cash<sub>anual</sub> = (Ingresos − Gastos opex)<sub>netos IVA</sub> − N8<sub>marginal</sub> − (Principal + Interés)</span>
<p>El N8 marginal = N8 proyectado − N8 baseline. Es el aumento de IS que las nuevas sucursales aportan al consolidado MCF.</p>

<h3>Limitaciones</h3>
<ul>
  <li>No se modela retención de IRPF en alquileres (N5, pass-through).</li>
  <li>No se aplican bonificaciones de IS para empresas de reducida dimensión.</li>
  <li>Asume que MCF está en posición fiscal positiva: si el baseline EBITDA−Depreciación es negativo, el N8 marginal absorbe primero esa pérdida antes de tributar.</li>
  <li>El motor proyecta 12 meses operativos completos por sucursal desde su fecha de inicio. No prorratea año 1 parcial.</li>
</ul>

<h2>3. Resultados de los escenarios</h2>

<p>Todos los importes en € · NPV calculado a 7 años con tasa de descuento del 6% y valor terminal de 15.000 €.</p>

<table>
  <thead>
    <tr>
      <th>Tag</th><th>Escenario</th>
      <th>Precio</th><th>Cash<br>Out</th><th>Préstamo</th>
      <th>Cash Op<br>Anual</th><th>Servicio<br>Deuda</th><th>Cash Neto<br>Anual</th>
      <th>NPV<br>(7 años)</th><th>IRR</th><th>Payback<br>(años)</th>
    </tr>
  </thead>
  <tbody>
    ${rows.map(r => {
      const isHighlight = ['B2', 'B3'].includes(r.tag);
      const isWarn = ['D1', 'D3', 'S1'].includes(r.tag);
      const cls = isHighlight ? 'highlight' : isWarn ? 'warn' : '';
      return `<tr class="${cls}">
        <td><span class="tag">${r.tag}</span></td>
        <td>${r.name}</td>
        <td class="num">${fmt(r.price)}</td>
        <td class="num">${fmt(r.cashOut)}</td>
        <td class="num">${fmt(r.loan)}</td>
        <td class="num">${fmt(r.annual_op_cash)}</td>
        <td class="num">${fmt(r.annual_debt_svc)}</td>
        <td class="num"><strong>${fmt(r.annual_net_cash)}</strong></td>
        <td class="num"><strong>${fmt(r.npv)}</strong></td>
        <td class="num">${fmtPct(r.irr, 0)}</td>
        <td class="num">${isFinite(r.payback) ? r.payback.toFixed(2) : '∞'}</td>
      </tr>`;
    }).join('\n    ')}
  </tbody>
</table>

<p class="small"><strong>Leyenda:</strong> <span class="tag">E*</span> escenarios guardados en el sistema; <span class="tag">A*/P*</span> compra individual all-cash; <span class="tag">B*</span> ambas lavanderías; <span class="tag">D*</span> caída de ventas −30% con ajuste de costos variables; <span class="tag">I*</span> Alcorcón con 8K€ adicionales de mejora; <span class="tag">S1</span> sensibilidad por costo de persona completo. Filas verdes: mejores escenarios. Filas amarillas: escenarios con margen ajustado.</p>

<h2>4. Respuestas a las 5 preguntas estratégicas</h2>

<h3>1. ¿Comprar solo Alcorcón, solo Prosperidad, o ambas?</h3>
<p><strong>Ambas.</strong> El escenario <span class="tag">B3</span> (Alcorcón 59K + Prosperidad 55K) tiene NPV de 177K€ con cash neto anual de 41.6K€. Comprar solo una alcanza como máximo 95–96K€ de NPV. La diferencia (~80K€ de NPV adicional) más que justifica el préstamo necesario.</p>
<p>Si solo es viable una, <strong>Prosperidad es la mejor opción</strong> en términos de riesgo ajustado: maquinaria nueva (menor capex futuro), no requiere persona adicional, y mejor resiliencia en escenarios bajistas.</p>

<h3>2. ¿Cómo financiar la compra?</h3>
<ul>
  <li><strong>Comprar ambas requiere uso parcial del préstamo:</strong> Entre 49K€ (B3) y 69K€ (B1) — siempre dentro de los 100K€ disponibles.</li>
  <li><strong>Dirigir la deuda a Alcorcón, cash a Prosperidad:</strong> Prosperidad es el activo más seguro, conviene tenerlo libre de cargas. Alcorcón soporta mejor el apalancamiento porque puede ofrecerse como garantía si algo va mal.</li>
  <li><strong>La tasa bancaria de 8.5% vs 6.6%</strong> apenas mueve el NPV (~4K€ de diferencia, comparando <span class="tag">E1</span> vs <span class="tag">E3</span>). No vale la pena gastar capital negociador buscando la tasa más baja — concentrarse en negociar el precio de compra.</li>
</ul>

<h3>3. ¿Qué pasa si las ventas caen −30%?</h3>
<div class="warn-box">
  <p><strong>Solo Alcorcón en caída (<span class="tag">D1</span>):</strong> 800€ de cash neto anual, NPV 580€. Está al borde de la insolvencia operativa — cualquier reparación inesperada lo lleva a pérdida.</p>
  <p><strong>Solo Prosperidad en caída (<span class="tag">D2</span>):</strong> 12.2K€ de cash neto anual, NPV 23K€. Cómodamente positivo. Maquinaria nueva + menor proporción de costos fijos + deuda mínima = resiliente.</p>
  <p><strong>Ambas en caída (<span class="tag">D3</span>):</strong> 12.1K€ de cash neto, NPV 13K€. Las dos sucursales se compensan parcialmente — Prosperidad sostiene a Alcorcón. Sobrevivible pero con margen ajustado.</p>
</div>
<p><strong>Implicación:</strong> Comprar solo Alcorcón es la opción más frágil. Comprar ambas reparte el riesgo y depende de Prosperidad para amortiguar la volatilidad de Alcorcón.</p>

<h3>4. ¿Hacer la inversión adicional de 8K€ en Alcorcón?</h3>
<div class="ok-box">
  <p><strong>Sí, hacerla.</strong> Incluso con un incremento de ventas conservador del 5% (<span class="tag">I2</span>), el NPV añadido sobre el escenario base <span class="tag">E3</span> es de 15K€ (retorno 1.9× sobre 8K€). Con incremento del 10% (<span class="tag">I1</span>), el NPV añadido es de 30K€ (retorno 3.75×).</p>
</div>

<h3>5. ¿Qué precio ofrecer a los vendedores?</h3>
<table>
  <thead>
    <tr><th>Propiedad</th><th>Ventas anuales</th><th>Rango (0.6–1.5×)</th><th>Oferta inicial</th><th>Punto de retirada</th></tr>
  </thead>
  <tbody>
    <tr><td>Alcorcón (2 locales)</td><td class="num">81.771</td><td class="num">49K – 123K</td><td class="num"><strong>55.000</strong></td><td class="num">60.000</td></tr>
    <tr><td>Prosperidad</td><td class="num">60.715</td><td class="num">36K – 91K</td><td class="num"><strong>55.000</strong></td><td class="num">65.000</td></tr>
  </tbody>
</table>
<p>Cada 10K€ menos en el precio de compra equivale a aproximadamente +10K€ de NPV — relación prácticamente euro-por-euro. Es la palanca más eficiente del análisis.</p>

<h2>5. Riesgos y consideraciones clave</h2>

<div class="warn-box">
  <h3 style="margin-top:0">⚠ Riesgo de costo de personal (mayor sensibilidad del modelo)</h3>
  <p>Los escenarios actuales asignan <strong>800€/mes</strong> a Alcorcón en concepto de limpieza/personal (cuenta G9), correspondiente a un prorrateo de la persona nueva (1.600€/mes totales). Si la persona dedica el 100% de su tiempo a Alcorcón (sin trabajo real en otras sucursales que justifique los otros 800€/mes), el costo incremental sube a 1.600€/mes y el NPV cae materialmente.</p>
  <p><strong>Escenario <span class="tag">S1</span></strong> (persona 100% cargada): NPV cae de 82K€ a 47K€ (−43%) para Alcorcón solo. En el caso de comprar ambas, el impacto sería aproximadamente 50K€ menor.</p>
  <p><strong>Acción requerida:</strong> Antes de firmar, confirmar exactamente qué porcentaje del tiempo de la persona nueva queda destinado a Alcorcón vs. otras sucursales. Si supera el 50%, el precio de oferta de Alcorcón debe reducirse 10–15K€ para compensar.</p>
</div>

<h3>Otros riesgos</h3>
<ul>
  <li><strong>Capex futuro en Alcorcón:</strong> Maquinaria de +13 años aumenta probabilidad de reemplazos en los próximos 3-5 años. Reservar al menos 10–15K€ para esto en el plan financiero.</li>
  <li><strong>Sensibilidad a la tasa de descuento:</strong> El NPV se calcula con 6%. Si las tasas de mercado suben (oportunidad de coste mayor), todos los NPV se reducen, pero el orden relativo entre escenarios no cambia.</li>
  <li><strong>Pagos de IVA y N8:</strong> El modelo asume regularidad. En la realidad hay liquidaciones trimestrales que pueden generar fluctuaciones de caja, no impactando la rentabilidad pero sí el calendario de liquidez.</li>
  <li><strong>Calidad de la información del vendedor:</strong> Las ventas estimadas (~80K Alcorcón, ~60K Prosperidad) deberían contrastarse con extractos bancarios reales antes de cerrar.</li>
</ul>

<h2>6. Plan de acción recomendado</h2>

<ol>
  <li><strong>Negociar Alcorcón en 55K€ (ambos locales).</strong> Walk-away en 60K€.</li>
  <li><strong>Negociar Prosperidad en 55K€.</strong> Aceptable hasta 60K€, walk-away en 65K€.</li>
  <li><strong>Estructurar el financiamiento:</strong> Préstamo bancario para Alcorcón (49–59K€ según precio final), 100% cash para Prosperidad.</li>
  <li><strong>Planificar el capex de mejora de 8K€</strong> en Alcorcón dentro del año 1.</li>
  <li><strong>Validar la atribución de costes de personal</strong> antes del cierre. Esta es la mayor incógnita del análisis.</li>
  <li><strong>Reservar 10–15K€</strong> adicionales en caja para capex no planificado en Alcorcón (mantenimiento de maquinaria antigua).</li>
</ol>

<h3>Resumen de uso de capital (plan recomendado, escenario B3)</h3>
<table>
  <thead>
    <tr><th>Concepto</th><th>Monto</th><th>Fuente</th></tr>
  </thead>
  <tbody>
    <tr><td>Compra Alcorcón (2 locales)</td><td class="num">55.000</td><td>Préstamo bancario (8.5% / 7 años)</td></tr>
    <tr><td>Compra Prosperidad</td><td class="num">55.000</td><td>Caja MCF</td></tr>
    <tr><td>Mejora equipo Alcorcón</td><td class="num">8.000</td><td>Caja MCF</td></tr>
    <tr><td>Reserva capex (recomendada)</td><td class="num">10.000</td><td>Caja MCF</td></tr>
    <tr><td><strong>Total caja</strong></td><td class="num"><strong>73.000</strong></td><td>(supera 65K disponibles → ajustar reserva o ampliar préstamo)</td></tr>
    <tr><td><strong>Total préstamo</strong></td><td class="num"><strong>55.000</strong></td><td>(de 100K disponibles)</td></tr>
  </tbody>
</table>
<p class="small"><em>Nota: si las ofertas se cierran a precios más bajos, queda margen para la reserva de capex sin tocar el préstamo. Si se cierran a precios más altos, se puede ampliar el préstamo (hasta 100K) en lugar de reducir la reserva.</em></p>

<hr style="border: none; border-top: 1px solid #d0d7e2; margin-top: 30px;">
<p class="small" style="text-align:center; color:#888;">Documento generado a partir del calculador de proyecciones MCF Soluciones · ${today}</p>

</body>
</html>`;

const outPath = path.resolve('mcf-analisis-inversion.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log('Wrote: ' + outPath);
console.log('Open in browser → File → Print → "Save as PDF" for PDF.');
console.log('Or open in Word and Save As → .docx');

process.exit(0);
