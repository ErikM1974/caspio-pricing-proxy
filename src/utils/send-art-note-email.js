// send-art-note-email.js — EmailJS sender for a single art-request note.
//
// Part of the two-way Art Hub note-notification feature. When a note is
// added to an art request, the backend POST /api/design-notes handler fires
// this (and a Slack notifier) so the RIGHT person hears about the reply:
//   - an AE's note  -> Steve (art@nwcustomapparel.com)
//   - Steve/Ruth's note -> the rep of record
//   - watchers (prior posters on the design) get a copy regardless
//
// One recipient per call — the route loops over the recipient set and calls
// this once per address.
//
// Email pipe: EmailJS (@emailjs/nodejs) — same service + credentials as
// send-ae-approval-digest.js / send-steve-digest.js. Authenticated with the
// backend-only private key, passed per-send (no emailjs.init()), matching
// every other sender in this directory.
//
// RESOLVES, NEVER THROWS — a note must always save even if email fails. The
// route fires this fire-and-forget; a rejected promise would surface as an
// unhandled rejection, so we always return a {sent, skipped?, error?} object.

const emailjs = require('@emailjs/nodejs');

// Match the Slack notifier's default (no www.) per feature spec — the link
// host used in the email's detail_link.
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://teamnwca.com';

// EmailJS template that renders the note-added email. Its params (used here
// and by the frontend that previously sent this): to_email, to_name,
// design_id, company_name, note_type, header_emoji, header_title, note_text,
// detail_link, from_name.
const TEMPLATE_ID = 'template_art_note_added';

/**
 * Pure helper — build the EmailJS template params for one recipient.
 * Exported via __test__ so tests can assert the detail_link suffix logic
 * (?view=ae for reps) without actually sending.
 *
 * The same EmailJS template (template_art_note_added) renders both art-request
 * notes and digitizing-mockup notes, so two optional args let a mockup note
 * link to its own detail page without a second template:
 *   args.detailPath — '/art-request/' (default) or '/mockup/'.
 *   args.linkId     — the id used IN the link (Digitizing_Mockups.ID for a
 *                     mockup), distinct from the displayed design_id which
 *                     stays args.idDesign (the human-facing Design_Number).
 *                     Defaults to idDesign so existing art callers are
 *                     unchanged.
 *
 * @param {object} args — same shape as sendArtNoteEmail's argument.
 * @returns {object} EmailJS templateParams.
 */
function buildParams(args) {
    args = args || {};
    var idDesign = args.idDesign;
    var basePath = args.detailPath || '/art-request/';
    var linkId = (args.linkId != null && args.linkId !== '') ? args.linkId : idDesign;
    // Reps land on the AE view of the detail page; Steve/Ruth get the plain
    // detail page. recipientIsRep drives the only difference.
    var detailLink = SITE_ORIGIN + basePath + linkId
        + (args.recipientIsRep ? '?view=ae' : '');

    return {
        to_email:     args.toEmail,
        to_name:      args.toName || 'there',
        design_id:    String(idDesign),
        company_name: args.company || '',
        note_type:    args.noteType || 'Note',
        header_emoji: '📝',
        header_title: args.noteType || 'New Note',
        note_text:    args.noteText || '',
        detail_link:  detailLink,
        from_name:    args.fromName || 'NWCA Art Hub'
    };
}

/**
 * Send a single "note added" email via EmailJS.
 *
 * @param {object}  args
 * @param {string}  args.toEmail        — recipient address (required; no send if blank).
 * @param {string}  [args.toName]       — recipient display name.
 * @param {string}  [args.fromName]     — who wrote the note (shown as "from").
 * @param {number|string} args.idDesign — ID_Design of the art request.
 * @param {string}  [args.company]      — company name for the email body.
 * @param {string}  [args.noteType]     — note type / header title.
 * @param {string}  [args.noteText]     — the note body.
 * @param {boolean} [args.recipientIsRep] — true => detail_link gets ?view=ae.
 * @param {string}  [args.detailPath]   — link base path ('/art-request/' default, '/mockup/' for mockups).
 * @param {number|string} [args.linkId] — id used in the link (defaults to idDesign).
 * @returns {Promise<{sent:boolean, skipped?:string, error?:string}>}
 *          Always resolves — never throws.
 */
async function sendArtNoteEmail(args) {
    args = args || {};
    var toEmail = args.toEmail;

    if (!toEmail) {
        console.log('[ART_NOTE_EMAIL_SKIP]', 'no-recipient', 'design=' + (args.idDesign != null ? args.idDesign : ''));
        return { sent: false, skipped: 'no-recipient' };
    }

    var serviceId  = process.env.EMAILJS_SERVICE_ID;
    var publicKey  = process.env.EMAILJS_PUBLIC_KEY;
    var privateKey = process.env.EMAILJS_PRIVATE_KEY;

    if (!serviceId || !publicKey || !privateKey) {
        var missing = [
            ['EMAILJS_SERVICE_ID', serviceId],
            ['EMAILJS_PUBLIC_KEY', publicKey],
            ['EMAILJS_PRIVATE_KEY', privateKey]
        ].filter(function (p) { return !p[1]; }).map(function (p) { return p[0]; });
        // Misconfiguration is a skip, not a throw — the note still saves.
        console.log('[ART_NOTE_EMAIL_SKIP]', 'missing-env', missing.join(','));
        return { sent: false, skipped: 'missing-env' };
    }

    var templateParams = buildParams(args);

    try {
        var resp = await emailjs.send(serviceId, TEMPLATE_ID, templateParams, {
            publicKey: publicKey,
            privateKey: privateKey
        });
        console.log('[ART_NOTE_EMAIL_OK]', 'design=' + templateParams.design_id,
            'to=' + toEmail, 'status=' + (resp && resp.status));
        return { sent: true };
    } catch (err) {
        // @emailjs/nodejs rejects with EmailJSResponseStatus objects ({status,
        // text}) which lack err.message — capture both shapes for useful logs.
        var errText = (err && (err.text || err.message)) || JSON.stringify(err);
        console.log('[ART_NOTE_EMAIL_FAIL]', 'design=' + templateParams.design_id,
            'to=' + toEmail, errText);
        return { sent: false, error: errText };
    }
}

module.exports = {
    sendArtNoteEmail,
    __test__: { buildParams }
};
