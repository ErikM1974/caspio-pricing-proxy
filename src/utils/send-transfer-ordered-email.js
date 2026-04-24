// Ordered notification email for heat-transfer orders.
//
// Fires from src/utils/transfer-auto-link.js when a newly-synced Supacolor job
// is auto-linked back to Steve's originating Transfer_Order. The transition
// Status='Requested' → 'Ordered' means Bradley has placed the order on
// supacolor.com and we know the Supacolor_Job_Number.
//
// Recipients:
//   To: Transfer_Orders.Sales_Rep_Email  (the account rep — Ruth/Nika/Taneisha/etc.)
//   CC: Steve (art@nwcustomapparel.com) + Requested_By if different from sales rep
//   Fallback when Sales_Rep_Email is empty: send only to Steve (still gets the audit record)
//
// Re-uses the SAME EmailJS template Bradley's manual status flip would hit
// (template_id 'transfer_ordered' on service_jgrave3) — so the email body
// looks identical regardless of whether a human or cron did the flip.
//
// Env vars (set on Heroku caspio-pricing-proxy):
//   EMAILJS_SERVICE_ID              — shared with other transfer emails
//   EMAILJS_PUBLIC_KEY              — shared
//   EMAILJS_PRIVATE_KEY             — shared
//   EMAILJS_TEMPLATE_TRANSFER_ORDERED  — template ID (default 'transfer_ordered')
//   SITE_ORIGIN                     — for detail_link (defaults teamnwca.com)

const emailjs = require('@emailjs/nodejs');

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
const STEVE_EMAIL = 'art@nwcustomapparel.com';

function formatDate(iso) {
    if (!iso) return '—';
    try {
        const norm = String(iso).endsWith('Z') ? iso : (String(iso).replace(' ', 'T') + 'Z');
        const d = new Date(norm);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) {
        return '—';
    }
}

/**
 * Send the transfer-ordered notification.
 *
 * @param {object} transfer — Transfer_Orders row (AFTER the Status='Ordered' update;
 *   must include Supacolor_Order_Number, Sales_Rep_Email, Sales_Rep_Name,
 *   Company_Name, Design_Number, ID_Transfer, Requested_By_Name)
 * @param {object} supaJob — Supacolor_Jobs row that triggered the link
 * @returns {Promise<{sent:boolean, skipped?:string, emailjsStatus?:number, to?:string, cc?:string}>}
 */
async function sendTransferOrderedEmail(transfer, supaJob) {
    if (!transfer) return { sent: false, skipped: 'no transfer record' };

    const serviceId  = process.env.EMAILJS_SERVICE_ID;
    const templateId = process.env.EMAILJS_TEMPLATE_TRANSFER_ORDERED || 'transfer_ordered';
    const publicKey  = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;

    if (!serviceId || !publicKey || !privateKey) {
        const missing = [
            ['EMAILJS_SERVICE_ID', serviceId],
            ['EMAILJS_PUBLIC_KEY', publicKey],
            ['EMAILJS_PRIVATE_KEY', privateKey]
        ].filter(p => !p[1]).map(p => p[0]);
        console.warn('[transfer-ordered-email] misconfigured — missing:', missing.join(', '));
        return { sent: false, skipped: 'misconfigured: ' + missing.join(',') };
    }

    // Recipients: sales rep is primary; Steve always CC'd; requester CC'd if
    // different from sales rep. Deduplicate.
    const salesRep = (transfer.Sales_Rep_Email || '').toLowerCase();
    const requester = (transfer.Requested_By || '').toLowerCase();

    let to = salesRep || STEVE_EMAIL;  // fallback to Steve if no sales rep captured
    const ccSet = new Set();
    ccSet.add(STEVE_EMAIL);
    if (requester && requester !== to) ccSet.add(requester);
    ccSet.delete(to.toLowerCase()); // never CC the TO recipient

    const ccList = Array.from(ccSet);

    const supaNum = (supaJob && supaJob.Supacolor_Job_Number) || transfer.Supacolor_Order_Number || '';
    const supaLocation = (supaJob && supaJob.Location) || '';
    const estShipDate = (supaJob && supaJob.Requested_Ship_Date) || transfer.Estimated_Ship_Date || '';

    const templateParams = {
        to_email:         to,
        to_name:          transfer.Sales_Rep_Name || 'there',
        cc_email:         ccList.join(','),
        id_transfer:      transfer.ID_Transfer || '',
        design_number:    transfer.Design_Number || '',
        company_name:     transfer.Company_Name || '(no company)',
        customer_name:    transfer.Customer_Name || '',
        rep_name:         transfer.Sales_Rep_Name || '',
        rep_email:        transfer.Sales_Rep_Email || '',
        supacolor_num:    supaNum,
        supacolor_location: supaLocation,
        transfer_type:    transfer.Transfer_Type || '—',
        estimated_ship_date: formatDate(estShipDate),
        actor_name:       'Auto-link (Supacolor sync)',
        actor_email:      'auto-link@nwcustomapparel.com',
        requested_by_name: transfer.Requested_By_Name || transfer.Requested_By || '',
        current_status:   'Ordered',
        detail_link:      SITE_ORIGIN + '/pages/transfer-detail.html?id=' + encodeURIComponent(transfer.ID_Transfer || ''),
        subject_line:     'Transfer ordered — ' + (transfer.Company_Name || '')
                          + ' (' + (transfer.ID_Transfer || '') + ')'
                          + (supaNum ? ' \u2192 Supacolor #' + supaNum : '')
    };

    try {
        const resp = await emailjs.send(serviceId, templateId, templateParams, {
            publicKey: publicKey,
            privateKey: privateKey
        });
        console.log('[transfer-ordered-email] sent — ' + transfer.ID_Transfer
            + ' to ' + to + ' (cc ' + ccList.length + '). EmailJS: ' + resp.status);
        return { sent: true, emailjsStatus: resp.status, to, cc: ccList.join(',') };
    } catch (err) {
        console.error('[transfer-ordered-email] EmailJS send failed for ' + transfer.ID_Transfer + ':',
            err && err.text || err.message || err);
        return { sent: false, skipped: 'emailjs error: ' + (err && err.text || err.message) };
    }
}

module.exports = { sendTransferOrderedEmail };
