/**
 * Unit tests for slack-art-note-notify.js
 *
 * Covers the contract the Art Hub note Slack ping depends on:
 *   • env unset  → skip with 'no-webhook' and axios NOT called
 *   • dedup      → second call within TTL on same noteId returns 'dedup', no 2nd POST
 *   • direction  → header text differs for 'ae' vs 'artist' (via __test__.buildText)
 *   • truncation → note body capped at MAX_NOTE_CHARS (600) with an ellipsis
 *   • resolves   → axios rejection returns {sent:false,error}, never throws
 *
 * axios is mocked — tests never hit the network.
 */
jest.mock('axios');
const axios = require('axios');

// Set env BEFORE require — module reads it at load time.
process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/noteXYZ';

const notifier = require('../../src/utils/slack-art-note-notify');
const { notifyArtNote } = notifier;
const { clearDedup, DEDUP_TTL_MS, buildText } = notifier.__test__;

beforeEach(() => {
    clearDedup();
    axios.post.mockReset();
});

describe('notifyArtNote — env-driven activation', () => {
    test('when env var is unset, returns skipped:no-webhook and never POSTs', () => {
        // Module reads env at load time. Re-require with env unset to verify.
        jest.resetModules();
        const oldUrl = process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL;
        delete process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL;

        jest.doMock('axios');
        const freshAxios = require('axios');
        const fresh = require('../../src/utils/slack-art-note-notify');

        return fresh.notifyArtNote({ idDesign: 11111, noteId: 1, direction: 'ae' }).then((result) => {
            expect(result).toEqual({ sent: false, skipped: 'no-webhook' });
            expect(freshAxios.post).not.toHaveBeenCalled();

            // Restore for the rest of the suite.
            process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL = oldUrl;
            jest.resetModules();
        });
    });
});

describe('notifyArtNote — happy path', () => {
    test('POSTs to webhook URL with mrkdwn text payload', async () => {
        axios.post.mockResolvedValue({ status: 200, data: 'ok' });

        const result = await notifyArtNote({
            idDesign: 40402,
            noteId: 555,
            noteType: 'To Art',
            noteText: 'Please tweak the logo placement.',
            noteBy: 'Taneisha',
            direction: 'ae',
            company: 'AutoShield',
            designNum: 'AS-1001'
        });

        expect(result).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(1);

        const [url, payload, opts] = axios.post.mock.calls[0];
        expect(url).toBe('https://hooks.slack.com/services/T000/B000/noteXYZ');
        expect(payload).toHaveProperty('text');
        expect(typeof payload.text).toBe('string');
        expect(payload.text).toContain('AutoShield');
        expect(payload.text).toContain('AS-1001');
        expect(payload.text).toContain('To Art');
        expect(payload.text).toContain('Please tweak the logo placement.');
        // Detail link uses the SITE_ORIGIN default + ID_Design.
        expect(payload.text).toContain('/art-request/40402');
        expect(opts).toMatchObject({ timeout: 8000, headers: { 'Content-Type': 'application/json' } });
    });
});

describe('notifyArtNote — dedup', () => {
    test('second call within TTL on same noteId returns dedup and does not POST again', async () => {
        axios.post.mockResolvedValue({ status: 200 });

        const first = await notifyArtNote({ idDesign: 40402, noteId: 9001, direction: 'ae' });
        expect(first).toEqual({ sent: true });

        const second = await notifyArtNote({ idDesign: 40402, noteId: 9001, direction: 'artist' });
        expect(second).toEqual({ sent: false, skipped: 'dedup' });
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('missing noteId disables dedup — both calls fire', async () => {
        axios.post.mockResolvedValue({ status: 200 });

        await notifyArtNote({ idDesign: 40402, direction: 'ae' });
        await notifyArtNote({ idDesign: 40402, direction: 'ae' });

        expect(axios.post).toHaveBeenCalledTimes(2);
    });

    test('TTL constant is 5 minutes', () => {
        expect(DEDUP_TTL_MS).toBe(5 * 60 * 1000);
    });
});

describe('buildText — direction-aware header', () => {
    test("direction 'ae' renders the 'for Steve' header", () => {
        const text = buildText({
            idDesign: 1,
            noteBy: 'Taneisha',
            direction: 'ae',
            noteType: 'To Art',
            noteText: 'hi'
        });
        expect(text).toContain('📝 *New note for Steve — from Taneisha*');
        expect(text).not.toContain('Art Dept note');
    });

    test("direction 'artist' renders the 'Art Dept note' header", () => {
        const text = buildText({
            idDesign: 1,
            noteBy: 'Steve',
            direction: 'artist',
            noteType: 'To Art',
            noteText: 'hi'
        });
        expect(text).toContain('📝 *Art Dept note — from Steve*');
        expect(text).not.toContain('for Steve');
    });

    test('the two directions produce different header lines for the same note', () => {
        const base = { idDesign: 7, noteBy: 'Casey', noteType: 'Note', noteText: 'x' };
        const aeText = buildText(Object.assign({}, base, { direction: 'ae' }));
        const artistText = buildText(Object.assign({}, base, { direction: 'artist' }));
        const aeHeader = aeText.split('\n')[0];
        const artistHeader = artistText.split('\n')[0];
        expect(aeHeader).not.toBe(artistHeader);
    });

    test('falls back to "someone" when noteBy is absent', () => {
        const text = buildText({ idDesign: 1, direction: 'ae', noteText: 'x' });
        expect(text).toContain('from someone');
    });
});

describe('buildText — note truncation', () => {
    test('long note is truncated to 600 chars + ellipsis', () => {
        const longNote = 'A'.repeat(1000);
        const text = buildText({ idDesign: 1, direction: 'ae', noteText: longNote });
        // The rendered note line is "*Note:* " + body. Body should be 600 A's + '…'.
        expect(text).toContain('*Note:* ' + 'A'.repeat(600) + '…');
        expect(text).not.toContain('A'.repeat(601));
    });

    test('short note is left intact with no ellipsis', () => {
        const text = buildText({ idDesign: 1, direction: 'ae', noteText: 'short note' });
        expect(text).toContain('*Note:* short note');
        expect(text).not.toContain('…');
    });
});

describe('notifyArtNote — error handling', () => {
    test('axios rejection resolves to {sent:false,error} and never throws', async () => {
        axios.post.mockRejectedValueOnce(new Error('network unreachable'));

        const result = await notifyArtNote({ idDesign: 77777, noteId: 4242, direction: 'ae' });
        expect(result.sent).toBe(false);
        expect(result.error).toMatch(/network unreachable/);
    });

    test('dedup is rolled back after a failure so the next attempt re-fires', async () => {
        axios.post.mockRejectedValueOnce(new Error('boom'));
        const first = await notifyArtNote({ idDesign: 88888, noteId: 8001, direction: 'ae' });
        expect(first.sent).toBe(false);

        axios.post.mockResolvedValueOnce({ status: 200 });
        const second = await notifyArtNote({ idDesign: 88888, noteId: 8001, direction: 'ae' });
        expect(second).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(2);
    });
});
