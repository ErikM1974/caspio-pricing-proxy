/**
 * One-shot CLI: subscribe (or list / unsubscribe) ShipStation webhooks for
 * the SHIP_NOTIFY event. ShipStation calls our proxy when a label is
 * purchased so we can pull tracking back into quote_sessions.
 *
 * USAGE:
 *   # List current subscriptions
 *   node scripts/setup-shipstation-webhooks.js list
 *
 *   # Subscribe to SHIP_NOTIFY (the most useful event for us)
 *   node scripts/setup-shipstation-webhooks.js subscribe
 *
 *   # Unsubscribe one (use ID from `list`)
 *   node scripts/setup-shipstation-webhooks.js unsubscribe 12345
 *
 *   # Subscribe with a custom target URL (e.g., for a staging deploy)
 *   node scripts/setup-shipstation-webhooks.js subscribe --target=https://staging.example.com/api/webhooks/shipstation
 *
 *   # Subscribe a different event
 *   node scripts/setup-shipstation-webhooks.js subscribe --event=ORDER_NOTIFY
 *
 * Env vars required:
 *   SHIPSTATION_API_KEY, SHIPSTATION_API_SECRET
 */

'use strict';

const ss = require('../lib/shipstation-client');

const DEFAULT_TARGET = process.env.SHIPSTATION_WEBHOOK_TARGET
    || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/webhooks/shipstation';

function getArg(flag, fallback) {
    const arg = process.argv.find(a => a.startsWith(`${flag}=`));
    if (arg) return arg.split('=')[1];
    return fallback;
}

async function main() {
    const cmd = (process.argv[2] || 'list').toLowerCase();

    if (cmd === 'list') {
        const webhooks = await ss.listWebhooks();
        console.log(`\nFound ${webhooks.length} subscription(s):\n`);
        if (webhooks.length === 0) {
            console.log('  (none — run: node scripts/setup-shipstation-webhooks.js subscribe)');
        } else {
            webhooks.forEach(w => {
                console.log(`  ID:           ${w.WebHookID || w.webHookID || w.id}`);
                console.log(`  Event:        ${w.HookType || w.hookType || w.event}`);
                console.log(`  Target URL:   ${w.Url || w.url || w.target_url}`);
                console.log(`  Friendly:     ${w.Name || w.name || w.friendly_name || '(unnamed)'}`);
                console.log(`  Active:       ${w.Active != null ? w.Active : w.active}`);
                console.log('  ─────────────────');
            });
        }
        return;
    }

    if (cmd === 'subscribe') {
        const target = getArg('--target', DEFAULT_TARGET);
        const event = getArg('--event', 'SHIP_NOTIFY');
        console.log(`\nSubscribing webhook:`);
        console.log(`  Event:  ${event}`);
        console.log(`  Target: ${target}\n`);
        const result = await ss.subscribeWebhook(target, event, {
            friendlyName: `NWCA ${event}`,
        });
        console.log('✓ Webhook subscribed:');
        console.log(JSON.stringify(result, null, 2));
        console.log('\nSave this webhook ID for future unsubscribe.');
        return;
    }

    if (cmd === 'unsubscribe') {
        const webhookId = process.argv[3];
        if (!webhookId) {
            console.error('Usage: node scripts/setup-shipstation-webhooks.js unsubscribe <webhookId>');
            process.exit(1);
        }
        console.log(`\nUnsubscribing webhook ${webhookId}...`);
        await ss.unsubscribeWebhook(webhookId);
        console.log('✓ Unsubscribed.');
        return;
    }

    console.error(`Unknown command: ${cmd}`);
    console.error('Usage: list | subscribe [--target=URL] [--event=NAME] | unsubscribe <id>');
    process.exit(1);
}

main().catch(err => {
    console.error('\n✗ Error:', err.message);
    if (err.body) console.error('  Response:', JSON.stringify(err.body, null, 2));
    process.exit(1);
});
