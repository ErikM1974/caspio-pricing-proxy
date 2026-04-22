// Daily broken-mockups digest email to Steve.
//
// Root problem: Steve habitually deletes files via Box's web UI as cleanup.
// Caspio still references those file IDs, so the mockup thumbnails 404 for
// the AE and customer. Steve's dashboard shows a red per-card badge when the
// scan detects this, but only if Steve looks at the dashboard. This digest
// emails him daily so he has an active to-do list of art requests to fix.
//
// Data source: the existing /api/art-requests/broken-mockups scan (cache +
// Box-API HEAD check per referenced fileId). We call it over localhost to
// reuse all of that logic without duplicating it.
//
// Email delivery: EmailJS (@emailjs/nodejs) — same service + templates used
// by the frontend, authenticated via the private key (backend-only).

const axios = require('axios');
const emailjs = require('@emailjs/nodejs');
const config = require('../../config');

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
// Steve's inbox is the shared art department alias, not a personal address.
const STEVE_EMAIL = process.env.STEVE_EMAIL || 'art@nwcustomapparel.com';

// Slot field name → friendly label shown in the email list.
const SLOT_LABELS = {
    Box_File_Mockup:  'Mockup 1',
    BoxFileLink:      'Mockup 2',
    Company_Mockup:   'Mockup 3',
    Additional_Art_1: 'Additional Art 1',
    Additional_Art_2: 'Additional Art 2'
};

function friendlySlotLabel(field) {
    return SLOT_LABELS[field] || field;
}

function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}

function buildRecordsHtml(records) {
    if (!records || !records.length) return '';
    var rows = records.map(function (r) {
        var slotNames = (r.brokenSlots || []).map(function (s) {
            return friendlySlotLabel(s.field);
        }).join(', ') || 'mockup';
        var detailUrl = SITE_ORIGIN + '/art-request/' + encodeURIComponent(r.designId);
        var company = escapeHtml(r.companyName || '(no name)');
        var status = escapeHtml(r.status || '');
        return '<li style="margin:0 0 10px;padding:8px 12px;background:#fff5f5;'
            + 'border-left:3px solid #dc3545;border-radius:4px;">'
            + '<a href="' + detailUrl + '" '
            + 'style="font-weight:600;color:#c0392b;text-decoration:none;">'
            + 'Design #' + escapeHtml(String(r.designId)) + '</a>'
            + ' &mdash; ' + company
            + ' <span style="color:#666;font-size:13px;">(' + status + ')</span>'
            + '<br><span style="font-size:12px;color:#888;">Missing: '
            + escapeHtml(slotNames) + '</span>'
            + '</li>';
    }).join('');
    return '<ul style="list-style:none;padding:0;margin:0;">' + rows + '</ul>';
}

/**
 * Run the daily digest: scan for broken mockups, email Steve if any found.
 * Safe to call multiple times (each call is a fresh scan). Returns a small
 * summary object the caller can log or return to an HTTP client.
 */
async function runDailyDigest() {
    var serviceId  = process.env.EMAILJS_SERVICE_ID;
    var templateId = process.env.EMAILJS_TEMPLATE_STEVE_DIGEST;
    var publicKey  = process.env.EMAILJS_PUBLIC_KEY;
    var privateKey = process.env.EMAILJS_PRIVATE_KEY;

    if (!serviceId || !templateId || !publicKey || !privateKey) {
        var missing = [
            ['EMAILJS_SERVICE_ID', serviceId],
            ['EMAILJS_TEMPLATE_STEVE_DIGEST', templateId],
            ['EMAILJS_PUBLIC_KEY', publicKey],
            ['EMAILJS_PRIVATE_KEY', privateKey]
        ].filter(function (p) { return !p[1]; }).map(function (p) { return p[0]; });
        throw new Error('Digest misconfigured — missing env vars: ' + missing.join(', '));
    }

    // Call our own broken-mockups endpoint over localhost so we reuse the
    // cache + scan logic without duplicating it.
    var port = (config.server && config.server.port) || process.env.PORT || 3002;
    var scanUrl = 'http://localhost:' + port
        + '/api/art-requests/broken-mockups?refresh=true';

    var scanResp = await axios.get(scanUrl, { timeout: 60000 });
    var data = scanResp.data || {};
    var broken = data.broken || 0;
    var results = data.results || [];

    if (broken === 0) {
        console.log('[Digest] Clean scan (' + (data.checked || 0)
            + ' records checked) — skipping email.');
        return {
            broken: 0,
            checked: data.checked || 0,
            emailed: false,
            reason: 'clean'
        };
    }

    var today = new Date();
    var scanDate = today.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    var templateParams = {
        to_email:     STEVE_EMAIL,
        to_name:      'Steve',
        broken_count: String(broken),
        scan_date:    scanDate,
        records_html: buildRecordsHtml(results),
        dashboard_link: SITE_ORIGIN + '/dashboards/art-hub-steve.html'
    };

    var emailResp = await emailjs.send(serviceId, templateId, templateParams, {
        publicKey: publicKey,
        privateKey: privateKey
    });

    console.log('[Digest] Emailed Steve — ' + broken + ' broken records ('
        + data.checked + ' scanned). EmailJS: ' + emailResp.status
        + ' ' + emailResp.text);

    return {
        broken: broken,
        checked: data.checked || 0,
        emailed: true,
        emailjsStatus: emailResp.status,
        to: STEVE_EMAIL
    };
}

module.exports = { runDailyDigest };
