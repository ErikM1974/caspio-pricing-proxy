// jotform.js — JotForm → Form_Submissions lead ingest (Leads CRM).
//
// One normalizer feeds all three ingest paths — webhook (rawRequest shape),
// daily reconcile and CSV backfill (REST `answers` shape) — so rows are
// byte-identical no matter how a lead arrived. Rows land in Form_Submissions
// as Form_ID='jotform-lead' (prefix JFL) with External_ID = the JotForm
// submissionID as the app-level dedupe key.
//
// Routing rule (Erik, 2026-07-18): a lead whose email exact-matches a
// CompanyContactsMerge2026 contact is assigned that customer's AE (contact
// Sales_Rep, falling back to Sales_Reps_2026.CustomerServiceRep) and gets
// Matched_ID_Customer auto-linked; everything else defaults to Taneisha Clark.
// Fuzzy company matches never auto-route — the Leads page shows suggestions.
//
// Pure parsing/build helpers are exported with NO caspio import at module
// load (jest-safe, same reason as form-submission-helpers.js); everything
// that touches Caspio/Slack lazy-requires inside the function body.

'use strict';

const crypto = require('crypto');
const {
  DEFAULT_STATUS, S, nowIso, buildSubmissionId,
} = require('./form-submission-helpers');

// ── Registry ──────────────────────────────────────────────────────────

const JOTFORM_FORMS = {
  '21764724640151': { title: 'Leads NWCA #1', variant: 'lead' },
  '220514824751149': { title: 'NW Embroidery Information Request', variant: 'info-request' },
  '243035771645458': { title: 'Leads Decosource', variant: 'lead' },
  '240425236898464': { title: 'Apparel Leads #1', variant: 'lead' },
  '242285010362042': { title: 'Webstore Contact Form', variant: 'webstore-contact' },
  '233535928059162': { title: 'NW Custom Apparel Franchise Inquiry', variant: 'franchise' },
};

// Display-name spelling matches the quote builders' rep dropdowns and the
// ShopWorks CSR names in CompanyContactsMerge2026.Sales_Rep.
const DEFAULT_LEAD_REP = 'Taneisha Clark';

const CONTACTS_TABLE = 'CompanyContactsMerge2026';
const REPS_TABLE = 'Sales_Reps_2026';
const SUBMISSIONS_PATH = '/tables/Form_Submissions/records';
const JOTFORM_API_BASE = 'https://api.jotform.com';
// JotForm reports created_at in the ACCOUNT timezone (Settings → Account).
const JOTFORM_TZ = process.env.JOTFORM_TZ || 'America/Los_Angeles';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Pure: entry extraction (two upstream shapes → one entry list) ─────

function humanize(slug) {
  return String(slug || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

// Webhook rawRequest: { "q3_email": "...", "q4_firstName": "...", "event_id": ... }
function entriesFromRawRequest(raw) {
  const out = [];
  for (const [key, value] of Object.entries(raw || {})) {
    const m = /^q\d+_(.+)$/.exec(key);
    if (!m) continue; // non-question metadata (event_id, path, …)
    out.push({ slug: m[1], label: humanize(m[1]), value, type: '' });
  }
  return out;
}

// REST API submission.answers: { "3": { name, text, type, answer }, … }
const SKIP_CONTROL_TYPES = new Set([
  'control_button', 'control_captcha', 'control_head', 'control_text',
  'control_pagebreak', 'control_image', 'control_divider', 'control_widget',
]);
function entriesFromApiAnswers(answers) {
  const out = [];
  for (const a of Object.values(answers || {})) {
    if (!a || a.answer === undefined || a.answer === null || a.answer === '') continue;
    if (SKIP_CONTROL_TYPES.has(a.type)) continue;
    const slug = String(a.name || '');
    out.push({
      slug,
      label: String(a.text || '').replace(/\s*:\s*$/, '').trim() || humanize(slug),
      value: a.answer,
      type: String(a.type || ''),
    });
  }
  return out;
}

// ── Pure: value rendering + classification ────────────────────────────

function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function valueToText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(', ');
  if (isPlainObject(value)) {
    if ('first' in value || 'last' in value) {
      return [value.prefix, value.first, value.middle, value.last, value.suffix].filter(Boolean).join(' ').trim();
    }
    if ('addr_line1' in value || 'city' in value || 'postal' in value) {
      return [
        value.addr_line1, value.addr_line2,
        [value.city, value.state].filter(Boolean).join(', '),
        value.postal, value.country,
      ].filter(Boolean).join(', ');
    }
    if ('full' in value) return String(value.full || '').trim();
    if ('area' in value || 'phone' in value) {
      const area = String(value.area || '').trim();
      return [area ? `(${area})` : '', String(value.phone || '').trim()].filter(Boolean).join(' ');
    }
    if ('datetime' in value) return String(value.datetime);
    if ('year' in value && 'month' in value && 'day' in value) return `${value.year}-${value.month}-${value.day}`;
    return Object.values(value).map(valueToText).filter(Boolean).join(' ');
  }
  return String(value).trim();
}

function extractUploadUrls(value) {
  const flat = Array.isArray(value) ? value : [value];
  return flat
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => /^https?:\/\/\S+/i.test(v));
}

// Slug → semantic kind. Compact key = lowercase alphanumerics only.
function classify(slug) {
  const k = String(slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!k) return 'other';
  if (k === 'hp' || k === 'submit' || /(captcha|verify|verification|honeypot)/.test(k)) return 'skip';
  if (/(upload|artwork|attach)/.test(k) || k.endsWith('file') || k.includes('filesform')) return 'upload';
  if (k.includes('email')) return 'email';
  if (k.includes('phone') || k.includes('cell')) return 'phone';
  if (k.includes('firstname') || k === 'first') return 'firstName';
  if (k.includes('lastname') || k === 'last') return 'lastName';
  if (k === 'name' || k === 'fullname' || k === 'yourname' || k === 'contactname') return 'name';
  if (/(company|business|organization|organisation|group|school)/.test(k)) return 'company';
  if (/(description|quoterequest|message|comments|additionalinformation|needs|whydoyou|tellus|inquiry)/.test(k)) return 'description';
  return 'other';
}

// ── Pure: normalization ───────────────────────────────────────────────

const PAYLOAD_MAX_CHARS = 60000; // Payload_JSON is Caspio TEXT (64K) — leave headroom

function capPayload(payload) {
  let json = JSON.stringify(payload);
  if (json.length <= PAYLOAD_MAX_CHARS) return payload;
  const capped = {
    ...payload,
    fields: (payload.fields || []).map(([l, v]) => [l, String(v).slice(0, 500)]),
  };
  json = JSON.stringify(capped);
  if (json.length <= PAYLOAD_MAX_CHARS) return capped;
  return { ...capped, fields: capped.fields.slice(0, 60) };
}

function normalizeEntries(formID, entries, submissionId) {
  const form = JOTFORM_FORMS[formID] || { title: `JotForm ${formID}`, variant: 'unknown' };
  let email = ''; let phone = ''; let company = '';
  let first = ''; let last = ''; let fullName = '';
  const descriptions = [];
  const artworkUrls = [];
  const fields = []; // [label, value] pairs — same self-describing style as the form twins

  for (const e of entries) {
    const kind = classify(e.slug);
    if (kind === 'skip') continue;

    if (kind === 'upload' || e.type === 'control_fileupload') {
      const urls = extractUploadUrls(e.value);
      urls.forEach((u) => artworkUrls.push(u));
      const text = urls.length ? urls.join(', ') : valueToText(e.value);
      if (text) fields.push([e.label, text]);
      continue;
    }

    const text = valueToText(e.value);
    if (!text) continue;

    switch (kind) {
      case 'email': if (!email && EMAIL_RE.test(text)) email = text.toLowerCase(); break;
      case 'phone': if (!phone) phone = text; break;
      case 'company': if (!company) company = text; break;
      case 'firstName': if (!first) first = text; break;
      case 'lastName': if (!last) last = text; break;
      case 'name': if (!fullName) fullName = text; break;
      case 'description': descriptions.push(text); break;
      default: break;
    }
    fields.push([e.label, text]);
  }

  const contactName = (fullName || [first, last].filter(Boolean).join(' ')).trim();
  if (!email) {
    // fallback: any field whose whole value is an email address
    const hit = fields.find(([, v]) => EMAIL_RE.test(String(v)));
    if (hit) email = String(hit[1]).toLowerCase();
  }
  const resolvedCompany = company || (contactName ? `Individual — ${contactName}` : '(no company)');
  const summary = (descriptions.join(' | ') || `${form.title} lead`).slice(0, 250);

  const payload = capPayload({
    fields,
    artworkUrls,
    _source: {
      system: 'jotform',
      formId: String(formID),
      formTitle: form.title,
      submissionId: String(submissionId || ''),
      url: submissionId ? `https://www.jotform.com/submission/${submissionId}` : '',
    },
  });

  return { email, phone, company: resolvedCompany, contactName, summary, payload };
}

const normalizeFromRawRequest = (formID, raw, submissionId) =>
  normalizeEntries(formID, entriesFromRawRequest(raw), submissionId);
const normalizeFromApiAnswers = (formID, answers, submissionId) =>
  normalizeEntries(formID, entriesFromApiAnswers(answers), submissionId);

// ── Pure: assignment pick + record build ──────────────────────────────

const isActiveish = (v) => v === 1 || v === '1' || v === true || v === 'true' || v === 'Yes';

// Prefer active customers, then rows that actually carry an AE, then most recent.
function pickBestContact(rows) {
  const usable = (rows || []).filter((r) => r && (r.id_Customer != null || S(r.Sales_Rep)));
  if (!usable.length) return null;
  return usable.sort((a, b) =>
    (isActiveish(b.Is_Active) - isActiveish(a.Is_Active)) ||
    (!!S(b.Sales_Rep) - !!S(a.Sales_Rep)) ||
    String(b.Last_Order_Date || '').localeCompare(String(a.Last_Order_Date || '')))[0];
}

function buildLeadRecord({ formID, submissionId, normalized, assign, opts = {} }) {
  return {
    Submission_ID: buildSubmissionId('jotform-lead'),
    Form_ID: 'jotform-lead',
    Company: S(normalized.company),
    Contact_Name: S(normalized.contactName),
    Phone: S(normalized.phone, 60),
    Email: S(normalized.email),
    Customer_Number: '',
    Sales_Rep: S((assign && assign.salesRep) || DEFAULT_LEAD_REP, 80),
    Due_Date: '',
    Status: opts.status || DEFAULT_STATUS['jotform-lead'],
    Summary: S(normalized.summary, 250),
    Payload_JSON: JSON.stringify(normalized.payload),
    Submitted_At: opts.submittedAtIso || nowIso(),
    Updated_At: nowIso(),
    Updated_By: opts.updatedBy || '',
    Art_Request_ID: '',
    External_Source: `jotform:${formID}`,
    External_ID: String(submissionId),
    Matched_ID_Customer: S((assign && assign.matchedIdCustomer) || ''),
    Linked_Quote_ID: '',
  };
}

// Webhook auth — hash both sides so timingSafeEqual never throws on length.
function timingSafeSecretCompare(given, expected) {
  if (!given || !expected) return false;
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

// ── Timezone: JotForm account-local "YYYY-MM-DD HH:MM:SS" → ISO UTC ──

function zoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? 0 : p.hour), +p.minute, +p.second);
  return asUTC - date.getTime();
}

function toIsoFromZone(s, timeZone = JOTFORM_TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return nowIso();
  const utcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return new Date(utcGuess - zoneOffsetMs(new Date(utcGuess), timeZone)).toISOString();
}

function zonedNowMinusDays(days, timeZone = JOTFORM_TZ) {
  const d = new Date(Date.now() - days * 86400000);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
}

// ── Caspio/Slack-touching functions (lazy requires — jest-safe) ───────

async function assignLead(normalized) {
  const fallback = { salesRep: DEFAULT_LEAD_REP, matchedIdCustomer: '', matchedCompany: '' };
  const email = normalized && normalized.email;
  if (!email || !EMAIL_RE.test(email)) return fallback;
  try {
    const { fetchAllCaspioPages } = require('./caspio');
    const { escWhere } = require('./where-guards');
    const rows = await fetchAllCaspioPages(`/tables/${CONTACTS_TABLE}/records`, {
      'q.where': `Email='${escWhere(email)}'`,
      'q.select': 'id_Customer,Company_Name,Sales_Rep,Is_Active,Last_Order_Date',
      'q.pageSize': 25,
    }, { maxPages: 1 });
    const best = pickBestContact(rows);
    if (!best) return fallback;

    let rep = S(best.Sales_Rep, 80);
    const custId = parseInt(best.id_Customer, 10);
    if (!rep && Number.isFinite(custId) && custId > 0) {
      const reps = await fetchAllCaspioPages(`/tables/${REPS_TABLE}/records`, {
        'q.where': `ID_Customer=${custId}`,
        'q.select': 'CustomerServiceRep',
        'q.pageSize': 5,
      }, { maxPages: 1 });
      rep = S(reps && reps[0] && reps[0].CustomerServiceRep, 80);
    }
    return {
      salesRep: rep || DEFAULT_LEAD_REP,
      matchedIdCustomer: best.id_Customer != null ? String(best.id_Customer) : '',
      matchedCompany: S(best.Company_Name),
    };
  } catch (e) {
    // Assignment is routing enrichment — a lookup hiccup must NEVER drop a lead.
    console.warn('[jotform] assignLead lookup failed — defaulting rep:', e.message);
    return fallback;
  }
}

async function existsByExternalId(externalId) {
  const { fetchAllCaspioPages } = require('./caspio');
  const { escWhere } = require('./where-guards');
  const rows = await fetchAllCaspioPages(SUBMISSIONS_PATH, {
    'q.where': `External_ID='${escWhere(String(externalId))}'`,
    'q.select': 'Submission_ID',
    'q.pageSize': 5,
  }, { maxPages: 1 });
  return !!(rows && rows.length);
}

/**
 * Ingest one JotForm submission → Form_Submissions row (+ Slack lead card).
 * knownExternalIds (optional Set) lets reconcile prefetch dedupe state in one
 * Caspio call instead of one lookup per submission.
 */
async function insertLead({ formID, submissionId, normalized, via, opts = {}, knownExternalIds }) {
  const extId = String(submissionId || '').trim();
  if (!JOTFORM_FORMS[formID]) return { skipped: 'unknown-form', formID };
  if (!extId) return { skipped: 'no-submission-id', formID };

  const isDupe = knownExternalIds ? knownExternalIds.has(extId) : await existsByExternalId(extId);
  if (isDupe) return { skipped: 'duplicate', formID, externalId: extId };

  const assign = await assignLead(normalized);
  const record = buildLeadRecord({
    formID, submissionId: extId, normalized, assign,
    opts: { updatedBy: via || 'jotform', ...opts },
  });

  const { makeCaspioRequest } = require('./caspio');
  try {
    await makeCaspioRequest('post', SUBMISSIONS_PATH, {}, record);
  } catch (e) {
    // one retry on the (rare) Submission_ID unique collision
    record.Submission_ID = buildSubmissionId('jotform-lead');
    await makeCaspioRequest('post', SUBMISSIONS_PATH, {}, record);
  }
  if (knownExternalIds) knownExternalIds.add(extId);

  const { notifyFormLead } = require('./slack-form-lead-notify');
  notifyFormLead({
    formId: 'jotform-lead',
    submissionId: record.Submission_ID,
    company: record.Company,
    contactName: record.Contact_Name,
    phone: record.Phone,
    email: record.Email,
    summary: record.Summary,
    rep: record.Sales_Rep,
    sourceTitle: JOTFORM_FORMS[formID].title,
  });

  console.log(`[jotform] ingested ${record.Submission_ID} (${JOTFORM_FORMS[formID].title}, ext ${extId}) → ${record.Sales_Rep}${record.Matched_ID_Customer ? ` [customer ${record.Matched_ID_Customer}]` : ''} via ${via}`);
  return { inserted: true, record };
}

// ── JotForm REST ──────────────────────────────────────────────────────

async function fetchJotformSubmissions(formID, { filter, limit = 1000, offset = 0, orderby = 'id' } = {}) {
  const key = process.env.JOTFORM_API_KEY || '';
  if (!key) throw new Error('JOTFORM_API_KEY is not set');
  const axios = require('axios');
  const resp = await axios.get(`${JOTFORM_API_BASE}/form/${formID}/submissions`, {
    headers: { APIKEY: key },
    params: {
      limit, offset, orderby,
      ...(filter ? { filter: JSON.stringify(filter) } : {}),
    },
    timeout: 30000,
  });
  return (resp.data && resp.data.content) || [];
}

/**
 * Pull the last `days` of submissions from all 6 forms and ingest any the
 * table doesn't have (webhook-miss backstop). One dedupe prefetch total.
 */
async function reconcileRecent(days = 2, { limitPerForm = 200 } = {}) {
  const { fetchAllCaspioPages } = require('./caspio');
  const cutoffIso = new Date(Date.now() - (days + 1) * 86400000).toISOString();
  const existing = await fetchAllCaspioPages(SUBMISSIONS_PATH, {
    'q.where': `Form_ID='jotform-lead' AND Submitted_At>'${cutoffIso}'`,
    'q.select': 'External_ID',
    'q.pageSize': 500,
    'q.orderBy': 'PK_ID',
  }, { maxPages: 4 });
  const known = new Set((existing || []).map((r) => String(r.External_ID || '')).filter(Boolean));

  const jotformCutoff = zonedNowMinusDays(days);
  const report = { days, forms: {}, inserted: 0, skipped: 0, fetched: 0 };
  for (const formID of Object.keys(JOTFORM_FORMS)) {
    const subs = await fetchJotformSubmissions(formID, {
      filter: { 'created_at:gt': jotformCutoff },
      limit: limitPerForm,
    });
    const tally = { fetched: 0, inserted: 0, skipped: 0 };
    for (const sub of subs) {
      if (!sub || String(sub.status || '').toUpperCase() === 'DELETED') continue;
      tally.fetched += 1;
      const normalized = normalizeFromApiAnswers(formID, sub.answers, sub.id);
      const result = await insertLead({
        formID,
        submissionId: sub.id,
        normalized,
        via: 'jotform-reconcile',
        opts: { submittedAtIso: toIsoFromZone(sub.created_at) },
        knownExternalIds: known,
      });
      if (result.inserted) tally.inserted += 1; else tally.skipped += 1;
    }
    report.forms[JOTFORM_FORMS[formID].title] = tally;
    report.fetched += tally.fetched;
    report.inserted += tally.inserted;
    report.skipped += tally.skipped;
  }
  return report;
}

module.exports = {
  JOTFORM_FORMS,
  DEFAULT_LEAD_REP,
  JOTFORM_TZ,
  // pure (jest-safe imports)
  entriesFromRawRequest,
  entriesFromApiAnswers,
  normalizeFromRawRequest,
  normalizeFromApiAnswers,
  valueToText,
  classify,
  pickBestContact,
  buildLeadRecord,
  timingSafeSecretCompare,
  toIsoFromZone,
  zonedNowMinusDays,
  // caspio/slack-touching (lazy-required internals)
  assignLead,
  existsByExternalId,
  insertLead,
  fetchJotformSubmissions,
  reconcileRecent,
};
