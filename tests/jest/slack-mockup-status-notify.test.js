/**
 * Unit tests for slack-mockup-status-notify.js
 *
 * Covers:
 *   • TRANSITIONS map: Awaiting Approval / Approved / Completed
 *   • untracked status (e.g. 'Revision Requested') → silent skip (handled by separate module)
 *   • Design # — Design Name composition
 *   • dedup keyed by (id|transition)
 */
jest.mock('axios');
const axios = require('axios');

process.env.SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL = 'https://hooks.slack.com/services/T0/B0/mockstatus';

const notifier = require('../../src/utils/slack-mockup-status-notify');
const { notifyMockupStatusTransition } = notifier;
const { clearDedup, buildText, TRANSITIONS } = notifier.__test__;

beforeEach(() => {
    clearDedup();
    axios.post.mockReset();
});

describe('TRANSITIONS map', () => {
    test('has the three watched mockup transitions', () => {
        expect(Object.keys(TRANSITIONS).sort()).toEqual([
            'Approved',
            'Awaiting Approval',
            'Completed'
        ]);
    });
});

describe('buildText', () => {
    const base = {
        ID: 9876,
        Company_Name: 'AutoShield',
        Design_Number: '40402',
        Design_Name: 'Phoenix Logo',
        Actor: 'Ruth'
    };

    test('Awaiting Approval renders 📤', () => {
        const text = buildText(base, 'Awaiting Approval');
        expect(text).toMatch(/📤 \*Mockup Ready for Approval by Ruth\*/);
        expect(text).toMatch(/\*Design #:\* 40402 — Phoenix Logo/);
        expect(text).toMatch(/\|View mockup>/);
    });

    test('Approved renders ✅', () => {
        const text = buildText(base, 'Approved');
        expect(text).toMatch(/✅ \*Mockup Approved by Ruth\*/);
    });

    test('Completed renders 🎯', () => {
        const text = buildText(base, 'Completed');
        expect(text).toMatch(/🎯 \*Mockup Completed by Ruth\*/);
    });

    test('actor omitted when blank', () => {
        const text = buildText({ ...base, Actor: '' }, 'Approved');
        expect(text).toMatch(/✅ \*Mockup Approved\*$/m);
        expect(text).not.toMatch(/by /);
    });

    test('design line uses just number when name missing', () => {
        const text = buildText({ ...base, Design_Name: '' }, 'Approved');
        expect(text).toMatch(/\*Design #:\* 40402$/m);
        expect(text).not.toMatch(/—/);
    });

    test('untracked status returns empty string', () => {
        expect(buildText(base, 'Revision Requested')).toBe('');
        expect(buildText(base, 'Submitted')).toBe('');
    });
});

describe('notifyMockupStatusTransition — gating', () => {
    test('Awaiting Approval POSTs once', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        const result = await notifyMockupStatusTransition({
            ID: 1, Company_Name: 'X', Design_Number: '111'
        }, 'Awaiting Approval');
        expect(result).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('untracked status → silent skip, no POST', async () => {
        const result = await notifyMockupStatusTransition({ ID: 1 }, 'Revision Requested');
        expect(result.skipped).toBe('transition-not-watched');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('missing ID → skip', async () => {
        const result = await notifyMockupStatusTransition({}, 'Approved');
        expect(result.skipped).toBe('missing-id');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('dedup: same transition twice fires once', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        await notifyMockupStatusTransition({ ID: 5 }, 'Completed');
        const second = await notifyMockupStatusTransition({ ID: 5 }, 'Completed');
        expect(second.skipped).toBe('dedup');
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('dedup is per-transition: different transitions fire independently', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        await notifyMockupStatusTransition({ ID: 5 }, 'Awaiting Approval');
        await notifyMockupStatusTransition({ ID: 5 }, 'Approved');
        await notifyMockupStatusTransition({ ID: 5 }, 'Completed');
        expect(axios.post).toHaveBeenCalledTimes(3);
    });
});
