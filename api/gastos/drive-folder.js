import { getDriveService } from '../_lib/google-auth.js';
import { getOrCreateMonthFolder } from '../_lib/drive-folders.js';

const DRIVE_FOLDER_ID = '1L44fCCmEsOQW0SvxvduC6QthJlt-DC7a';

/**
 * GET /api/gastos/drive-folder?mm=5&yyyy=2026
 *
 * Returns the Drive URL for the YYYY-MM subfolder under the parent facturas
 * folder. Creates the subfolder on the fly if it doesn't exist yet, so the
 * "Ir a Drive" button always lands on a real folder.
 *
 * Response: { folder_id, folder_name, url }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const mm = toInt(req.query.mm);
    const yyyy = toInt(req.query.yyyy);
    if (!mm || !yyyy) return res.status(400).json({ error: 'mm and yyyy are required' });

    const drive = getDriveService();
    const folderId = await getOrCreateMonthFolder(drive, DRIVE_FOLDER_ID, yyyy, mm);
    const folderName = `${yyyy}-${String(mm).padStart(2, '0')}`;
    return res.status(200).json({
      folder_id: folderId,
      folder_name: folderName,
      url: `https://drive.google.com/drive/folders/${folderId}`,
    });
  } catch (err) {
    console.error('gastos/drive-folder error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
