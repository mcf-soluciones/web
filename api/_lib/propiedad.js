/**
 * Canonicalize a propiedad value to the form used in catalogo_cuentas.propiedad.
 *
 * Accepts inputs like 'usera', 'Usera', '(001) Usera', 'USERA' →
 * always returns the canonical form '(001) Usera' (etc.).
 *
 * Unknown inputs pass through unchanged so we don't silently destroy data.
 */
export function canonicalizePropiedad(p) {
  if (p == null) return p;
  const s = String(p).trim().toLowerCase();
  if (s === 'usera' || s === '(001) usera') return '(001) Usera';
  if (s === 'hortaleza' || s === '(002) hortaleza') return '(002) Hortaleza';
  if (s === 'corporate' || s === '(000) corporate') return 'Corporate';
  if (s === '(003) compra tbc') return '(003) Compra TBC';
  return p;
}
