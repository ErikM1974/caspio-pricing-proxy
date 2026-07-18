// send-lead-email.js — EmailJS "new lead" notification to the assigned rep.
//
// Fired fire-and-forget by src/utils/jotform.js insertLead() right after the
// Caspio insert + #form-leads Slack card, so the AE the routing rule picked
// (exact-email customer match → their AE; otherwise Taneisha) hears about the
// lead without watching Slack.
//
// Email pipe: EmailJS (@emailjs/nodejs) — same service + credentials as every
// other send-* util in this directory (backend-only private key, passed
// per-send, no emailjs.init()).
//
// RESOLVES, NEVER THROWS — a lead must always save even if email fails.
// Misconfiguration or an unknown template is a logged skip/fail, never a 500.

const emailjs = require('@emailjs/nodejs');

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://teamnwca.com';

// EmailJS template that renders the new-lead email (Erik creates it once in
// the EmailJS dashboard on the same service). Params: to_email, to_name,
// lead_id, company, contact_name, contact_email, contact_phone, summary,
// source, customer_note, lead_link, from_name.
const TEMPLATE_ID = 'template_new_lead';

// Rep display name (the Sales_Rep column / Sales_Reps_2026.CustomerServiceRep
// spelling) → inbox. Blank/unknown reps fall back to Taneisha — she owns
// unrouted leads (Erik's routing rule, 2026-07-18).
const REP_EMAILS = {
    'taneisha clark': 'taneisha@nwcustomapparel.com',
    'nika lao': 'nika@nwcustomapparel.com',
    'erik mickelson': 'erik@nwcustomapparel.com',
    'jim mickelson': 'jim@nwcustomapparel.com',
    'bradley wright': 'bradley@nwcustomapparel.com',
    'steve deland': 'art@nwcustomapparel.com',
    'ruth nhong': 'ruth@nwcustomapparel.com',
    'general sales': 'sales@nwcustomapparel.com',
};
const DEFAULT_LEAD_INBOX = 'taneisha@nwcustomapparel.com';

/**
 * Resolve a rep display name to an inbox. Tolerates first-name-only drift
 * ('Taneisha' vs 'Taneisha Clark' — ShopWorks CSR strings vary). Unknown or
 * blank → Taneisha's inbox.
 */
function repEmailFor(repName) {
    const key = String(repName || '').trim().toLowerCase();
    if (!key) return DEFAULT_LEAD_INBOX;
    if (REP_EMAILS[key]) return REP_EMAILS[key];
    const first = key.split(/\s+/)[0];
    const hit = Object.keys(REP_EMAILS).find((k) => k.split(/\s+/)[0] === first);
    return hit ? REP_EMAILS[hit] : DEFAULT_LEAD_INBOX;
}

/**
 * Pure helper — build the EmailJS template params for one lead.
 *
 * NOTE: the lead link deliberately carries NO '=' — quoted-printable encoding
 * mangles '=' inside delivered links (see send-art-note-email.js). The Leads
 * board opens the lead from the '#Submission_ID' hash instead.
 */
function buildParams(args) {
    args = args || {};
    const record = args.record || {};
    return {
        to_email: repEmailFor(record.Sales_Rep),
        to_name: record.Sales_Rep || 'Taneisha Clark',
        lead_id: record.Submission_ID || '',
        company: record.Company || '(no company)',
        contact_name: record.Contact_Name || '',
        contact_email: record.Email || '',
        contact_phone: record.Phone || '',
        summary: record.Summary || '',
        source: args.sourceTitle || 'Website',
        customer_note: record.Matched_ID_Customer
            ? 'Existing ShopWorks customer #' + record.Matched_ID_Customer +
              (args.matchedCompany ? ' — ' + args.matchedCompany : '')
            : 'New prospect (no ShopWorks match)',
        lead_link: SITE_ORIGIN + '/dashboards/leads.html#' + encodeURIComponent(record.Submission_ID || ''),
        from_name: 'NWCA Leads',
    };
}

/**
 * Send one "new lead" email to the assigned rep via EmailJS.
 *
 * @param {object} args
 * @param {object} args.record        — the Form_Submissions record just inserted.
 * @param {string} [args.sourceTitle] — which JotForm form it came through.
 * @param {string} [args.matchedCompany] — matched ShopWorks company name, if any.
 * @returns {Promise<{sent:boolean, skipped?:string, error?:string}>} always resolves.
 */
async function sendLeadEmail(args) {
    const params = buildParams(args);

    const serviceId = process.env.EMAILJS_SERVICE_ID;
    const publicKey = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;
    if (!serviceId || !publicKey || !privateKey) {
        const missing = [
            ['EMAILJS_SERVICE_ID', serviceId],
            ['EMAILJS_PUBLIC_KEY', publicKey],
            ['EMAILJS_PRIVATE_KEY', privateKey],
        ].filter((p) => !p[1]).map((p) => p[0]);
        console.log('[LEAD_EMAIL_SKIP]', 'missing-env', missing.join(','), 'lead=' + params.lead_id);
        return { sent: false, skipped: 'missing-env' };
    }

    try {
        const resp = await emailjs.send(serviceId, TEMPLATE_ID, params, {
            publicKey: publicKey,
            privateKey: privateKey,
        });
        console.log('[LEAD_EMAIL_OK]', 'lead=' + params.lead_id, 'to=' + params.to_email,
            'status=' + (resp && resp.status));
        return { sent: true };
    } catch (err) {
        // @emailjs/nodejs rejects with {status, text} objects lacking .message.
        const errText = (err && (err.text || err.message)) || JSON.stringify(err);
        console.log('[LEAD_EMAIL_FAIL]', 'lead=' + params.lead_id, 'to=' + params.to_email, errText);
        return { sent: false, error: errText };
    }
}

module.exports = {
    sendLeadEmail,
    repEmailFor,
    __test__: { buildParams, REP_EMAILS, TEMPLATE_ID },
};
