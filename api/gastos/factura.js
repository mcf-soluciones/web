import { Readable } from 'stream';
import turso from '../_lib/turso.js';
import { getDriveService } from '../_lib/google-auth.js';
import { getOrCreateMonthFolder } from '../_lib/drive-folders.js';

const DRIVE_FOLDER_ID = '1L44fCCmEsOQW0SvxvduC6QthJlt-DC7a';

/**
 * POST /api/gastos/factura
 *   body: { id: number, file: { name, type, content: <base64> } }
 *
 * Uploads a factura PDF to Drive and stores the URL in gastos.recibo_url.
 * Used by the month table's re-attach flow (click paperclip on a row).
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const id = toInt(body.id);
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (!body.file || !body.file.content) {
      return res.status(400).json({ error: 'file.content (base64) is required' });
    }

    // Look up the gasto's month so we drop the factura into the right subfolder.
    const gastoRow = await turso.execute({
      sql: `SELECT mm, yyyy, fecha FROM gastos WHERE id = ? LIMIT 1`,
      args: [id],
    });
    if (gastoRow.rows.length === 0) return res.status(404).json({ error: 'gasto not found' });
    const g = gastoRow.rows[0];
    const yyyy = Number(g.yyyy) || (g.fecha ? Number(String(g.fecha).slice(0, 4)) : new Date().getFullYear());
    const mm = Number(g.mm) || (g.fecha ? Number(String(g.fecha).slice(5, 7)) : new Date().getMonth() + 1);

    const drive = getDriveService();
    const monthFolderId = await getOrCreateMonthFolder(drive, DRIVE_FOLDER_ID, yyyy, mm);
    const buffer = Buffer.from(body.file.content, 'base64');
    const created = await drive.files.create({
      requestBody: {
        name: body.file.name || `factura-gasto-${id}-${Date.now()}`,
        parents: [monthFolderId],
      },
      media: {
        mimeType: body.file.type || 'application/pdf',
        body: Readable.from(buffer),
      },
      fields: 'id,webViewLink',
    });
    const reciboUrl = `https://drive.google.com/file/d/${created.data.id}/view`;

    const rs = await turso.execute({
      sql: `UPDATE gastos SET recibo_url = ? WHERE id = ?`,
      args: [reciboUrl, id],
    });

    return res.status(200).json({
      success: true,
      id,
      recibo_url: reciboUrl,
      rows_changed: Number(rs.rowsAffected) || 0,
    });
  } catch (err) {
    console.error('gastos/factura error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
