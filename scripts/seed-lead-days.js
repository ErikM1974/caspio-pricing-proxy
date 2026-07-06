// seed-lead-days.js — one-time seed of production lead-time Service_Codes
// (delivery-promise chips on teamnwca.com PDP/cart, 2026-07-06 BAW adoption #1).
// SellPrice = BUSINESS DAYS until estimated ship for orders placed today.
// Erik tunes these in Caspio (no deploy) as the shop gets busy/slow.
// Idempotent — existing codes are skipped. Run: node scripts/seed-lead-days.js
'use strict';
require('dotenv').config();
const axios = require('axios');

const DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const V2 = `https://${DOMAIN}/rest/v2`;

// Initial value 10 business days for every method — matches the public site
// copy "ships in 7-10 business days". Conservative on purpose; tune down in Caspio.
const ROWS = ['EMB', 'CAP', 'DTG', 'SCP', 'DTF'].map((m) => ({
  ServiceCode: `LEAD-DAYS-${m}`,
  ServiceType: 'CONFIG',
  DisplayName: `Production lead time — ${m} (business days to est. ship)`,
  Category: 'Lead Times',
  PricingMethod: 'FLAT',
  TierLabel: '',
  UnitCost: 0,
  SellPrice: 10,
  PerUnit: 'business days',
  QuoteBuilderField: '',
  Position: '',
  StitchBase: 0,
  IsActive: true,
}));

(async () => {
  const tok = await axios.post(`https://${DOMAIN}/oauth/token`, new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.CASPIO_CLIENT_ID,
    client_secret: process.env.CASPIO_CLIENT_SECRET,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const h = { Authorization: `Bearer ${tok.data.access_token}`, 'Content-Type': 'application/json' };

  for (const row of ROWS) {
    const existing = (await axios.get(
      `${V2}/tables/Service_Codes/records?q.where=${encodeURIComponent(`ServiceCode='${row.ServiceCode}'`)}`,
      { headers: h }
    )).data;
    if ((existing.Result || []).length) {
      console.log(`✓ ${row.ServiceCode} already exists (SellPrice=${existing.Result[0].SellPrice}) — skipped`);
      continue;
    }
    await axios.post(`${V2}/tables/Service_Codes/records`, row, { headers: h });
    console.log(`✓ Inserted ${row.ServiceCode} (SellPrice=${row.SellPrice} business days)`);
  }
  console.log('DONE');
})().catch((e) => {
  console.error('SEED FAILED:', e.response ? JSON.stringify(e.response.data) : e.message);
  process.exit(1);
});
