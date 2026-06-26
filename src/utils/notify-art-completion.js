// notify-art-completion.js — alert the AE-of-record when their art request is
// marked "Completed".
//
// WHY THIS EXISTS: completion used to notify the AE only via a browser EmailJS
// call that (a) resolved the recipient from the free-text `Sales_Rep` display
// name through a first-name-keyed map, so full names like "Nika Lao" fell
// through to sales@nwcustomapparel.com, and (b) had no Slack path at all (the
// channel ping to #art-notifications only reaches Steve/Ruth). This moves the
// AE alert server-side so EVERY completion surface (gallery + detail page) is
// covered identically and reliably:
//   - EMAIL via sendArtNoteEmail (server-side EmailJS, proven template_art_note_added)
//   - SLACK DM straight to the AE via slack-dm-notify (chat.postMessage)
//
// Recipient resolution prefers the free-text Sales_Rep (full-name tolerant via
// resolveAEEmailLoose) and falls back to the record's User_Email. Both go
// through the @nwcustomapparel.com guard so a customer email is never targeted.
//
// RESOLVES, NEVER THROWS — fired fire-and-forget from the status route, which
// must succeed even if email/Slack are down.

const { resolveAEEmail, resolveAEName, resolveAEEmailLoose } = require('./rep-email-map');
const { sendArtNoteEmail } = require('./send-art-note-email');
const { sendSlackDM } = require('./slack-dm-notify');

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://teamnwca.com';

/**
 * Resolve the AE email for a completed art request.
 * Sales_Rep (free-text, often a full name) first, then User_Email. Returns
 * null when neither yields an internal address (e.g. blank rep + customer email).
 */
function resolveCompletionRecipient(salesRep, userEmail) {
    return resolveAEEmailLoose(salesRep) || resolveAEEmail(userEmail) || null;
}

/**
 * Notify the AE that their artwork is complete (email + Slack DM).
 *
 * @param {object} record
 * @param {number|string} record.idDesign   — ID_Design (used in the link + email).
 * @param {string} [record.company]          — CompanyName.
 * @param {string} [record.designNumSW]      — Design_Num_SW (shown in messages).
 * @param {string} [record.salesRep]         — Sales_Rep (free-text name/email).
 * @param {string} [record.userEmail]        — User_Email fallback.
 * @param {string} [record.actor]            — who completed it (for "from").
 * @returns {Promise<{toEmail:string|null, email?:object, dm?:object, skipped?:string}>}
 *          Always resolves.
 */
async function notifyArtCompletionToAE(record) {
    record = record || {};
    try {
        const toEmail = resolveCompletionRecipient(record.salesRep, record.userEmail);
        if (!toEmail) {
            console.log('[ART_COMPLETE_NOTIFY_SKIP]', 'no-recipient',
                'design=' + (record.idDesign != null ? record.idDesign : ''),
                'rep=' + (record.salesRep || ''));
            return { toEmail: null, skipped: 'no-recipient' };
        }

        const company = record.company || '';
        const designLabel = record.designNumSW ? ('#' + record.designNumSW) : ('#' + record.idDesign);
        const fromName = record.actor ? (record.actor + ' — Art Department') : 'Steve — Art Department';
        const noteText = 'Your artwork for ' + (company || 'this order') + ' (' + designLabel
            + ') is complete and ready for production.';

        const emailP = sendArtNoteEmail({
            toEmail: toEmail,
            toName: resolveAEName(record.salesRep || toEmail),
            fromName: fromName,
            idDesign: record.idDesign,
            company: company,
            noteType: 'Artwork Completed',
            noteText: noteText,
            recipientIsRep: true
        });

        const detailUrl = SITE_ORIGIN + '/art-request/' + record.idDesign + '?ae';
        const dmText = '🎯 *Artwork Completed* — ' + (company || 'a request') + ' ' + designLabel
            + ' is done and ready for production.\n<' + detailUrl + '|View art request>';
        const dmP = sendSlackDM(toEmail, dmText);

        const [email, dm] = await Promise.all([emailP, dmP]);
        return { toEmail: toEmail, email: email, dm: dm };
    } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        console.warn('[ART_COMPLETE_NOTIFY_FAIL]',
            'design=' + (record.idDesign != null ? record.idDesign : ''), msg);
        return { toEmail: null, skipped: 'error', error: msg };
    }
}

module.exports = {
    notifyArtCompletionToAE,
    __test__: { resolveCompletionRecipient }
};
