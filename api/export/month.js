import XLSX from 'xlsx';
import archiver from 'archiver';
import turso from '../_lib/turso.js';
import { getDriveService } from '../_lib/google-auth.js';

/**
 * GET /api/export/month?yyyy=2026&mm=3
 *
 * Streams a ZIP containing a tidy accounting dossier for the month:
 *
 *   mcf-YYYY-MM.xlsx
 *     ├ Ventas   — monthly totals only (property × cash/banco), no daily rows
 *     └ Gastos   — only is_fiscal = Sí, with a `factura_file` pointer that
 *                  matches the filenames inside facturas/
 *   facturas/
 *     └ gasto-<id>.pdf — one per fiscal gasto that has a recibo_url
 *
 * Each factura file is renamed strictly by the gasto `id` so the accountant
 * can match a row in the xlsx to the PDF in one glance.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const mm = toInt(req.query.mm);
    const yyyy = toInt(req.query.yyyy);
    if (!mm || !yyyy) return res.status(400).json({ error: 'mm and yyyy are required' });

    const ym = `${yyyy}-${String(mm).padStart(2, '0')}`;

    const [ventasRs, gastosRs] = await Promise.all([
      // Ventas: one row per (property × account) for the whole month.
      turso.execute({
        sql: `SELECT CASE WHEN mcf_user LIKE '%hortaleza%' THEN 'hortaleza'
                          WHEN mcf_user LIKE '%usera%'     THEN 'usera'
                          ELSE 'otra' END AS property,
                     account,
                     COALESCE(SUM(euros), 0) AS euros
              FROM sales
              WHERE substr(date_real, 1, 7) = ?
              GROUP BY property, account
              ORDER BY property, account`,
        args: [ym],
      }),
      // Gastos: only fiscal rows.
      turso.execute({
        sql: `SELECT g.id, g.fecha, g.yyyy, g.mm, g.propiedad, g.concepto_mcf, g.cuenta,
                     g.categoria_gastos_mcf, g.concepto_proveedor, g.razon_social,
                     g.nif_proveedor, g.num_factura, g.concepto_banco,
                     COALESCE(g.importe_total, g.gasto, 0) AS importe_total,
                     g.importe_iva, g.importe_irpf, g.importe_otro,
                     g.currency, g.is_fiscal, g.es_inversion,
                     g.user_name AS mcf_user, g.recibo_url, g.sheet_row_id,
                     g.created_at
              FROM gastos g
              WHERE g.yyyy = ? AND g.mm = ? AND g.is_fiscal = 1
              ORDER BY g.fecha, g.id`,
        args: [yyyy, mm],
      }),
    ]);

    // -------------------------------------------------------------------------
    // Ventas sheet — single summary block per property × account
    // -------------------------------------------------------------------------
    const ventasTotals = {};
    let ventasGrandTotal = 0;
    for (const r of ventasRs.rows) {
      const key = `${r.property}|${r.account}`;
      const v = Number(r.euros) || 0;
      ventasTotals[key] = v;
      ventasGrandTotal += v;
    }
    const ventasRows = [
      ['Mes', ym],
      [],
      ['Propiedad', 'Cuenta (cash/banco)', 'Euros'],
    ];
    const props = ['usera', 'hortaleza'];
    const accts = ['cash', 'banco'];
    const propSubtotals = {};
    for (const p of props) {
      let sub = 0;
      for (const a of accts) {
        const v = ventasTotals[`${p}|${a}`] || 0;
        ventasRows.push([p, a, v]);
        sub += v;
      }
      propSubtotals[p] = sub;
      ventasRows.push([p, 'Subtotal', sub]);
      ventasRows.push([]);
    }
    ventasRows.push(['TOTAL MCF', '', ventasGrandTotal]);

    const ventasSheet = XLSX.utils.aoa_to_sheet(ventasRows);
    ventasSheet['!cols'] = [{ wch: 14 }, { wch: 22 }, { wch: 14 }];

    // -------------------------------------------------------------------------
    // Gastos sheet — fiscal-only + factura_file column pointing at the ZIP path
    // -------------------------------------------------------------------------
    const gastosHeader = [
      'id', 'fecha', 'yyyy', 'mm', 'propiedad', 'concepto_mcf', 'cuenta',
      'categoria_gastos_mcf', 'concepto_proveedor', 'razon_social',
      'nif_proveedor', 'num_factura', 'concepto_banco',
      'importe_total', 'importe_iva', 'importe_irpf', 'importe_otro',
      'currency', 'is_fiscal', 'es_inversion', 'mcf_user', 'sheet_row_id',
      'created_at', 'factura_file', 'recibo_url',
    ];

    const gastosData = [gastosHeader];
    for (const g of gastosRs.rows) {
      const facturaFile = g.recibo_url ? `facturas/gasto-${g.id}.pdf` : '';
      gastosData.push(gastosHeader.map(h => {
        if (h === 'is_fiscal') return Number(g.is_fiscal) === 1 ? 'Sí' : 'No';
        if (h === 'factura_file') return facturaFile;
        if (h === 'recibo_url') return g.recibo_url || '';
        return g[h] == null ? '' : g[h];
      }));
    }
    const gastosSheet = XLSX.utils.aoa_to_sheet(gastosData);

    // Hyperlink columns: `factura_file` (zip-relative) + `recibo_url` (Drive)
    const facturaColIdx = gastosHeader.indexOf('factura_file');
    const urlColIdx = gastosHeader.indexOf('recibo_url');
    for (let r = 1; r < gastosData.length; r++) {
      const row = gastosData[r];
      const facName = row[facturaColIdx];
      if (facName) {
        const addr = XLSX.utils.encode_cell({ c: facturaColIdx, r });
        gastosSheet[addr] = { t: 's', v: facName, l: { Target: facName } };
      }
      const url = row[urlColIdx];
      if (url) {
        const addr = XLSX.utils.encode_cell({ c: urlColIdx, r });
        gastosSheet[addr] = { t: 's', v: 'Ver en Drive', l: { Target: String(url) } };
      }
    }
    gastosSheet['!cols'] = gastosHeader.map(h => {
      if (h === 'concepto_proveedor' || h === 'razon_social') return { wch: 28 };
      if (h === 'recibo_url' || h === 'factura_file') return { wch: 18 };
      if (h === 'categoria_gastos_mcf' || h === 'concepto_mcf') return { wch: 22 };
      return { wch: 12 };
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ventasSheet, 'Ventas');
    XLSX.utils.book_append_sheet(wb, gastosSheet, 'Gastos');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // -------------------------------------------------------------------------
    // Stream ZIP
    // -------------------------------------------------------------------------
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="mcf-${ym}.zip"`);
    res.setHeader('Cache-Control', 'no-store');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (err) => console.warn('archiver warning:', err));
    archive.on('error', (err) => {
      console.error('archiver error:', err);
      try { res.end(); } catch {}
    });
    archive.pipe(res);
    archive.append(xlsxBuf, { name: `mcf-${ym}.xlsx` });

    // Fetch every referenced factura; name strictly by gasto id.
    const drive = getDriveService();
    const missing = [];
    for (const g of gastosRs.rows) {
      if (!g.recibo_url) continue;
      const fileId = extractDriveId(g.recibo_url);
      if (!fileId) { missing.push({ id: g.id, reason: 'no_drive_id' }); continue; }
      try {
        const stream = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'stream' },
        );
        archive.append(stream.data, { name: `facturas/gasto-${g.id}.pdf` });
      } catch (e) {
        missing.push({ id: g.id, reason: e.message || 'drive_fetch_failed' });
        console.warn(`factura missing for gasto ${g.id}:`, e.message || e);
      }
    }

    // If any facturas couldn't be fetched, include a manifest so the accountant
    // can see which rows are missing attachments.
    if (missing.length > 0) {
      const manifest = [
        `Facturas no incluidas en este paquete (${ym})`,
        '',
        ...missing.map(m => `gasto-${m.id}: ${m.reason}`),
      ].join('\n');
      archive.append(Buffer.from(manifest, 'utf8'), { name: 'facturas/_faltantes.txt' });
    }

    await archive.finalize();
  } catch (err) {
    console.error('export/month error:', err);
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    try { res.end(); } catch {}
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractDriveId(url) {
  const m = String(url).match(/\/file\/d\/([^\/?]+)/) || String(url).match(/[?&]id=([^&]+)/);
  return m ? m[1] : null;
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
