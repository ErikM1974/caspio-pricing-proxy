/**
 * Unit tests for box-webhooks.js signature verification + freshness guard.
 *
 * These are pure-function tests: no Box, no Caspio, no Express. The webhook
 * receiver's outer route is exercised by the live deploy + a manual file-trash
 * test in Box (see plan verification step 2). What we pin here is the
 * crypto/HMAC contract — if Box ever changes their signing scheme, this
 * test breaks first and we know to update before deploying.
 *
 * Box V2 webhook signing (per https://developer.box.com/guides/webhooks/v2/setup-webhooks-v2/):
 *   sig = base64( HMAC-SHA256( rawBody || timestamp || deliveryId, primaryKey ) )
 *   primary OR secondary key may match (rotation support).
 */
const crypto = require('crypto');

// Set env BEFORE require — module reads them at load time.
process.env.BOX_WEBHOOK_PRIMARY_KEY = 'primary-test-key-do-not-use-in-prod';
process.env.BOX_WEBHOOK_SECONDARY_KEY = 'secondary-test-key-do-not-use-in-prod';
process.env.BOX_WEBHOOK_ENABLED = 'true';

const router = require('../../src/routes/box-webhooks');
const { verifySignature, isFresh } = router.__test__;

function signWith(key, rawBody, timestamp, deliveryId) {
    const h = crypto.createHmac('sha256', key);
    h.update(Buffer.from(rawBody, 'utf8'));
    h.update(timestamp);
    h.update(deliveryId);
    return h.digest('base64');
}

describe('verifySignature', () => {
    const RAW = '{"trigger":"FILE.TRASHED","source":{"id":"123","type":"file"}}';
    const TS = '2026-05-06T18:00:00-07:00';
    const ID = 'delivery-id-abc';

    test('valid signature with primary key passes', () => {
        const sig = signWith(process.env.BOX_WEBHOOK_PRIMARY_KEY, RAW, TS, ID);
        expect(verifySignature(Buffer.from(RAW), ID, TS, sig, '')).toBe(true);
    });

    test('valid signature with secondary key passes (rotation support)', () => {
        const sig = signWith(process.env.BOX_WEBHOOK_SECONDARY_KEY, RAW, TS, ID);
        // Primary slot is empty/wrong, secondary holds the correct sig.
        expect(verifySignature(Buffer.from(RAW), ID, TS, '', sig)).toBe(true);
    });

    test('wrong key rejected', () => {
        const sig = signWith('totally-different-key', RAW, TS, ID);
        expect(verifySignature(Buffer.from(RAW), ID, TS, sig, sig)).toBe(false);
    });

    test('tampered body rejected', () => {
        const sig = signWith(process.env.BOX_WEBHOOK_PRIMARY_KEY, RAW, TS, ID);
        const tampered = RAW.replace('FILE.TRASHED', 'FILE.UPLOADED');
        expect(verifySignature(Buffer.from(tampered), ID, TS, sig, '')).toBe(false);
    });

    test('tampered timestamp rejected', () => {
        const sig = signWith(process.env.BOX_WEBHOOK_PRIMARY_KEY, RAW, TS, ID);
        expect(verifySignature(Buffer.from(RAW), ID, '2026-05-06T18:00:01-07:00', sig, '')).toBe(false);
    });

    test('tampered delivery id rejected', () => {
        const sig = signWith(process.env.BOX_WEBHOOK_PRIMARY_KEY, RAW, TS, ID);
        expect(verifySignature(Buffer.from(RAW), 'different-id', TS, sig, '')).toBe(false);
    });

    test('missing rawBody rejected', () => {
        const sig = signWith(process.env.BOX_WEBHOOK_PRIMARY_KEY, RAW, TS, ID);
        expect(verifySignature(null, ID, TS, sig, '')).toBe(false);
    });

    test('missing both signatures rejected', () => {
        expect(verifySignature(Buffer.from(RAW), ID, TS, '', '')).toBe(false);
    });
});

describe('isFresh (10-min replay protection)', () => {
    test('current ISO timestamp passes', () => {
        expect(isFresh(new Date().toISOString())).toBe(true);
    });

    test('5 minutes ago passes', () => {
        const t = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        expect(isFresh(t)).toBe(true);
    });

    test('11 minutes ago rejected', () => {
        const t = new Date(Date.now() - 11 * 60 * 1000).toISOString();
        expect(isFresh(t)).toBe(false);
    });

    test('11 minutes in future rejected (clock skew protection)', () => {
        const t = new Date(Date.now() + 11 * 60 * 1000).toISOString();
        expect(isFresh(t)).toBe(false);
    });

    test('missing timestamp rejected', () => {
        expect(isFresh('')).toBe(false);
        expect(isFresh(null)).toBe(false);
        expect(isFresh(undefined)).toBe(false);
    });

    test('garbage timestamp rejected', () => {
        expect(isFresh('not-a-timestamp')).toBe(false);
    });
});
