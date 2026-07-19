// lead-conversion.js — Leads CRM conversion tracking.
//
//   runConversionSync()  — daily job: auto-move a lead to WON when its customer
//                          placed an order AFTER the inquiry (the "first order
//                          after the lead" rule that separates a real new win
//                          from a customer who was already ordering), attach the
//                          ShopWorks customer #, and stamp lifetime sales into
//                          Lead_Value. Refreshes lifetime on already-Won leads.
//   buildScorecard()     — per-rep close report: for every WON lead, compute the
//                          conversion date (first order >= inquiry) + current
//                          lifetime sales, group by Sales_Rep, filter by a date
//                          range. Answers "Taneisha since Oct 2025".
//
// caspio is lazy-required INSIDE the async functions (utils/caspio pulls in
// api-tracker's timer, which keeps jest's event loop alive — same rule as
// jotform.js / lead-followup-digest.js). The pure helpers below stay import-free
// and are the jest surface.

'use strict';

const LEAD_FORM_IDS = ['jotform-lead', 'quote-request', 'webstore-request', 'team-roster', 'manual-lead'];
// A lead in one of these states is NOT eligible for auto-Won (already closed, or
// the rep deliberately parked it). Archived is eligible ONLY on a backfill run.
const NON_ELIGIBLE = ['Won', 'Lost', 'Launched', 'Completed', 'Entered in ShopWorks'];
const CONTACTS_TABLE = 'CompanyContactsMerge2026';
const ORDERS_TABLE = 'ORDER_ODBC';
const SUBMISSIONS_PATH = '/tables/Form_Submissions/records';
const ACTIVITY_PATH = '/tables/Lead_Activity/records';
const GRACE_DAYS = 14; // an order up to 14d before the lead still counts as "after" (inquiry↔order lag)

// personal/consumer email domains — a match on these identifies a PERSON, not an
// org, so a company-name mismatch is a real entity-collision risk.
const GENERIC_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'comcast.net',
  'aol.com', 'icloud.com', 'live.com', 'msn.com', 'me.com', 'ymail.com', 'protonmail.com', 'att.net', 'verizon.net', 'sbcglobal.net']);
const CO_STOP = new Set(['the', 'of', 'and', 'a', 'llc', 'inc', 'co', 'corp', 'corporation', 'company', 'ltd', 'group',
  'services', 'service', 'solutions', 'systems', 'association', 'club', 'school', 'district', 'city', 'county',
  'department', 'dept', 'university', 'northwest', 'nw', 'washington', 'wa', 'construction']);
const JUNK_CO = new Set(['', 'none', 'n/a', 'na', '-', '–', 'personal', 'individual', 'family', 'me', 'test', '.', 'private', 'home', 'self']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (s) => String(s == null ? '' : s).trim().toLowerCase();
const isEmail = (s) => EMAIL_RE.test(normEmail(s));
const escWhere = (s) => String(s).replace(/'/g, "''");
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

function isGenericEmail(email) { return GENERIC_DOMAINS.has(normEmail(email).split('@')[1] || ''); }

function normCompany(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(llc|inc|incorporated|co|corp|corporation|ltd|company|the|group)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function isJunkCompany(s) { return JUNK_CO.has(String(s == null ? '' : s).trim().toLowerCase()) || normCompany(s).length < 4; }
function companyTokens(s) { return normCompany(s).split(' ').filter((t) => t.length >= 4 && !CO_STOP.has(t)); }
function companyNamesAlign(a, b) {
  if (normCompany(a) && normCompany(a) === normCompany(b)) return true;
  const A = new Set(companyTokens(a));
  return companyTokens(b).some((t) => A.has(t));
}

// Given a lead's inquiry date and a customer's order dates (ms epochs), classify.
// converted = has an order on/after (leadDate - grace). firstOrder/lastOrder/count/
// lifetime come from the caller. NEW-vs-existing isn't decided here — the sync
// only requires "ordered after inquiry" to call it a win for this lead.
function classifyOrders(leadDateMs, orderDatesMs) {
  const dates = (orderDatesMs || []).filter((t) => typeof t === 'number' && !isNaN(t)).sort((x, y) => x - y);
  if (!dates.length) return { converted: false, orderCount: 0, firstOrderMs: 0, lastOrderMs: 0, conversionMs: 0 };
  const grace = GRACE_DAYS * 86400000;
  const conv = dates.find((t) => t >= (leadDateMs || 0) - grace) || 0;
  return {
    converted: !!conv,
    orderCount: dates.length,
    firstOrderMs: dates[0],
    lastOrderMs: dates[dates.length - 1],
    conversionMs: conv, // the first order on/after the inquiry — the true "close" date
  };
}

// Is this email→customer match an entity-collision risk? (personal domain + the
// company names don't share a token). Exact/fuzzy company matches are aligned by
// construction, so only email matches are ever flagged.
function isCollisionRisk(via, email, leadCompany, custCompany) {
  return via === 'email' && isGenericEmail(email) && !companyNamesAlign(leadCompany, custCompany);
}

const dayMs = (iso) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? iso + 'T12:00:00' : String(iso || '')) || 0;
const msToDay = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

// ---------- async (lazy caspio) ----------

async function fetchOrdersByCustomer(custIds) {
  const { fetchAllCaspioPages } = require('./caspio');
  const byCust = new Map();
  for (const grp of chunk([...new Set(custIds.map(String))].filter((x) => x && x !== 'null' && x !== 'undefined'), 40)) {
    const rows = await fetchAllCaspioPages(`/tables/${ORDERS_TABLE}/records`, {
      'q.where': 'id_Customer IN (' + grp.join(',') + ')',
      'q.select': 'id_Customer,date_OrderPlaced,cnCur_TotalInvoice',
      'q.pageSize': 1000, 'q.orderBy': 'PK_ID',
    }, { maxPages: 15 });
    for (const o of rows) {
      const k = String(o.id_Customer);
      if (!byCust.has(k)) byCust.set(k, { dates: [], lifetime: 0 });
      const b = byCust.get(k);
      const t = Date.parse(o.date_OrderPlaced);
      if (!isNaN(t)) b.dates.push(t);
      b.lifetime += parseFloat(o.cnCur_TotalInvoice) || 0;
    }
  }
  return byCust;
}

// Match a set of leads to ShopWorks customers. Email match (chunked IN) always;
// exact Company_Name match (chunked IN) always; normalized-fuzzy company match
// only when opts.fuzzyCompany (a one-time backfill — it pulls the full contact
// table, too heavy for the daily run). Returns Map(Submission_ID -> {custId,
// custCompany, custEmail, via}).
async function matchLeads(leads, opts) {
  const { fetchAllCaspioPages } = require('./caspio');
  const out = new Map();
  const emails = [...new Set(leads.map((l) => normEmail(l.Email)).filter(isEmail))];
  const emailToCust = new Map();
  for (const grp of chunk(emails, 40)) {
    const rows = await fetchAllCaspioPages(`/tables/${CONTACTS_TABLE}/records`, {
      'q.where': "Email IN ('" + grp.map(escWhere).join("','") + "')",
      'q.select': 'id_Customer,Company_Name,Email,Last_Order_Date', 'q.pageSize': 200,
    }, { maxPages: 2 });
    for (const c of rows) {
      const e = normEmail(c.Email); if (!e) continue;
      const prev = emailToCust.get(e);
      if (!prev || (Date.parse(c.Last_Order_Date || 0) || 0) > (Date.parse(prev.Last_Order_Date || 0) || 0)) emailToCust.set(e, c);
    }
  }
  for (const l of leads) {
    const e = normEmail(l.Email);
    if (isEmail(e) && emailToCust.has(e)) {
      const c = emailToCust.get(e);
      out.set(l.Submission_ID, { custId: c.id_Customer, custCompany: c.Company_Name, custEmail: c.Email, via: 'email' });
    }
  }
  // exact Company_Name IN for the still-unmatched, non-junk companies
  const unmatched = leads.filter((l) => !out.has(l.Submission_ID) && !isJunkCompany(l.Company));
  const companies = [...new Set(unmatched.map((l) => String(l.Company).trim()).filter(Boolean))];
  const exactByCo = new Map();
  for (const grp of chunk(companies, 30)) {
    const rows = await fetchAllCaspioPages(`/tables/${CONTACTS_TABLE}/records`, {
      'q.where': "Company_Name IN ('" + grp.map(escWhere).join("','") + "')",
      'q.select': 'id_Customer,Company_Name,Email,Last_Order_Date', 'q.pageSize': 200,
    }, { maxPages: 3 });
    for (const c of rows) {
      const n = String(c.Company_Name || '').trim().toLowerCase(); if (!n) continue;
      const prev = exactByCo.get(n);
      if (!prev || (Date.parse(c.Last_Order_Date || 0) || 0) > (Date.parse(prev.Last_Order_Date || 0) || 0)) exactByCo.set(n, c);
    }
  }
  for (const l of unmatched) {
    const n = String(l.Company).trim().toLowerCase();
    if (exactByCo.has(n)) { const c = exactByCo.get(n); out.set(l.Submission_ID, { custId: c.id_Customer, custCompany: c.Company_Name, custEmail: c.Email, via: 'company' }); }
  }
  // fuzzy normalized-company match — backfill only (pulls all contacts)
  if (opts && opts.fuzzyCompany) {
    const still = leads.filter((l) => !out.has(l.Submission_ID) && !isJunkCompany(l.Company));
    if (still.length) {
      const all = await fetchAllCaspioPages(`/tables/${CONTACTS_TABLE}/records`, {
        'q.select': 'id_Customer,Company_Name,Email,Last_Order_Date', 'q.pageSize': 1000, 'q.orderBy': 'id_Customer',
      }, { maxPages: 40 });
      const byNorm = new Map();
      for (const c of all) {
        const n = normCompany(c.Company_Name); if (!n || n.length < 4) continue;
        const prev = byNorm.get(n);
        if (!prev || (Date.parse(c.Last_Order_Date || 0) || 0) > (Date.parse(prev.Last_Order_Date || 0) || 0)) byNorm.set(n, c);
      }
      for (const l of still) {
        const c = byNorm.get(normCompany(l.Company));
        if (c) out.set(l.Submission_ID, { custId: c.id_Customer, custCompany: c.Company_Name, custEmail: c.Email, via: 'company-fuzzy' });
      }
    }
  }
  return out;
}

/**
 * Daily conversion sync.
 * @param {{dryRun?:boolean, includeArchived?:boolean, fuzzyCompany?:boolean, refreshWon?:boolean}} opts
 *   includeArchived + fuzzyCompany → the one-time historical backfill.
 *   refreshWon (default true) → re-stamp lifetime sales on already-Won leads.
 */
async function runConversionSync(opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const { fetchAllCaspioPages, makeCaspioRequest, putWithRecordsAffected } = require('./caspio');
  const { nowIso } = require('./form-submission-helpers');

  // 1) eligible leads
  let where = "Form_ID IN ('" + LEAD_FORM_IDS.join("','") + "') AND Status NOT IN ('" + NON_ELIGIBLE.join("','") + "')";
  if (!opts.includeArchived) where += " AND Status<>'Archived'";
  const leads = await fetchAllCaspioPages(SUBMISSIONS_PATH, {
    'q.where': where,
    'q.select': 'Submission_ID,Form_ID,Company,Contact_Name,Email,Submitted_At,Status,Sales_Rep,Matched_ID_Customer',
    'q.pageSize': 1000, 'q.orderBy': 'PK_ID',
  }, { maxPages: 10 });

  const matches = await matchLeads(leads, { fuzzyCompany: !!opts.fuzzyCompany });
  const matchedLeads = leads.filter((l) => matches.has(l.Submission_ID));
  const ordersByCust = await fetchOrdersByCustomer(matchedLeads.map((l) => matches.get(l.Submission_ID).custId));

  const won = [], skipped = [];
  for (const l of matchedLeads) {
    const m = matches.get(l.Submission_ID);
    const oc = ordersByCust.get(String(m.custId)) || { dates: [], lifetime: 0 };
    const cls = classifyOrders(dayMs(l.Submitted_At), oc.dates);
    if (!cls.converted) continue; // matched a customer but no order after the inquiry
    if (isCollisionRisk(m.via, l.Email, l.Company, m.custCompany)) {
      skipped.push({ id: l.Submission_ID, reason: 'collision-risk', email: l.Email, leadCompany: l.Company, custCompany: m.custCompany, custId: m.custId });
      continue;
    }
    const lifetime = Math.round(oc.lifetime);
    const rec = { id: l.Submission_ID, custId: String(m.custId), custCompany: m.custCompany, lifetime, orders: cls.orderCount, via: m.via, rep: l.Sales_Rep, conversionDate: msToDay(cls.conversionMs), fromStatus: l.Status };
    won.push(rec);
    if (!dryRun) {
      await putWithRecordsAffected(SUBMISSIONS_PATH, `Submission_ID='${escWhere(l.Submission_ID)}'`, {
        Status: 'Won', Matched_ID_Customer: String(m.custId), Lead_Value: String(lifetime),
        Updated_By: 'conversion-tracker', Updated_At: nowIso(),
      });
      await makeCaspioRequest('post', ACTIVITY_PATH, {}, {
        Submission_ID: l.Submission_ID, Activity_Type: 'system',
        Activity_Text: `Auto-matched to ShopWorks customer #${m.custId}${m.custCompany ? ' (' + m.custCompany + ')' : ''} — ${cls.orderCount} order(s), $${lifetime.toLocaleString('en-US')} lifetime. Moved to Won (matched by ${m.via}).`,
        Attachment_URL: '', Created_By: 'conversion-tracker', Created_At: nowIso(), Parent_PK: null,
      }).catch(() => { /* activity is best-effort; the Won already landed */ });
    }
  }

  // 2) refresh lifetime on already-Won leads (default on; skip on backfill run to
  //    avoid re-reading — backfill already stamped fresh lifetime above)
  let refreshed = 0;
  if (opts.refreshWon !== false && !opts.includeArchived) {
    const wonLeads = await fetchAllCaspioPages(SUBMISSIONS_PATH, {
      'q.where': "Form_ID IN ('" + LEAD_FORM_IDS.join("','") + "') AND Status='Won' AND Matched_ID_Customer>''",
      'q.select': 'Submission_ID,Matched_ID_Customer,Lead_Value', 'q.pageSize': 1000, 'q.orderBy': 'PK_ID',
    }, { maxPages: 5 });
    const wonOrders = await fetchOrdersByCustomer(wonLeads.map((l) => l.Matched_ID_Customer));
    for (const l of wonLeads) {
      const oc = wonOrders.get(String(l.Matched_ID_Customer)); if (!oc) continue;
      const lifetime = String(Math.round(oc.lifetime));
      if (String(l.Lead_Value || '') === lifetime) continue; // no change → no write
      if (!dryRun) {
        await putWithRecordsAffected(SUBMISSIONS_PATH, `Submission_ID='${escWhere(l.Submission_ID)}'`, {
          Lead_Value: lifetime, Updated_By: 'conversion-tracker', Updated_At: nowIso(),
        });
      }
      refreshed += 1;
    }
  }

  console.log(`[conversion-sync] scanned ${leads.length} · matched ${matchedLeads.length} · won ${won.length} · skipped ${skipped.length} · lifetime-refreshed ${refreshed}${dryRun ? ' (dry-run)' : ''}`);
  return { scanned: leads.length, matched: matchedLeads.length, wonCount: won.length, skippedCount: skipped.length, refreshed, won, skipped, dryRun };
}

/**
 * Per-rep close scorecard. For every WON lead with a customer link, compute its
 * conversion date (first order >= inquiry) + current lifetime sales, filter by
 * [since, until] on the conversion date, group by Sales_Rep.
 * @param {{since?:string, until?:string}} opts  ISO 'YYYY-MM-DD' bounds (inclusive)
 */
async function buildScorecard(opts) {
  opts = opts || {};
  const { fetchAllCaspioPages } = require('./caspio');
  const sinceMs = opts.since ? dayMs(opts.since) : 0;
  const untilMs = opts.until ? dayMs(opts.until) + 86400000 : Infinity; // inclusive end-of-day

  const wonLeads = await fetchAllCaspioPages(SUBMISSIONS_PATH, {
    'q.where': "Form_ID IN ('" + LEAD_FORM_IDS.join("','") + "') AND Status='Won'",
    'q.select': 'Submission_ID,Form_ID,Company,Contact_Name,Sales_Rep,Matched_ID_Customer,Lead_Value,Submitted_At',
    'q.pageSize': 1000, 'q.orderBy': 'PK_ID',
  }, { maxPages: 5 });
  const ordersByCust = await fetchOrdersByCustomer(wonLeads.map((l) => l.Matched_ID_Customer).filter(Boolean));

  const perRep = new Map();
  const leadsOut = [];
  let totalSales = 0, totalClosed = 0;
  for (const l of wonLeads) {
    const oc = l.Matched_ID_Customer ? ordersByCust.get(String(l.Matched_ID_Customer)) : null;
    const cls = classifyOrders(dayMs(l.Submitted_At), oc ? oc.dates : []);
    // conversion date = first order after inquiry; fall back to the inquiry date
    // for a manually-Won lead with no matched orders.
    const convMs = cls.conversionMs || dayMs(l.Submitted_At);
    if (convMs < sinceMs || convMs >= untilMs) continue;
    const lifetime = oc ? Math.round(oc.lifetime) : (parseFloat(l.Lead_Value) || 0);
    const rep = l.Sales_Rep || '(unassigned)';
    if (!perRep.has(rep)) perRep.set(rep, { rep, leadsClosed: 0, totalSales: 0, withOrders: 0 });
    const r = perRep.get(rep);
    r.leadsClosed += 1; r.totalSales += lifetime; if (oc) r.withOrders += 1;
    totalClosed += 1; totalSales += lifetime;
    leadsOut.push({
      submissionId: l.Submission_ID, company: l.Company, contact: l.Contact_Name, rep,
      custId: l.Matched_ID_Customer, lifetime, orders: cls.orderCount,
      inquiry: String(l.Submitted_At || '').slice(0, 10), conversionDate: msToDay(convMs),
    });
  }
  const reps = [...perRep.values()].map((r) => ({ ...r, totalSales: Math.round(r.totalSales) }))
    .sort((a, b) => b.totalSales - a.totalSales);
  leadsOut.sort((a, b) => b.lifetime - a.lifetime);
  return {
    since: opts.since || null, until: opts.until || null,
    totals: { repsWithCloses: reps.length, leadsClosed: totalClosed, totalSales: Math.round(totalSales) },
    reps, leads: leadsOut,
  };
}

module.exports = {
  runConversionSync, buildScorecard,
  // pure (jest)
  normEmail, isEmail, isGenericEmail, normCompany, isJunkCompany, companyNamesAlign,
  classifyOrders, isCollisionRisk, LEAD_FORM_IDS, NON_ELIGIBLE, GRACE_DAYS,
};
