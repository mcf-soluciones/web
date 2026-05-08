/**
 * Whitelist of columns the /api/gastos/update and /api/gastos/bulk endpoints
 * are allowed to modify. Anything outside this list is rejected server-side.
 *
 * Keep this conservative — id / sheet_row_id / created_at are intentionally
 * absent so edits can't rewrite stable keys.
 */
export const EDITABLE_FIELDS = new Set([
  'fecha',          // ISO YYYY-MM-DD; we also re-derive mm/yyyy when it changes
  'propiedad',
  'concepto_mcf',
  'cuenta',         // triggers re-derive of categoria_gastos_mcf
  'concepto_proveedor',
  'razon_social',
  'nif_proveedor',
  'num_factura',
  'importe_total',
  'importe_iva',
  'importe_irpf',
  'importe_otro',
  'currency',
  'is_fiscal',
  'es_inversion',
  'categoria_gastos_mcf',
  'user_name',
  'concepto_banco',
  'recibo_url',
]);

/** Fields safe to modify in a single bulk operation (N rows share one value). */
export const BULK_FIELDS = new Set([
  'categoria_gastos_mcf',
  'cuenta',
  'concepto_mcf',
  'propiedad',
  'es_inversion',
  'is_fiscal',
  'user_name',
  'currency',
]);

/** Coerce an incoming value to match the column's declared type. */
export function coerce(field, value) {
  if (value === null || value === undefined) return null;
  const numeric = ['importe_total', 'importe_iva', 'importe_irpf', 'importe_otro'];
  if (numeric.includes(field)) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  if (field === 'is_fiscal') {
    if (value === true || value === 1 || value === '1' || value === 'true') return 1;
    if (value === false || value === 0 || value === '0' || value === 'false') return 0;
    return Number(value) ? 1 : 0;
  }
  if (field === 'es_inversion') {
    const s = String(value).trim().toLowerCase();
    return (s === 'si' || s === 'sí' || s === 'yes' || s === 'true' || s === '1') ? 'Si' : 'No';
  }
  // All other fields are strings — trim and return; empty string becomes null.
  const s = String(value).trim();
  return s === '' ? null : s;
}
