// Monthly orphan-Box-folder digest email to Erik.
//
// Problem: even with the POST /api/mockups dedup guard in place, a folder can
// still land in "Ruth Digitizing Mockups" without a Caspio row — e.g. someone
// right-clicks → "New Folder" in the Box UI. This cron catches that drift.
//
// Behavior:
//   - Runs via cron (monthly, first of month at 8 AM Pacific — wired in server.js)
//   - Reuses detectOrphans() with quality filters ON (test data + empty folders
//     skipped — same filters the backfill script uses)
//   - Sends email only if clean orphans > 0; logs and returns otherwise
//   - Email body lists each orphan with a link to the Box folder so Erik can
//     decide to run --apply, delete, or ignore
//
// EmailJS pattern matches send-steve-digest.js exactly.

const emailjs = require('@emailjs/nodejs');
const { detectOrphans } = require('./detect-orphan-mockups');

const ERIK_EMAIL = process.env.ORPHAN_DIGEST_TO || 'erik@nwcustomapparel.com';

function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}

function buildOrphansHtml(orphans) {
    if (!orphans || !orphans.length) return '';
    const rows = orphans.map(function (o) {
        const folderUrl = 'https://app.box.com/folder/' + encodeURIComponent(o.folder.id);
        const designLabel = o.designNumber || '(no design #)';
        return '<li style="margin:0 0 10px;padding:8px 12px;background:#fffbe6;'
            + 'border-left:3px solid #f1a52b;border-radius:4px;">'
            + '<a href="' + folderUrl + '" '
            + 'style="font-weight:600;color:#6b4300;text-decoration:none;">'
            + escapeHtml(o.folder.name) + '</a>'
            + ' <span style="color:#666;font-size:13px;">('
            + escapeHtml(designLabel) + ' · ' + escapeHtml(o.companyName) + ')</span>'
            + '</li>';
    }).join('');
    return '<ul style="list-style:none;padding:0;margin:0;">' + rows + '</ul>';
}

/**
 * Scan Box + Caspio, email Erik if any clean orphans are found. Safe to call
 * repeatedly (each call is a fresh scan, no state). Returns a summary object
 * the caller can log or return to an HTTP client.
 */
async function runOrphanDigest() {
    const serviceId  = process.env.EMAILJS_SERVICE_ID;
    const templateId = process.env.EMAILJS_TEMPLATE_ORPHAN_DIGEST;
    const publicKey  = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;

    if (!serviceId || !templateId || !publicKey || !privateKey) {
        const missing = [
            ['EMAILJS_SERVICE_ID', serviceId],
            ['EMAILJS_TEMPLATE_ORPHAN_DIGEST', templateId],
            ['EMAILJS_PUBLIC_KEY', publicKey],
            ['EMAILJS_PRIVATE_KEY', privateKey]
        ].filter(p => !p[1]).map(p => p[0]);
        throw new Error('Orphan digest misconfigured — missing env vars: ' + missing.join(', '));
    }

    const report = await detectOrphans({ applyQualityFilters: true, inspectFolderContents: true });

    if (report.orphans.length === 0) {
        console.log('[Orphan Digest] Clean scan — '
            + report.boxTotal + ' Box folders, '
            + report.caspioTotal + ' Caspio rows, 0 orphans. Skipping email.');
        return {
            emailed: false,
            reason: 'clean',
            boxTotal: report.boxTotal,
            caspioTotal: report.caspioTotal,
            orphans: 0
        };
    }

    const today = new Date();
    const scanDate = today.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    const templateParams = {
        to_email:      ERIK_EMAIL,
        to_name:       'Erik',
        orphan_count:  String(report.orphans.length),
        box_total:     String(report.boxTotal),
        caspio_total:  String(report.caspioTotal),
        dedup_skipped: String(report.dedupSkipped.length),
        test_skipped:  String(report.testSkipped.length),
        empty_skipped: String(report.emptySkipped.length),
        scan_date:     scanDate,
        orphans_html:  buildOrphansHtml(report.orphans)
    };

    const emailResp = await emailjs.send(serviceId, templateId, templateParams, {
        publicKey: publicKey,
        privateKey: privateKey
    });

    console.log('[Orphan Digest] Emailed Erik — '
        + report.orphans.length + ' clean orphans found. EmailJS: '
        + emailResp.status + ' ' + emailResp.text);

    return {
        emailed: true,
        orphans: report.orphans.length,
        boxTotal: report.boxTotal,
        caspioTotal: report.caspioTotal,
        emailjsStatus: emailResp.status,
        to: ERIK_EMAIL
    };
}

module.exports = { runOrphanDigest };
