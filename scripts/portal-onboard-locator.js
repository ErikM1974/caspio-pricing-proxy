#!/usr/bin/env node
/**
 * Portal onboarding locator (READ-ONLY — never writes).
 *
 * Finds every customer who has a COMPLETED design proof from EITHER artist and emits a
 * review CSV so a human can pick the login contact before we stage them for the portal.
 *
 *   - Steve set  = ArtRequests   Status IN (Completed, Approved) AND a real proof
 *                  (Final_Approved_Mockup || Box_File_Mockup || BoxFileLink)  — NOT MAIN_IMAGE_URL
 *                  (matches what renderMyLogos actually shows; the SanMar garment photo was dropped v.12).
 *   - Ruth set   = Digitizing_Mockups Status='Completed' AND a Box image (Box_Mockup_1|2|3).
 *   - UNION      = has proof from either. BOTH flag = in both sets (Erik's original pilot rule).
 *
 * We query Caspio DIRECTLY (proxy's own client_credentials token), so ArtRequests is NOT capped
 * at the ~2000-row public-endpoint limit. Nothing is written — no Customer_Portal_Access rows,
 * no invite emails. Staging is a deliberate separate step.
 *
 *   node scripts/portal-onboard-locator.js                  # locate + write cohort CSV (read-only)
 *   node scripts/portal-onboard-locator.js --stage          # + dry-run the "ready-now" staging plan (still read-only)
 *   node scripts/portal-onboard-locator.js --stage --apply  # + WRITE Customer_Portal_Access rows (Enabled=Yes, NO invites)
 *
 * Staging writes rows identical to the admin console's POST (Email lowercased, id_Customer digits,
 * Company_Name, Enabled='Yes', Role=''). It NEVER sends an invite/magic link — that stays a
 * deliberate per-customer click. It stages only the "ready-now" set (resolved email + non-empty
 * My Logos today), excludes the house account (3739) + anyone already staged, and dedups by email.
 *
 * Output: prints a summary + top rows, and writes the full cohort to
 *   <repo>/portal-onboard-cohort.csv   (NOT committed — it holds customer emails)
 *
 * "has_2026_content" = the customer's qualifying proof is dated >= 2026-01-01, i.e. their
 * My Logos will be NON-EMPTY today (the portal date-gates display at PORTAL_DATE_CUTOFF).
 * A customer can be in the union but have has_2026_content=No — their logos wait for the
 * Phase-1 brand-logo table. Prioritize has_2026_content=Yes for the first invites.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../src/config');
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../src/utils/caspio');

const CUTOFF = '2026-01-01';                 // portal My Logos display cutoff (server.js PORTAL_DATE_CUTOFF)
const OUT = path.join(__dirname, '..', 'portal-onboard-cohort.csv');
const BASE = config.caspio.apiBaseUrl;
const ACCESS_TABLE = 'Customer_Portal_Access';
const STAGE = process.argv.includes('--stage');   // build the staging plan (and, with --apply, write it)
const APPLY = process.argv.includes('--apply');    // with --stage: actually write rows (else dry-run)
const DENY = new Set(['3739']);                    // house/internal accounts to never auto-onboard

// ── helpers ──────────────────────────────────────────────────────────────
const nz = (v) => v !== null && v !== undefined && String(v).trim() !== '';        // non-empty
const normId = (v) => { const n = parseInt(String(v == null ? '' : v).trim(), 10); return (Number.isInteger(n) && n > 0) ? String(n) : null; };
const day = (v) => { const s = String(v == null ? '' : v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };
const is2026 = (v) => { const d = day(v); return d && d >= CUTOFF; };
const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

function ensure(map, id) {
  if (!map.has(id)) map.set(id, {
    id, company: '', steve: 0, ruth: 0, has2026: false,
    latestSteve: '', latestRuth: '',
    contactName: '', contactEmail: '', contactLastOrder: '', numContacts: 0, otherEmails: [],
    inPortal: false, portalEnabled: ''
  });
  return map.get(id);
}

async function main() {
  console.log('Portal onboarding locator (READ-ONLY) — querying Caspio directly…\n');

  // 1) Steve — ArtRequests Completed/Approved (direct query, no 2000-row cap)
  const artRows = await fetchAllCaspioPages('/tables/ArtRequests/records', {
    'q.select': 'Shopwork_customer_number,id_customer,CompanyName,Status,Final_Approved_Mockup,Box_File_Mockup,BoxFileLink,Date_Created',
    'q.where': "(Status='Completed' OR Status='Approved')",
    'q.limit': 1000
  }) || [];

  // 2) Ruth — Digitizing_Mockups Completed
  const ruthRows = await fetchAllCaspioPages('/tables/Digitizing_Mockups/records', {
    'q.select': 'Id_Customer,Company_Name,Status,Box_Mockup_1,Box_Mockup_2,Box_Mockup_3,Submitted_Date',
    'q.where': "Status='Completed'",
    'q.limit': 500
  }) || [];

  console.log(`Fetched: ArtRequests(Completed/Approved)=${artRows.length}, Digitizing_Mockups(Completed)=${ruthRows.length}`);

  const cust = new Map();

  // Steve rows with a REAL proof (not MAIN_IMAGE_URL)
  let steveProofRows = 0;
  for (const a of artRows) {
    const hasProof = nz(a.Final_Approved_Mockup) || nz(a.Box_File_Mockup) || nz(a.BoxFileLink);
    if (!hasProof) continue;
    const id = normId(a.Shopwork_customer_number) || normId(a.id_customer);
    if (!id) continue;
    steveProofRows++;
    const c = ensure(cust, id);
    c.steve++;
    if (!c.company && nz(a.CompanyName)) c.company = String(a.CompanyName).trim();
    const d = day(a.Date_Created);
    if (d > c.latestSteve) c.latestSteve = d;
    if (is2026(a.Date_Created)) c.has2026 = true;
  }

  // Ruth rows with a Box image
  let ruthImgRows = 0;
  for (const m of ruthRows) {
    const hasImg = nz(m.Box_Mockup_1) || nz(m.Box_Mockup_2) || nz(m.Box_Mockup_3);
    if (!hasImg) continue;
    const id = normId(m.Id_Customer);
    if (!id) continue;
    ruthImgRows++;
    const c = ensure(cust, id);
    c.ruth++;
    if (!c.company && nz(m.Company_Name)) c.company = String(m.Company_Name).trim();
    const d = day(m.Submitted_Date);
    if (d > c.latestRuth) c.latestRuth = d;
    if (is2026(m.Submitted_Date)) c.has2026 = true;   // null Submitted_Date → not 2026 (matches portal filter)
  }

  const ids = [...cust.keys()];
  const steveDistinct = [...cust.values()].filter((c) => c.steve > 0).length;
  const ruthDistinct = [...cust.values()].filter((c) => c.ruth > 0).length;
  const bothCount = [...cust.values()].filter((c) => c.steve > 0 && c.ruth > 0).length;

  // 3) Already-staged customers (Customer_Portal_Access)
  const accessRows = await fetchAllCaspioPages('/tables/Customer_Portal_Access/records', {
    'q.select': 'Email,id_Customer,Company_Name,Enabled', 'q.limit': 1000
  }) || [];
  const portalById = new Map();
  for (const r of accessRows) { const id = normId(r.id_Customer); if (id) portalById.set(id, r); }
  for (const id of ids) { const r = portalById.get(id); if (r) { const c = cust.get(id); c.inPortal = true; c.portalEnabled = r.Enabled || ''; } }

  // 4) Resolve contacts for the union (CompanyContactsMerge2026, IN batches)
  const BATCH = 60;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const rows = await fetchAllCaspioPages('/tables/CompanyContactsMerge2026/records', {
      'q.select': 'id_Customer,Company_Name,Email,ct_NameFull,NameFirst,NameLast,Last_Order_Date,Is_Active',
      'q.where': `Is_Active=1 AND id_Customer IN (${slice.join(',')})`,
      'q.orderBy': 'Last_Order_Date DESC',
      'q.limit': 1000
    }) || [];
    const byCust = new Map();
    for (const r of rows) { const id = normId(r.id_Customer); if (!id || !nz(r.Email)) continue; if (!byCust.has(id)) byCust.set(id, []); byCust.get(id).push(r); }
    for (const [id, list] of byCust) {
      list.sort((a, b) => String(b.Last_Order_Date || '').localeCompare(String(a.Last_Order_Date || '')));
      const c = cust.get(id); if (!c) continue;
      const primary = list[0];
      const name = nz(primary.ct_NameFull) ? primary.ct_NameFull : [primary.NameFirst, primary.NameLast].filter(nz).join(' ').trim();
      c.contactName = name || '';
      c.contactEmail = primary.Email || '';
      c.contactLastOrder = day(primary.Last_Order_Date);
      c.numContacts = list.length;
      c.otherEmails = list.slice(1).map((r) => r.Email).filter(nz);
      if (!c.company && nz(primary.Company_Name)) c.company = String(primary.Company_Name).trim();
    }
    process.stdout.write(`  contacts resolved ${Math.min(i + BATCH, ids.length)}/${ids.length}\r`);
  }
  console.log('');

  // 5) Build + sort rows: both first, then has_2026, then design volume
  const rows = [...cust.values()].map((c) => ({
    ...c,
    both: c.steve > 0 && c.ruth > 0,
    total: c.steve + c.ruth,
    latest: c.latestSteve > c.latestRuth ? c.latestSteve : c.latestRuth
  }));
  rows.sort((a, b) =>
    (b.both - a.both) || (b.has2026 - a.has2026) || (b.total - a.total) ||
    String(a.company).localeCompare(String(b.company)));

  // 6) CSV
  const header = ['id_Customer', 'Company_Name', 'has_steve', 'has_ruth', 'both',
    'steve_designs', 'ruth_designs', 'has_2026_content', 'already_in_portal', 'portal_enabled',
    'primary_contact_name', 'primary_contact_email', 'num_contacts', 'other_emails', 'latest_proof_date'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.company, r.steve > 0 ? 'Yes' : 'No', r.ruth > 0 ? 'Yes' : 'No', r.both ? 'Yes' : 'No',
      r.steve, r.ruth, r.has2026 ? 'Yes' : 'No', r.inPortal ? 'Yes' : 'No', r.portalEnabled,
      r.contactName, r.contactEmail, r.numContacts, r.otherEmails.join('; '), r.latest
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(OUT, '﻿' + lines.join('\r\n'), 'utf8');

  // 7) Summary
  const withEmail = rows.filter((r) => nz(r.contactEmail)).length;
  const noEmail = rows.length - withEmail;
  const has2026 = rows.filter((r) => r.has2026).length;
  const alreadyIn = rows.filter((r) => r.inPortal).length;
  console.log('\n════════ COHORT SUMMARY ════════');
  console.log(`Steve (completed/approved + real proof):   ${steveDistinct} customers  (${steveProofRows} proof rows)`);
  console.log(`Ruth  (completed + Box image):             ${ruthDistinct} customers  (${ruthImgRows} image rows)`);
  console.log(`UNION (proof from either):                 ${rows.length} customers`);
  console.log(`  ├─ BOTH artists:                         ${bothCount}`);
  console.log(`  ├─ Ruth only:                            ${ruthDistinct - bothCount}`);
  console.log(`  └─ Steve only:                           ${steveDistinct - bothCount}`);
  console.log(`Non-empty My Logos TODAY (has 2026 proof): ${has2026}`);
  console.log(`Already staged in portal:                  ${alreadyIn}`);
  console.log(`Resolved a primary contact email:          ${withEmail}`);
  console.log(`NO contact email (needs manual):           ${noEmail}`);
  console.log(`\nCSV written: ${OUT}`);

  console.log('\n──── Top 20 (both-artists first, then has-2026, then volume) ────');
  console.log(['#', 'id', 'company', 'S', 'R', 'both', '2026', 'inPortal', 'email'].join('\t'));
  rows.slice(0, 20).forEach((r, i) => console.log([
    i + 1, r.id, (r.company || '').slice(0, 26), r.steve, r.ruth,
    r.both ? 'Y' : '-', r.has2026 ? 'Y' : '-', r.inPortal ? 'Y' : '-', r.contactEmail || '(none)'
  ].join('\t')));

  // 8) Staging (opt-in). Provision access rows for the "ready-now" set — NO invites.
  if (!STAGE) return;
  const existingEmails = new Set(accessRows.map((r) => String(r.Email || '').toLowerCase().trim()).filter(Boolean));

  // Ready-now = has a resolved email AND non-empty My Logos today; exclude house acct + already-staged.
  const eligible = rows.filter((r) => !DENY.has(r.id) && !r.inPortal && nz(r.contactEmail) && r.has2026);
  const seen = new Set();
  const toStage = [];
  let skipDupEmail = 0, skipEmailStaged = 0;
  for (const r of eligible) {
    const em = r.contactEmail.toLowerCase().trim();
    if (existingEmails.has(em)) { skipEmailStaged++; continue; }   // that email already logs in somewhere
    if (seen.has(em)) { skipDupEmail++; continue; }                // two customers share a contact — stage once
    seen.add(em);
    toStage.push(r);
  }

  console.log('\n════════ STAGING PLAN — "ready-now" cohort (NO invites sent) ════════');
  console.log('Rule: resolved email + has_2026_content + not house(3739) + not already staged, deduped by email.');
  console.log(`Would create ${toStage.length} Customer_Portal_Access rows (Enabled=Yes, Role='').`);
  console.log(`Held back: no-email ${rows.filter((r) => !nz(r.contactEmail)).length}, `
    + `no-2026-content ${rows.filter((r) => !r.has2026).length}, already-staged ${rows.filter((r) => r.inPortal).length}, `
    + `house-acct ${rows.filter((r) => DENY.has(r.id)).length}, email-already-staged ${skipEmailStaged}, dup-email-in-cohort ${skipDupEmail}.`);
  console.log('\n  idx  id       company                          email');
  toStage.forEach((r, i) => console.log(
    `  ${String(i + 1).padStart(3)}  ${r.id.padEnd(7)}  ${(r.company || '').slice(0, 30).padEnd(31)}  ${r.contactEmail}`));

  if (!APPLY) {
    console.log(`\nDRY-RUN — nothing written. Review the list above, then run:`);
    console.log(`  node scripts/portal-onboard-locator.js --stage --apply`);
    return;
  }

  console.log(`\nAPPLYING — writing ${toStage.length} rows to ${ACCESS_TABLE}…`);
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  let created = 0, failed = 0;
  for (const r of toStage) {
    const body = { Email: r.contactEmail.toLowerCase().trim(), id_Customer: r.id, Company_Name: String(r.company || '').slice(0, 255), Enabled: 'Yes', Role: '' };
    try {
      await axios.post(`${BASE}/tables/${ACCESS_TABLE}/records`, body, H);
      created++; process.stdout.write(`  staged ${created}/${toStage.length}\r`);
    } catch (e) {
      failed++; console.error(`\n  FAIL ${r.id} ${body.Email}: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
    }
  }
  console.log(`\nDone. Created ${created}, failed ${failed}. NO invites were sent (magic link is a separate step).`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : (e.stack || e.message));
  process.exit(1);
});
