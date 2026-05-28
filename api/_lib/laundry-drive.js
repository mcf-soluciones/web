import { Readable } from 'stream';
import { getDriveService } from './google-auth.js';

/**
 * Uploads a base64-encoded file to the Drive folder configured by
 * LAUNDRY_DRIVE_FOLDER_ID, used for both pin photos and arbitrary file
 * attachments (contracts, planos, etc.) tied to a laundry.
 *
 * @param {{ name?: string, type?: string, content: string }} file  base64 in `content`
 * @param {string} prefix  filename prefix injected before the original name (e.g. laundry slug)
 * @returns {Promise<{ driveUrl: string, fileId: string, fileName: string, mimeType: string }>}
 */
export async function uploadLaundryFile(file, prefix = '') {
  const folderId = process.env.LAUNDRY_DRIVE_FOLDER_ID;
  if (!folderId) {
    const err = new Error(
      'LAUNDRY_DRIVE_FOLDER_ID env var not configured. Create a Drive folder, ' +
      'share it with the gastos service account, and set the env var on Vercel.'
    );
    err.code = 'NO_FOLDER';
    throw err;
  }
  const drive = getDriveService();
  const buffer = Buffer.from(file.content, 'base64');
  const safePrefix = prefix ? sanitize(prefix) + '-' : '';
  const fileName = `${safePrefix}${Date.now()}-${sanitize(file.name || 'upload')}`;
  const mimeType = file.type || 'application/octet-stream';
  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id,webViewLink',
  });
  return {
    driveUrl: `https://drive.google.com/file/d/${created.data.id}/view`,
    fileId: created.data.id,
    fileName,
    mimeType,
  };
}

function sanitize(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}
