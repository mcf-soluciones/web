/**
 * Drive folder helpers — month-based subfoldering for facturas.
 *
 * Layout under the parent folder:
 *   <parent>/2026-05/
 *   <parent>/2026-04/
 *   ...
 *
 * Folders are created on demand. We never delete them; the parent folder is
 * the canonical "all facturas" view.
 */

/**
 * Returns the Drive folder id for the given (yyyy, mm) under `parentId`,
 * creating it if it doesn't exist. Folder name format: "YYYY-MM".
 */
export async function getOrCreateMonthFolder(drive, parentId, yyyy, mm) {
  const name = monthFolderName(yyyy, mm);
  // Look up existing
  const escaped = name.replace(/'/g, "\\'");
  const list = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escaped}' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 1,
    spaces: 'drive',
  });
  if (list.data.files && list.data.files.length > 0) {
    return list.data.files[0].id;
  }
  // Create
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return created.data.id;
}

export function monthFolderName(yyyy, mm) {
  return `${yyyy}-${String(mm).padStart(2, '0')}`;
}

/**
 * Extracts the Drive file id from any of these URL forms:
 *   https://drive.google.com/file/d/{ID}/view
 *   https://drive.google.com/file/d/{ID}/edit
 *   https://drive.google.com/open?id={ID}
 *   https://drive.google.com/uc?id={ID}
 * Returns null if the URL doesn't look like a Drive link.
 */
export function extractDriveFileId(url) {
  if (!url) return null;
  const m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/) || String(url).match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
