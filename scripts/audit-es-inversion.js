require('dotenv').config();
const { createClient } = require('@libsql/client');
const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

async function main() {
  console.log('\n=== All rows flagged es_inversion = Si ===');
  const rs = await turso.execute(`
    SELECT id, fecha, yyyy, mm,
           substr(cuenta, 1, 1) AS letter,
           cuenta, concepto_mcf, razon_social,
           categoria_gastos_mcf,
           ROUND(importe_total, 2) AS importe
    FROM gastos
    WHERE COALESCE(es_inversion, 'No') = 'Si'
    ORDER BY letter, fecha
  `);
  console.log(`Total: ${rs.rows.length} rows\n`);
  let currentLetter = null;
  let letterTotal = 0;
  let letterCount = 0;
  for (const r of rs.rows) {
    if (r.letter !== currentLetter) {
      if (currentLetter) {
        console.log(`  (${currentLetter} subtotal: ${letterCount} rows, €${letterTotal.toFixed(2)})\n`);
      }
      currentLetter = r.letter;
      letterCount = 0;
      letterTotal = 0;
      const label = letterLabel(currentLetter);
      console.log(`--- letter ${currentLetter} ${label ? '(' + label + ')' : ''} ---`);
    }
    letterCount++;
    letterTotal += Number(r.importe) || 0;
    console.log(`  id=${String(r.id).padStart(4)}  ${r.fecha}  ${String(r.cuenta||'-').padEnd(5)}  €${String(r.importe).padStart(10)}  ${String(r.concepto_mcf||'-').padEnd(28)}  ${r.razon_social || '(sin razón)'}`);
  }
  if (currentLetter) {
    console.log(`  (${currentLetter} subtotal: ${letterCount} rows, €${letterTotal.toFixed(2)})`);
  }

  // Total across all is_inversion rows
  const total = rs.rows.reduce((s, r) => s + (Number(r.importe) || 0), 0);
  console.log(`\n=== GRAND TOTAL: €${total.toFixed(2)} across ${rs.rows.length} rows ===`);

  // Also show the counts by letter
  console.log('\n=== Summary by letter ===');
  const byLetter = new Map();
  for (const r of rs.rows) {
    const k = r.letter;
    if (!byLetter.has(k)) byLetter.set(k, { n: 0, total: 0 });
    const v = byLetter.get(k);
    v.n++;
    v.total += Number(r.importe) || 0;
  }
  for (const [letter, v] of byLetter) {
    const label = letterLabel(letter) || '(?)';
    console.log(`  ${letter}  ${label.padEnd(36)}  ${v.n} row(s)  €${v.total.toFixed(2)}`);
  }
}

function letterLabel(l) {
  return {
    C: 'Alquiler',
    D: 'Financiamiento',
    E: 'Consumibles (Core)',
    F: 'Consumibles (Non-Core)',
    G: 'Fijos Otros',
    H: 'Clientes',
    I: 'Mantenimiento',
    J: 'Corporate',
    N: 'Impuestos pagados',
    O: 'Depreciación',
  }[l] || '';
}

main().catch(e => { console.error(e); process.exit(1); });
