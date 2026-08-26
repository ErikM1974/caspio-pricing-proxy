/**
 * fetchAllCaspioPages must use ONE paging model, starting at page 1.
 *
 * WHY (2026-08-26)
 * It used to request page 1 with `q.limit` and pages 2+ with
 * `q.pageSize` + `q.pageNumber`. Those are different paging models and Caspio does not agree
 * between them about which rows are the first N. Measured live on SanMar_Shipments, 1,626 rows:
 *
 *     q.limit=1000                    -> 1000 rows, PK 1119..1271
 *     q.pageSize=1000&q.pageNumber=1  -> 1000 rows, PK    6..1005
 *     q.pageSize=1000&q.pageNumber=2  ->  626 rows, PK 1006..1631
 *
 * So page 2 continued from a baseline page 1 never delivered. The call returned 1,626 rows
 * containing 326 DUPLICATES while 326 real rows were never returned at all — silently, and
 * only on result sets bigger than one page, which is why it hid behind every narrow q.where.
 * It was found while backfilling Ship_To, where it made the target count read 202 instead of
 * the true 165 — i.e. it would have written phantom rows and skipped real ones.
 *
 * The second half: Caspio rejects q.pageSize < 5, and 51 call sites pass `q.limit: 1` as an
 * existence check. Those used to cost FOUR requests to read one row — page 1 succeeded, the
 * fallback saw a "full" page and asked for q.pageSize=1&q.pageNumber=2, Caspio 400'd, the
 * 400-handler burned a token refresh and retried, and it 400'd again. Caspio quota is a hard
 * constraint here, so that waste was real money on the hottest read path in the repo.
 *
 * These tests assert the REQUESTS, not just the rows — the bug was invisible in the returned
 * array on any small table, and only the outgoing params tell the two models apart.
 */

process.env.CASPIO_ACCOUNT_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN || 'test.caspio.com';
process.env.CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID || 'test-client';
process.env.CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET || 'test-secret';

jest.mock('axios', () => {
    const mockAxios = jest.fn();
    mockAxios.post = jest.fn();
    mockAxios.interceptors = { request: { use: jest.fn() }, response: { use: jest.fn() } };
    return mockAxios;
});
jest.mock('../../src/utils/api-tracker', () => ({}));

const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');

const rows = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i }));
/** Every GET the helper made, as its params object. */
const sent = () => axios.mock.calls.map((c) => c[0].params).filter(Boolean);

beforeEach(() => {
    axios.mockReset();
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { access_token: 'tok', expires_in: 3600 } });
});

describe('one paging model, from page 1', () => {
    test('page 1 asks for q.pageSize + q.pageNumber=1 — never q.limit', () => {
        axios.mockResolvedValue({ data: { Result: rows(3) } });
        return fetchAllCaspioPages('/tables/T/records', { 'q.pageSize': 10 }).then(() => {
            const p = sent()[0];
            expect(p['q.pageSize']).toBe(10);
            expect(p['q.pageNumber']).toBe(1);
            // The whole bug in one assertion: mixing the two models is what lost rows.
            expect(p['q.limit']).toBeUndefined();
        });
    });

    test('q.limit is accepted as a page size and translated, not sent alongside', () => {
        axios.mockResolvedValue({ data: { Result: rows(3) } });
        return fetchAllCaspioPages('/tables/T/records', { 'q.limit': 500 }).then(() => {
            const p = sent()[0];
            expect(p['q.pageSize']).toBe(500);
            expect(p['q.pageNumber']).toBe(1);
            expect(p['q.limit']).toBeUndefined();
        });
    });

    test('continuation advances ONLY the page number, keeping the same page size', async () => {
        axios
            .mockResolvedValueOnce({ data: { Result: rows(10, 0) } })    // full page -> continue
            .mockResolvedValueOnce({ data: { Result: rows(10, 10) } })   // full page -> continue
            .mockResolvedValueOnce({ data: { Result: rows(4, 20) } });   // partial  -> stop
        const out = await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 10 });

        const p = sent();
        expect(p.map((x) => x['q.pageNumber'])).toEqual([1, 2, 3]);
        expect(p.every((x) => x['q.pageSize'] === 10)).toBe(true);
        expect(p.every((x) => x['q.limit'] === undefined)).toBe(true);
        expect(out).toHaveLength(24);
        // No row appears twice — the actual symptom of the old bug.
        expect(new Set(out.map((r) => r.id)).size).toBe(24);
    });

    test('a result set smaller than one page is one request', async () => {
        axios.mockResolvedValueOnce({ data: { Result: rows(7) } });
        const out = await fetchAllCaspioPages('/tables/T/records', { 'q.pageSize': 100 });
        expect(out).toHaveLength(7);
        expect(sent()).toHaveLength(1);
    });
});

describe('q.limit below Caspio\'s minimum page size is a single request', () => {
    // Caspio rejects q.pageSize < 5 outright, so these cannot be paged. 51 call sites pass
    // q.limit:1 as an existence check; each used to cost four requests.
    test('q.limit:1 that FINDS a row makes exactly ONE request', async () => {
        axios.mockResolvedValueOnce({ data: { Result: rows(1) } });
        const out = await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 1 });
        expect(out).toHaveLength(1);
        expect(sent()).toHaveLength(1);
        // It must keep q.limit — sending q.pageSize=1 is what Caspio rejects.
        expect(sent()[0]['q.limit']).toBe(1);
        expect(sent()[0]['q.pageSize']).toBeUndefined();
        expect(sent()[0]['q.pageNumber']).toBeUndefined();
    });

    test('q.limit:1 that finds NOTHING is also one request', async () => {
        axios.mockResolvedValueOnce({ data: { Result: [] } });
        const out = await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 1 });
        expect(out).toHaveLength(0);
        expect(sent()).toHaveLength(1);
    });

    test('the boundary holds: 4 stays single-request, 5 pages', async () => {
        axios.mockResolvedValueOnce({ data: { Result: rows(4) } });
        await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 4 });
        expect(sent()[0]['q.limit']).toBe(4);
        expect(sent()).toHaveLength(1);

        axios.mockReset();
        axios.post.mockResolvedValue({ data: { access_token: 'tok', expires_in: 3600 } });
        axios
            .mockResolvedValueOnce({ data: { Result: rows(5) } })
            .mockResolvedValueOnce({ data: { Result: rows(2, 5) } });
        await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 5 });
        expect(sent()[0]['q.pageSize']).toBe(5);
        expect(sent().map((x) => x['q.pageNumber'])).toEqual([1, 2]);
    });
});

describe('behaviour that must NOT change', () => {
    test('maxPages still caps, and strict still throws on truncation', async () => {
        axios.mockResolvedValue({ data: { Result: rows(10) } });   // always full -> never ends
        await expect(
            fetchAllCaspioPages('/tables/T/records', { 'q.limit': 10 }, { maxPages: 2, strict: true })
        ).rejects.toMatchObject({ code: 'CASPIO_PAGINATION_TRUNCATED' });
    });

    test('non-strict callers still get partial results at the cap', async () => {
        axios.mockResolvedValue({ data: { Result: rows(10) } });
        const out = await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 10 }, { maxPages: 2 });
        expect(out).toHaveLength(20);
    });

    test('earlyExitCondition still short-circuits', async () => {
        axios.mockResolvedValue({ data: { Result: rows(10) } });
        const out = await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 10 },
            { earlyExitCondition: (_page, all) => all.length >= 10 });
        expect(out).toHaveLength(10);
        expect(sent()).toHaveLength(1);
    });

    test('discardResults still streams via pageCallback and returns []', async () => {
        axios
            .mockResolvedValueOnce({ data: { Result: rows(10, 0) } })
            .mockResolvedValueOnce({ data: { Result: rows(3, 10) } });
        const seen = [];
        const out = await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 10 },
            { discardResults: true, pageCallback: (page) => seen.push(...page) });
        expect(out).toEqual([]);
        expect(seen).toHaveLength(13);
    });

    test('a server-driven NextPageUrl is still followed verbatim, params dropped', async () => {
        // The @nextpage branch was always correct — Caspio carries the cursor in the URL.
        axios
            .mockResolvedValueOnce({ data: { Result: rows(10), NextPageUrl: 'https://x/@nextpage/abc' } })
            .mockResolvedValueOnce({ data: { Result: rows(2, 10) } });
        const out = await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 10 });
        expect(out).toHaveLength(12);
        expect(axios.mock.calls[1][0].url).toBe('https://x/@nextpage/abc');
        expect(axios.mock.calls[1][0].params).toBeUndefined();
    });

    test('other query params ride through untouched', async () => {
        axios.mockResolvedValueOnce({ data: { Result: rows(2) } });
        await fetchAllCaspioPages('/tables/T/records',
            { 'q.select': 'A,B', 'q.where': "X='1'", 'q.orderBy': 'PK_ID DESC', 'q.limit': 50 });
        const p = sent()[0];
        expect(p['q.select']).toBe('A,B');
        expect(p['q.where']).toBe("X='1'");
        expect(p['q.orderBy']).toBe('PK_ID DESC');
    });
});
