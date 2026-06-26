/**
 * Unit tests for notify-art-completion.js — server-side AE completion alert.
 *
 * Covers:
 *   • resolveCompletionRecipient: full-name Sales_Rep ("Nika Lao") → AE email
 *     (the exact bug that misrouted completion email to sales@), User_Email
 *     fallback, and customer-email rejection.
 *   • notifyArtCompletionToAE: sends email + DM to the resolved AE; skips
 *     cleanly with no sends when no internal recipient resolves.
 */
jest.mock('../../src/utils/send-art-note-email');
jest.mock('../../src/utils/slack-dm-notify');

const { sendArtNoteEmail } = require('../../src/utils/send-art-note-email');
const { sendSlackDM } = require('../../src/utils/slack-dm-notify');
const { notifyArtCompletionToAE, __test__ } = require('../../src/utils/notify-art-completion');
const { resolveCompletionRecipient } = __test__;

beforeEach(() => {
    sendArtNoteEmail.mockReset().mockResolvedValue({ sent: true });
    sendSlackDM.mockReset().mockResolvedValue({ sent: true });
});

describe('resolveCompletionRecipient', () => {
    test('full-name Sales_Rep resolves to AE email (the misroute bug)', () => {
        expect(resolveCompletionRecipient('Nika Lao', '')).toBe('nika@nwcustomapparel.com');
        expect(resolveCompletionRecipient('Taneisha Clark', '')).toBe('taneisha@nwcustomapparel.com');
    });
    test('bare first name still resolves', () => {
        expect(resolveCompletionRecipient('Nika', '')).toBe('nika@nwcustomapparel.com');
    });
    test('blank Sales_Rep falls back to internal User_Email', () => {
        expect(resolveCompletionRecipient('', 'nika@nwcustomapparel.com')).toBe('nika@nwcustomapparel.com');
    });
    test('customer email is never targeted', () => {
        expect(resolveCompletionRecipient('', 'customer@gmail.com')).toBeNull();
        expect(resolveCompletionRecipient('Unknown Person', 'customer@gmail.com')).toBeNull();
    });
});

describe('notifyArtCompletionToAE', () => {
    test('sends email + DM to the resolved AE', async () => {
        const res = await notifyArtCompletionToAE({
            idDesign: 53011,
            company: 'Cascade Cougar Club',
            designNumSW: '40009',
            salesRep: 'Nika Lao',
            userEmail: 'nika@nwcustomapparel.com',
            actor: 'Steve'
        });

        expect(res.toEmail).toBe('nika@nwcustomapparel.com');
        expect(sendArtNoteEmail).toHaveBeenCalledTimes(1);
        const emailArg = sendArtNoteEmail.mock.calls[0][0];
        expect(emailArg.toEmail).toBe('nika@nwcustomapparel.com');
        expect(emailArg.noteType).toBe('Artwork Completed');
        expect(emailArg.recipientIsRep).toBe(true);
        expect(emailArg.idDesign).toBe(53011);

        expect(sendSlackDM).toHaveBeenCalledTimes(1);
        const [dmEmail, dmText] = sendSlackDM.mock.calls[0];
        expect(dmEmail).toBe('nika@nwcustomapparel.com');
        expect(dmText).toMatch(/Artwork Completed/);
        expect(dmText).toMatch(/#40009/);
    });

    test('no internal recipient → skip, no email, no DM', async () => {
        const res = await notifyArtCompletionToAE({
            idDesign: 999,
            company: 'Walk-in',
            salesRep: '',
            userEmail: 'walkin@gmail.com'
        });
        expect(res.skipped).toBe('no-recipient');
        expect(sendArtNoteEmail).not.toHaveBeenCalled();
        expect(sendSlackDM).not.toHaveBeenCalled();
    });

    test('resolves (never throws) even if a sender rejects', async () => {
        sendSlackDM.mockRejectedValueOnce(new Error('boom'));
        const res = await notifyArtCompletionToAE({
            idDesign: 1, company: 'X', salesRep: 'Nika', userEmail: ''
        });
        // Promise.all rejects → caught → skipped:'error', still resolves.
        expect(res.skipped).toBe('error');
    });
});
