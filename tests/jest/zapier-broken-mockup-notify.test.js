/**
 * Unit tests for zapier-broken-mockup-notify.js
 *
 * Covers the contract that Zapier (and Steve's Slack DM) depends on:
 *   • env unset → skip without throwing
 *   • dedup → second call within TTL returns 'dedup', no axios POST
 *   • happy path → axios POST fires once, payload shape matches contract
 *   • non-200 response → returns error, dedup is rolled back so a transient
 *     Zapier outage doesn't permanently silence a design
 *   • missing designNumber → skip with 'missing-design-number'
 *
 * axios is mocked — tests never hit the network.
 */
jest.mock('axios');
const axios = require('axios');

// Set env BEFORE require — module reads it at load time.
process.env.ZAPIER_BROKEN_MOCKUP_WEBHOOK_URL = 'https://hooks.zapier.com/test/abc/xyz';

const notifier = require('../../src/utils/zapier-broken-mockup-notify');
const { notifyBrokenMockup } = notifier;
const { clearDedup, getDedupSize, DEDUP_TTL_MS } = notifier.__test__;

beforeEach(() => {
    clearDedup();
    axios.post.mockReset();
});

describe('notifyBrokenMockup — happy path', () => {
    test('POSTs to webhook URL with full payload', async () => {
        axios.post.mockResolvedValue({ status: 200, data: { ok: true } });

        const result = await notifyBrokenMockup({
            designNumber: '40402',
            companyName: 'AutoShield',
            pkId: 1234,
            table: 'ArtRequests',
            slotField: 'Box_File_Mockup',
            detailUrl: 'https://www.teamnwca.com/art-request/40402',
            reason: 'no-folder'
        });

        expect(result).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(1);

        const [url, payload, opts] = axios.post.mock.calls[0];
        expect(url).toBe('https://hooks.zapier.com/test/abc/xyz');
        expect(payload).toMatchObject({
            event: 'broken_mockup_unrecoverable',
            designNumber: '40402',
            companyName: 'AutoShield',
            pkId: '1234',                 // coerced to string
            table: 'ArtRequests',
            slotField: 'Box_File_Mockup',
            detailUrl: 'https://www.teamnwca.com/art-request/40402',
            reason: 'no-folder',
            error: null
        });
        expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(opts).toMatchObject({ timeout: 8000, headers: { 'Content-Type': 'application/json' } });
    });

    test('coerces designNumber to string and tolerates missing optional fields', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        await notifyBrokenMockup({ designNumber: 99999 });
        const [, payload] = axios.post.mock.calls[0];
        expect(payload.designNumber).toBe('99999');
        expect(payload.companyName).toBe('');
        expect(payload.slotField).toBe('');
        expect(payload.error).toBeNull();
    });
});

describe('notifyBrokenMockup — dedup', () => {
    test('second call within TTL returns dedup and does not POST again', async () => {
        axios.post.mockResolvedValue({ status: 200 });

        const first = await notifyBrokenMockup({
            designNumber: '40402',
            slotField: 'Box_File_Mockup',
            reason: 'no-folder'
        });
        expect(first).toEqual({ sent: true });

        const second = await notifyBrokenMockup({
            designNumber: '40402',
            slotField: 'Box_File_Mockup',
            reason: 'no-match'  // same design+slot, different reason — still dedup'd
        });
        expect(second).toEqual({ sent: false, skipped: 'dedup' });
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('different slotField on same design fires a separate ping (per-slot)', async () => {
        axios.post.mockResolvedValue({ status: 200 });

        await notifyBrokenMockup({ designNumber: '12345', slotField: 'Box_Mockup_1' });
        await notifyBrokenMockup({ designNumber: '12345', slotField: 'Box_Mockup_2' });

        expect(axios.post).toHaveBeenCalledTimes(2);
    });

    test('TTL constant is 24 hours', () => {
        expect(DEDUP_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
});

describe('notifyBrokenMockup — guards', () => {
    test('missing designNumber → skip', async () => {
        const result = await notifyBrokenMockup({ companyName: 'X' });
        expect(result).toEqual({ sent: false, skipped: 'missing-design-number' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('null opts → skip without throwing', async () => {
        const result = await notifyBrokenMockup(null);
        expect(result.sent).toBe(false);
        expect(axios.post).not.toHaveBeenCalled();
    });
});

describe('notifyBrokenMockup — error handling', () => {
    test('axios failure returns error result and rolls back dedup', async () => {
        axios.post.mockRejectedValueOnce(new Error('network unreachable'));

        const first = await notifyBrokenMockup({
            designNumber: '77777',
            slotField: 'Box_File_Mockup'
        });
        expect(first.sent).toBe(false);
        expect(first.error).toMatch(/network unreachable/);

        // Dedup should be rolled back — second attempt should re-fire.
        axios.post.mockResolvedValueOnce({ status: 200 });
        const second = await notifyBrokenMockup({
            designNumber: '77777',
            slotField: 'Box_File_Mockup'
        });
        expect(second).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(2);
    });
});

describe('notifyBrokenMockup — env-driven activation', () => {
    test('when env var is unset, returns skipped:no-webhook (verified via fresh require)', () => {
        // Module reads env at load time. Re-require with env unset to verify.
        jest.resetModules();
        const oldUrl = process.env.ZAPIER_BROKEN_MOCKUP_WEBHOOK_URL;
        delete process.env.ZAPIER_BROKEN_MOCKUP_WEBHOOK_URL;

        const fresh = require('../../src/utils/zapier-broken-mockup-notify');
        return fresh.notifyBrokenMockup({ designNumber: '11111' }).then((result) => {
            expect(result).toEqual({ sent: false, skipped: 'no-webhook' });

            // Restore for other tests
            process.env.ZAPIER_BROKEN_MOCKUP_WEBHOOK_URL = oldUrl;
        });
    });
});
