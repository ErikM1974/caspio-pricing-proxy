// Portal requests must reach a human (Erik 2026-09-02): DM the customer's rep on Slack, fall back
// to Erik when the rep is unassigned/unreachable, and email the shared sales inbox when the
// EmailJS template is configured. Source-level lock on src/routes/portal-reorder.js.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'portal-reorder.js'), 'utf8');

describe('portal-reorder — request notifications', () => {
  test('uses the Slack DM helper (bot token), not only the never-configured channel webhook', () => {
    expect(src).toMatch(/require\('\.\.\/utils\/slack-dm-notify'\)/);
    expect(src).toMatch(/sendSlackDM\(to, text\)/);
  });
  test('resolves the rep email from REP_EMAIL_MAP by full name, then first name', () => {
    expect(src).toMatch(/if \(REP_EMAIL_MAP\[n\]\) return REP_EMAIL_MAP\[n\];/);
    expect(src).toMatch(/return REP_EMAIL_MAP\[first\] \|\| '';/);
  });
  test('falls back to Erik when the rep is unassigned or the DM cannot be delivered', () => {
    expect(src).toMatch(/FALLBACK_NOTIFY_EMAIL = process\.env\.PORTAL_REQUEST_FALLBACK_EMAIL \|\| 'erik@nwcustomapparel\.com'/);
    expect(src).toMatch(/const to = repEmailFor\(repName\) \|\| FALLBACK_NOTIFY_EMAIL;/);
    expect(src).toMatch(/unreachable on Slack/);
  });
  test('emails the shared sales inbox, gated on EMAILJS_TEMPLATE_PORTAL_REQUEST (never throws)', () => {
    expect(src).toMatch(/PORTAL_REQUEST_EMAIL = process\.env\.PORTAL_REQUEST_EMAIL \|\| 'sales@nwcustomapparel\.com'/);
    expect(src).toMatch(/process\.env\.EMAILJS_TEMPLATE_PORTAL_REQUEST/);
    expect(src).toMatch(/email skipped — EMAILJS_TEMPLATE_PORTAL_REQUEST not configured/);
    expect(src).toMatch(/emailPortalRequest\(Object\.assign\(\{ rep: repName \|\| '\(unassigned\)' \}, fields\)\)\.catch\(\(\) => \{\}\)/);
  });
  test('both the single request and the batch notify, after the Caspio row is saved', () => {
    const single = src.indexOf("router.post('/request'");
    const batch = src.indexOf("router.post('/batch'");
    const n1 = src.indexOf('notifyPortalRequest(row.Rep', single);
    const n2 = src.indexOf('notifyPortalRequest(rows[0].Rep', batch);
    expect(n1).toBeGreaterThan(src.indexOf('/tables/Portal_Reorder_Requests/records', single));
    expect(n2).toBeGreaterThan(src.indexOf('/tables/Portal_Reorder_Requests/records', batch));
  });
  test('general portal requests (QUOTE / NEWLOGO / LOGOCHG / ACCOUNT) get their own headline', () => {
    expect(src).toMatch(/QUOTE: '💬 \*Portal quote request\*'/);
    expect(src).toMatch(/NEWLOGO: '🎨 \*Portal new-logo request\*'/);
  });
});
