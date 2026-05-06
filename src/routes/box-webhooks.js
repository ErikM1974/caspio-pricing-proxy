// box-webhooks.js — Box V2 webhook receiver for proactive break detection.
//
// When a file inside BOX_ART_FOLDER_ID or BOX_MOCKUP_FOLDER_ID is trashed,
// deleted, or moved out of the watched tree, Box POSTs an event here. We:
//   1. Verify the HMAC-SHA256 signature (Box's standard webhook auth)
//   2. Find Caspio rows that reference the affected fileId
//   3. Fire the existing auto-recovery routine for each row
//   4. Bust the broken-mockups caches so digests + dashboards refresh fast
//
// This is Layer 2 of the Box link-stability plan (see
// .claude/plans/look-at-the-screenshot-dapper-badger.md). Layer 1
// (permission downgrade) and Layer 3 (display-time auto-heal) are
// independent. Layer 2 only kicks in when Layers 1 + 3 don't catch the
// break — e.g., file moved silently overnight; webhook fires; Caspio gets
// rewritten before staff opens the dashboard in the morning.
//
// Setup (one-time, manual):
//   1. In Box Developer Console → your app → Webhooks V2 tab, register
//      a webhook on each of the two parent folders with triggers
//      FILE.TRASHED, FILE.DELETED, ITEM.MOVED, and address
//      `${PUBLIC_URL}/api/box/webhook`.
//   2. Copy the primary + secondary keys to Heroku config:
//        BOX_WEBHOOK_PRIMARY_KEY, BOX_WEBHOOK_SECONDARY_KEY
//   3. Optionally set BOX_WEBHOOK_ENABLED=false to disable processing
//      while keeping the endpoint reachable (Box rejects unreachable URLs).

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const router = express.Router();

const config = require('../../config');
const { getCaspioAccessToken } = require('../utils/caspio');
const { getBoxAccessToken } = require('../utils/box-client');
const { recoverBrokenMockup } = require('../utils/recover-broken-mockup');
const { recoverBrokenRuthMockup } = require('../utils/recover-broken-ruth-mockup');

const PRIMARY_KEY = process.env.BOX_WEBHOOK_PRIMARY_KEY || '';
const SECONDARY_KEY = process.env.BOX_WEBHOOK_SECONDARY_KEY || '';
const WEBHOOK_ENABLED = process.env.BOX_WEBHOOK_ENABLED !== 'false';
const MAX_AGE_MS = 10 * 60 * 1000; // 10 min — Box recommendation for replay protection
const BREAK_TRIGGERS = new Set(['FILE.TRASHED', 'FILE.DELETED', 'ITEM.MOVED']);
const ART_FIELDS = ['Box_File_Mockup', 'BoxFileLink', 'Company_Mockup', 'Additional_Art_1', 'Additional_Art_2'];
const RUTH_FIELDS = ['Box_Mockup_1', 'Box_Mockup_2', 'Box_Mockup_3', 'Box_Mockup_4', 'Box_Mockup_5', 'Box_Mockup_6', 'Box_Reference_File'];

// ── Signature Verification ────────────────────────────────────────────

function verifySignature(rawBody, deliveryId, deliveryTimestamp, signaturePrimary, signatureSecondary) {
    if (!rawBody) return false;
    // Box accepts EITHER key matching — supports key rotation without downtime.
    const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const tryKey = (key, sig) => {
        if (!key || !sig) return false;
        const h = crypto.createHmac('sha256', key);
        h.update(buf);
        h.update(deliveryTimestamp);
        h.update(deliveryId);
        const computed = h.digest('base64');
        try {
            return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
        } catch (e) {
            return false;
        }
    };
    return tryKey(PRIMARY_KEY, signaturePrimary) || tryKey(SECONDARY_KEY, signatureSecondary);
}

function isFresh(deliveryTimestamp) {
    if (!deliveryTimestamp) return false;
    const t = Date.parse(deliveryTimestamp);
    if (isNaN(t)) return false;
    return Math.abs(Date.now() - t) <= MAX_AGE_MS;
}

// ── Caspio Lookup ─────────────────────────────────────────────────────

/**
 * Find Caspio rows referencing a Box fileId, returning everything the
 * recovery routines need (designNumber, companyName, slot field, row id).
 * Distinct from findBoxFileReferences in box-upload.js (which only returns
 * what the delete-guard needs).
 */
async function findReferencesWithRecoveryData(fileId) {
    const token = await getCaspioAccessToken();
    const pattern = `thumbnail/${fileId}`;
    const refs = [];

    // ArtRequests (Steve) — single recoverable slot is Box_File_Mockup,
    // but we still surface other fields so we can log non-recoverable hits.
    try {
        const where = ART_FIELDS.map(f => `${f} LIKE '%${pattern}%'`).join(' OR ');
        const resp = await axios.get(`${config.caspio.apiBaseUrl}/tables/ArtRequests/records`, {
            params: {
                'q.where': where,
                'q.select': 'PK_ID,ID_Design,Design_Num_SW,CompanyName,' + ART_FIELDS.join(','),
                'q.pageSize': 50
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 10000
        });
        (resp.data.Result || []).forEach(row => {
            ART_FIELDS.forEach(f => {
                if (row[f] && row[f].indexOf(pattern) !== -1) {
                    refs.push({
                        table: 'ArtRequests',
                        pkId: row.PK_ID,
                        designId: row.ID_Design,
                        slotField: f,
                        designNumber: row.Design_Num_SW || '',
                        companyName: row.CompanyName || '',
                        recoverable: f === 'Box_File_Mockup'
                    });
                }
            });
        });
    } catch (e) {
        console.warn('[BOX_WEBHOOK] ArtRequests lookup failed:', e.message);
    }

    // Digitizing_Mockups (Ruth) — all 7 slot fields are recoverable.
    try {
        const where = RUTH_FIELDS.map(f => `${f} LIKE '%${pattern}%'`).join(' OR ');
        const resp = await axios.get(`${config.caspio.apiBaseUrl}/tables/Digitizing_Mockups/records`, {
            params: {
                'q.where': where,
                'q.select': 'ID,PK_ID,Design_Number,Company_Name,' + RUTH_FIELDS.join(','),
                'q.pageSize': 50
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 10000
        });
        (resp.data.Result || []).forEach(row => {
            RUTH_FIELDS.forEach(f => {
                if (row[f] && row[f].indexOf(pattern) !== -1) {
                    refs.push({
                        table: 'Digitizing_Mockups',
                        // Ruth's auto-recover route uses ID, not PK_ID
                        id: row.ID || row.PK_ID,
                        slotField: f,
                        designNumber: row.Design_Number || '',
                        companyName: row.Company_Name || '',
                        recoverable: true
                    });
                }
            });
        });
    } catch (e) {
        console.warn('[BOX_WEBHOOK] Digitizing_Mockups lookup failed:', e.message);
    }

    return refs;
}

// ── Recovery Dispatcher ───────────────────────────────────────────────

async function dispatchRecovery(ref) {
    const publicUrl = (config.app && config.app.publicUrl) || '';
    if (ref.table === 'ArtRequests') {
        if (!ref.recoverable) {
            return { ref, status: 'skip-not-recoverable' };
        }
        const result = await recoverBrokenMockup({
            pkId: ref.pkId,
            designNumber: ref.designNumber,
            companyName: ref.companyName,
            getBoxToken: getBoxAccessToken,
            publicUrl
        });
        return { ref, ...result };
    }
    if (ref.table === 'Digitizing_Mockups') {
        const result = await recoverBrokenRuthMockup({
            id: ref.id,
            slotField: ref.slotField,
            designNumber: ref.designNumber,
            companyName: ref.companyName,
            getBoxToken: getBoxAccessToken,
            publicUrl
        });
        return { ref, ...result };
    }
    return { ref, status: 'skip-unknown-table' };
}

function bustCachesSafely() {
    // Both caches live in their respective route modules. We require lazily
    // to avoid circular-require issues at boot. Either failure is harmless
    // — the next 10-min cache TTL will flush naturally.
    try {
        const { invalidateBrokenMockupsCache } = require('./box-upload');
        if (typeof invalidateBrokenMockupsCache === 'function') invalidateBrokenMockupsCache();
    } catch (e) { /* defensive */ }
    try {
        const { invalidateRuthBrokenMockupsCache } = require('./mockup-routes');
        if (typeof invalidateRuthBrokenMockupsCache === 'function') invalidateRuthBrokenMockupsCache();
    } catch (e) { /* defensive */ }
}

// ── Endpoint ──────────────────────────────────────────────────────────

/**
 * POST /api/box/webhook
 *
 * Box delivers JSON events here. We respond 200 quickly (Box requires
 * <10s) and process recovery synchronously when the impact is small,
 * else fire-and-forget. Either way we always return 200 unless the
 * signature is bad — Box auto-disables webhooks that 4xx/5xx repeatedly.
 *
 * Required headers from Box:
 *   box-delivery-id, box-delivery-timestamp,
 *   box-signature-primary, box-signature-secondary,
 *   box-signature-version (must be "1"),
 *   box-signature-algorithm (must be "HmacSHA256")
 */
router.post('/box/webhook', async (req, res) => {
    const deliveryId = req.headers['box-delivery-id'];
    const deliveryTimestamp = req.headers['box-delivery-timestamp'];
    const sigPrimary = req.headers['box-signature-primary'];
    const sigSecondary = req.headers['box-signature-secondary'];
    const sigVersion = req.headers['box-signature-version'];
    const sigAlgo = req.headers['box-signature-algorithm'];

    if (sigVersion !== '1' || sigAlgo !== 'HmacSHA256') {
        console.warn('[BOX_WEBHOOK] Unsupported signature version/algorithm', { sigVersion, sigAlgo });
        return res.status(403).end();
    }
    if (!isFresh(deliveryTimestamp)) {
        console.warn('[BOX_WEBHOOK] Stale or missing timestamp — replay protection rejected', { deliveryTimestamp });
        return res.status(403).end();
    }

    // express.json's verify hook stashes raw bytes on req.rawBody (see server.js).
    if (!verifySignature(req.rawBody, deliveryId, deliveryTimestamp, sigPrimary, sigSecondary)) {
        console.warn('[BOX_WEBHOOK] Signature mismatch', { deliveryId });
        return res.status(403).end();
    }

    const event = req.body || {};
    const trigger = event.trigger;
    const fileId = event.source && event.source.id;
    const sourceType = event.source && event.source.type;

    // Only file-trigger events matter for thumbnail breakage.
    if (sourceType !== 'file' || !BREAK_TRIGGERS.has(trigger)) {
        return res.status(200).end();
    }

    if (!WEBHOOK_ENABLED) {
        console.log(`[BOX_WEBHOOK] disabled — would have processed ${trigger} for fileId=${fileId}`);
        return res.status(200).end();
    }

    // Respond 200 immediately; do the work async so Box's 10s deadline is safe.
    res.status(200).end();

    try {
        const refs = await findReferencesWithRecoveryData(String(fileId));
        if (refs.length === 0) {
            console.log(`[BOX_WEBHOOK] ${trigger} fileId=${fileId} — no Caspio refs, no-op`);
            return;
        }
        console.log(`[BOX_WEBHOOK] ${trigger} fileId=${fileId} — ${refs.length} Caspio ref(s), starting recovery`);

        const results = [];
        for (const ref of refs) {
            try {
                const r = await dispatchRecovery(ref);
                results.push(r);
            } catch (e) {
                results.push({ ref, status: 'error', error: e.message || String(e) });
            }
        }

        const recovered = results.filter(r => r.status === 'recovered').length;
        console.log(`[BOX_WEBHOOK] ${trigger} fileId=${fileId} — ${recovered}/${results.length} recovered`);

        if (recovered > 0) bustCachesSafely();
    } catch (err) {
        console.error('[BOX_WEBHOOK] async processing failed:', err.message || err);
    }
});

// Test/debug helper — lets ops verify the route is mounted without sending a real event.
router.get('/box/webhook/health', (req, res) => {
    res.json({
        ok: true,
        enabled: WEBHOOK_ENABLED,
        primaryKeyConfigured: !!PRIMARY_KEY,
        secondaryKeyConfigured: !!SECONDARY_KEY,
        triggers: Array.from(BREAK_TRIGGERS)
    });
});

module.exports = router;
// Export internals for test harness.
module.exports.__test__ = {
    verifySignature,
    isFresh,
    findReferencesWithRecoveryData,
    dispatchRecovery
};
