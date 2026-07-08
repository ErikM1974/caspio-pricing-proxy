/**
 * quote-delete-response — lock for the 2026-07-08 delete-by-PK fix.
 *
 * Caspio v3 returns 200 {"RecordsAffected": 0} when a DELETE's q.where matches
 * nothing — the same status as a real delete. The proxy used to (a) discard
 * that body in makeCaspioRequest and (b) reply "deleted successfully,
 * recordsAffected: 0" for hits AND misses. This locks the pure seam: a real
 * count reports 200 with the true number; anything else is a 404, never a
 * fake success.
 *
 * Pure unit test — no network, no env vars.
 */

const { deleteResponseFor } = require('../../src/utils/quote-delete-response');

describe('deleteResponseFor', () => {
    test('RecordsAffected 1 → 200 with accurate count', () => {
        const { httpStatus, body } = deleteResponseFor('Quote session', {
            success: true, status: 200, RecordsAffected: 1,
        });
        expect(httpStatus).toBe(200);
        expect(body.message).toBe('Quote session deleted successfully');
        expect(body.recordsAffected).toBe(1);
    });

    test('RecordsAffected > 1 (bulk where) → 200 with the real count', () => {
        const { httpStatus, body } = deleteResponseFor('Quote item', {
            success: true, status: 200, RecordsAffected: 3,
        });
        expect(httpStatus).toBe(200);
        expect(body.recordsAffected).toBe(3);
    });

    test('RecordsAffected 0 (no row matched) → 404, never "deleted successfully"', () => {
        const { httpStatus, body } = deleteResponseFor('Quote session', {
            success: true, status: 200, RecordsAffected: 0,
        });
        expect(httpStatus).toBe(404);
        expect(body.error).toMatch(/not found/i);
        expect(body.recordsAffected).toBe(0);
        expect(body.message).toBeUndefined();
    });

    test('legacy shape without RecordsAffected ({success, status}) → 404, not a fabricated success', () => {
        // Exactly what makeCaspioRequest returned for every DELETE before the
        // fix — the shape that made recordsAffected: 0 appear on real deletes.
        const { httpStatus, body } = deleteResponseFor('Quote session', {
            success: true, status: 200,
        });
        expect(httpStatus).toBe(404);
        expect(body.recordsAffected).toBe(0);
    });

    test('null / garbage results → 404', () => {
        expect(deleteResponseFor('Quote item', null).httpStatus).toBe(404);
        expect(deleteResponseFor('Quote item', undefined).httpStatus).toBe(404);
        expect(deleteResponseFor('Quote item', { RecordsAffected: 'zero' }).httpStatus).toBe(404);
        expect(deleteResponseFor('Quote item', { RecordsAffected: -2 }).httpStatus).toBe(404);
    });

    test('numeric-string count from Caspio still reports honestly', () => {
        const { httpStatus, body } = deleteResponseFor('Quote analytics', {
            success: true, status: 200, RecordsAffected: '1',
        });
        expect(httpStatus).toBe(200);
        expect(body.recordsAffected).toBe(1);
    });
});
