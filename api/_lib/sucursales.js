/**
 * The Mexican sucursales, and what keeps them out of Spain's numbers.
 *
 * Spain's reports must never count them, and the accountant must never see them:
 *   - Sales live only in sales_detail, under MEXICO_COMPANY, and never in `sales`. So everything filtering on
 *     company = 'mcf', and everything reading `sales`, leaves them out without knowing they exist.
 *   - Gastos share the gastos table, so every read of it for Spain adds sinMexico(). A test fails if one forgets.
 *
 * Taxes were already paid in Mexico, so no IVA or Impuesto de Sociedades is ever computed on these stores.
 * Amounts are entered in euros.
 */
export const MEXICO_COMPANY = 'mcf_mx';

// `key` is sales_detail.property and must appear in `label`, which is gastos.propiedad. `hermana` is the Spanish
// store each one is added to in the monthly Resumen.
export const MEXICO = [
  { key: 'monterrey', label: '(003) Monterrey', hermana: 'usera' },
  { key: 'cdmx', label: '(004) CDMX', hermana: 'hortaleza' },
];

// Shows partners the with/without Mexico toggle.
export const MEXICO_VISIBLE = true;

// Mexican facturas go in their own Drive folder, outside the one the accountant uses. Set when the stores go live;
// until then a Mexican factura is refused rather than filed with Spain's.
export const MEXICO_DRIVE_FOLDER_ID = null;

/** The Mexican store a gastos.propiedad or sales_detail.property value names, however it is spelled, or null. */
export function tiendaMexico(propiedad) {
  const s = String(propiedad ?? '').toLowerCase();
  return MEXICO.find(t => s.includes(t.key)) ?? null;
}

export const esMexico = propiedad => tiendaMexico(propiedad) !== null;

/** The Spanish store a Mexican one is added to in the Resumen, or null for any other store. */
export const hermanaDe = property => MEXICO.find(t => t.key === property)?.hermana ?? null;

/**
 * SQL condition leaving Mexican gastos out. Rows with no propiedad stay in, which a plain NOT IN would drop.
 * Pass the table's alias if the query has one.
 */
export function sinMexico(alias = '') {
  const column = `LOWER(COALESCE(${alias ? `${alias}.` : ''}propiedad, ''))`;
  return MEXICO.map(t => `${column} NOT LIKE '%${t.key}%'`).join(' AND ');
}
