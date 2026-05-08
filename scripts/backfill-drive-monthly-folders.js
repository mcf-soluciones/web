// Backfills the Drive factura layout: moves each existing factura referenced by
// gastos.recibo_url into a YYYY-MM subfolder of the parent.
//
//   <parent>/2026-05/<file>
//   <parent>/2026-04/<file>
//   ...
//
// Usage:
//   node --env-file=.env scripts/backfill-drive-monthly-folders.js          # dry run
//   node --env-file=.env scripts/backfill-drive-monthly-folders.js --apply  # actually move
//
// Files the service account doesn't own (e.g. legacy uploads from
// mcf.usera@gmail.com) are skipped — drive.file scope can't move them.

import turso from '../api/_lib/turso.js';
import { getDriveService } from '../api/_lib/google-auth.js';
import { getOrCreateMonthFolder, extractDriveFileId, monthFolderName } from '../api/_lib/drive-folders.js';

const DRIVE_FOLDER_ID = '1L44fCCmEsOQW0SvxvduC6QthJlt-DC7a';
const APPLY = process.argv.includes('--apply');

async function main() {
  const drive = getDriveService();

  console.log(`Mode: ${APPLY ? 'APPLY (will move files)' : 'DRY RUN (no changes)'}`);

  // 1. Pull every gasto with a recibo_url
  const rs = await turso.execute(`
    SELECT id, fecha, mm, yyyy, recibo_url
    FROM gastos
    WHERE recibo_url IS NOT NULL AND recibo_url <> ''
  `);
  console.log(`Found ${rs.rows.length} gastos with recibo_url`);

  // 2. Cache month folder ids so we don't list/create twice
  const folderCache = new Map(); // key "YYYY-MM" → folderId

  let alreadyCorrect = 0;
  let moved = 0;
  let skipped = 0;
  let failed = 0;

  for (const g of rs.rows) {
    const fileId = extractDriveFileId(g.recibo_url);
    if (!fileId) {
      console.log(`  skip gasto ${g.id} — recibo_url is not a Drive link: ${g.recibo_url}`);
      skipped++;
      continue;
    }

    // Resolve mm/yyyy (fall back to fecha string if columns are null)
    let yyyy = Number(g.yyyy);
    let mm = Number(g.mm);
    if (!yyyy || !mm) {
      if (g.fecha) {
        yyyy = yyyy || Number(String(g.fecha).slice(0, 4));
        mm = mm || Number(String(g.fecha).slice(5, 7));
      }
    }
    if (!yyyy || !mm) {
      console.log(`  skip gasto ${g.id} — no period info`);
      skipped++;
      continue;
    }
    const targetName = monthFolderName(yyyy, mm);

    // Check current parents — if already in the right folder, skip
    let meta;
    try {
      meta = await drive.files.get({
        fileId,
        fields: 'id, name, parents, owners(emailAddress), capabilities(canMoveItemWithinDrive,canEdit)',
      });
    } catch (e) {
      console.log(`  fail  gasto ${g.id} file ${fileId} — ${e.message}`);
      failed++;
      continue;
    }
    const oldParents = meta.data.parents || [];

    // Resolve target folder
    let targetFolderId = folderCache.get(targetName);
    if (!targetFolderId) {
      if (APPLY) {
        targetFolderId = await getOrCreateMonthFolder(drive, DRIVE_FOLDER_ID, yyyy, mm);
      } else {
        // Dry run: try to find without creating
        const list = await drive.files.list({
          q: `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and name='${targetName}' and trashed=false`,
          fields: 'files(id, name)',
          pageSize: 1,
        });
        targetFolderId = list.data.files?.[0]?.id || `<would-create:${targetName}>`;
      }
      folderCache.set(targetName, targetFolderId);
    }

    if (oldParents.includes(targetFolderId)) {
      alreadyCorrect++;
      continue;
    }

    if (!APPLY) {
      console.log(`  plan  gasto ${g.id} → ${targetName}  (${meta.data.name})`);
      moved++;
      continue;
    }

    // Skip files we can't move (capabilities check)
    const caps = meta.data.capabilities || {};
    if (caps.canMoveItemWithinDrive === false || caps.canEdit === false) {
      const owner = meta.data.owners?.[0]?.emailAddress || '?';
      console.log(`  skip  gasto ${g.id} — service account lacks move capability (owner ${owner})`);
      skipped++;
      continue;
    }

    try {
      await drive.files.update({
        fileId,
        addParents: targetFolderId,
        removeParents: oldParents.join(','),
        fields: 'id, parents',
      });
      moved++;
      if (moved % 25 === 0) console.log(`  moved ${moved} so far…`);
    } catch (e) {
      console.log(`  fail  gasto ${g.id} → ${targetName} — ${e.message}`);
      failed++;
    }
  }

  console.log('---');
  console.log(`already correct: ${alreadyCorrect}`);
  console.log(`${APPLY ? 'moved' : 'would move'}:    ${moved}`);
  console.log(`skipped:         ${skipped}`);
  console.log(`failed:          ${failed}`);
  if (!APPLY) console.log('\nRe-run with --apply to actually perform the moves.');
}

main().catch(e => { console.error(e); process.exit(1); });
