import turso from '../_lib/turso.js';
import { uploadLaundryFile } from '../_lib/laundry-drive.js';

/**
 * POST /api/laundries/photo
 *   body: { laundry_id, file: { name, type, content (base64) }, caption?, uploaded_by? }
 *
 * Uploads one image to the laundry Drive folder, then inserts a row into
 * laundry_photos. Requires LAUNDRY_DRIVE_FOLDER_ID env var (folder must be
 * shared with the gastos service account).
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const laundryId = toInt(body.laundry_id);
    const file = body.file;
    if (!laundryId) return res.status(400).json({ error: 'laundry_id is required' });
    if (!file || !file.content) return res.status(400).json({ error: 'file.content (base64) is required' });

    // Verify the laundry exists before uploading — avoids orphan Drive files
    // if the client sent a stale id.
    const check = await turso.execute({
      sql: `SELECT id, name FROM laundries WHERE id = ? LIMIT 1`,
      args: [laundryId],
    });
    if (check.rows.length === 0) return res.status(404).json({ error: 'laundry not found' });
    const laundryName = check.rows[0].name || `laundry-${laundryId}`;

    let uploaded;
    try {
      uploaded = await uploadLaundryFile(file, laundryName);
    } catch (e) {
      if (e.code === 'NO_FOLDER') return res.status(500).json({ error: e.message });
      throw e;
    }

    const insert = await turso.execute({
      sql: `INSERT INTO laundry_photos (laundry_id, drive_url, caption, uploaded_by)
            VALUES (?, ?, ?, ?)`,
      args: [
        laundryId,
        uploaded.driveUrl,
        (body.caption || '').toString().trim() || null,
        (body.uploaded_by || '').toString().trim() || null,
      ],
    });

    return res.status(200).json({
      success: true,
      id: Number(insert.lastInsertRowid),
      drive_url: uploaded.driveUrl,
    });
  } catch (err) {
    console.error('laundries/photo error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
