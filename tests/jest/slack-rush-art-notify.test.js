/**
 * Unit tests for slack-rush-art-notify.js — locks the rush message contract.
 *
 *   • Item_Type emoji label propagates ("RUSH STICKER REQUEST")
 *   • specs block surfaced for non-garment
 *   • Is_Rush truthy variations all fire
 *   • Is_Rush falsy → silent skip, no POST
 */
jest.mock('axios');
const axios = require('axios');

process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL = 'https://hooks.slack.com/services/T0/B0/rush';

const notifier = require('../../src/utils/slack-rush-art-notify');
const { notifyRushArtRequest } = notifier;
const { clearDedup, buildText, isTruthy } = notifier.__test__;

beforeEach(() => {
    clearDedup();
    axios.post.mockReset();
});

describe('isTruthy — Caspio Is_Rush coercion', () => {
    test.each([true, 'true', 'Yes', 1])('%j → true', (v) => {
        expect(isTruthy(v)).toBe(true);
    });
    test.each([false, 'false', 'No', 0, null, undefined, ''])('%j → false', (v) => {
        expect(isTruthy(v)).toBe(false);
    });
});

describe('buildText — Item_Type label propagation', () => {
    const base = {
        ID_Design: 99,
        CompanyName: 'AutoShield',
        Design_Num_SW: '40500',
        Due_Date: '2026-05-15',
        Sales_Rep: 'Taneisha'
    };

    test('Garment / null → RUSH ART REQUEST', () => {
        const text = buildText({ ...base, Item_Type: null });
        expect(text).toMatch(/🔥 \*RUSH ART REQUEST\* — AutoShield/);
        expect(text).not.toMatch(/Specs/);
    });

    test('Sticker → RUSH STICKER REQUEST + Specs', () => {
        const text = buildText({
            ...base,
            Item_Type: 'Sticker',
            Item_Specs_Notes: 'STICKER REQUEST\nSize: 4" × 4"'
        });
        expect(text).toMatch(/🔥 \*RUSH STICKER REQUEST\* — AutoShield/);
        expect(text).toMatch(/\*Specs:\*\nSTICKER REQUEST/);
    });

    test('Banner → RUSH BANNER REQUEST (MANUAL QUOTE) + Specs', () => {
        const text = buildText({
            ...base,
            Item_Type: 'Banner',
            Item_Specs_Notes: 'BANNER REQUEST\nDimensions: 24" × 72"'
        });
        expect(text).toMatch(/🔥 \*RUSH BANNER REQUEST \(MANUAL QUOTE\)\* — AutoShield/);
    });

    test('JDS → RUSH JDS LASER REQUEST + JDS SKU + Specs', () => {
        const text = buildText({
            ...base,
            Item_Type: 'JDS',
            JDS_SKU: 'LTM7001',
            Item_Specs_Notes: 'JDS REQUEST\nProduct: Polar Camel 20oz'
        });
        expect(text).toMatch(/🔥 \*RUSH JDS LASER REQUEST\* — AutoShield/);
        expect(text).toMatch(/\*JDS SKU:\* LTM7001/);
        expect(text).toMatch(/\*Specs:\*\nJDS REQUEST/);
    });
});

describe('notifyRushArtRequest — gating', () => {
    test('Is_Rush=true POSTs once', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        const result = await notifyRushArtRequest({ ID_Design: 1, Is_Rush: true });
        expect(result).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('Is_Rush falsy → silent skip, no POST', async () => {
        const result = await notifyRushArtRequest({ ID_Design: 1, Is_Rush: false });
        expect(result.skipped).toBe('not-rush');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('missing ID_Design → skip', async () => {
        const result = await notifyRushArtRequest({ Is_Rush: true });
        expect(result.skipped).toBe('missing-id-design');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('dedup within TTL', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        await notifyRushArtRequest({ ID_Design: 5, Is_Rush: true });
        const second = await notifyRushArtRequest({ ID_Design: 5, Is_Rush: true });
        expect(second.skipped).toBe('dedup');
        expect(axios.post).toHaveBeenCalledTimes(1);
    });
});
