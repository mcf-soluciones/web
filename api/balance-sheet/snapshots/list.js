import turso from '../../_lib/turso.js';

/**
 * GET /api/balance-sheet/snapshots/list
 *
 * Returns all snapshots ordered by as_of_date desc, with line counts and
 * (optionally) lines for each. To keep payloads small, lines are only
 * returned when ?include_lines=1 is passed.
 *
 *   { snapshots: [{ id, as_of_date, yyyy, mm, name, notes, mode, created_by,
 *                   created_at, line_count, lines?: [{line_code, amount}] }],
 *     anchor_date: string|null }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const includeLines = req.query.include_lines === '1' || req.query.include_lines === 'true';

    const r = await turso.execute(
      `SELECT s.id, s.as_of_date, s.yyyy, s.mm, s.name, s.notes, s.mode,
              s.created_by, s.created_at,
              (SELECT COUNT(*) FROM bs_snapshot_lines sl WHERE sl.snapshot_id = s.id) AS line_count
       FROM bs_snapshots s
       ORDER BY s.as_of_date DESC`
    );

    let linesByMap = {};
    if (includeLines && r.rows.length > 0) {
      const ids = r.rows.map(x => Number(x.id));
      const placeholders = ids.map(() => '?').join(',');
      const linesRs = await turso.execute({
        sql: `SELECT snapshot_id, line_code, amount
              FROM bs_snapshot_lines
              WHERE snapshot_id IN (${placeholders})`,
        args: ids,
      });
      for (const row of linesRs.rows) {
        const sid = Number(row.snapshot_id);
        (linesByMap[sid] ||= []).push({
          line_code: row.line_code,
          amount: Number(row.amount),
        });
      }
    }

    const snapshots = r.rows.map(row => {
      const out = {
        id: Number(row.id),
        as_of_date: row.as_of_date,
        yyyy: Number(row.yyyy),
        mm: Number(row.mm),
        name: row.name,
        notes: row.notes,
        mode: row.mode,
        created_by: row.created_by,
        created_at: row.created_at,
        line_count: Number(row.line_count),
      };
      if (includeLines) out.lines = linesByMap[Number(row.id)] || [];
      return out;
    });

    const anchorDate = snapshots.length > 0 ? snapshots[0].as_of_date : null;

    return res.status(200).json({ snapshots, anchor_date: anchorDate });
  } catch (err) {
    console.error('balance-sheet/snapshots/list error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
