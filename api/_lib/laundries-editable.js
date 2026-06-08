/**
 * Whitelist of columns the /api/laundries/update endpoint is allowed to modify.
 * Anything outside this list is rejected server-side. Stable keys (id, created_at)
 * and audit fields are intentionally absent.
 */
export const EDITABLE_FIELDS = new Set([
  'name',
  'brand',
  'address',
  'lat',
  'lng',
  'propiedad_mcf',
  'tel',
  'google_rating',
  'google_review_count',
  'google_place_id',
  'num_lavadoras',
  'num_secadoras',
  'precio_lavado_15kg',
  'precio_secado_15kg',
  'marca_maquinas',
  'estado_limpieza',
  'years_aprox',
  'clientes_estim',
  'interes_venta',
  'status2025',
  'prioridad',
  'modelo2',
  'sq_link',
  'call_notes',
  'category',
]);

const NUMERIC_REAL = new Set(['lat', 'lng', 'google_rating']);
const NUMERIC_INT = new Set([
  'google_review_count', 'num_lavadoras', 'num_secadoras', 'clientes_estim',
]);

/** Coerce an incoming value to match the column's declared type. */
export function coerce(field, value) {
  if (value === null || value === undefined || value === '') return null;
  if (field === 'propiedad_mcf') {
    if (value === true || value === 1 || value === '1' || value === 'true') return 1;
    if (value === false || value === 0 || value === '0' || value === 'false') return 0;
    return Number(value) ? 1 : 0;
  }
  if (NUMERIC_REAL.has(field)) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  if (NUMERIC_INT.has(field)) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}
