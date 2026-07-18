// slack-form-lead-notify.js — POST a Slack incoming-webhook when a PUBLIC
// lead form lands in the Forms Inbox (quote-request, webstore-request).
//
// The Forms Inbox is PULL — staff open it when they think of it. A quote
// lead that sits unseen for a day is a lost sale, so arrival gets a push.
// Fire-and-forget: a Slack failure NEVER fails the save (the customer's
// submission is already in Caspio by the time this runs).
//
// Activation: set `SLACK_FORM_LEADS_WEBHOOK_URL` env (e.g. a #sales-leads
// channel webhook). Unset = silent no-op — no deploy needed to turn on.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_FORM_LEADS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';

const FORM_LABELS = {
  'quote-request': '💬 New QUOTE REQUEST',
  'webstore-request': '🏪 New WEBSTORE inquiry',
  'jotform-lead': '🌐 New WEBSITE LEAD',
  'manual-lead': '📞 New PHONE/WALK-IN LEAD',
};

// rep + sourceTitle are optional (JotForm leads set both: auto-assigned AE or
// the Taneisha default, and which of the 6 JotForm forms it came through).
async function notifyFormLead({ formId, submissionId, company, contactName, phone, email, summary, rep, sourceTitle }) {
  if (!WEBHOOK_URL) return; // not configured — silent no-op by design

  const label = FORM_LABELS[formId] || `📥 New ${formId}`;
  const inboxLink = formId === 'jotform-lead'
    ? `<${SITE_ORIGIN}/dashboards/leads.html|Open the Leads board>`
    : `<${SITE_ORIGIN}/dashboards/form-submissions.html|Open the Forms Inbox>`;
  const lines = [
    `*${label}*${sourceTitle ? ` (${sourceTitle})` : ''} — \`${submissionId}\``,
    `*${company || '(no company)'}*${contactName ? ' · ' + contactName : ''}`,
    [phone, email].filter(Boolean).join(' · '),
    summary || '',
    rep ? `Assigned: *${rep}*` : '',
    inboxLink,
  ].filter(Boolean);

  try {
    await axios.post(WEBHOOK_URL, { text: lines.join('\n') }, { timeout: 5000 });
  } catch (err) {
    console.error('[slack-form-lead] notify failed (save already succeeded):', err.message);
  }
}

module.exports = { notifyFormLead };
