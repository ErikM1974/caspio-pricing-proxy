// customer-portal-access.js — read a customer's portal-access record from the
// Customer_Portal_Access Caspio table (Email → id_Customer + Enabled). The front-end
// calls this SERVER-SIDE during magic-link request + verify (with the CRM secret) to
// decide whether an email may log in and which company it's scoped to. Gated by
// requireCrmApiSecret at the mount (server-to-server only; never browser-reachable).
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Strict email validation — also excludes quotes/backslash so it's safe to inline in a
// Caspio q.where clause (defense-in-depth; the value is also a server-controlled lookup).
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const ok = /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email);
  return ok ? email.toLowerCase().trim() : null;
}

// GET /api/customer-portal-access/by-email/:email → { found, access? }
//   access = { email, id_Customer, company_name, enabled (bool), role }
router.get('/by-email/:email', async (req, res) => {
  const email = sanitizeEmail(req.params.email);
  if (!email) return res.status(400).json({ error: 'valid email required' });
  try {
    const rows = await fetchAllCaspioPages('/tables/Customer_Portal_Access/records', {
      'q.where': `Email='${email}'`,
      'q.select': 'Email,id_Customer,Company_Name,Enabled,Role',
    });
    const row = rows && rows[0];
    if (!row) return res.json({ found: false });
    res.json({
      found: true,
      access: {
        email: row.Email,
        id_Customer: row.id_Customer,
        company_name: row.Company_Name,
        enabled: String(row.Enabled || '').trim().toLowerCase() === 'yes',
        role: row.Role || null,
      },
    });
  } catch (e) {
    console.error('[customer-portal-access] lookup failed:', e.message);
    res.status(502).json({ error: 'portal-access lookup failed' });
  }
});

module.exports = router;
