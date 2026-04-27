// Daily broken-mockups digest email to Ruth.
//
// Sister of `send-steve-digest.js`. Same pattern: scan
// /api/mockups/broken-mockups over localhost (reuses 10-min cache + scan
// logic), bail if clean, else email Ruth with a per-record list of
// broken slots so she has an active to-do list to fix.
//
// Email delivery: EmailJS (@emailjs/nodejs) — same backend pipe as
// Steve's digest, authenticated via EMAILJS_PRIVATE_KEY.

const axios = require('axios');
const emailjs = require('@emailjs/nodejs');
const config = require('../../config');

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
// Ruth's inbox. Override via env if needed.
const RUTH_EMAIL = process.env.RUTH_EMAIL || 'ruth@nwcustomapparel.com';

// Slot field name → friendly label shown in the email list.
const SLOT_LABELS = {
    Box_Mockup_1:       'Mockup 1',
    Box_Mockup_2:       'Mockup 2',
    Box_Mockup_3:       'Mockup 3',
    Box_Mockup_4:       'Mockup 4',
    Box_Mockup_5:       'Mockup 5',
    Box_Mockup_6:       'Mockup 6',
    Box_Reference_File: 'Reference File'
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
        var detailUrl = SITE_ORIGIN + '/mockup/' + encodeURIComponent(r.id);
        var company = escapeHtml(r.companyName || '(no name)');
        var status = escapeHtml(r.status || '');
        var design = escapeHtml(String(r.designNumber || ''));
        return '<li style="margin:0 0 10px;padding:8px 12px;background:#fff5f5;'
            + 'border-left:3px solid #dc3545;border-radius:4px;">'
            + '<a href="' + detailUrl + '" '
            + 'style="font-weight:600;color:#c0392b;text-decoration:none;">'
            + 'Design #' + design + '</a>'
            + ' &mdash; ' + company
            + ' <span style="color:#666;font-size:13px;">(' + status + ')</span>'
            + '<br><span style="font-size:12px;color:#888;">Missing: '
            + escapeHtml(slotNames) + '</span>'
            + '</li>';
    }).join('');
    return '<ul style="list-style:none;padding:0;margin:0;">' + rows + '</ul>';
}

/**
 * Run the daily Ruth digest: scan for broken mockups, email Ruth if any.
 * Reuses the same EmailJS template ID env var as Steve's digest unless
 * an override is provided (so a single template can render both).
 */
async function runDailyDigest() {
    var serviceId  = process.env.EMAILJS_SERVICE_ID;
    var templateId = process.env.EMAILJS_TEMPLATE_RUTH_DIGEST
        || process.env.EMAILJS_TEMPLATE_STEVE_DIGEST;
    var publicKey  = process.env.EMAILJS_PUBLIC_KEY;
    var privateKey = process.env.EMAILJS_PRIVATE_KEY;

    if (!serviceId || !templateId || !publicKey || !privateKey) {
        var missing = [
            ['EMAILJS_SERVICE_ID', serviceId],
            ['EMAILJS_TEMPLATE_RUTH_DIGEST or EMAILJS_TEMPLATE_STEVE_DIGEST', templateId],
            ['EMAILJS_PUBLIC_KEY', publicKey],
            ['EMAILJS_PRIVATE_KEY', privateKey]
        ].filter(function (p) { return !p[1]; }).map(function (p) { return p[0]; });
        throw new Error('Ruth digest misconfigured — missing env vars: ' + missing.join(', '));
    }

    var port = (config.server && config.server.port) || process.env.PORT || 3002;
    var scanUrl = 'http://localhost:' + port + '/api/mockups/broken-mockups?refresh=true';

    var scanResp = await axios.get(scanUrl, { timeout: 60000 });
    var data = scanResp.data || {};
    var broken = data.broken || 0;
    var results = data.results || [];

    if (broken === 0) {
        console.log('[Ruth Digest] Clean scan (' + (data.checked || 0)
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
        to_email:     RUTH_EMAIL,
        to_name:      'Ruth',
        broken_count: String(broken),
        scan_date:    scanDate,
        records_html: buildRecordsHtml(results),
        dashboard_link: SITE_ORIGIN + '/dashboards/digitizing-mockup-dashboard.html'
    };

    var emailResp = await emailjs.send(serviceId, templateId, templateParams, {
        publicKey: publicKey,
        privateKey: privateKey
    });

    console.log('[Ruth Digest] Emailed Ruth — ' + broken + ' broken records ('
        + data.checked + ' scanned). EmailJS: ' + emailResp.status
        + ' ' + emailResp.text);

    return {
        broken: broken,
        checked: data.checked || 0,
        emailed: true,
        emailjsStatus: emailResp.status,
        to: RUTH_EMAIL
    };
}

module.exports = { runDailyDigest };
