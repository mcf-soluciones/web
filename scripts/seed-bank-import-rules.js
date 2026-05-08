// Seeds bank_import_rules with a starting set derived from the May 2026 banco
// statement. Add more via SQL or a future admin UI. Idempotent: ON CONFLICT
// not needed because we do INSERT OR IGNORE on (pattern).
//
// Usage: node --env-file=.env scripts/seed-bank-import-rules.js
//
// To upgrade an existing rule, delete it first then re-run.

import turso from '../api/_lib/turso.js';

const RULES = [
  // ---- Impuestos / hacienda --------------------------------------------------
  {
    pattern: '^Recibo Tgss\\. Cotizacion 005 R\\.e\\.autonomos',
    concepto_mcf: 'Impuestos Seg. Social (N)',
    razon_social: 'TGSS',
    propiedad_override: 'Corporate',
    notes: 'Cotización autónomos mensual',
    priority: 10,
  },
  {
    pattern: 'Domiciliacion Impuesto.*Iva Autoliquidacion',
    concepto_mcf: 'IVA Neto (N)',
    razon_social: 'Hacienda',
    propiedad_override: 'Corporate',
    notes: 'IVA trimestral',
    priority: 10,
  },
  {
    pattern: 'Domiciliacion Impuesto.*Imp\\. Sociedades',
    concepto_mcf: 'Impuestos Sociedad (N)',
    razon_social: 'Hacienda',
    propiedad_override: 'Corporate',
    notes: 'Pago a cuenta IS',
    priority: 10,
  },
  {
    pattern: 'Domiciliacion Impuesto.*Irpf',
    concepto_mcf: 'Impuestos Ret IRPF Alquiler (N)',
    razon_social: 'Hacienda',
    propiedad_override: 'Corporate',
    notes: 'IRPF retenciones',
    priority: 10,
  },

  // ---- Corporate (gestor / tech / phone) -------------------------------------
  {
    pattern: '^Recibo Lexges Asesores',
    concepto_mcf: 'Gestor (J)',
    razon_social: 'Lexges Asesores SL',
    propiedad_override: 'Corporate',
    priority: 20,
  },
  {
    pattern: '^Recibo Premium Numbers',
    concepto_mcf: 'Tech (J)',
    razon_social: 'Premium Numbers SL',
    propiedad_override: 'Corporate',
    notes: 'Numeración telefónica',
    priority: 20,
  },

  // ---- Per-store fixed costs (use upload sucursal) ---------------------------
  {
    pattern: '^Recibo Vodafone Servicios',
    concepto_mcf: 'Internet (G)',
    razon_social: 'Vodafone Servicios SLU',
    nif_proveedor: 'A80907397',
    priority: 30,
  },
  {
    pattern: '^Recibo Securitas Direct',
    concepto_mcf: 'Alarma (G)',
    razon_social: 'Securitas Direct España SAU',
    priority: 30,
  },
  {
    pattern: '^Recibo Endesa Energia',
    concepto_mcf: 'Agua, Luz (E)',
    razon_social: 'Endesa Energía SA',
    priority: 30,
  },
  {
    pattern: '^Recibo Energia Xxi',
    concepto_mcf: 'Gas (E)',
    razon_social: 'Energía XXI',
    priority: 30,
  },
  {
    pattern: '^Tpv - Tasa De Descuento Mensual',
    concepto_mcf: 'Comissiones Bancarias (F)',
    razon_social: 'Banco',
    notes: 'Comisión TPV mensual',
    priority: 30,
  },

  // ---- Usera-specific (hardcoded propiedad because address is in concepto) ---
  {
    pattern: '^Transferencia A Favor De Alfonso Arauz Arauz',
    concepto_mcf: 'Alquiler (C)',
    razon_social: 'Alfonso Arauz Arauz',
    propiedad_override: 'usera',
    notes: 'Alquiler Cristo de la Victoria 110',
    priority: 15,
  },
  {
    pattern: '^Recibo Cristo De La Victoria 110',
    concepto_mcf: 'Alquiler (C)',
    razon_social: 'Comunidad Cristo Victoria 110',
    propiedad_override: 'usera',
    notes: 'Cuota de comunidad — sucursal Usera',
    priority: 15,
  },
];

async function main() {
  // Make pattern unique-ish to avoid dupes on re-run. SQLite doesn't have
  // ON CONFLICT without a unique index, so we just check first.
  const existing = await turso.execute('SELECT pattern FROM bank_import_rules');
  const have = new Set(existing.rows.map(r => r.pattern));

  let inserted = 0;
  for (const r of RULES) {
    if (have.has(r.pattern)) continue;
    await turso.execute({
      sql: `INSERT INTO bank_import_rules
              (pattern, concepto_mcf, cuenta_mcf, razon_social, nif_proveedor,
               propiedad_override, is_fiscal, notes, priority)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        r.pattern,
        r.concepto_mcf || null,
        r.cuenta_mcf || null,
        r.razon_social || null,
        r.nif_proveedor || null,
        r.propiedad_override || null,
        r.is_fiscal ?? 1,
        r.notes || null,
        r.priority ?? 100,
      ],
    });
    inserted++;
  }
  console.log(`Seeded ${inserted} rules (skipped ${RULES.length - inserted} already present).`);
}

main().catch(e => { console.error(e); process.exit(1); });
