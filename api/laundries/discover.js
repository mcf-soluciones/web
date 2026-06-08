import turso from '../_lib/turso.js';
import { ANCHORS, CATEGORIES, RADIUS_M } from '../_lib/discover-config.js';

/**
 * POST /api/laundries/discover
 *   body: { anchorIndex: number, categories?: string[] }
 *
 * Runs ONE anchor of the Google Places sweep (the frontend loops the 30 anchors
 * so each request stays short). For the anchor, searches each selected
 * category's keywords via the legacy Places Nearby Search, dedupes results
 * against existing rows (by google_place_id) and within the request, and
 * inserts new businesses with their category and source='google'.
 *
 * Requires env GOOGLE_PLACES_API_KEY (legacy Places API enabled).
 *
 * Returns: { anchor, found, inserted, skippedExisting, byCategory }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_PLACES_API_KEY not configured' });

  try {
    const body = req.body || {};
    const idx = toInt(body.anchorIndex);
    if (idx == null || idx < 0 || idx >= ANCHORS.length) {
      return res.status(400).json({ error: `anchorIndex must be 0..${ANCHORS.length - 1}`, total: ANCHORS.length });
    }
    const wantCats = Array.isArray(body.categories) && body.categories.length
      ? body.categories.filter(c => CATEGORIES[c])
      : Object.keys(CATEGORIES);

    const [lat, lng, label] = ANCHORS[idx];

    // Existing place_ids — dedupe target. Small table, one cheap scan.
    const existing = await turso.execute('SELECT google_place_id FROM laundries WHERE google_place_id IS NOT NULL');
    const known = new Set(existing.rows.map(r => r.google_place_id));

    const byCategory = {};
    let found = 0, inserted = 0, skippedExisting = 0;
    const insertedHere = new Set();

    for (const cat of wantCats) {
      byCategory[cat] = { found: 0, inserted: 0 };
      for (const kw of CATEGORIES[cat].keywords) {
        const results = await nearby(lat, lng, kw, key);
        for (const p of results) {
          found++; byCategory[cat].found++;
          const pid = p.place_id;
          if (!pid) continue;
          if (known.has(pid) || insertedHere.has(pid)) { skippedExisting++; continue; }
          insertedHere.add(pid);
          const loc = p.geometry?.location;
          if (!loc) continue;
          await turso.execute({
            sql: `INSERT INTO laundries
                    (name, brand, address, lat, lng, propiedad_mcf,
                     google_rating, google_review_count, google_place_id,
                     category, source, created_by)
                  VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'google', 'google')`,
            args: [
              p.name || '(sin nombre)', null, p.vicinity || null,
              loc.lat, loc.lng,
              p.rating ?? null, p.user_ratings_total ?? null, pid,
              cat,
            ],
          });
          inserted++; byCategory[cat].inserted++;
          known.add(pid);
        }
      }
    }

    return res.status(200).json({
      anchor: { index: idx, label, total: ANCHORS.length },
      found, inserted, skippedExisting, byCategory,
    });
  } catch (err) {
    console.error('laundries/discover error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Legacy Places Nearby Search (first page only — proven to work with the
// existing key). Returns the raw results array (or []).
async function nearby(lat, lng, keyword, key) {
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
    + `?location=${lat},${lng}&radius=${RADIUS_M}`
    + `&keyword=${encodeURIComponent(keyword)}&key=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Places HTTP ${r.status}`);
  const data = await r.json();
  if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}`);
  }
  return data.results || [];
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
