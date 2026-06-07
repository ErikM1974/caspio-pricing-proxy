#!/usr/bin/env node
/**
 * Seed the Caspio `Box_Density_Reference` table from data/box-density-reference.csv.
 *
 * WHY: GET /api/shipping/box-density reads this table so Erik can tune outbound
 * pieces-per-box WITHOUT a deploy. Until the table exists, the endpoint serves the
 * hardcoded defaults in src/routes/shipping.js (source:"default").
 *
 * WHAT IT DOES (idempotent):
 *   1. Probe whether the table exists.
 *   2. If missing, try to CREATE it (PK_ID autonumber, Category text, PiecesPerBox number).
 *      If the API token can't create tables, it prints the 2-minute Caspio-UI import steps
 *      and exits without error.
 *   3. Upsert the 7 category rows (Category, PiecesPerBox) from the CSV.
 *
 * Usage:  node scripts/seed-box-density-caspio.js
 * Reads CASPIO_ACCOUNT_DOMAIN / CASPIO_CLIENT_ID / CASPIO_CLIENT_SECRET from .env.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

const DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
const TABLE = 'Box_Density_Reference';
const CSV = path.join(__dirname, '..', 'data', 'box-density-reference.csv');

if (!DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing CASPIO_ACCOUNT_DOMAIN / CASPIO_CLIENT_ID / CASPIO_CLIENT_SECRET in .env');
  process.exit(1);
}
const BASE = `https://${DOMAIN}/rest/v2`;

const UI_STEPS = `
  Could not create the table via API. Do the 2-minute UI import instead:
    1. Caspio → Tables → New Table → Import from CSV.
    2. Choose data/box-density-reference.csv.
    3. Name the table exactly: Box_Density_Reference
    4. Ensure columns "Category" (Text 255) and "PiecesPerBox" (Number) import correctly.
    5. Done — GET /api/shipping/box-density will now return source:"caspio".
  Then re-run this script to verify/seed the rows.`;

async function getToken() {
  const res = await axios.post(`https://${DOMAIN}/oauth/token`,
    new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return res.data.access_token;
}

function parseCsv() {
  // Category + PiecesPerBox are the first two columns and never contain commas,
  // so a simple split is safe even though later columns (DataBasis) are quoted.
  const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const Category = (parts[0] || '').trim();
    const PiecesPerBox = parseFloat(parts[1]);
    if (Category && PiecesPerBox > 0) out.push({ Category, PiecesPerBox });
  }
  return out;
}

async function tableExists(token) {
  try {
    await axios.get(`${BASE}/tables/${TABLE}/records`, {
      headers: { Authorization: `Bearer ${token}` }, params: { 'q.limit': 1 },
    });
    return true;
  } catch (e) {
    if (e.response && (e.response.status === 404)) return false;
    throw e;
  }
}

async function createTable(token) {
  // NOTE: Caspio's REST /tables create rejects an explicit AUTONUMBER PK from this token
  // (400 IncorrectBodyParameter). The minimal two-column body below creates fine (201).
  const body = {
    Name: TABLE,
    Columns: [
      { Name: 'Category', Type: 'STRING' },
      { Name: 'PiecesPerBox', Type: 'NUMBER' },
    ],
  };
  await axios.post(`${BASE}/tables`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

async function upsertRow(token, row) {
  const where = `Category='${row.Category.replace(/'/g, "''")}'`;
  const existing = await axios.get(`${BASE}/tables/${TABLE}/records`, {
    headers: { Authorization: `Bearer ${token}` }, params: { 'q.where': where, 'q.limit': 1 },
  });
  const found = existing.data && existing.data.Result && existing.data.Result.length > 0;
  if (found) {
    await axios.put(`${BASE}/tables/${TABLE}/records`, { PiecesPerBox: row.PiecesPerBox },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, params: { 'q.where': where } });
    return 'updated';
  }
  await axios.post(`${BASE}/tables/${TABLE}/records`, row,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  return 'inserted';
}

(async () => {
  try {
    const rows = parseCsv();
    console.log(`Parsed ${rows.length} category rows from CSV:`, rows.map((r) => `${r.Category}=${r.PiecesPerBox}`).join(', '));
    const token = await getToken();

    let exists = await tableExists(token);
    if (!exists) {
      console.log(`Table ${TABLE} not found — attempting to create it...`);
      try {
        await createTable(token);
        console.log(`Created table ${TABLE}.`);
        exists = true;
      } catch (e) {
        const detail = e.response ? JSON.stringify(e.response.data) : e.message;
        console.warn(`Table create failed (${e.response && e.response.status}): ${detail}`);
        console.warn(UI_STEPS);
        process.exit(0);
      }
    } else {
      console.log(`Table ${TABLE} already exists — seeding rows.`);
    }

    let ins = 0, upd = 0;
    for (const row of rows) {
      const r = await upsertRow(token, row);
      r === 'inserted' ? ins++ : upd++;
      console.log(`  ${row.Category} → ${row.PiecesPerBox} (${r})`);
    }
    console.log(`Done. Inserted ${ins}, updated ${upd}. GET /api/shipping/box-density should now return source:"caspio".`);
  } catch (err) {
    console.error('Seed failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    process.exit(1);
  }
})();
