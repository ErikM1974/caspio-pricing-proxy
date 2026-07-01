#!/usr/bin/env node
/**
 * Create the `Customer_Reward_Ledger` Caspio table — the append-only ledger for Customer
 * Portal Phase 5 (reward dollars). A customer's BALANCE is SUM(Amount) over their rows;
 * we NEVER store a mutable balance. Every change is a signed entry:
 *   +amount = grant/earn, -amount = redeem/deduct. All writes are STAFF-initiated (the
 *   customer can never change their own balance). Erik/reps grant manually for now
 *   (auto-accrual rules are a later phase).
 *
 *   node scripts/create-customer-reward-ledger-table.js          # dry-run
 *   node scripts/create-customer-reward-ledger-table.js --apply  # create
 *
 * Idempotent: skips if the table already exists.
 */
'use strict';
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Customer_Reward_Ledger';
const APPLY = process.argv.includes('--apply');

const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'id_Customer',  Type: 'STRING' }, // ShopWorks customer id (the balance key)
    { Name: 'Company_Name', Type: 'STRING' },
    { Name: 'Amount',       Type: 'STRING' }, // SIGNED dollars as text (+grant / -redeem)
    { Name: 'Type',         Type: 'STRING' }, // grant | redeem | adjust
    { Name: 'Reason',       Type: 'STRING' }, // why ("Loyalty bonus", "Applied to order #…")
    { Name: 'Order_Ref',    Type: 'STRING' }, // optional order # for a redemption
    { Name: 'Created',      Type: 'STRING' }, // ISO timestamp
    { Name: 'Created_By',   Type: 'STRING' }, // staff email who wrote the entry (audit)
  ],
};

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
  let exists = false;
  try { await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } }); exists = true; } catch (_) { exists = false; }
  console.log(`Table ${TABLE}: ${exists ? 'already exists' : 'does NOT exist'}`);
  if (!exists) {
    console.log(`  ${APPLY ? 'creating' : 'would create'}: PK_ID(auto) + ${TABLE_DEF.Fields.map(f => f.Name).join(', ')}`);
    if (APPLY) { await axios.post(`${BASE}/tables`, TABLE_DEF, H); console.log('  ✓ created'); }
  }
  if (APPLY) {
    const fields = (await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } })).data;
    const list = (fields.Result || fields.result || fields || []).map(f => f.Name || f.name).filter(Boolean);
    console.log(`\nVerify — ${TABLE}: ${list.join(', ')}`);
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
