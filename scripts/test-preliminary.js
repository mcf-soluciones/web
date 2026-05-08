require('dotenv').config();
const fs = require('fs');

async function main() {
  console.log('=== Export Mar 2026 with new scope ===');
  const mod = await import('../api/export/month.js');
  const handler = mod.default;
  const out = fs.createWriteStream('scripts/test-export.zip');
  const res = Object.assign(out, {
    _status: 200, _headers: {}, headersSent: false,
    status(s) { this._status = s; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    json(body) { console.log('fallback:', JSON.stringify(body).slice(0, 200)); out.end(); },
  });
  const req = { method: 'GET', query: { mm: '3', yyyy: '2026' } };
  await handler(req, res);
  await new Promise(r => out.on('close', r));

  const size = fs.statSync('scripts/test-export.zip').size;
  console.log(`  zip size: ${(size/1024).toFixed(1)} KB`);

  // List entries
  const { execSync } = require('child_process');
  const listing = execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [System.IO.Compression.ZipFile]::OpenRead('scripts/test-export.zip'); $z.Entries | ForEach-Object { $_.FullName + '|' + $_.Length } | Out-String"`, { encoding: 'utf8' });
  const entries = listing.split('\n').map(s => s.trim()).filter(s => s);
  console.log(`  total entries: ${entries.length}`);
  const xlsx = entries.filter(e => e.endsWith('.xlsx|' + e.split('|').pop()));
  const pdfs = entries.filter(e => e.includes('gasto-'));
  const faltantes = entries.filter(e => e.includes('_faltantes'));
  console.log(`  xlsx: ${entries.filter(e => e.includes('.xlsx')).length}`);
  console.log(`  factura PDFs: ${pdfs.length}`);
  console.log(`  manifest (_faltantes.txt): ${faltantes.length}`);
  if (pdfs.length > 0) {
    console.log('  first 5 PDFs:');
    for (const p of pdfs.slice(0, 5)) console.log(`    ${p}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
