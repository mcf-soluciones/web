/**
 * Canonicalize a propiedad value to the form used in catalogo_cuentas.propiedad.
 *
 * Matches on a keyword anywhere in the string so EVERY spelling collapses to a
 * single canonical label:
 *   'usera', 'USERA', 'Usera', 'Usera (001)', '(001) Usera' → '(001) Usera'
 *   'hortaleza', 'HORTALEZA', '(002) Hortaleza'            → '(002) Hortaleza'
 *   'corporate', '(000) Corporate'                          → 'Corporate'
 *   'monterrey', '(003) Monterrey'                          → '(003) Monterrey'
 *   'cdmx', '(004) CDMX'                                    → '(004) CDMX'
 *
 * Unknown inputs (and null/empty) pass through unchanged so we don't silently
 * destroy data.
 */
export function canonicalizePropiedad(p) {
  if (p == null) return p;
  const s = String(p).trim().toLowerCase();
  if (s === '') return p;
  if (s.includes('usera')) return '(001) Usera';
  if (s.includes('hortaleza')) return '(002) Hortaleza';
  if (s.includes('monterrey') || s.includes('(003)')) return '(003) Monterrey';
  if (s.includes('cdmx') || s.includes('(004)')) return '(004) CDMX';
  if (s.includes('corporate') || s.includes('(000)')) return 'Corporate';
  return p;
}
