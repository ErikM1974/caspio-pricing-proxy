// Daily AE Awaiting-Approval digest.
//
// Problem: mockups land in "Awaiting Approval" status when Steve sends them
// to the customer for sign-off. Some sit for days because the AE isn't
// proactively chasing the customer. Today nothing reminds the AE.
//
// Fix: every weekday at 8 AM Pacific, group every Awaiting-Approval row
// (across ArtRequests + Digitizing_Mockups) by Sales_Rep, and email each AE
// a personal list of their items with a "days waiting" elapsed counter and
// a deep link to the detail page. AEs with zero items get no email.
//
// Email pipe: same EmailJS pattern as send-steve-digest.js.

const emailjs = require('@emailjs/nodejs');
const { fetchAllCaspioPages } = require('./caspio');
const { resolveAEEmail, resolveAEName } = require('./rep-email-map');

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';

function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}

// Caspio strips the trailing Z from ISO timestamps — append it before
// passing to Date so we don't accidentally interpret UTC as local.
function parseCaspioDate(value) {
    if (!value) return null;
    var s = String(value);
    if (s && !/[zZ]$/.test(s) && !/[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function daysWaiting(approvalSentDate) {
    var d = parseCaspioDate(approvalSentDate);
    if (!d) return null;
    var ms = Date.now() - d.getTime();
    if (ms < 0) return 0;
    return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function daysWaitingLabel(n) {
    if (n == null) return 'unknown';
    if (n === 0) return 'today';
    if (n === 1) return '1 day';
    return n + ' days';
}

// Style each row by urgency so an AE skimming the email sees the worst
// offenders first. Same color scale as the broken-mockups digest.
function urgencyStyle(days) {
    if (days == null) return { border: '#888', bg: '#f7f7f7', accent: '#666' };
    if (days >= 7)    return { border: '#dc3545', bg: '#fff5f5', accent: '#c0392b' };
    if (days >= 3)    return { border: '#fd7e14', bg: '#fff8f0', accent: '#b85a00' };
    return { border: '#198754', bg: '#f4faf6', accent: '#0f5132' };
}

/**
 * Fetch every ArtRequests + Digitizing_Mockups row currently in
 * "Awaiting Approval" and normalize them to a common shape so the email
 * builder doesn't care which table they came from.
 */
async function fetchAwaitingApprovalItems() {
    var artParams = {
        'q.where':  "Status='Awaiting Approval'",
        'q.select': 'PK_ID,ID_Design,Design_Num_SW,CompanyName,Sales_Rep,User_Email,Approval_Sent_Date,Status',
        'q.limit':  1000
    };
    var mockupParams = {
        'q.where':  "Status='Awaiting Approval'",
        'q.select': 'ID,PK_ID,Design_Number,Company_Name,Sales_Rep,User_Email,Approval_Sent_Date',
        'q.limit':  1000
    };

    var [artRows, mockupRows] = await Promise.all([
        fetchAllCaspioPages('/tables/ArtRequests/records',       artParams).catch(function (e) {
            console.error('[AE Digest] ArtRequests fetch failed:', e.message);
            return [];
        }),
        fetchAllCaspioPages('/tables/Digitizing_Mockups/records', mockupParams).catch(function (e) {
            console.error('[AE Digest] Digitizing_Mockups fetch failed:', e.message);
            return [];
        })
    ]);

    var normalizedArt = (artRows || []).map(function (r) {
        return {
            source:        'art',
            recordId:      r.ID_Design,
            designNumber:  r.Design_Num_SW || r.ID_Design,
            companyName:   r.CompanyName || '(no name)',
            salesRep:      r.Sales_Rep || '',
            userEmail:     r.User_Email || '',
            approvalSent:  r.Approval_Sent_Date,
            detailUrl:     SITE_ORIGIN + '/art-request/' + encodeURIComponent(r.ID_Design) + '?view=ae'
        };
    });

    var normalizedMockup = (mockupRows || []).map(function (r) {
        return {
            source:        'mockup',
            recordId:      r.ID,
            designNumber:  r.Design_Number || r.ID,
            companyName:   r.Company_Name || '(no name)',
            salesRep:      r.Sales_Rep || '',
            userEmail:     r.User_Email || '',
            approvalSent:  r.Approval_Sent_Date,
            detailUrl:     SITE_ORIGIN + '/mockup/' + encodeURIComponent(r.ID) + '?view=ae'
        };
    });

    return normalizedArt.concat(normalizedMockup);
}

// Group by AE email so each AE gets exactly one digest. Items without a
// resolvable email collapse into an "unassigned" bucket the caller logs
// rather than emails — useful signal that Sales_Rep is blank somewhere.
function groupByAE(items) {
    var groups = new Map();
    var unassigned = [];

    items.forEach(function (item) {
        var key = resolveAEEmail(item.salesRep) || resolveAEEmail(item.userEmail);
        if (!key) {
            unassigned.push(item);
            return;
        }
        if (!groups.has(key)) {
            // Derive the displayed name from the RESOLVED email, not the
            // original Sales_Rep, so redirects (e.g. Taylor → sales@) show
            // up under "Sales" instead of the former employee's name.
            groups.set(key, {
                aeEmail: key,
                aeName:  resolveAEName(key),
                items:   []
            });
        }
        groups.get(key).items.push(item);
    });

    // Within each AE, sort oldest-first so the most overdue rises to the top.
    groups.forEach(function (g) {
        g.items.sort(function (a, b) {
            var da = parseCaspioDate(a.approvalSent);
            var db = parseCaspioDate(b.approvalSent);
            if (!da && !db) return 0;
            if (!da) return 1;
            if (!db) return -1;
            return da.getTime() - db.getTime();
        });
    });

    return { groups: Array.from(groups.values()), unassigned: unassigned };
}

function buildItemsHtml(items) {
    var rows = items.map(function (it) {
        var days = daysWaiting(it.approvalSent);
        var style = urgencyStyle(days);
        var company = escapeHtml(it.companyName);
        var detailUrl = it.detailUrl;
        return '<li style="margin:0 0 10px;padding:10px 14px;background:' + style.bg
            + ';border-left:4px solid ' + style.border + ';border-radius:4px;">'
            + '<a href="' + detailUrl + '" '
            + 'style="font-weight:600;color:' + style.accent + ';text-decoration:none;font-size:15px;">'
            + 'Design #' + escapeHtml(String(it.designNumber)) + '</a>'
            + ' <span style="color:#333;">&mdash; ' + company + '</span>'
            + '<br><span style="font-size:12px;color:' + style.accent + ';font-weight:600;">'
            + 'Waiting ' + escapeHtml(daysWaitingLabel(days)) + '</span>'
            + '</li>';
    }).join('');
    return '<ul style="list-style:none;padding:0;margin:0;">' + rows + '</ul>';
}

/**
 * Run the digest: fetch, group, send one email per AE with items.
 * dryRun=true returns the grouping without sending email — used by the
 * /scan admin endpoint and for local debugging.
 */
async function runAEApprovalDigest(opts) {
    opts = opts || {};
    var dryRun = !!opts.dryRun;

    var serviceId  = process.env.EMAILJS_SERVICE_ID;
    var templateId = process.env.EMAILJS_TEMPLATE_AE_APPROVAL_DIGEST;
    var publicKey  = process.env.EMAILJS_PUBLIC_KEY;
    var privateKey = process.env.EMAILJS_PRIVATE_KEY;

    if (!dryRun) {
        if (!serviceId || !templateId || !publicKey || !privateKey) {
            var missing = [
                ['EMAILJS_SERVICE_ID', serviceId],
                ['EMAILJS_TEMPLATE_AE_APPROVAL_DIGEST', templateId],
                ['EMAILJS_PUBLIC_KEY', publicKey],
                ['EMAILJS_PRIVATE_KEY', privateKey]
            ].filter(function (p) { return !p[1]; }).map(function (p) { return p[0]; });
            throw new Error('AE digest misconfigured — missing env vars: ' + missing.join(', '));
        }
    }

    var items = await fetchAwaitingApprovalItems();
    var grouping = groupByAE(items);
    var dashboardLink = SITE_ORIGIN + '/dashboards/staff-dashboard.html';

    if (dryRun) {
        return {
            dryRun:        true,
            totalItems:    items.length,
            aeGroups:      grouping.groups.map(function (g) {
                return {
                    aeEmail: g.aeEmail,
                    aeName:  g.aeName,
                    count:   g.items.length,
                    items:   g.items.map(function (i) {
                        return {
                            source:       i.source,
                            recordId:     i.recordId,
                            designNumber: i.designNumber,
                            company:      i.companyName,
                            daysWaiting:  daysWaiting(i.approvalSent),
                            detailUrl:    i.detailUrl
                        };
                    })
                };
            }),
            unassignedCount: grouping.unassigned.length,
            unassigned:      grouping.unassigned.map(function (i) {
                return {
                    source: i.source, recordId: i.recordId,
                    designNumber: i.designNumber, company: i.companyName,
                    salesRep: i.salesRep, userEmail: i.userEmail
                };
            })
        };
    }

    if (grouping.groups.length === 0) {
        console.log('[AE Digest] No AEs have Awaiting Approval items — skipping all emails. ('
            + items.length + ' total items, ' + grouping.unassigned.length + ' unassigned)');
        return {
            aesEmailed:      0,
            totalItems:      items.length,
            unassignedCount: grouping.unassigned.length,
            reason:          'no-groups'
        };
    }

    var today = new Date();
    var scanDate = today.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    var sendResults = [];
    for (var i = 0; i < grouping.groups.length; i++) {
        var g = grouping.groups[i];
        var templateParams = {
            to_email:       g.aeEmail,
            to_name:        g.aeName,
            ae_name:        g.aeName,
            item_count:     String(g.items.length),
            scan_date:      scanDate,
            items_html:     buildItemsHtml(g.items),
            dashboard_link: dashboardLink
        };
        try {
            var resp = await emailjs.send(serviceId, templateId, templateParams, {
                publicKey: publicKey, privateKey: privateKey
            });
            sendResults.push({ ae: g.aeEmail, items: g.items.length, status: resp.status, ok: true });
            console.log('[AE Digest] Sent ' + g.items.length + ' items to ' + g.aeEmail
                + ' (status ' + resp.status + ')');
        } catch (err) {
            sendResults.push({ ae: g.aeEmail, items: g.items.length, error: err.message, ok: false });
            console.error('[AE Digest] Send failed for ' + g.aeEmail + ': ' + err.message);
        }
    }

    var aesEmailed = sendResults.filter(function (r) { return r.ok; }).length;
    console.log('[AE Digest] ' + aesEmailed + '/' + grouping.groups.length + ' AEs emailed. '
        + items.length + ' total items, ' + grouping.unassigned.length + ' unassigned.');

    return {
        aesEmailed:      aesEmailed,
        aesAttempted:    grouping.groups.length,
        totalItems:      items.length,
        unassignedCount: grouping.unassigned.length,
        results:         sendResults
    };
}

module.exports = { runAEApprovalDigest };
