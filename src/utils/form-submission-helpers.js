// form-submission-helpers.js — pure helpers for src/routes/form-submissions.js.
// Deliberately imports NOTHING (no utils/caspio chain — api-tracker holds a timer
// that keeps jest's event loop alive), so tests/jest/form-submissions-cardstrip
// can import these directly without open handles.
'use strict';

const FORM_PREFIX = {
  'garment-drop-off': 'DRP',
  'artwork-request': 'ART',
  'name-personalization': 'NAM',
  'sample-checkout': 'SMP',
  'ae-order-intake': 'AEO',
  'final-qc-checklist': 'QCC',
  'spoilage-report': 'SPL',
  'maintenance-log': 'MNT', // one formId for all 6 equipment types (type in payload)
  // 2026-07-11 batch 2 (Erik-approved 7)
  'customer-onboarding': 'ONB',
  'team-roster': 'RST',
  'webstore-request': 'WSR',   // WEB is a quote prefix — WSR avoids the collision
  'credit-application': 'CRD',
  'tax-exempt-cert': 'TAX',    // Due_Date = cert expiration → "Due in 7 days" widget
  'pto-request': 'PTO',        // Due_Date = first day of leave
  'injury-report': 'INJ',
  'credit-card-auth': 'CCA',   // stores IDENTITY only (last4/expiry) — PAN/CVV never; strip enforced
  'quote-request': 'QRQ',      // PUBLIC customer lead form — Slack-notified on arrival
  'jotform-lead': 'JFL',       // JotForm website leads (6 forms) — ingested by src/routes/jotform.js, never posted by a twin
};

const DEFAULT_STATUS = {
  'garment-drop-off': 'New',
  'artwork-request': 'New',
  'name-personalization': 'New',
  'sample-checkout': 'Checked Out',
  'ae-order-intake': 'New',
  'final-qc-checklist': 'New',
  'spoilage-report': 'New',
  'maintenance-log': 'Logged',
  'customer-onboarding': 'New',
  'team-roster': 'New',
  'webstore-request': 'New',
  'credit-application': 'Under Review',
  'tax-exempt-cert': 'New',
  'pto-request': 'Pending',
  'injury-report': 'Open',
  'credit-card-auth': 'New',
  'quote-request': 'New',
  'jotform-lead': 'New',
};

// PUBLIC lead forms → Slack ping on arrival (the Inbox is pull; a quote lead
// sitting unseen for a day is a lost sale). webstore-request doubles as the
// staff twin AND the public inquiry — both are worth a ping. team-roster is
// linked from the webstore spokes' names-and-numbers sections (2026-07-16) —
// a customer roster arriving silently would read as "order placed" to them.
const LEAD_NOTIFY_FORMS = new Set(['quote-request', 'webstore-request', 'team-roster', 'jotform-lead']);

// Forms whose payloads must NEVER carry card data — stripCardFields() runs
// server-side on these regardless of what the client sends. credit-card-auth
// deliberately stores only card IDENTITY under non-card-ish labels ("Ending
// in", "Good through") — PCI allows last4+expiry; PAN/CVV labels get eaten.
const CARD_STRIPPED_FORMS = new Set(['sample-checkout', 'credit-card-auth']);

// Any payload key that smells like card data is dropped for sample-checkout.
// Substring matches are chosen to avoid innocent collisions: 'exp' is exact-only
// (else 'expected' dies) and 'pan' is exact-only (else 'company' dies).
const CARD_KEY_RE = /(card|cvv|cvc|last\s*4)/i;
const CARD_KEY_EXACT = new Set(['exp', 'fldexp', 'expiry', 'expiration', 'pan']);

const isCardKey = (k) => typeof k === 'string' && (CARD_KEY_RE.test(k) || CARD_KEY_EXACT.has(k.toLowerCase()));

// Strips card-ish data from object KEYS and from [label, value] pair entries in
// arrays (the twins' self-describing payloads carry fields as label/value pairs).
function stripCardFields(node) {
  if (Array.isArray(node)) {
    return node
      .filter((entry) => !(Array.isArray(entry) && isCardKey(entry[0])))
      .map((entry) => (entry && typeof entry === 'object') ? stripCardFields(entry) : entry);
  }
  if (node && typeof node === 'object') {
    const clean = {};
    for (const [key, value] of Object.entries(node)) {
      if (isCardKey(key)) continue;
      clean[key] = (value && typeof value === 'object') ? stripCardFields(value) : value;
    }
    return clean;
  }
  return node;
}

const sanitizeId = (v) => (typeof v === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(v) ? v : null);
const sanitizeLike = (v) => (typeof v === 'string' ? v.replace(/['"\\%_]/g, '').trim().slice(0, 80) : '');
const isoDay = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
const nowIso = () => new Date().toISOString();
const S = (v, max = 255) => String(v == null ? '' : v).trim().slice(0, max);

function buildSubmissionId(formId) {
  const prefix = FORM_PREFIX[formId];
  const d = new Date();
  const mmdd = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}${mmdd}-${rand}`;
}

function validateSubmission(body) {
  const errors = [];
  if (!FORM_PREFIX[body.formId]) errors.push(`formId must be one of: ${Object.keys(FORM_PREFIX).join(', ')}`);
  if (!S(body.company)) errors.push('company is required');
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) errors.push('payload object is required');
  if (body.items !== undefined && (!Array.isArray(body.items) || body.items.length > 40)) errors.push('items must be an array of at most 40 rows');
  return errors;
}

module.exports = {
  FORM_PREFIX,
  DEFAULT_STATUS,
  CARD_STRIPPED_FORMS,
  LEAD_NOTIFY_FORMS,
  stripCardFields,
  sanitizeId,
  sanitizeLike,
  isoDay,
  nowIso,
  S,
  buildSubmissionId,
  validateSubmission,
};
