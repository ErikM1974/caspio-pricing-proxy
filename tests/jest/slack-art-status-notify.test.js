/**
 * Unit tests for slack-art-status-notify.js
 *
 * Covers:
 *   • TRANSITIONS map: Awaiting Approval / Customer Approved / Completed
 *   • '__on_hold__' branch — surfaces On_Hold_Note as *Reason:*
 *   • untracked status (e.g. 'In Progress') → silent skip, no POST
 *   • Item_Type label included for non-garment
 *   • dedup keyed by (id|transition) so each transition fires once but a
 *     subsequent different-transition fires
 *   • non-200 rolls back dedup
 */
jest.mock('axios');
const axios = require('axios');

process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL = 'https://hooks.slack.com/services/T0/B0/status';

const notifier = require('../../src/utils/slack-art-status-notify');
const { notifyArtStatusTransition } = notifier;
const { clearDedup, buildText, TRANSITIONS } = notifier.__test__;

beforeEach(() => {
    clearDedup();
    axios.post.mockReset();
});

describe('TRANSITIONS map', () => {
    test('has the three watched art transitions', () => {
        expect(Object.keys(TRANSITIONS).sort()).toEqual([
            'Awaiting Approval',
            'Completed',
            'Customer Approved'
        ]);
    });
});

describe('buildText — happy paths', () => {
    const base = {
        ID_Design: 12345,
        CompanyName: 'AutoShield',
        Design_Num_SW: '40402',
        Item_Type: null,
        Actor: 'Steve'
    };

    test('Awaiting Approval renders 📤 with actor', () => {
        const text = buildText(base, 'Awaiting Approval');
        expect(text).toMatch(/📤 \*Mockup Sent for Customer Approval by Steve\*/);
        expect(text).toMatch(/\*Company:\* AutoShield/);
        expect(text).toMatch(/\*Design #:\* 40402/);
        expect(text).toMatch(/\|View art request>/);
    });

    test('Customer Approved renders ✅', () => {
        const text = buildText(base, 'Customer Approved');
        expect(text).toMatch(/✅ \*Customer Approved by Steve\*/);
    });

    test('Completed renders 🎯', () => {
        const text = buildText(base, 'Completed');
        expect(text).toMatch(/🎯 \*Artwork Completed by Steve\*/);
    });

    test('actor omitted when blank', () => {
        const text = buildText({ ...base, Actor: '' }, 'Completed');
        expect(text).toMatch(/🎯 \*Artwork Completed\*/);
        expect(text).not.toMatch(/by /);
    });

    test('Item_Type=Sticker shows Item Type field', () => {
        const text = buildText({ ...base, Item_Type: 'Sticker' }, 'Completed');
        expect(text).toMatch(/\*Item Type:\* Sticker Request/);
    });

    test('Item_Type=Banner strips "(Manual Quote)" from the type label', () => {
        const text = buildText({ ...base, Item_Type: 'Banner' }, 'Completed');
        expect(text).toMatch(/\*Item Type:\* Banner Request$/m);
        expect(text).not.toMatch(/Manual Quote/);
    });

    test('On Hold (__on_hold__) renders ⏸️ with reason from On_Hold_Note', () => {
        const text = buildText({
            ...base,
            On_Hold_Note: 'Customer needs to confirm pantone color'
        }, '__on_hold__');
        expect(text).toMatch(/⏸️ \*Art On Hold by Steve\*/);
        expect(text).toMatch(/\*Reason:\* Customer needs to confirm pantone color/);
    });

    test('On Hold without note omits *Reason:* line', () => {
        const text = buildText(base, '__on_hold__');
        expect(text).not.toMatch(/Reason/);
    });

    test('untracked transition returns empty string', () => {
        expect(buildText(base, 'In Progress')).toBe('');
        expect(buildText(base, 'Submitted')).toBe('');
    });
});

describe('notifyArtStatusTransition — gating', () => {
    test('Awaiting Approval POSTs once', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        const result = await notifyArtStatusTransition({
            ID_Design: 1, CompanyName: 'X'
        }, 'Awaiting Approval');
        expect(result).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('untracked transition → silent skip, no POST', async () => {
        const result = await notifyArtStatusTransition({ ID_Design: 1 }, 'In Progress');
        expect(result.skipped).toBe('transition-not-watched');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('missing ID_Design → skip', async () => {
        const result = await notifyArtStatusTransition({}, 'Completed');
        expect(result.skipped).toBe('missing-id-design');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('dedup: same transition twice within TTL fires once', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        await notifyArtStatusTransition({ ID_Design: 5 }, 'Completed');
        const second = await notifyArtStatusTransition({ ID_Design: 5 }, 'Completed');
        expect(second.skipped).toBe('dedup');
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('dedup is per-transition: different transitions fire independently', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        await notifyArtStatusTransition({ ID_Design: 5 }, 'Awaiting Approval');
        await notifyArtStatusTransition({ ID_Design: 5 }, 'Customer Approved');
        await notifyArtStatusTransition({ ID_Design: 5 }, 'Completed');
        expect(axios.post).toHaveBeenCalledTimes(3);
    });

    test('non-200 rolls back dedup so retry can fire', async () => {
        axios.post.mockRejectedValueOnce(new Error('500 Internal'));
        const first = await notifyArtStatusTransition({ ID_Design: 7 }, 'Completed');
        expect(first.error).toMatch(/500/);

        axios.post.mockResolvedValueOnce({ status: 200 });
        const second = await notifyArtStatusTransition({ ID_Design: 7 }, 'Completed');
        expect(second).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(2);
    });

    test('__on_hold__ fires through gating', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        const result = await notifyArtStatusTransition({
            ID_Design: 9, CompanyName: 'X', On_Hold_Note: 'awaiting samples'
        }, '__on_hold__');
        expect(result).toEqual({ sent: true });
        const [, payload] = axios.post.mock.calls[0];
        expect(payload.text).toMatch(/⏸️ \*Art On Hold\*/);
        expect(payload.text).toMatch(/awaiting samples/);
    });
});
