// lead-followup-digest.js — weekday-morning "your leads need attention" email,
// one per AE. Structural clone of send-ae-approval-digest.js (same EmailJS
// pipe, same groupByAE-and-skip-empty shape) over the Leads CRM rows in
// Form_Submissions.
//
// Sections per AE:
//   1. OVERDUE      — Due_Date < today (follow-up missed), oldest first
//   2. DUE TODAY    — Due_Date == today
//   3. NEW & UNTOUCHED — Status='New', no Due_Date set, older than 48h,
//      submitted within the last 60 days (guards against backfill noise)
//
// ONE Caspio read per run. Terminal-status rows excluded in JS (post-fetch
// filtering per the approval-digest precedent — avoids Caspio date-syntax
// fragility). Deep links are `#hash` — NEVER `?id=` (quoted-printable
// mangles '=' in delivered email; see dashboards/js/leads.js).
//
// Cron: weekdays 7:45 AM Pacific (proxy server.js) — staggered 15 min before
// the 8:00 approval digest to avoid an EmailJS burst.

'use strict';

// caspio + emailjs are lazy-required inside the async functions — utils/caspio
// pulls in api-tracker whose timer keeps jest's event loop alive (same jest-
// safety rule as form-submission-helpers.js / jotform.js).
const { resolveAEEmailLoose, resolveAEName } = require('./rep-email-map');

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';

const LEAD_FORM_IDS = ['jotform-lead', 'quote-request', 'webstore-request', 'team-roster'];
// Mirrors the frontend's WON_STATUSES ∪ {Lost, Archived} (dashboards/js/leads.js) —
// keep in sync if the pipeline vocabulary changes.
const TERMINAL_STATUSES = ['Won', 'Lost', 'Archived', 'Launched', 'Completed', 'Entered in ShopWorks'];
const SOURCE_LABELS = {
  'jotform-lead': 'Website',
  'quote-request': 'Quote Request',
  'webstore-request': 'Webstore',
  'team-roster': 'Roster',
};
const NEW_UNTOUCHED_MIN_HOURS = 48;
const NEW_UNTOUCHED_MAX_DAYS = 60;
const SECTION_CAP = 15;

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Today's calendar date in Pacific, as 'YYYY-MM-DD' (Due_Date is stored that way).
function todayPT(now) {
  const d = now instanceof Date ? now : new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const isIsoDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function daysBetweenIso(fromDay, toDay) {
  return Math.round((Date.parse(toDay + 'T12:00:00Z') - Date.parse(fromDay + 'T12:00:00Z')) / 86400000);
}

function parseSubmittedMs(v) {
  const t = Date.parse(String(v || ''));
  return isNaN(t) ? null : t;
}

/**
 * PURE — classify active lead rows into digest buckets (jest target).
 * @param {Array} rows — Form_Submissions rows (lead formIds, non-archived)
 * @param {string} todayStr — 'YYYY-MM-DD' Pacific
 * @param {number} [nowMs] — injectable clock for tests
 * @returns {{overdue:[], dueToday:[], newUntouched:[]}} each item = the row +
 *          {daysOverdue?} — already sorted (overdue oldest-first).
 */
function buildDigestModel(rows, todayStr, nowMs) {
  const now = nowMs || Date.now();
  const overdue = [];
  const dueToday = [];
  const newUntouched = [];

  for (const row of rows || []) {
    if (!row || TERMINAL_STATUSES.includes(row.Status)) continue;
    if (!LEAD_FORM_IDS.includes(row.Form_ID)) continue;

    const due = isIsoDay(row.Due_Date) ? row.Due_Date : '';
    if (due) {
      if (due < todayStr) overdue.push({ ...row, daysOverdue: daysBetweenIso(due, todayStr) });
      else if (due === todayStr) dueToday.push({ ...row });
      continue;
    }

    if (row.Status === 'New') {
      const submitted = parseSubmittedMs(row.Submitted_At);
      if (submitted == null) continue;
      const ageHours = (now - submitted) / 3600000;
      if (ageHours >= NEW_UNTOUCHED_MIN_HOURS && ageHours <= NEW_UNTOUCHED_MAX_DAYS * 24) {
        newUntouched.push({ ...row });
      }
    }
  }

  overdue.sort((a, b) => String(a.Due_Date).localeCompare(String(b.Due_Date)));
  newUntouched.sort((a, b) => String(a.Submitted_At).localeCompare(String(b.Submitted_At)));
  return { overdue, dueToday, newUntouched };
}

/**
 * PURE — group bucketed rows per AE via the loose resolver (Sales_Rep holds
 * FULL display names like "Taneisha Clark"). Unassigned bucket is returned
 * for logging, never emailed.
 */
function groupModelByAE(model) {
  const groups = new Map();
  const unassigned = [];
  const add = (bucket, row) => {
    const email = resolveAEEmailLoose(row.Sales_Rep);
    if (!email) { unassigned.push({ bucket, row }); return; }
    if (!groups.has(email)) {
      groups.set(email, { aeEmail: email, aeName: resolveAEName(email), overdue: [], dueToday: [], newUntouched: [] });
    }
    groups.get(email)[bucket].push(row);
  };
  model.overdue.forEach((r) => add('overdue', r));
  model.dueToday.forEach((r) => add('dueToday', r));
  model.newUntouched.forEach((r) => add('newUntouched', r));
  return { groups: Array.from(groups.values()), unassigned };
}

function rowStyle(kind, daysOverdue) {
  if (kind === 'overdue') {
    return daysOverdue >= 3
      ? { border: '#dc3545', bg: '#fff5f5', accent: '#c0392b' }
      : { border: '#fd7e14', bg: '#fff8f0', accent: '#b85a00' };
  }
  if (kind === 'dueToday') return { border: '#198754', bg: '#f4faf6', accent: '#0f5132' };
  return { border: '#0d6efd', bg: '#f3f7ff', accent: '#0a4fb5' };
}

function fmtValue(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? ' · est. $' + n.toLocaleString('en-US') : '';
}

// Deep link — #hash only (no '='). Opens the full lead workspace (P2).
const LEAD_PAGE = '/dashboards/lead.html#';

function buildRowsHtml(kind, rows) {
  const shown = rows.slice(0, SECTION_CAP);
  const items = shown.map((r) => {
    const style = rowStyle(kind, r.daysOverdue || 0);
    const meta = kind === 'overdue'
      ? `Due ${escapeHtml(r.Due_Date)} — ${r.daysOverdue} day${r.daysOverdue === 1 ? '' : 's'} overdue`
      : kind === 'dueToday' ? 'Due today'
        : 'New — no follow-up set yet';
    const link = SITE_ORIGIN + LEAD_PAGE + encodeURIComponent(r.Submission_ID);
    return '<li style="margin:0 0 10px;padding:10px 14px;background:' + style.bg
      + ';border-left:4px solid ' + style.border + ';border-radius:4px;">'
      + '<a href="' + link + '" style="font-weight:600;color:' + style.accent + ';text-decoration:none;font-size:15px;">'
      + escapeHtml(r.Company || '(no company)') + '</a>'
      + '<span style="color:#333;"> &mdash; ' + escapeHtml(r.Contact_Name || '') + '</span>'
      + '<br><span style="font-size:12px;color:' + style.accent + ';font-weight:600;">' + escapeHtml(meta) + '</span>'
      + '<span style="font-size:12px;color:#555;"> · ' + escapeHtml(SOURCE_LABELS[r.Form_ID] || r.Form_ID)
      + escapeHtml(fmtValue(r.Lead_Value)) + '</span>'
      + '</li>';
  }).join('');
  const more = rows.length > SECTION_CAP
    ? '<p style="font-size:12px;color:#666;margin:4px 0 0;">…and ' + (rows.length - SECTION_CAP) + ' more on the board.</p>'
    : '';
  return '<ul style="list-style:none;padding:0;margin:0;">' + items + '</ul>' + more;
}

// Section header baked INSIDE the html param so the EmailJS template needs
// zero conditionals; empty section → empty string.
function buildSectionHtml(title, emoji, kind, rows) {
  if (!rows.length) return '';
  return '<h3 style="font-size:14px;letter-spacing:.5px;text-transform:uppercase;color:#444;margin:18px 0 8px;">'
    + emoji + ' ' + escapeHtml(title) + ' (' + rows.length + ')</h3>'
    + buildRowsHtml(kind, rows);
}

async function fetchActiveLeadRows() {
  const { fetchAllCaspioPages } = require('./caspio');
  const where = "Form_ID IN ('" + LEAD_FORM_IDS.join("','") + "') AND Status<>'Archived'";
  return fetchAllCaspioPages('/tables/Form_Submissions/records', {
    'q.where': where,
    'q.select': 'Submission_ID,Form_ID,Company,Contact_Name,Email,Sales_Rep,Status,Due_Date,Lead_Value,Submitted_At',
    'q.pageSize': 1000,
    'q.orderBy': 'PK_ID',
  }, { maxPages: 5 });
}

/**
 * Run the follow-up digest. dryRun=true returns the grouping without email.
 */
async function runLeadFollowupDigest(opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;

  const serviceId = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_LEAD_FOLLOWUP_DIGEST;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;
  if (!dryRun) {
    const missing = [
      ['EMAILJS_SERVICE_ID', serviceId],
      ['EMAILJS_TEMPLATE_LEAD_FOLLOWUP_DIGEST', templateId],
      ['EMAILJS_PUBLIC_KEY', publicKey],
      ['EMAILJS_PRIVATE_KEY', privateKey],
    ].filter((p) => !p[1]).map((p) => p[0]);
    if (missing.length) throw new Error('Lead digest misconfigured — missing env vars: ' + missing.join(', '));
  }

  const today = todayPT();
  const rows = await fetchActiveLeadRows();
  const model = buildDigestModel(rows, today);
  const { groups, unassigned } = groupModelByAE(model);

  if (unassigned.length) {
    console.log('[Lead Digest] ' + unassigned.length + ' item(s) with unresolvable Sales_Rep (logged, not emailed): '
      + unassigned.slice(0, 5).map((u) => u.row.Submission_ID + '/' + (u.row.Sales_Rep || 'blank')).join(', '));
  }

  if (dryRun) {
    return {
      dryRun: true,
      today,
      totals: { overdue: model.overdue.length, dueToday: model.dueToday.length, newUntouched: model.newUntouched.length },
      aeGroups: groups.map((g) => ({
        aeEmail: g.aeEmail,
        aeName: g.aeName,
        overdue: g.overdue.map((r) => r.Submission_ID),
        dueToday: g.dueToday.map((r) => r.Submission_ID),
        newUntouched: g.newUntouched.map((r) => r.Submission_ID),
      })),
      unassignedCount: unassigned.length,
    };
  }

  if (!groups.length) {
    console.log('[Lead Digest] Nothing needs attention — no emails sent.');
    return { aesEmailed: 0, reason: 'no-groups', unassignedCount: unassigned.length };
  }

  const digestDate = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const emailjs = require('@emailjs/nodejs');
  const results = [];
  for (const g of groups) {
    const total = g.overdue.length + g.dueToday.length + g.newUntouched.length;
    const templateParams = {
      to_email: g.aeEmail,
      to_name: g.aeName,
      ae_name: g.aeName,
      digest_date: digestDate,
      overdue_count: String(g.overdue.length),
      due_count: String(g.dueToday.length),
      new_count: String(g.newUntouched.length),
      total_count: String(total),
      overdue_html: buildSectionHtml('Overdue follow-ups', '🔴', 'overdue', g.overdue),
      due_html: buildSectionHtml('Due today', '🟢', 'dueToday', g.dueToday),
      new_html: buildSectionHtml('New & untouched', '🔵', 'newUntouched', g.newUntouched),
      board_link: SITE_ORIGIN + '/dashboards/leads.html',
    };
    try {
      const resp = await emailjs.send(serviceId, templateId, templateParams, { publicKey, privateKey });
      results.push({ ae: g.aeEmail, total, ok: true, status: resp.status });
      console.log('[Lead Digest] Sent ' + total + ' item(s) to ' + g.aeEmail + ' (status ' + resp.status + ')');
    } catch (err) {
      const errText = (err && (err.text || err.message)) || JSON.stringify(err);
      results.push({ ae: g.aeEmail, total, ok: false, error: errText });
      console.error('[Lead Digest] Send failed for ' + g.aeEmail + ': ' + errText);
    }
  }

  const aesEmailed = results.filter((r) => r.ok).length;
  console.log('[Lead Digest] ' + aesEmailed + '/' + groups.length + ' AEs emailed.');
  return { aesEmailed, aesAttempted: groups.length, unassignedCount: unassigned.length, results };
}

module.exports = {
  runLeadFollowupDigest,
  // pure (jest targets)
  buildDigestModel,
  groupModelByAE,
  todayPT,
  TERMINAL_STATUSES,
  __test__: { buildSectionHtml, buildRowsHtml, fmtValue },
};
