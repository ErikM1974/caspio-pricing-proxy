// Decoration Method Eligibility API
// GET /api/decoration-methods — category-level decoration rules + per-style overrides
// for the customer product page (which methods to offer per product).
//
// Data lives in Caspio so Erik tunes eligibility cells with NO deploy:
//   - Decoration_Method_Rules     (Category × EMB/DTG/SCP/DTF + DTG_CottonGate)
//   - Decoration_Method_Overrides (StyleNumber × Method → Allow, beats category rule)
// Erik-approved matrix 2026-06-11. Cached ~1 hour (same pattern as categories.js).
//
// Erik's #1 rule: on Caspio failure this endpoint returns a visible 502 — NEVER an
// empty-but-200 body. The frontend treats failure as "embroidery-only + warning",
// so it must be able to TELL it failed.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const DECORATION_METHODS_CACHE_TTL = 60 * 60 * 1000; // 1 hour
let decorationMethodsCache = null; // { data, timestamp }

/**
 * Normalize a Caspio Yes/No value to a strict boolean.
 * Caspio REST v3 serializes YES/NO fields as JSON true/false, but be tolerant of
 * "Yes"/"No"/"Y"/"N"/"true"/"false"/1/0 (CSV imports, DataPage edits, older API
 * versions). null/undefined/unknown → false (deny the method, never silently allow).
 * @param {*} value
 * @returns {boolean}
 */
function normalizeYesNo(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    return ['yes', 'y', 'true', '1'].includes(value.trim().toLowerCase());
  }
  return false;
}

// GET /api/decoration-methods
// Query params:
//   - refresh (optional): "true" bypasses the 1h cache
// Response: {
//   rules:     [{ category, EMB, DTG, SCP, DTF, dtgCottonGate, notes }],
//   overrides: [{ styleNumber, method, allow, note }]
// }
router.get('/decoration-methods', async (req, res) => {
  console.log('GET /api/decoration-methods requested');

  const forceRefresh = req.query.refresh === 'true';
  const now = Date.now();
  if (!forceRefresh && decorationMethodsCache && (now - decorationMethodsCache.timestamp) < DECORATION_METHODS_CACHE_TTL) {
    console.log('[CACHE HIT] decoration-methods');
    return res.json(decorationMethodsCache.data);
  }
  console.log('[CACHE MISS] decoration-methods');

  try {
    const [ruleRows, overrideRows] = await Promise.all([
      fetchAllCaspioPages('/tables/Decoration_Method_Rules/records', { 'q.limit': 200 }),
      fetchAllCaspioPages('/tables/Decoration_Method_Overrides/records', { 'q.limit': 1000 })
    ]);

    // The rules table is seeded with the full 15-category matrix. Zero rows means
    // something upstream is broken (wrong table, wiped data) — surface it, don't
    // hand the frontend an empty-but-200 that silently disables every method.
    if (!Array.isArray(ruleRows) || ruleRows.length === 0) {
      throw new Error('Decoration_Method_Rules returned no rows');
    }

    const rules = ruleRows
      .filter(row => (row.Category || '').trim())
      .map(row => ({
        category: row.Category.trim(),
        EMB: normalizeYesNo(row.EMB),
        DTG: normalizeYesNo(row.DTG),
        SCP: normalizeYesNo(row.SCP),
        DTF: normalizeYesNo(row.DTF),
        dtgCottonGate: normalizeYesNo(row.DTG_CottonGate),
        notes: (row.Notes || '').trim()
      }));

    const overrides = (overrideRows || [])
      .filter(row => (row.StyleNumber || '').trim() && (row.Method || '').trim())
      .map(row => ({
        styleNumber: row.StyleNumber.trim(),
        method: row.Method.trim().toUpperCase(),
        allow: normalizeYesNo(row.Allow),
        note: (row.Note || '').trim()
      }));

    const data = { rules, overrides };
    decorationMethodsCache = { data, timestamp: now };
    console.log(`Decoration methods: ${rules.length} category rules, ${overrides.length} style overrides`);
    res.json(data);
  } catch (error) {
    // Erik's #1 rule: visible failure — no stale cache, no hardcoded fallback matrix.
    console.error('Error in /api/decoration-methods:', error.message);
    res.status(502).json({
      error: 'Failed to fetch decoration method rules',
      details: error.message
    });
  }
});

module.exports = router;
module.exports.normalizeYesNo = normalizeYesNo;
