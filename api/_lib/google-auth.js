import { google } from 'googleapis';

let _driveCredentials = null;
let _sheetsCredentials = null;

export function getDriveService() {
  if (!_driveCredentials) {
    _driveCredentials = JSON.parse(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON);
  }
  // Two scopes so the service account can BOTH:
  //   - drive.file     — create + manage files the app uploads (create.js, factura.js)
  //   - drive.readonly — read facturas uploaded by other identities (e.g. via the
  //                      legacy Google Form → mcf.usera@gmail.com) that are
  //                      shared with the folder. This is what unblocks
  //                      /api/export/month's ZIP attaching historical PDFs.
  const auth = new google.auth.GoogleAuth({
    credentials: _driveCredentials,
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  return google.drive({ version: 'v3', auth });
}

export function getSheetsService() {
  if (!_sheetsCredentials) {
    _sheetsCredentials = JSON.parse(process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: _sheetsCredentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}
