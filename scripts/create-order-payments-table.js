// create-order-payments-table.js — one-time Caspio setup for the online quote
// payment flow (Storefront Checkout Phase 1, 2026-07-05). Idempotent — safe to
// re-run; each step skips if already done.
//
//   1. Creates table `Order_Payments` via Caspio platform REST **v2**
//      (this account 404s on /rest/v3; v2 POST /tables works but ONLY accepts
//      a minimal {Name, Columns:[{Name,Type}]} body — Note/Unique/Description/
//      AUTONUMBER all trigger IncorrectBodyParameter). All columns STRING,
//      matching the Customer_Reward_Ledger house pattern (Amount stored as
//      string; ISO Created sorts lexicographically = chronologically).
//   2. Inserts Service_Codes row DEPOSIT-PCT (SellPrice=100 → PAY IN FULL,
//      per Erik 2026-07-05; set to 50 in Caspio to switch to 50% deposits —
//      no deploy needed).
//
// Run from the proxy repo root:  node scripts/create-order-payments-table.js
'use strict';
require('dotenv').config();
const axios = require('axios');

const DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const V3 = `https://${DOMAIN}/rest/v3`;
const V2 = `https://${DOMAIN}/rest/v2`;

async function getToken() {
  const r = await axios.post(`https://${DOMAIN}/oauth/token`, new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.CASPIO_CLIENT_ID,
    client_secret: process.env.CASPIO_CLIENT_SECRET,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return r.data.access_token;
}

// Columns: QuoteID · Type (deposit|balance|refund) · Amount (signed dollars,
// stored as string — refund negative) · Stripe_Session_ID · Payment_Intent ·
// Payer_Email · Customer_Name · Company_Name · Created (ISO timestamp written
// by the app; kept as text to avoid Caspio Pacific-naive timestamp pitfalls).
const TABLE_DEF = {
  Name: 'Order_Payments',
  Columns: [
    'QuoteID', 'Type', 'Amount', 'Stripe_Session_ID', 'Payment_Intent',
    'Payer_Email', 'Customer_Name', 'Company_Name', 'Created',
  ].map((n) => ({ Name: n, Type: 'STRING' })),
};

// SellPrice=100 → customer pays IN FULL at the quote page (Erik 2026-07-05).
const SERVICE_CODE_ROW = {
  ServiceCode: 'DEPOSIT-PCT',
  ServiceType: 'PAYMENT',
  DisplayName: 'Online payment percent (100 = pay in full)',
  Category: 'Payments',
  PricingMethod: 'FLAT',
  TierLabel: '',
  UnitCost: 0,
  SellPrice: 100,
  PerUnit: 'percent of order total',
  QuoteBuilderField: '',
  Position: '',
  StitchBase: 0,
  IsActive: true,
};

(async () => {
  const token = await getToken();
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1) Order_Payments table
  const tables = (await axios.get(`${V2}/tables`, { headers: h })).data;
  const names = (tables && tables.Result) || [];
  if (names.includes(TABLE_DEF.Name)) {
    console.log(`✓ Table ${TABLE_DEF.Name} already exists — skipping create.`);
  } else {
    await axios.post(`${V2}/tables`, TABLE_DEF, { headers: h });
    console.log(`✓ Created table ${TABLE_DEF.Name} (${TABLE_DEF.Columns.length} columns).`);
  }

  // 2) DEPOSIT-PCT service code
  const existing = (await axios.get(
    `${V2}/tables/Service_Codes/records?q.where=${encodeURIComponent("ServiceCode='DEPOSIT-PCT'")}`,
    { headers: h }
  )).data;
  const rows = (existing && existing.Result) || [];
  if (rows.length) {
    console.log(`✓ Service_Codes DEPOSIT-PCT already exists (SellPrice=${rows[0].SellPrice}, IsActive=${rows[0].IsActive}) — skipping insert.`);
  } else {
    await axios.post(`${V2}/tables/Service_Codes/records`, SERVICE_CODE_ROW, { headers: h });
    console.log('✓ Inserted Service_Codes DEPOSIT-PCT (SellPrice=100 → pay in full).');
  }

  // 3) Verify both
  const verify = (await axios.get(`${V2}/tables/${TABLE_DEF.Name}/fields`, { headers: h })).data;
  console.log(`✓ Verified table exists with ${((verify && verify.Result) || []).length} columns.`);
  console.log('DONE');
})().catch((e) => {
  console.error('SETUP FAILED:', e.response ? JSON.stringify(e.response.data) : e.message);
  process.exit(1);
});
