/**
 * Unit tests for slack-art-reminder-notify.js
 *
 *   • happy path POSTs once
 *   • dedup window squelches double-clicks
 *   • missing ID_Design → skip
 *   • env unset → skip without throwing
 */
jest.mock('axios');
const axios = require('axios');

process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL = 'https://hooks.slack.com/services/T0/B0/reminder';

const notifier = require('../../src/utils/slack-art-reminder-notify');
const { notifyArtReminder } = notifier;
const { clearDedup, buildText } = notifier.__test__;

beforeEach(() => {
    clearDedup();
    axios.post.mockReset();
});

describe('buildText', () => {
    test('full record with AE + recipient', () => {
        const text = buildText({
            ID_Design: 12345,
            CompanyName: 'AutoShield',
            Design_Num_SW: '40402',
            AE_Name: 'Nika',
            Recipient_Email: 'sales@autoshield.com'
        });
        expect(text).toMatch(/🔔 \*Approval Reminder Sent by Nika\*/);
        expect(text).toMatch(/\*Company:\* AutoShield/);
        expect(text).toMatch(/\*Design #:\* 40402/);
        expect(text).toMatch(/\*To:\* sales@autoshield\.com/);
        expect(text).toMatch(/\|View art request>/);
    });

    test('omits AE name when blank', () => {
        const text = buildText({ ID_Design: 1 });
        expect(text).toMatch(/🔔 \*Approval Reminder Sent\*$/m);
        expect(text).not.toMatch(/by /);
    });
});

describe('notifyArtReminder — gating', () => {
    test('happy path POSTs once', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        const result = await notifyArtReminder({
            ID_Design: 1, CompanyName: 'X', AE_Name: 'Nika'
        });
        expect(result).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('dedup: same designId twice within window fires once', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        await notifyArtReminder({ ID_Design: 5 });
        const second = await notifyArtReminder({ ID_Design: 5 });
        expect(second.skipped).toBe('dedup');
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('missing ID_Design → skip', async () => {
        const result = await notifyArtReminder({});
        expect(result.skipped).toBe('missing-id-design');
        expect(axios.post).not.toHaveBeenCalled();
    });
});
