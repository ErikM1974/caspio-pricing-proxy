#!/usr/bin/env node
/**
 * Backfill ALL historical JotForm lead submissions (6 forms, ~1,765 rows) into
 * a CSV for Caspio's UI import into Form_Submissions.
 *
 * WHY CSV, NOT REST: bulk loads ride the Caspio Data-import quota, which is
 * nearly empty — REST writes would burn ~1,800 calls of the maxed 500K/mo
 * Integrations quota. LOCAL ONE-OFF — never schedule this.
 *
 *   node scripts/backfill-jotform-csv.js                    # full run → jotform-leads-backfill.csv
 *   node scripts/backfill-jotform-csv.js --fresh-days 60    # rows newer than N days import as
 *                                                           # 'New', older as 'Archived' (default 60)
 *   node scripts/backfill-jotform-csv.js --forms 21764724640151,220514824751149
 *   node scripts/backfill-jotform-csv.js --out C:\path\file.csv
 *
 * What it does:
 *   1. Pulls every submission from each form via the JotForm REST API (paginated,
 *      skips JotForm-DELETED trash).
 *   2. Prefetches Caspio state ONCE: existing jotform-lead External_IDs (webhook
 *      rows land first — those are excluded, so zero dupes) + the contacts email
 *      map + the Sales_Reps_2026 rep map for OFFLINE AE auto-assignment
 *      (identical rule to the live webhook: email match → AE, else Taneisha).
 *   3. Emits a UTF-8-BOM CSV shaped exactly like live rows (same normalizer),
 *      with historical Submission_IDs JFL{MMDD-of-original}-{4 digits from the
 *      JotForm submissionID}, collision-bumped.
 *
 * IMPORT (Erik, Caspio UI): Tables → Form_Submissions → Import → this CSV →
 * "Add new records only", map by header. Upload the file AS-IS — never open /
 * re-save it in Excel first (Excel mangles long JSON cells).
 *
 * Env (local .env): JOTFORM_API_KEY + the Caspio creds the proxy already uses.
 * Optional JOTFORM_TZ (IANA zone of the JotForm account; default America/Los_Angeles).
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  JOTFORM_FORMS, DEFAULT_LEAD_REP, JOTFORM_TZ,
  normalizeFromApiAnswers, pickBestContact, buildLeadRecord,
  toIsoFromZone, fetchJotformSubmissions,
} = require('../src/utils/jotform');
const { S } = require('../src/utils/form-submission-helpers');
const { fetchAllCaspioPages } = require('../src/utils/caspio');

const args = process.argv.slice(2);
const flagValue = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const FRESH_DAYS = parseInt(flagValue('--fresh-days', '60'), 10) || 60;
const OUT_PATH = path.resolve(flagValue('--out', path.join(process.cwd(), 'jotform-leads-backfill.csv')));
const ONLY_FORMS = (flagValue('--forms', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const CSV_COLUMNS = [
  'Submission_ID', 'Form_ID', 'Company', 'Contact_Name', 'Phone', 'Email',
  'Customer_Number', 'Sales_Rep', 'Due_Date', 'Status', 'Summary', 'Payload_JSON',
  'Submitted_At', 'Updated_At', 'Updated_By', 'Art_Request_ID',
  'Pushed_To_ShopWorks', 'ShopWorks_Order_ID',
  'External_Source', 'External_ID', 'Matched_ID_Customer', 'Linked_Quote_ID',
];

// Payload_JSON is single-line by construction (JSON.stringify escapes newlines);
// every other column gets raw newlines flattened so rows stay one physical line.
const csvCell = (v, isPayload) => {
  let s = String(v == null ? '' : v);
  if (!isPayload) s = s.replace(/[\r\n]+/g, ' ');
  return `"${s.replace(/"/g, '""')}"`;
};

async function loadCaspioState() {
  console.log('Prefetching Caspio state (one-time reads)…');

  const existing = await fetchAllCaspioPages('/tables/Form_Submissions/records', {
    'q.where': "Form_ID='jotform-lead'",
    'q.select': 'External_ID,Submission_ID',
    'q.pageSize': 1000,
    'q.orderBy': 'PK_ID',
  }, { maxPages: 30 });
  const existingExternalIds = new Set((existing || []).map((r) => String(r.External_ID || '')).filter(Boolean));
  const usedSubmissionIds = new Set((existing || []).map((r) => String(r.Submission_ID || '')).filter(Boolean));

  const contacts = await fetchAllCaspioPages('/tables/CompanyContactsMerge2026/records', {
    'q.where': "Email<>''",
    'q.select': 'Email,id_Customer,Company_Name,Sales_Rep,Is_Active,Last_Order_Date',
    'q.pageSize': 1000,
    'q.orderBy': 'PK_ID',
  }, { maxPages: 100 });
  const contactsByEmail = new Map();
  for (const c of contacts || []) {
    const email = String(c.Email || '').trim().toLowerCase();
    if (!email) continue;
    if (!contactsByEmail.has(email)) contactsByEmail.set(email, []);
    contactsByEmail.get(email).push(c);
  }

  const reps = await fetchAllCaspioPages('/tables/Sales_Reps_2026/records', {
    'q.select': 'ID_Customer,CustomerServiceRep',
    'q.pageSize': 1000,
    'q.orderBy': 'PK_ID',
  }, { maxPages: 30 });
  const repsById = new Map();
  for (const r of reps || []) {
    const id = parseInt(r.ID_Customer, 10);
    if (Number.isFinite(id) && S(r.CustomerServiceRep)) repsById.set(id, S(r.CustomerServiceRep, 80));
  }

  console.log(`  existing jotform-lead rows: ${existingExternalIds.size} · contacts w/ email: ${contactsByEmail.size} · rep map: ${repsById.size}`);
  return { existingExternalIds, usedSubmissionIds, contactsByEmail, repsById };
}

// Same rule as the live assignLead(), from the prefetched maps.
function offlineAssign(email, { contactsByEmail, repsById }) {
  const fallback = { salesRep: DEFAULT_LEAD_REP, matchedIdCustomer: '', matchedCompany: '' };
  if (!email) return fallback;
  const best = pickBestContact(contactsByEmail.get(String(email).toLowerCase()) || []);
  if (!best) return fallback;
  let rep = S(best.Sales_Rep, 80);
  const custId = parseInt(best.id_Customer, 10);
  if (!rep && Number.isFinite(custId)) rep = repsById.get(custId) || '';
  return {
    salesRep: rep || DEFAULT_LEAD_REP,
    matchedIdCustomer: best.id_Customer != null ? String(best.id_Customer) : '',
    matchedCompany: S(best.Company_Name),
  };
}

// Historical ID: JFL{MMDD of the ORIGINAL submission}-{4 digits from the JotForm
// submissionID}, bumped on collision. Same visual shape as live JFL ids.
function historicalId(createdAtLocal, externalId, usedIds) {
  const mmdd = `${String(createdAtLocal).slice(5, 7)}${String(createdAtLocal).slice(8, 10)}` || '0000';
  let n = parseInt(String(externalId).slice(-4), 10);
  if (!Number.isFinite(n)) n = 1000;
  for (let i = 0; i < 10000; i += 1) {
    const id = `JFL${mmdd}-${String((n + i) % 10000).padStart(4, '0')}`;
    if (!usedIds.has(id)) { usedIds.add(id); return id; }
  }
  throw new Error('could not find a free Submission_ID slot (impossible at this volume)');
}

async function main() {
  if (!process.env.JOTFORM_API_KEY) { console.error('JOTFORM_API_KEY is not set'); process.exit(1); }
  const state = await loadCaspioState();
  const freshCutoffMs = Date.now() - FRESH_DAYS * 86400000;

  const lines = [CSV_COLUMNS.map((c) => csvCell(c)).join(',')];
  const report = [];
  let totalWritten = 0; let totalMatched = 0; let totalNew = 0;

  const formIds = ONLY_FORMS.length ? ONLY_FORMS : Object.keys(JOTFORM_FORMS);
  for (const formID of formIds) {
    const title = (JOTFORM_FORMS[formID] || {}).title || formID;
    const tally = { title, fetched: 0, deleted: 0, dupes: 0, written: 0, matched: 0, statusNew: 0 };

    let offset = 0;
    for (;;) {
      const page = await fetchJotformSubmissions(formID, { limit: 1000, offset, orderby: 'id' });
      for (const sub of page) {
        if (String(sub.status || '').toUpperCase() === 'DELETED') { tally.deleted += 1; continue; }
        tally.fetched += 1;
        const extId = String(sub.id || '');
        if (!extId || state.existingExternalIds.has(extId)) { tally.dupes += 1; continue; }

        const normalized = normalizeFromApiAnswers(formID, sub.answers, extId);
        const assign = offlineAssign(normalized.email, state);
        const submittedAtIso = toIsoFromZone(sub.created_at);
        const isFresh = Date.parse(submittedAtIso) >= freshCutoffMs;

        const record = buildLeadRecord({
          formID, submissionId: extId, normalized, assign,
          opts: {
            status: isFresh ? 'New' : 'Archived',
            submittedAtIso,
            updatedBy: 'jotform-backfill',
          },
        });
        record.Submission_ID = historicalId(sub.created_at, extId, state.usedSubmissionIds);
        record.Pushed_To_ShopWorks = '';
        record.ShopWorks_Order_ID = '';

        lines.push(CSV_COLUMNS.map((c) => csvCell(record[c], c === 'Payload_JSON')).join(','));
        state.existingExternalIds.add(extId);
        tally.written += 1;
        if (record.Matched_ID_Customer) tally.matched += 1;
        if (isFresh) tally.statusNew += 1;
      }
      if (page.length < 1000) break;
      offset += 1000;
    }

    report.push(tally);
    totalWritten += tally.written; totalMatched += tally.matched; totalNew += tally.statusNew;
    console.log(`${title}: fetched ${tally.fetched} (+${tally.deleted} deleted skipped) → wrote ${tally.written}, already ingested ${tally.dupes}, customer-matched ${tally.matched}, status New ${tally.statusNew}`);
  }

  fs.writeFileSync(OUT_PATH, String.fromCharCode(0xFEFF) + lines.join('\r\n'), 'utf8'); // BOM so Caspio reads UTF-8

  console.log('\n──────────────────────────────────────────────');
  console.log(`CSV written: ${OUT_PATH}`);
  console.log(`Rows: ${totalWritten} (${totalNew} New / ${totalWritten - totalNew} Archived · ${totalMatched} matched to a ShopWorks customer, rest assigned ${DEFAULT_LEAD_REP})`);
  console.log(`JotForm timezone assumed: ${JOTFORM_TZ} (set JOTFORM_TZ if the account differs)`);
  console.log('\nIMPORT: Caspio → Tables → Form_Submissions → Import → this file →');
  console.log('  "Add new records only", map by header. Upload AS-IS — do NOT open/');
  console.log('  re-save in Excel first (it mangles long JSON cells).');
}

main().catch((e) => {
  console.error('FATAL:', e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message);
  process.exit(1);
});
