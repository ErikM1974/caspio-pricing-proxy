// staff-page-access.js — return the Staff_Page_Access rows (Page → Allowed_Roles/Emails).
// The front-end fetches this server-side (with the CRM secret), caches it, and gates
// /dashboards/*.html against it. Holds only RESTRICTED pages; unlisted = any staff.
// requireCrmApiSecret-gated at the mount (server-to-server only).
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// GET /api/staff-page-access → { rules: [ {Page, Allowed_Roles, Allowed_Emails, Description} ] }
router.get('/', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages('/tables/Staff_Page_Access/records', {
      'q.select': 'Page,Allowed_Roles,Allowed_Emails,Description',
      'q.pageSize': 200,
    });
    res.json({ rules: rows || [] });
  } catch (e) {
    console.error('[staff-page-access] lookup failed:', e.message);
    res.status(502).json({ error: 'page-access lookup failed' });
  }
});

module.exports = router;
