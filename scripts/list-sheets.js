require('dotenv').config();
const { google } = require('googleapis');

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const id = '1brwERISPLIXih8nbPbHDpUHU0yBWdt8S6wvNYqs5mN4';

  // Fetch row 127 (Neto) formula for each month in both 2025 and 2026 sheets
  for (const tab of ['2025_P&L_conjunto_mes', '2026_P&L_conjunto_mes']) {
    const f = await sheets.spreadsheets.get({
      spreadsheetId: id,
      ranges: [`${tab}!D127:O127`],
      includeGridData: true,
      fields: 'sheets.data.rowData.values(formattedValue,userEnteredValue)',
    });
    const cells = f.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || [];
    console.log(`\n=== ${tab} P127 (Neto) formulas ===`);
    const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    cells.forEach((cell, i) => {
      const formula = cell?.userEnteredValue?.formulaValue;
      const val = cell?.formattedValue;
      console.log(`  ${months[i]}: val=${val}  formula=${formula || '(literal)'}`);
    });
  }
}
main().catch(err => { console.error(err); process.exit(1); });
