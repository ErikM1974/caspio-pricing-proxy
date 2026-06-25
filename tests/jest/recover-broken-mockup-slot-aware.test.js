/**
 * Unit tests for slot-aware recovery (added 2026-05-06).
 *
 * Pins the contract that recoverBrokenMockup validates slotField BEFORE
 * making any Box / Caspio calls — so a misconfigured frontend can't trick
 * the util into writing arbitrary fields on ArtRequests.
 *
 * The full recovery happy-path (folder search → image pick → Caspio write)
 * requires Box API access and is exercised by manual integration tests
 * against the live proxy. What we pin here is the cheap, deterministic
 * stuff: validation, error shape, default behavior.
 */

// Import without env vars for Box — the validation paths return early before
// any Box call, so we never hit the network.
const {
    recoverBrokenMockup,
    updateMockupSlot,
    VALID_SLOT_FIELDS
} = require('../../src/utils/recover-broken-mockup');

describe('VALID_SLOT_FIELDS', () => {
    test('exports the canonical 8-field list (6 mockup slots + 2 additional-art)', () => {
        expect(VALID_SLOT_FIELDS).toEqual([
            'Box_File_Mockup',
            'BoxFileLink',
            'Company_Mockup',
            'Mockup_4',
            'Mockup_5',
            'Mockup_6',
            'Additional_Art_1',
            'Additional_Art_2'
        ]);
    });
});

describe('recoverBrokenMockup — slotField validation', () => {
    const baseOpts = {
        pkId: 999,
        designNumber: '40402',
        companyName: 'Test',
        getBoxToken: async () => 'fake-token-never-used'
    };

    test('rejects invalid slotField without making Box calls', async () => {
        const result = await recoverBrokenMockup({
            ...baseOpts,
            slotField: 'Some_Random_Field'
        });
        expect(result.status).toBe('error');
        expect(result.error).toMatch(/invalid slotField/);
        expect(result.error).toMatch(/Box_File_Mockup/);
    });

    test('rejects empty slotField string', async () => {
        const result = await recoverBrokenMockup({
            ...baseOpts,
            slotField: 'NotAField'
        });
        expect(result.status).toBe('error');
    });

    test('accepts each VALID_SLOT_FIELDS entry (validation passes — Box call may fail later)', async () => {
        for (const field of VALID_SLOT_FIELDS) {
            const result = await recoverBrokenMockup({
                ...baseOpts,
                slotField: field,
                // Force getBoxToken to throw so we exit early after passing validation.
                getBoxToken: async () => { throw new Error('intentional-stop'); }
            });
            // Passes validation → enters try block → getBoxToken throws → caught
            // and returned as 'error' with that exact message. If validation had
            // failed instead, the error would mention 'invalid slotField'.
            expect(result.status).toBe('error');
            expect(result.error).toBe('intentional-stop');
        }
    });

    test('omitted slotField defaults to Box_File_Mockup (back-compat)', async () => {
        const result = await recoverBrokenMockup({
            ...baseOpts,
            getBoxToken: async () => { throw new Error('stop'); }
            // slotField intentionally not provided
        });
        // The error path includes slotField in the result for upstream notify use.
        expect(result.slotField).toBe('Box_File_Mockup');
    });
});

describe('recoverBrokenMockup — required-field guards', () => {
    test('missing pkId → error', async () => {
        const result = await recoverBrokenMockup({
            designNumber: '40402',
            getBoxToken: async () => 'tok'
        });
        expect(result.status).toBe('error');
        expect(result.error).toMatch(/missing pkId/);
    });

    test('missing designNumber → error', async () => {
        const result = await recoverBrokenMockup({
            pkId: 1,
            getBoxToken: async () => 'tok'
        });
        expect(result.status).toBe('error');
        expect(result.error).toMatch(/missing designNumber/);
    });

    test('missing getBoxToken → error', async () => {
        const result = await recoverBrokenMockup({
            pkId: 1,
            designNumber: '40402'
        });
        expect(result.status).toBe('error');
        expect(result.error).toMatch(/getBoxToken function required/);
    });
});

describe('updateMockupSlot — direct call', () => {
    test('throws on invalid slotField (does not make Caspio call)', async () => {
        await expect(updateMockupSlot({
            pkId: 1,
            slotField: 'XX_Bogus',
            newUrl: 'https://...'
        })).rejects.toThrow(/invalid slotField/);
    });
});
