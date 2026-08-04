/**
 * fetchAllCaspioPages strict-mode truncation must SURFACE, not be swallowed.
 *
 * The truncation guard throws CASPIO_PAGINATION_TRUNCATED inside the same try
 * whose catch returns partial results whenever any rows were collected — which
 * at page-cap truncation is always. Before the fix, strict:true was therefore a
 * no-op for the exact case it exists for (silent 20k-of-155k truncation, the
 * failure mode that re-uploaded ~6,900 thumbnails in July 2026). These tests
 * lock the rethrow AND the two behaviors that must not change: non-strict
 * callers still get partials at the cap, and partial-on-midstream-error stays.
 */

process.env.CASPIO_ACCOUNT_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN || 'test.caspio.com';
process.env.CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID || 'test-client';
process.env.CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET || 'test-secret';

jest.mock('axios', () => {
    const mockAxios = jest.fn();
    mockAxios.post = jest.fn();
    mockAxios.interceptors = {
        request: { use: jest.fn() },
        response: { use: jest.fn() }
    };
    return mockAxios;
});

// caspio.js requires api-tracker purely for its axios-interceptor side effect;
// stub it out so the test never installs metering or timers.
jest.mock('../../src/utils/api-tracker', () => ({}));

const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');

const FULL_PAGE = { data: { Result: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }] } };

beforeEach(() => {
    axios.mockReset();
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { access_token: 'tok', expires_in: 3600 } });
});

test('strict:true surfaces CASPIO_PAGINATION_TRUNCATED instead of returning partials', async () => {
    // Every page comes back full (5 rows at q.limit=5, no TotalRecords, no
    // NextPageUrl) so the fallback pagination believes more rows exist when the
    // maxPages cap stops the loop — the truncation case.
    axios.mockResolvedValue(FULL_PAGE);

    expect.assertions(2);
    try {
        await fetchAllCaspioPages('/tables/Fake/records', { 'q.limit': 5 }, { maxPages: 2, strict: true });
    } catch (err) {
        expect(err.code).toBe('CASPIO_PAGINATION_TRUNCATED');
        expect(err.message).toContain('maxPages=2');
    }
});

test('default (non-strict) still returns the capped partial result set', async () => {
    axios.mockResolvedValue(FULL_PAGE);

    const rows = await fetchAllCaspioPages('/tables/Fake/records', { 'q.limit': 5 }, { maxPages: 2 });
    expect(rows).toHaveLength(10);
});

test('mid-stream non-truncation error still returns rows collected so far', async () => {
    const failure = new Error('boom');
    failure.response = { status: 500 };
    axios.mockResolvedValueOnce(FULL_PAGE).mockRejectedValueOnce(failure);

    const rows = await fetchAllCaspioPages('/tables/Fake/records', { 'q.limit': 5 }, { maxPages: 5 });
    expect(rows).toHaveLength(5);
});
