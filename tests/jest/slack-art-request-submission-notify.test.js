/**
 * Unit tests for slack-art-request-submission-notify.js
 *
 * Locks the Item_Type-aware message contract:
 *   • Garment / null → 🎨 header, Placement field, NOTES, no Specs
 *   • Sticker → 🏷️ header, no Placement, Specs block
 *   • Banner → 🪧 header with "Manual Quote", Specs block
 *   • JDS → 🔬 header, JDS_SKU surfaced, Specs block
 *   • dedup, env-unset, missing-id, non-Submitted skips behave per existing pattern
 *
 * axios is mocked — tests never hit the network.
 */
jest.mock('axios');
const axios = require('axios');

process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/artHook';

const notifier = require('../../src/utils/slack-art-request-submission-notify');
const { notifyArtRequestSubmission } = notifier;
const { clearDedup, buildText, buildPayload, metaForItemType, ITEM_TYPE_META } = notifier.__test__;

beforeEach(() => {
    clearDedup();
    axios.post.mockReset();
});

describe('metaForItemType', () => {
    test('null / missing → Garment', () => {
        expect(metaForItemType(null)).toBe(ITEM_TYPE_META.Garment);
        expect(metaForItemType(undefined)).toBe(ITEM_TYPE_META.Garment);
        expect(metaForItemType('')).toBe(ITEM_TYPE_META.Garment);
    });
    test('unknown Item_Type → Garment fallback', () => {
        expect(metaForItemType('Frisbee')).toBe(ITEM_TYPE_META.Garment);
    });
    test('known types map exactly', () => {
        expect(metaForItemType('Garment').emoji).toBe('🎨');
        expect(metaForItemType('Sticker').emoji).toBe('🏷️');
        expect(metaForItemType('Banner').emoji).toBe('🪧');
        expect(metaForItemType('JDS').emoji).toBe('🔬');
    });
});

describe('buildText — Item_Type branches', () => {
    const baseRecord = {
        ID_Design: 12345,
        CompanyName: 'AutoShield',
        Design_Num_SW: '40402',
        Due_Date: '2026-05-15',
        Sales_Rep: 'Nika',
        NOTES: 'Match brand red'
    };

    test('Garment (null Item_Type) renders 🎨 header, Placement, NOTES, no Specs', () => {
        const text = buildText({
            ...baseRecord,
            Item_Type: null,
            Garment_Placement: 'Left Chest',
            Item_Specs_Notes: 'should be ignored for garment'
        });
        expect(text).toMatch(/🎨 \*New Art Request from Nika\*/);
        expect(text).toMatch(/\*Placement:\* Left Chest/);
        expect(text).toMatch(/\*Notes:\* Match brand red/);
        expect(text).not.toMatch(/\*Specs:\*/);
        expect(text).toMatch(/\|View art request>/);
    });

    test('Sticker renders 🏷️ header, no Placement, Specs block', () => {
        const text = buildText({
            ...baseRecord,
            Item_Type: 'Sticker',
            Garment_Placement: 'should be hidden for sticker',
            Item_Specs_Notes: 'STICKER REQUEST\nSize: 3" × 3"\nMaterial: Vinyl — Gloss'
        });
        expect(text).toMatch(/🏷️ \*New Sticker Request from Nika\*/);
        expect(text).not.toMatch(/Placement/);
        expect(text).toMatch(/\*Specs:\*\nSTICKER REQUEST/);
        expect(text).toMatch(/Material: Vinyl — Gloss/);
    });

    test('Banner renders 🪧 header with Manual Quote label and Specs block', () => {
        const text = buildText({
            ...baseRecord,
            Item_Type: 'Banner',
            Item_Specs_Notes: 'BANNER REQUEST\nDimensions: 24" × 72"\nMaterial: 13oz Vinyl'
        });
        expect(text).toMatch(/🪧 \*New Banner Request \(Manual Quote\) from Nika\*/);
        expect(text).toMatch(/\*Specs:\*\nBANNER REQUEST/);
        expect(text).toMatch(/Material: 13oz Vinyl/);
    });

    test('JDS renders 🔬 header, JDS SKU, and Specs block', () => {
        const text = buildText({
            ...baseRecord,
            Item_Type: 'JDS',
            JDS_SKU: 'LTM7001',
            Item_Specs_Notes: 'JDS REQUEST\nProduct: Polar Camel 20oz Tumbler\nEngrave Color: Silver'
        });
        expect(text).toMatch(/🔬 \*New JDS Laser Request from Nika\*/);
        expect(text).toMatch(/\*JDS SKU:\* LTM7001/);
        expect(text).toMatch(/\*Specs:\*\nJDS REQUEST/);
    });

    test('header omits "from {salesRep}" when Sales_Rep is empty', () => {
        const text = buildText({ ...baseRecord, Sales_Rep: '', Item_Type: 'Sticker' });
        expect(text).toMatch(/🏷️ \*New Sticker Request\*/);
        expect(text).not.toMatch(/from /);
    });
});

describe('buildPayload — image attachment caption', () => {
    test('Garment uses default caption when CDN_Link present', () => {
        const payload = buildPayload({
            ID_Design: 1, Item_Type: 'Garment', CDN_Link: 'https://example.com/x.jpg'
        });
        expect(payload.attachments).toEqual([
            { image_url: 'https://example.com/x.jpg', text: 'Reference artwork' }
        ]);
    });
    test('JDS uses Catalog/reference caption', () => {
        const payload = buildPayload({
            ID_Design: 1, Item_Type: 'JDS', CDN_Link: 'https://example.com/jds.jpg'
        });
        expect(payload.attachments[0].text).toBe('Catalog / reference');
    });
    test('no attachments when CDN_Link missing', () => {
        const payload = buildPayload({ ID_Design: 1, Item_Type: 'Sticker' });
        expect(payload.attachments).toBeUndefined();
    });
});

describe('notifyArtRequestSubmission — gating', () => {
    test('happy path POSTs once', async () => {
        axios.post.mockResolvedValue({ status: 200, data: 'ok' });
        const result = await notifyArtRequestSubmission({
            ID_Design: 1, CompanyName: 'X', Item_Type: 'Sticker', Status: 'Submitted'
        });
        expect(result).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('dedup: second call within TTL returns dedup, no second POST', async () => {
        axios.post.mockResolvedValue({ status: 200 });
        await notifyArtRequestSubmission({ ID_Design: 9, CompanyName: 'X', Status: 'Submitted' });
        const second = await notifyArtRequestSubmission({ ID_Design: 9, CompanyName: 'X', Status: 'Submitted' });
        expect(second.skipped).toBe('dedup');
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('skip when Status is something other than Submitted', async () => {
        const result = await notifyArtRequestSubmission({ ID_Design: 5, Status: 'In Progress' });
        expect(result.skipped).toBe('not-submitted');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('skip when ID_Design missing', async () => {
        const result = await notifyArtRequestSubmission({ CompanyName: 'X' });
        expect(result.skipped).toBe('missing-id-design');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('non-200 response rolls back dedup so retry can fire', async () => {
        axios.post.mockRejectedValueOnce(new Error('500 Internal'));
        const first = await notifyArtRequestSubmission({ ID_Design: 7, Status: 'Submitted' });
        expect(first.error).toMatch(/500/);

        axios.post.mockResolvedValueOnce({ status: 200 });
        const second = await notifyArtRequestSubmission({ ID_Design: 7, Status: 'Submitted' });
        expect(second).toEqual({ sent: true });
        expect(axios.post).toHaveBeenCalledTimes(2);
    });
});
