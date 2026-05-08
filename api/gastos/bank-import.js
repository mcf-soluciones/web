import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import turso from '../_lib/turso.js';

/**
 * POST /api/gastos/bank-import
 *
 * Body: { sucursal: 'usera' | 'hortaleza', file: { name, content (base64) } }
 *
 * Reads a banco "MovimientosCuenta" xlsx, applies bank_import_rules to each
 * negative-amount row, and inserts gastos + matching movements rows.
 *
 * - Positive amounts (sales liquidaciones) are skipped silently.
 * - Each row is fingerprinted as SHA1(date|importe|concepto_text) and stored
 *   in gastos.bank_movement_hash. Re-uploads are de-duplicated by the unique
 *   index — INSERT OR IGNORE returns rowsAffected=0.
 * - Rules without a propiedad_override use the upload's sucursal.
 * - When a rule supplies concepto_mcf, the cuenta is derived from
 *   catalogo_cuentas (desc, propiedad). When no rule matches, the row still
 *   inserts with cuenta=NULL so the user can classify it later in the gastos
 *   editor.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const sucursal = String(body.sucursal || '').toLowerCase();
    if (sucursal !== 'usera' && sucursal !== 'hortaleza') {
      return res.status(400).json({ error: 'sucursal must be usera or hortaleza' });
    }
    if (!body.file || !body.file.content) {
      return res.status(400).json({ error: 'file.content (base64) is required' });
    }

    const buffer = Buffer.from(body.file.content, 'base64');
    const movements = parseBbvaWorkbook(buffer);
    if (movements.length === 0) {
      return res.status(400).json({ error: 'no movements found in the workbook' });
    }

    const rules = await loadRules();

    const summary = {
      total_rows: movements.length,
      negatives_processed: 0,
      positives_skipped: 0,
      matched: 0,
      unmatched: 0,
      duplicates: 0,
      inserted_ids: [],
      sample: [],
    };

    const mcfUser = body.mcf_user || body.user || 'bank-import';

    for (const m of movements) {
      if (m.importe >= 0) {
        summary.positives_skipped++;
        continue;
      }
      summary.negatives_processed++;

      const rule = applyRules(m.concepto_text, rules);
      const propiedadShort = rule?.propiedad_override || sucursal;       // 'usera' | 'hortaleza' | 'Corporate'
      const propiedadCanonical = canonicalizePropiedad(propiedadShort);
      const conceptoMcf = rule?.concepto_mcf || null;
      const explicitCuenta = rule?.cuenta_mcf || null;

      // Resolve cuenta: prefer rule.cuenta_mcf if present, otherwise derive
      // from (concepto_mcf, propiedad) via catalogo_cuentas.
      let cuenta = explicitCuenta;
      let categoria = null;
      if (cuenta) {
        categoria = await categoriaForCuenta(cuenta);
      } else if (conceptoMcf) {
        const resolved = await resolveCuenta(conceptoMcf, propiedadCanonical);
        cuenta = resolved?.cuenta_mcf || null;
        categoria = resolved?.categoria_gastos_mcf || null;
      }

      const importeTotal = Math.abs(m.importe);
      const fecha = m.fecha; // YYYY-MM-DD
      const mm = parseInt(fecha.slice(5, 7), 10);
      const yyyy = parseInt(fecha.slice(0, 4), 10);

      const hash = sha1(`${fecha}|${importeTotal.toFixed(2)}|${m.concepto_text}`);

      const title = `Banco ${propiedadCanonical} · ${rule?.razon_social || conceptoMcf || 'Sin clasificar'} · ${fecha}`;
      const description = m.concepto_text;
      // Bank-imported gastos are always fiscal (real money out of the company account).
      const isFiscal = 1;

      // INSERT OR IGNORE on the unique bank_movement_hash index handles dupes.
      const ins = await turso.execute({
        sql: `INSERT OR IGNORE INTO gastos (
                concepto_text, user_name, concepto_mcf, currency, cuenta,
                concepto_proveedor, num_factura, nif_proveedor, razon_social,
                concepto_banco, gasto, importe_iva, importe_irpf, importe_otro,
                recibo_url, is_fiscal,
                categoria_gastos_mcf, es_inversion, fecha, mm, yyyy,
                importe_total, propiedad, bank_movement_hash
              ) VALUES (?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?, 'No', ?, ?, ?, ?, ?, ?)`,
        args: [
          title,
          mcfUser,
          conceptoMcf,
          cuenta,
          rule?.notes || null,
          null,
          rule?.nif_proveedor || null,
          rule?.razon_social || null,
          m.concepto_text,
          importeTotal,
          isFiscal,
          categoria,
          fecha,
          mm,
          yyyy,
          importeTotal,
          propiedadCanonical,
          hash,
        ],
      });

      const wasInserted = Number(ins.rowsAffected || 0) > 0;
      if (!wasInserted) {
        summary.duplicates++;
        continue;
      }

      const gastoId = Number(ins.lastInsertRowid);
      summary.inserted_ids.push(gastoId);
      if (rule) summary.matched++;
      else summary.unmatched++;

      // Mirror to movements (for Hub balances)
      await turso.execute({
        sql: `INSERT INTO movements (movement, type, account, euros, propiedad, mcf_user, date_real, description, icon)
              VALUES (?, 'gasto', 'cash', ?, ?, ?, ?, ?, '🏦')`,
        args: [title, importeTotal, propiedadCanonical, mcfUser, fecha, description],
      });

      if (summary.sample.length < 5) {
        summary.sample.push({
          fecha, importe: importeTotal,
          concepto_text: m.concepto_text,
          matched_rule: rule ? { pattern: rule.pattern, razon_social: rule.razon_social } : null,
          cuenta, propiedad: propiedadCanonical,
        });
      }
    }

    return res.status(200).json({ success: true, summary });
  } catch (err) {
    console.error('bank-import error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// =============================================================================
// Excel parser — banco "MovimientosCuenta" format
// =============================================================================

function parseBbvaWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('movimiento')) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });

  // Locate header row by scanning for "Fecha Operación".
  const headerIdx = rows.findIndex(r => Array.isArray(r) && r.some(c => typeof c === 'string' && /Fecha Operaci/i.test(c)));
  if (headerIdx < 0) throw new Error('Could not find header row ("Fecha Operación") in workbook');

  const dataRows = rows.slice(headerIdx + 1).filter(r => Array.isArray(r) && r[0] && r[2]);
  return dataRows.map(r => ({
    fecha: parseSpanishDate(String(r[0])),         // 07/05/2026 → 2026-05-07
    fecha_valor: parseSpanishDate(String(r[1] || r[0])),
    concepto_text: String(r[2]).trim(),
    importe: parseSpanishNumber(r[3]),             // -47.99 / 52.20
    saldo: parseSpanishNumber(r[5]),
    codigo: r[7] != null ? String(r[7]) : null,
    documento: r[8] != null ? String(r[8]).trim() : null,
    referencia1: r[9] != null ? String(r[9]).trim() : null,
    referencia2: r[10] != null ? String(r[10]).trim() : null,
  })).filter(m => m.fecha && Number.isFinite(m.importe));
}

function parseSpanishDate(s) {
  // "DD/MM/YYYY" → "YYYY-MM-DD"
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseSpanishNumber(v) {
  if (v == null) return NaN;
  // Bank exports as either "1,234.56" (en) or "1.234,56" (es). Both observed.
  // Strategy: if the last separator is "," with 2 trailing digits, treat as decimal.
  const s = String(v).replace(/\s/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized;
  if (lastComma > lastDot) {
    // Spanish: thousands "." decimal ","
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    // English: thousands "," decimal "."
    normalized = s.replace(/,/g, '');
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : NaN;
}

// =============================================================================
// Rule matching
// =============================================================================

async function loadRules() {
  const r = await turso.execute(
    `SELECT id, pattern, concepto_mcf, cuenta_mcf, razon_social, nif_proveedor,
            propiedad_override, is_fiscal, notes, priority
     FROM bank_import_rules
     ORDER BY priority ASC, id ASC`
  );
  return r.rows.map(row => ({ ...row, regex: new RegExp(row.pattern, 'i') }));
}

function applyRules(conceptoText, rules) {
  for (const r of rules) {
    if (r.regex.test(conceptoText)) return r;
  }
  return null;
}

// =============================================================================
// Catalogo lookups
// =============================================================================

async function resolveCuenta(conceptoMcf, propiedadCanonical) {
  const rs = await turso.execute({
    sql: `SELECT cuenta_mcf, categoria_gastos_mcf
          FROM catalogo_cuentas
          WHERE desc = ? AND propiedad = ?
          LIMIT 1`,
    args: [conceptoMcf, propiedadCanonical],
  });
  return rs.rows[0] || null;
}

async function categoriaForCuenta(cuenta) {
  const rs = await turso.execute({
    sql: `SELECT categoria_gastos_mcf FROM catalogo_cuentas WHERE cuenta_mcf = ? LIMIT 1`,
    args: [String(cuenta).trim()],
  });
  return rs.rows[0]?.categoria_gastos_mcf || null;
}

function canonicalizePropiedad(p) {
  const s = String(p || '').trim().toLowerCase();
  if (s === 'usera' || s === '(001) usera') return '(001) Usera';
  if (s === 'hortaleza' || s === '(002) hortaleza') return '(002) Hortaleza';
  if (s === 'corporate') return 'Corporate';
  return p;
}

// =============================================================================
// Misc
// =============================================================================

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
