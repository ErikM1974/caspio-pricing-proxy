/**
 * Unit tests for slack-dm-notify.js — direct-message a Slack user.
 *
 * Covers:
 *   • no SLACK_BOT_TOKEN → graceful no-op (skipped:'no-token'), no HTTP
 *   • mapped email resolves via EMAIL_TO_SLACK_ID (no lookup call)
 *   • unmapped email falls back to users.lookupByEmail
 *   • unresolved user → skip, no chat.postMessage
 *   • chat.postMessage ok:false → {sent:false,error}
 *   • missing args → skip
 */
jest.mock('axios');
const axios = require('axios');

const { sendSlackDM, resolveSlackUserId } = require('../../src/utils/slack-dm-notify');

const ORIG_TOKEN = process.env.SLACK_BOT_TOKEN;

beforeEach(() => {
    axios.post.mockReset();
    axios.get.mockReset();
});
afterEach(() => {
    if (ORIG_TOKEN === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = ORIG_TOKEN;
});

describe('no-op when unconfigured', () => {
    test('no token → skipped:no-token, no HTTP', async () => {
        delete process.env.SLACK_BOT_TOKEN;
        const res = await sendSlackDM('nika@nwcustomapparel.com', 'hi');
        expect(res).toEqual({ sent: false, skipped: 'no-token' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('missing text → skipped:missing-args', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-test';
        const res = await sendSlackDM('nika@nwcustomapparel.com', '');
        expect(res).toEqual({ sent: false, skipped: 'missing-args' });
        expect(axios.post).not.toHaveBeenCalled();
    });
});

describe('resolveSlackUserId', () => {
    test('mapped AE email resolves from the hardcoded map without a lookup', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-test';
        const id = await resolveSlackUserId('Nika@NWCustomApparel.com'); // case-insensitive
        expect(id).toBe('UFR8DAZAP');
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('unmapped email falls back to users.lookupByEmail', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-test';
        axios.get.mockResolvedValue({ data: { ok: true, user: { id: 'U123NEW' } } });
        const id = await resolveSlackUserId('newrep@nwcustomapparel.com');
        expect(id).toBe('U123NEW');
        expect(axios.get).toHaveBeenCalledTimes(1);
    });

    test('lookup miss → null', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-test';
        axios.get.mockResolvedValue({ data: { ok: false, error: 'users_not_found' } });
        const id = await resolveSlackUserId('ghost@nwcustomapparel.com');
        expect(id).toBeNull();
    });
});

describe('sendSlackDM', () => {
    test('mapped AE → chat.postMessage to the user id', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-test';
        axios.post.mockResolvedValue({ data: { ok: true } });
        const res = await sendSlackDM('taneisha@nwcustomapparel.com', '🎯 done');
        expect(res).toEqual({ sent: true });
        const [url, body, opts] = axios.post.mock.calls[0];
        expect(url).toBe('https://slack.com/api/chat.postMessage');
        expect(body).toEqual({ channel: 'U099VV5A52T', text: '🎯 done' });
        expect(opts.headers.Authorization).toBe('Bearer xoxb-test');
    });

    test('unresolved user → skip, no post', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-test';
        axios.get.mockResolvedValue({ data: { ok: false } });
        const res = await sendSlackDM('ghost@nwcustomapparel.com', 'hi');
        expect(res).toEqual({ sent: false, skipped: 'unresolved-user' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('Slack ok:false surfaces error, never throws', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-test';
        axios.post.mockResolvedValue({ data: { ok: false, error: 'not_in_channel' } });
        const res = await sendSlackDM('nika@nwcustomapparel.com', 'hi');
        expect(res).toEqual({ sent: false, error: 'not_in_channel' });
    });

    test('network throw is caught → {sent:false,error}', async () => {
        process.env.SLACK_BOT_TOKEN = 'xoxb-test';
        axios.post.mockRejectedValue(new Error('ETIMEDOUT'));
        const res = await sendSlackDM('nika@nwcustomapparel.com', 'hi');
        expect(res.sent).toBe(false);
        expect(res.error).toMatch(/ETIMEDOUT/);
    });
});
