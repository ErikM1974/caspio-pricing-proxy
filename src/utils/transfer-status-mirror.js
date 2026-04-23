// Transfer status mirror — flips Transfer_Orders.Status → 'Shipped' when the
// linked Supacolor_Jobs record enters a shipped-signal state (Closed, or Date_Shipped set).
//
// Called from 3 paths in supacolor-jobs.js after an upsert:
//   - POST /sync/all       (cron — stub data: Status + Date_Shipped, no tracking)
//   - POST /sync/:jobNumber (deep — includes Tracking_Number + Carrier)
//   - POST /upsert          (paste-OCR backfill)
//
// Also fires the shipment email to Steve + Mikalah + Ruthie + Brian + Bradley
// once the transition happens — see send-transfer-shipped-email.js for the payload.

const axios = require('axios');
const config = require('../../config');
const { sendTransferShippedEmail } = require('./send-transfer-shipped-email');
const caspioApiBaseUrl = config.caspio.apiBaseUrl;

const TRANSFER_TABLE = 'Transfer_Orders';
const NOTES_TABLE = 'Transfer_Order_Notes';

// Status values the Transfer_Orders state machine uses. Mirror only fires when
// we're BEFORE these terminal states — past those, Bradley has already dealt with it.
const TRANSFER_TERMINAL_STATUSES = ['Shipped', 'Received', 'Cancelled'];

function escapeSQL(s) {
    return String(s == null ? '' : s).replace(/'/g, "''");
}

/**
 * Is this Supacolor job in a state that means it shipped?
 * Mirrors the logic in supacolor-jobs.js hasShippedSignal().
 */
function isShippedSignal(supaJob) {
    if (!supaJob) return false;
    if (supaJob.Date_Shipped) return true;
    if (supaJob.Status === 'Closed') return true;
    // 'Dispatched' comes from the API passthrough before bucketing to Closed.
    // Keeping it here defensively in case upstream mapping changes.
    if (supaJob.Status === 'Dispatched') return true;
    return false;
}

/**
 * Look up Transfer_Orders row by Supacolor_Order_Number.
 * Returns null if no match.
 */
async function fetchTransferBySupaNumber(token, supaJobNumber) {
    const url = `${caspioApiBaseUrl}/tables/${TRANSFER_TABLE}/records?q.where=Supacolor_Order_Number='${escapeSQL(supaJobNumber)}'`;
    try {
        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const records = resp.data && resp.data.Result;
        return (records && records[0]) || null;
    } catch (err) {
        console.error('[transfer-mirror] Transfer lookup failed:', err.response ? JSON.stringify(err.response.data) : err.message);
        return null;
    }
}

/**
 * Write a status_change note to Transfer_Order_Notes.
 */
async function writeMirrorNote(token, transferId, noteText) {
    try {
        const url = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records`;
        await axios.post(url, {
            Transfer_ID: transferId,
            Note_Type: 'status_change',
            Note_Text: noteText,
            Author_Email: 'supacolor-sync@nwcustomapparel.com',
            Author_Name: 'Supacolor API (auto)'
        }, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });
    } catch (err) {
        // Non-fatal — the status change itself is what matters.
        console.warn('[transfer-mirror] Note write failed (non-fatal):', err.message);
    }
}

/**
 * Main entry: given an upserted Supacolor_Jobs payload, flip the matching
 * Transfer_Orders row to 'Shipped' if the signals warrant it.
 *
 * @param {string} token — Caspio access token (caller's existing context)
 * @param {object} supaJob — Supacolor_Jobs payload as it exists AFTER the upsert
 *                           (must include Supacolor_Job_Number, Status; optionally
 *                           Date_Shipped, Tracking_Number, Carrier, Shipping_Method)
 * @returns {Promise<{transitioned: boolean, transferId?: string, transfer?: object}>}
 */
async function mirrorShippedToTransfer(token, supaJob) {
    if (!supaJob || !supaJob.Supacolor_Job_Number) {
        return { transitioned: false };
    }
    if (!isShippedSignal(supaJob)) {
        return { transitioned: false };
    }

    const transfer = await fetchTransferBySupaNumber(token, supaJob.Supacolor_Job_Number);
    if (!transfer) {
        return { transitioned: false };
    }
    if (TRANSFER_TERMINAL_STATUSES.includes(transfer.Status)) {
        return { transitioned: false, transfer };
    }
    if (!transfer.ID_Transfer) {
        console.warn('[transfer-mirror] Transfer matched but has no ID_Transfer:', transfer);
        return { transitioned: false };
    }

    const update = {
        Status: 'Shipped'
    };
    if (supaJob.Tracking_Number && !transfer.Tracking_Number) update.Tracking_Number = supaJob.Tracking_Number;
    if (supaJob.Carrier && !transfer.Carrier) update.Carrier = supaJob.Carrier;
    if (supaJob.Shipping_Method && !transfer.Shipping_Method) update.Shipping_Method = supaJob.Shipping_Method;
    if (supaJob.Date_Shipped && !transfer.Estimated_Ship_Date) update.Estimated_Ship_Date = supaJob.Date_Shipped;

    const safeId = escapeSQL(transfer.ID_Transfer);
    const url = `${caspioApiBaseUrl}/tables/${TRANSFER_TABLE}/records?q.where=ID_Transfer='${safeId}'`;

    try {
        await axios.put(url, update, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });
    } catch (err) {
        console.error(`[transfer-mirror] Failed to flip ${transfer.ID_Transfer} to Shipped:`, err.response ? JSON.stringify(err.response.data) : err.message);
        return { transitioned: false };
    }

    const noteParts = [`Status changed: ${transfer.Status} → Shipped (Supacolor auto-sync)`];
    if (supaJob.Supacolor_Job_Number) noteParts.push(`Supacolor #${supaJob.Supacolor_Job_Number}`);
    if (update.Tracking_Number) noteParts.push(`Tracking: ${update.Tracking_Number}`);
    if (update.Carrier) noteParts.push(`Carrier: ${update.Carrier}`);
    await writeMirrorNote(token, transfer.ID_Transfer, noteParts.join(' | '));

    console.log(`[transfer-mirror] ${transfer.ID_Transfer} → Shipped (Supacolor #${supaJob.Supacolor_Job_Number})`);

    // Merge the update into the transfer object so the email sender sees the latest shape
    const updatedTransfer = Object.assign({}, transfer, update);

    // D.4 — fire shipment email. Non-blocking: log failures but don't roll back
    // the status flip. The status change is what's important; a missed email can be
    // re-sent manually.
    try {
        await sendTransferShippedEmail(updatedTransfer, supaJob);
    } catch (emailErr) {
        console.warn('[transfer-mirror] shipment email failed (non-fatal):', emailErr.message);
    }

    return { transitioned: true, transferId: transfer.ID_Transfer, transfer: updatedTransfer };
}

module.exports = {
    mirrorShippedToTransfer,
    isShippedSignal
};
