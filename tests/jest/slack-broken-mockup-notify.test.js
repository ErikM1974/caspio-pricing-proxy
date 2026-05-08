/**
 * Unit tests for slack-broken-mockup-notify.js
 *
 * Covers the contract that Steve's Slack message depends on:
 *   • env unset → skip without throwing
 *   • dedup → second call within TTL returns 'dedup', no axios POST
 *   • happy path → axios POST fires once, payload is { text: <mrkdwn> } with key fields present
 *   • non-200 response → returns error, dedup is rolled back so a transient
 *     Slack outage doesn't permanently silence a design
 *   • missing designNumber → skip with 'missing-design-number'
 *
 * axios is mocked — tests never hit the network.
 */
jest.mock('axios');
const axios = require('axios');

// Set env BEFORE require — module reads it at load time.
process.env.SLACK_BROKEN_MOCKUP_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/abcXYZ';

const notifier = require('../../src/utils/slack-broken-mockup-notify');
const { notifyBrokenMockup } = notifier;
const { clearDedup, DEDUP_TTL_MS, buildText } = notifier.__test__;

beforeEach(() => {
    clearDedup();
    axios.post.mockReset();
});

describe('notifyBrokenMockup — happy path', () => {
    test('POSTs to webhook URL with mrkdwn text payload', async () => {
        axios.post.mockResolvedValue({ status: 200, data: 'ok' });

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
        expect(url).toBe('https://hooks.slack.com/services/T000/B000/abcXYZ');
        expect(payload).toHaveProperty('text');
        expect(typeof payload.text).toBe('string');
        // Key fields must appear in the rendered Slack message.
        expect(payload.text).toContain('40402');
        expect(payload.text).toContain('AutoShield');
        expect(payload.text).toContain('Box_File_Mockup');
        expect(payload.text).toContain('no-folder');
        expect(payload.text).toContain('https://www.teamnwca.com/art-request/40402');
        expect(opts).toMatchObject({ timeout: 8000, headers: { 'Content-Type': 'application/json' } });
    });

    test('coerces designNumber to string and tolerates missing optional fields', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        await notifyBrokenMockup({ designNumber: 99999 });
        const [, payload] = axios.post.mock.calls[0];
        expect(payload.text).toContain('99999');
        // Empty company / slot rows are simply omitted from the text — verify
        // the message still renders coherently.
        expect(payload.text).not.toContain('*Company:*');
        expect(payload.text).not.toContain('*Slot:*');
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
        const oldUrl = process.env.SLACK_BROKEN_MOCKUP_WEBHOOK_URL;
        delete process.env.SLACK_BROKEN_MOCKUP_WEBHOOK_URL;

        const fresh = require('../../src/utils/slack-broken-mockup-notify');
        return fresh.notifyBrokenMockup({ designNumber: '11111' }).then((result) => {
            expect(result).toEqual({ sent: false, skipped: 'no-webhook' });

            // Restore for other tests
            process.env.SLACK_BROKEN_MOCKUP_WEBHOOK_URL = oldUrl;
        });
    });
});

describe('buildText', () => {
    test('renders all rows when every field is provided', () => {
        const text = buildText({
            designNumber: '40402',
            companyName: 'AutoShield',
            slotField: 'Box_File_Mockup',
            reason: 'no-folder',
            detailUrl: 'https://example.com/x',
            error: ''
        });

        expect(text).toContain('⚠️ *Broken Mockup');
        expect(text).toContain('*Design:* 40402');
        expect(text).toContain('*Company:* AutoShield');
        expect(text).toContain('*Slot:* `Box_File_Mockup`');
        expect(text).toContain('*Reason:* no-folder');
        expect(text).toContain('<https://example.com/x|Open detail page>');
    });

    test('omits empty optional rows', () => {
        const text = buildText({ designNumber: '99999' });
        expect(text).toContain('*Design:* 99999');
        expect(text).toContain('*Reason:* unknown');
        expect(text).not.toContain('*Company:*');
        expect(text).not.toContain('*Slot:*');
    });
});
