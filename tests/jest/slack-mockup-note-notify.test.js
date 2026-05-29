/**
 * Unit tests for slack-mockup-note-notify.js
 *
 * Twin of slack-art-note-notify.test.js. Covers the contract the mockup note
 * Slack ping depends on:
 *   • env unset  → skip with 'no-webhook' and axios NOT called
 *   • dedup      → second call within TTL on same noteId returns 'dedup', no 2nd POST
 *   • direction  → header text differs for 'ae' vs 'artist' (via __test__.buildText)
 *   • link       → detail link uses /mockup/{id} (not /art-request/)
 *   • truncation → note body capped at MAX_NOTE_CHARS (600) with an ellipsis
 *   • resolves   → axios rejection returns {sent:false,error}, never throws
 *
 * axios is mocked — tests never hit the network.
 */
jest.mock('axios');
const axios = require('axios');

// Set env BEFORE require — module reads it at load time.
process.env.SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/mockXYZ';

const notifier = require('../../src/utils/slack-mockup-note-notify');
const { notifyMockupNote } = notifier;
const { clearDedup, DEDUP_TTL_MS, buildText } = notifier.__test__;

beforeEach(() => {
    clearDedup();
    axios.post.mockReset();
});

describe('notifyMockupNote — env-driven activation', () => {
    test('when env var is unset, returns skipped:no-webhook and never POSTs', () => {
        // Module reads env at load time. Re-require with env unset to verify.
        jest.resetModules();
        const oldUrl = process.env.SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL;
        delete process.env.SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL;

        jest.doMock('axios');
        const freshAxios = require('axios');
        const fresh = require('../../src/utils/slack-mockup-note-notify');

        return fresh.notifyMockupNote({ mockupId: 11111, noteId: 1, direction: 'ae' }).then((result) => {
            expect(result).toEqual({ sent: false, skipped: 'no-webhook' });
            expect(freshAxios.post).not.toHaveBeenCalled();

            // Restore for the rest of the suite.
            process.env.SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL = oldUrl;
            jest.resetModules();
        });
    });
});

describe('notifyMockupNote — happy path', () => {
    test('POSTs to webhook URL with mrkdwn text payload + /mockup/ link', async () => {
        axios.post.mockResolvedValue({ status: 200, data: 'ok' });

        const result = await notifyMockupNote({
            mockupId: 88,
            noteId: 'k1',
            noteType: 'AE Instruction',
            noteText: 'Please bump the stitch count.',
            noteBy: 'Taneisha',
            direction: 'ae',
            company: 'AutoShield',
            designNum: '12345'
        });

        expect(result).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(1);

        const [url, payload, opts] = axios.post.mock.calls[0];
        expect(url).toBe('https://hooks.slack.com/services/T000/B000/mockXYZ');
        expect(payload).toHaveProperty('text');
        expect(typeof payload.text).toBe('string');
        expect(payload.text).toContain('AutoShield');
        expect(payload.text).toContain('12345');
        expect(payload.text).toContain('AE Instruction');
        expect(payload.text).toContain('Please bump the stitch count.');
        // Detail link uses the SITE_ORIGIN default + /mockup/ + mockupId.
        expect(payload.text).toContain('/mockup/88');
        expect(payload.text).not.toContain('/art-request/');
        expect(opts).toMatchObject({ timeout: 8000, headers: { 'Content-Type': 'application/json' } });
    });
});

describe('notifyMockupNote — dedup', () => {
    test('second call within TTL on same noteId returns dedup and does not POST again', async () => {
        axios.post.mockResolvedValue({ status: 200 });

        const first = await notifyMockupNote({ mockupId: 88, noteId: 9001, direction: 'ae' });
        expect(first).toEqual({ sent: true });

        const second = await notifyMockupNote({ mockupId: 88, noteId: 9001, direction: 'artist' });
        expect(second).toEqual({ sent: false, skipped: 'dedup' });
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('missing noteId disables dedup — both calls fire', async () => {
        axios.post.mockResolvedValue({ status: 200 });

        await notifyMockupNote({ mockupId: 88, direction: 'ae' });
        await notifyMockupNote({ mockupId: 88, direction: 'ae' });

        expect(axios.post).toHaveBeenCalledTimes(2);
    });

    test('TTL constant is 5 minutes', () => {
        expect(DEDUP_TTL_MS).toBe(5 * 60 * 1000);
    });
});

describe('buildText — direction-aware header', () => {
    test("direction 'ae' renders the 'for Ruth' header", () => {
        const text = buildText({
            mockupId: 1,
            noteBy: 'Taneisha',
            direction: 'ae',
            noteType: 'AE Instruction',
            noteText: 'hi'
        });
        expect(text).toContain('📝 *New note for Ruth — from Taneisha*');
        expect(text).not.toContain('Digitizing note');
    });

    test("direction 'artist' renders the 'Digitizing note' header", () => {
        const text = buildText({
            mockupId: 1,
            noteBy: 'Ruth',
            direction: 'artist',
            noteType: 'Digitizing Note',
            noteText: 'hi'
        });
        expect(text).toContain('📝 *Digitizing note — from Ruth*');
        expect(text).not.toContain('for Ruth —');
    });

    test('the two directions produce different header lines for the same note', () => {
        const base = { mockupId: 7, noteBy: 'Casey', noteType: 'Note', noteText: 'x' };
        const aeText = buildText(Object.assign({}, base, { direction: 'ae' }));
        const artistText = buildText(Object.assign({}, base, { direction: 'artist' }));
        const aeHeader = aeText.split('\n')[0];
        const artistHeader = artistText.split('\n')[0];
        expect(aeHeader).not.toBe(artistHeader);
    });

    test('falls back to "someone" when noteBy is absent', () => {
        const text = buildText({ mockupId: 1, direction: 'ae', noteText: 'x' });
        expect(text).toContain('from someone');
    });
});

describe('buildText — note truncation', () => {
    test('long note is truncated to 600 chars + ellipsis', () => {
        const longNote = 'A'.repeat(1000);
        const text = buildText({ mockupId: 1, direction: 'ae', noteText: longNote });
        expect(text).toContain('*Note:* ' + 'A'.repeat(600) + '…');
        expect(text).not.toContain('A'.repeat(601));
    });

    test('short note is left intact with no ellipsis', () => {
        const text = buildText({ mockupId: 1, direction: 'ae', noteText: 'short note' });
        expect(text).toContain('*Note:* short note');
        expect(text).not.toContain('…');
    });
});

describe('notifyMockupNote — error handling', () => {
    test('axios rejection resolves to {sent:false,error} and never throws', async () => {
        axios.post.mockRejectedValueOnce(new Error('network unreachable'));

        const result = await notifyMockupNote({ mockupId: 77777, noteId: 4242, direction: 'ae' });
        expect(result.sent).toBe(false);
        expect(result.error).toMatch(/network unreachable/);
    });

    test('dedup is rolled back after a failure so the next attempt re-fires', async () => {
        axios.post.mockRejectedValueOnce(new Error('boom'));
        const first = await notifyMockupNote({ mockupId: 88888, noteId: 8001, direction: 'ae' });
        expect(first.sent).toBe(false);

        axios.post.mockResolvedValueOnce({ status: 200 });
        const second = await notifyMockupNote({ mockupId: 88888, noteId: 8001, direction: 'ae' });
        expect(second).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(2);
    });
});
