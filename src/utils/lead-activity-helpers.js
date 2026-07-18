// lead-activity-helpers.js — pure validators for the Lead_Activity timeline
// (src/routes/lead-activity.js). Imports NOTHING (jest-safe, same reason as
// form-submission-helpers.js).
'use strict';

const ACTIVITY_TYPES = ['note', 'status', 'attachment', 'quote', 'system', 'email'];

// Activity_Text is a Caspio TEXT column (64K) — long-cap, NOT the default
// 255-char S() from form-submission-helpers.
const TEXT_MAX = 60000;
const longText = (v) => String(v == null ? '' : v).trim().slice(0, TEXT_MAX);
const shortText = (v, max = 255) => String(v == null ? '' : v).trim().slice(0, max);

const SUBMISSION_ID_RE = /^[A-Za-z0-9-]{1,40}$/;

// Attachment URLs may only point at our own proxy file server or JotForm
// uploads (mirrors the Leads drawer's extractFileUrls allow-list) — never an
// arbitrary customer-typed URL.
const JOTFORM_UPLOAD_RE = /^https:\/\/((www\.)?jotform\.com\/uploads\/|files\.jotform\.com\/)\S+$/i;
const FILES_KEY_RE = /^\/api\/files\/[A-Za-z0-9-]{8,}(\?[A-Za-z0-9=&_-]*)?$/;

/**
 * @param {string} url — candidate Attachment_URL
 * @param {string} filesBase — this proxy's own origin (e.g. https://caspio-…herokuapp.com)
 */
function isAllowedAttachmentUrl(url, filesBase) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (JOTFORM_UPLOAD_RE.test(u)) return true;
  const base = String(filesBase || '').replace(/\/+$/, '');
  if (base && u.startsWith(base)) return FILES_KEY_RE.test(u.slice(base.length));
  return false;
}

/**
 * Validate a POST /api/lead-activity body. Returns { errors, record } —
 * record is the Caspio-ready row (minus Created_At, which the route stamps
 * server-side).
 */
function validateActivity(body, filesBase) {
  body = body || {};
  const errors = [];

  const submissionId = shortText(body.submissionId, 40);
  if (!SUBMISSION_ID_RE.test(submissionId)) errors.push('submissionId is required (letters/digits/dashes)');

  const type = shortText(body.activityType, 40);
  if (!ACTIVITY_TYPES.includes(type)) errors.push(`activityType must be one of: ${ACTIVITY_TYPES.join(', ')}`);

  const text = longText(body.activityText);
  const attachmentUrl = shortText(body.attachmentUrl, 255);
  if (!text && !attachmentUrl) errors.push('activityText or attachmentUrl is required');
  if (attachmentUrl && !isAllowedAttachmentUrl(attachmentUrl, filesBase)) {
    errors.push('attachmentUrl must be a proxy /api/files/ URL or a JotForm upload URL');
  }

  const createdBy = shortText(body.createdBy, 120);
  if (!createdBy) errors.push('createdBy is required');

  return {
    errors,
    record: {
      Submission_ID: submissionId,
      Activity_Type: type,
      Activity_Text: text,
      Attachment_URL: attachmentUrl,
      Created_By: createdBy,
      Parent_PK: null,
    },
  };
}

module.exports = { ACTIVITY_TYPES, TEXT_MAX, longText, shortText, isAllowedAttachmentUrl, validateActivity };
