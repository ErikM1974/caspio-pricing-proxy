// staff-app-roles.js — read a staff member's app-RBAC role from the Staff_App_Roles
// Caspio table (Email → Role). The front-end calls this SERVER-SIDE at login (with the
// CRM secret) to derive permissions, replacing the hardcoded staff-saml map. Gated by
// requireCrmApiSecret at the mount (server-to-server only; not browser-reachable).
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Strict email validation — also excludes quotes/backslash so it's safe to inline in
// a Caspio q.where clause (defense-in-depth; the value is also a verified SAML email).
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const ok = /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email);
  return ok ? email.toLowerCase().trim() : null;
}

// GET /api/staff-app-role?email=...  → { email, role|null }
router.get('/', async (req, res) => {
  const email = sanitizeEmail(req.query.email);
  if (!email) return res.status(400).json({ error: 'valid email required' });
  try {
    const rows = await fetchAllCaspioPages('/tables/Staff_App_Roles/records', {
      'q.where': `Email='${email}'`,
      'q.select': 'Email,Role',
    });
    const role = rows && rows[0] ? (rows[0].Role || null) : null;
    res.json({ email, role });
  } catch (e) {
    console.error('[staff-app-role] lookup failed:', e.message);
    res.status(502).json({ error: 'role lookup failed' });
  }
});

module.exports = router;
