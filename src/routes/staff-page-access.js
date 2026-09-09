// staff-page-access.js — return the Staff_Page_Access rows (Page → Allowed_Roles/Emails).
// The front-end fetches this server-side (with the CRM secret), caches it 5 min, and
// gates /dashboards/*.html against it. Holds only RESTRICTED pages; unlisted = any staff.
// requireCrmApiSecret-gated at the mount (server-to-server only).
//
// Cached 10 minutes here (2026-09-09): the site's own 5-minute cache still asked for
// this table 260 times in 19 hours (every expiry on every site dyno, and every one of
// the site's ~17 deploys a day starts cold). The table changes when Erik edits it in
// Caspio, so a change now takes up to 10 min here + 5 min on the site to apply;
// ?refresh=true bypasses and /api/product-cache/clear drops it (registered ttl-cache).
// An EMPTY read is never cached — pinning "no restricted pages" would open every
// dashboard to any staff login for ten minutes (the 2026-07-25 all-brands lesson).
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');
const { createTtlCache, shouldBypass } = require('../utils/ttl-cache');

const rulesCache = createTtlCache({ name: 'staff-page-access', ttlMs: 10 * 60 * 1000, maxEntries: 1 });

// GET /api/staff-page-access → { rules: [ {Page, Allowed_Roles, Allowed_Emails, Description} ] }
router.get('/', async (req, res) => {
  try {
    if (!shouldBypass(req)) {
      const hit = rulesCache.get('rules');
      if (hit) return res.json({ rules: hit });
    }
    const rows = await fetchAllCaspioPages('/tables/Staff_Page_Access/records', {
      'q.select': 'Page,Allowed_Roles,Allowed_Emails,Description',
      'q.pageSize': 200,
    });
    const rules = rows || [];
    if (rules.length) rulesCache.set('rules', rules);
    res.json({ rules });
  } catch (e) {
    console.error('[staff-page-access] lookup failed:', e.message);
    res.status(502).json({ error: 'page-access lookup failed' });
  }
});

module.exports = router;
