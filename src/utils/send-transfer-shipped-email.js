// Shipment notification email for heat-transfer orders.
//
// Fires from src/utils/transfer-status-mirror.js when Supacolor marks a job
// as shipped (Status='Closed' or Date_Shipped set) and we auto-flip the
// matching Transfer_Orders row to 'Shipped'.
//
// Recipients (confirmed by Erik 2026-04-23):
//   To: Transfer_Orders.Requested_By       (usually Steve = art@nwcustomapparel.com)
//   CC: mikalah@, ruth@, brian.beardsley@, bradley@
//   Dedup: if the requester is in the CC list, drop the duplicate.
//
// Env vars (set on Heroku caspio-pricing-proxy):
//   EMAILJS_SERVICE_ID             — shared with send-steve-digest.js
//   EMAILJS_PUBLIC_KEY             — shared
//   EMAILJS_PRIVATE_KEY            — shared
//   EMAILJS_TEMPLATE_TRANSFER_SHIPPED  — new template ID (Erik creates in EmailJS)
//   TRANSFER_SHIP_NOTIFY_CC        — optional override, comma-separated
//   SITE_ORIGIN                    — for detail_link (defaults teamnwca.com)

const emailjs = require('@emailjs/nodejs');

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';

// Hardcoded fallback — keeps the email working if env var is unset.
const DEFAULT_CC_LIST = [
    'mikalah@nwcustomapparel.com',
    'ruth@nwcustomapparel.com',
    'brian.beardsley@nwcustomapparel.com',
    'bradley@nwcustomapparel.com'
];

function resolveCcList() {
    const raw = process.env.TRANSFER_SHIP_NOTIFY_CC;
    if (!raw) return DEFAULT_CC_LIST.slice();
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function trackingUrl(carrier, tracking) {
    if (!tracking) return '';
    const c = String(carrier || '').toLowerCase();
    const t = encodeURIComponent(tracking);
    if (c.indexOf('fedex') >= 0) return 'https://www.fedex.com/fedextrack/?tracknumbers=' + t;
    if (c.indexOf('ups') >= 0) return 'https://www.ups.com/track?tracknum=' + t;
    if (c.indexOf('usps') >= 0) return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + t;
    if (c.indexOf('dhl') >= 0) return 'https://www.dhl.com/en/express/tracking.html?AWB=' + t;
    return '';
}

function formatDate(iso) {
    if (!iso) return '—';
    try {
        // Caspio strips Z — append if missing so JS doesn't interpret as local
        const norm = String(iso).endsWith('Z') ? iso : (iso.replace(' ', 'T') + 'Z');
        const d = new Date(norm);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) {
        return '—';
    }
}

/**
 * Send the transfer-shipped notification.
 *
 * @param {object} transfer — Transfer_Orders row (AFTER the Status='Shipped' update)
 * @param {object} supaJob  — Supacolor_Jobs row that drove the transition
 * @returns {Promise<{sent:boolean, skipped?:string, emailjsStatus?:number}>}
 */
async function sendTransferShippedEmail(transfer, supaJob) {
    if (!transfer) return { sent: false, skipped: 'no transfer record' };

    const serviceId  = process.env.EMAILJS_SERVICE_ID;
    const templateId = process.env.EMAILJS_TEMPLATE_TRANSFER_SHIPPED;
    const publicKey  = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;

    if (!serviceId || !templateId || !publicKey || !privateKey) {
        // Soft-fail — log and move on. Better to ship the status flip
        // than to block it on a misconfigured email template.
        const missing = [
            ['EMAILJS_SERVICE_ID', serviceId],
            ['EMAILJS_TEMPLATE_TRANSFER_SHIPPED', templateId],
            ['EMAILJS_PUBLIC_KEY', publicKey],
            ['EMAILJS_PRIVATE_KEY', privateKey]
        ].filter(p => !p[1]).map(p => p[0]);
        console.warn('[transfer-shipped-email] misconfigured — missing:', missing.join(', '));
        return { sent: false, skipped: 'misconfigured: ' + missing.join(',') };
    }

    const to = transfer.Requested_By || '';
    if (!to) {
        console.warn('[transfer-shipped-email] no Requested_By on transfer ' + transfer.ID_Transfer);
        return { sent: false, skipped: 'no requester' };
    }

    // Dedup: remove the requester from the CC list if present (so they don't
    // get the same email twice).
    const ccList = resolveCcList().filter(addr => addr.toLowerCase() !== to.toLowerCase());

    const carrier  = (supaJob && supaJob.Carrier) || transfer.Carrier || '';
    const tracking = (supaJob && supaJob.Tracking_Number) || transfer.Tracking_Number || '';
    const track    = trackingUrl(carrier, tracking);
    const shipDate = (supaJob && supaJob.Date_Shipped) || transfer.Estimated_Ship_Date || '';

    const templateParams = {
        to_email:           to,
        to_name:            transfer.Requested_By_Name || 'there',
        cc_email:           ccList.join(','),
        id_transfer:        transfer.ID_Transfer || '',
        design_number:      transfer.Design_Number || '',
        company_name:       transfer.Company_Name || '(no company)',
        customer_name:      transfer.Customer_Name || '',
        quantity:           transfer.Quantity || '—',
        transfer_size:      transfer.Transfer_Size || '—',
        supacolor_num:      (supaJob && supaJob.Supacolor_Job_Number) || transfer.Supacolor_Order_Number || '',
        carrier:            carrier || '—',
        shipping_method:    (supaJob && supaJob.Shipping_Method) || transfer.Shipping_Method || '',
        tracking_number:    tracking || '—',
        tracking_url:       track,
        date_shipped:       formatDate(shipDate),
        requested_by_name:  transfer.Requested_By_Name || transfer.Requested_By || '',
        detail_link:        SITE_ORIGIN + '/pages/transfer-detail.html?id=' + encodeURIComponent(transfer.ID_Transfer || ''),
        subject_line:       'Transfer shipped — ' + (transfer.Company_Name || '')
                             + ' (' + (transfer.ID_Transfer || '')
                             + ')' + (carrier ? ' · ' + carrier : '')
                             + (tracking ? ' ' + tracking : '')
    };

    try {
        const resp = await emailjs.send(serviceId, templateId, templateParams, {
            publicKey: publicKey,
            privateKey: privateKey
        });
        console.log('[transfer-shipped-email] sent — ' + transfer.ID_Transfer
            + ' to ' + to + ' (cc ' + ccList.length + '). EmailJS: ' + resp.status);
        return { sent: true, emailjsStatus: resp.status, to, ccCount: ccList.length };
    } catch (err) {
        console.error('[transfer-shipped-email] EmailJS send failed for ' + transfer.ID_Transfer + ':', err && err.text || err.message || err);
        return { sent: false, skipped: 'emailjs error: ' + (err && err.text || err.message) };
    }
}

module.exports = { sendTransferShippedEmail };
