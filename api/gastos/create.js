import { Readable } from 'stream';
import turso from '../_lib/turso.js';
import { getDriveService } from '../_lib/google-auth.js';
import { getOrCreateMonthFolder } from '../_lib/drive-folders.js';
import { canonicalizePropiedad } from '../_lib/propiedad.js';

const DRIVE_FOLDER_ID = '1L44fCCmEsOQW0SvxvduC6QthJlt-DC7a';

/**
 * POST /api/gastos/create
 *
 * Creates one gasto row (Turso) + one matching movements row (for Hub balances).
 * Optionally uploads a base64 factura PDF to Drive and stores the URL.
 *
 * This is the ONE write path for gastos going forward. Replaces:
 *   - /api/gastos       (legacy Drive upload)
 *   - /api/gastos-sheets (legacy Sheet mirror)
 *   - /api/movimientos   (gasto branch — now handled here)
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { fecha, mm, yyyy } = resolvePeriod(body);
    // Always store propiedad in canonical form ("(001) Usera", etc.) so reports
    // and the gastos table show consistent values regardless of which client
    // (simple form, detailed modal, bank import) submitted.
    const propiedad = canonicalizePropiedad(body.propiedad) || null;
    const conceptoMcf = body.concepto_mcf || null;

    // Cuenta resolution:
    //   1. Use the explicit value if the client supplied one (detailed modal).
    //   2. Otherwise derive from (concepto_mcf, propiedad) — this is what the
    //      simple gastos.html form needs since it never sends cuenta.
    let cuenta = body.cuenta || body.cuenta_mcf || null;
    let categoria = null;
    if (cuenta) {
      categoria = await resolveCategoria(cuenta);
    } else if (conceptoMcf && propiedad) {
      const resolved = await resolveCuentaFromConcept(conceptoMcf, propiedad);
      if (resolved) {
        cuenta = resolved.cuenta_mcf;
        categoria = resolved.categoria_gastos_mcf;
      }
    }

    // Optional factura upload to Drive (into a YYYY-MM subfolder of the parent).
    let reciboUrl = body.recibo_url || null;
    if (body.file && body.file.content) {
      reciboUrl = await uploadFacturaToDrive(body.file, yyyy, mm);
    }

    const importeTotal = parseFloat(body.importe_total ?? body.gasto) || 0;
    const title = `Gasto ${propiedad || '-'} - ${conceptoMcf || '-'} - ${fecha || ''}`;
    // Letter Z / category "Adquisición o Inversiones" is always capex — force
    // es_inversion='Si' so these never leak into the P&L even if the user
    // forgot to tick the checkbox.
    const isCapexCategory = (categoria || '').trim() === 'Adquisición o Inversiones'
      || (String(cuenta || '').toUpperCase().charAt(0) === 'Z');
    const esInversion = isCapexCategory ? 'Si' : normaliseYesNo(body.es_inversion, 'No');
    const isFiscal = body.is_fiscal === true || body.is_fiscal === 'true' || body.is_fiscal === 1 ? 1 : 0;
    const mcfUser = body.mcf_user || body.user_name || body.user || null;

    const insert = await turso.execute({
      sql: `INSERT INTO gastos (
              concepto_text, user_name, concepto_mcf, currency, cuenta,
              concepto_proveedor, num_factura, nif_proveedor, razon_social,
              concepto_banco, gasto, importe_iva, importe_irpf, importe_otro,
              recibo_url, is_fiscal,
              categoria_gastos_mcf, es_inversion, fecha, mm, yyyy,
              importe_total, propiedad
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        title,
        mcfUser,
        conceptoMcf,
        body.currency || 'EUR',
        cuenta,
        body.concepto_proveedor || null,
        body.num_factura || null,
        body.nif_proveedor || body.nif || null,
        body.razon_social || null,
        body.concepto_banco || null,
        importeTotal,
        parseFloat(body.importe_iva) || 0,
        parseFloat(body.importe_irpf) || 0,
        parseFloat(body.importe_otros ?? body.importe_otro) || 0,
        reciboUrl,
        isFiscal,
        categoria,
        esInversion,
        fecha,
        mm,
        yyyy,
        importeTotal,
        propiedad,
      ],
    });

    const gastoId = Number(insert.lastInsertRowid);

    // Create matching movements row so Hub user balances stay correct.
    let movementId = null;
    if (mcfUser) {
      const movTitle = title;
      const movDescription = `Concepto: ${body.concepto_proveedor || conceptoMcf || '-'}\nImporte: ${importeTotal} ${body.currency || 'EUR'}\nFiscal: ${isFiscal ? 'Si' : 'No'}\nInversion: ${esInversion}`;
      const mov = await turso.execute({
        sql: `INSERT INTO movements (movement, type, account, euros, propiedad, mcf_user, date_real, description, icon)
              VALUES (?, 'gasto', 'cash', ?, ?, ?, ?, ?, '💸')`,
        args: [movTitle, importeTotal, propiedad, mcfUser, fecha, movDescription],
      });
      movementId = Number(mov.lastInsertRowid);
    }

    return res.status(200).json({
      success: true,
      id: gastoId,
      movement_id: movementId,
      recibo_url: reciboUrl,
      categoria_gastos_mcf: categoria,
    });
  } catch (err) {
    console.error('gastos/create error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function uploadFacturaToDrive(file, yyyy, mm) {
  const drive = getDriveService();
  const monthFolderId = await getOrCreateMonthFolder(drive, DRIVE_FOLDER_ID, yyyy, mm);
  const buffer = Buffer.from(file.content, 'base64');
  const created = await drive.files.create({
    requestBody: { name: file.name || `factura-${Date.now()}`, parents: [monthFolderId] },
    media: { mimeType: file.type || 'application/pdf', body: Readable.from(buffer) },
    fields: 'id,webViewLink',
  });
  return `https://drive.google.com/file/d/${created.data.id}/view`;
}

async function resolveCategoria(cuenta) {
  try {
    const r = await turso.execute({
      sql: `SELECT categoria_gastos_mcf FROM catalogo_cuentas WHERE cuenta_mcf = ? LIMIT 1`,
      args: [String(cuenta).trim()],
    });
    return r.rows[0]?.categoria_gastos_mcf || null;
  } catch {
    return null;
  }
}

// Look up cuenta_mcf from (desc, propiedad) — same pair the resolve-cuenta
// endpoint uses. Falls back to a case-insensitive propiedad match if the exact
// canonical form doesn't hit (e.g. legacy rows stored as "Usera").
async function resolveCuentaFromConcept(conceptoMcf, propiedad) {
  try {
    let r = await turso.execute({
      sql: `SELECT cuenta_mcf, categoria_gastos_mcf
            FROM catalogo_cuentas
            WHERE desc = ? AND propiedad = ?
            LIMIT 1`,
      args: [conceptoMcf, propiedad],
    });
    if (r.rows.length === 0) {
      r = await turso.execute({
        sql: `SELECT cuenta_mcf, categoria_gastos_mcf
              FROM catalogo_cuentas
              WHERE desc = ? AND LOWER(propiedad) LIKE ?
              LIMIT 1`,
        args: [conceptoMcf, `%${String(propiedad).toLowerCase()}%`],
      });
    }
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

function resolvePeriod(body) {
  const raw = body.fecha || body.date || new Date().toISOString();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    const now = new Date();
    return {
      fecha: ymd(now),
      mm: now.getMonth() + 1,
      yyyy: now.getFullYear(),
    };
  }
  return { fecha: ymd(d), mm: d.getMonth() + 1, yyyy: d.getFullYear() };
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normaliseYesNo(v, fallback = 'No') {
  if (v === true || v === 1 || v === 'Si' || v === 'si' || v === 'true') return 'Si';
  if (v === false || v === 0 || v === 'No' || v === 'no' || v === 'false') return 'No';
  return fallback;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
