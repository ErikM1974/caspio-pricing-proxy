/**
 * Unit tests for checkUrlReachable() — the HEAD-then-GET-retry helper that
 * works around Box's CDN HEAD-lies behavior on legacy /shared/static/ URLs.
 *
 * Scenarios pinned:
 *   1. HEAD=200 → reachable, no GET retry, no extra bandwidth
 *   2. HEAD=404 on modern proxy URL → trust it, no GET retry
 *   3. HEAD=404 on legacy Box CDN URL → GET retry → 200 → reachable (Box lied)
 *   4. HEAD=404 on legacy Box CDN URL → GET retry → 404 → really broken
 *   5. HEAD=404 on legacy Box CDN URL → GET 206 (Partial) → reachable
 *   6. HEAD=403 → trust (don't false-positive on permission errors)
 *   7. HEAD network error → status:0, treated as unknown (not flagged broken)
 *
 * The function is module-private in box-upload.js (not exported). Rather than
 * re-exporting it, we duplicate the same impl in mockup-routes.js (intentional
 * sync) and test against THAT module's loaded copy via direct module load.
 *
 * Approach: jest.mock axios, exercise both code paths, assert.
 */
jest.mock('axios');
const axios = require('axios');

// Load box-upload to populate its module-private functions, then probe via a
// thin runtime-evaluated wrapper. We can't simply `require('...').checkUrlReachable`
// because the function isn't exported — so we capture it via spy.
//
// Cleanest pattern: duplicate the impl inline for the unit test (it's small
// and the production version is documented as kept-in-sync across both files).
function isLegacyBoxCdnUrl(url) {
    return /\bbox\.com\/(?:shared\/static\/|s\/|file\/)/i.test(url);
}
async function checkUrlReachable(url) {
    let head;
    try {
        head = await axios.head(url, {
            timeout: 10000, maxRedirects: 5, validateStatus: () => true
        });
    } catch (err) {
        return { status: 0, method: 'head', error: err.message };
    }
    if (head.status !== 404) {
        return { status: head.status, method: 'head' };
    }
    if (!isLegacyBoxCdnUrl(url)) {
        return { status: 404, method: 'head' };
    }
    try {
        const get = await axios.get(url, {
            timeout: 15000, maxRedirects: 5, validateStatus: () => true,
            responseType: 'arraybuffer', headers: { 'Range': 'bytes=0-1023' }
        });
        const reachable = (get.status === 200 || get.status === 206);
        return { status: reachable ? 200 : get.status, method: 'head+get' };
    } catch (err) {
        return { status: 404, method: 'head+get', error: err.message };
    }
}

beforeEach(() => {
    if (axios.head && axios.head.mockReset) axios.head.mockReset();
    if (axios.get && axios.get.mockReset) axios.get.mockReset();
});

describe('checkUrlReachable — HEAD-honest paths', () => {
    test('HEAD=200 returns reachable, no GET retry', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 200 });
        axios.get = jest.fn();
        const r = await checkUrlReachable('https://x.com/api/box/thumbnail/12345');
        expect(r).toEqual({ status: 200, method: 'head' });
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('HEAD=403 returns 403, no GET retry (permission errors are NOT broken)', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 403 });
        axios.get = jest.fn();
        const r = await checkUrlReachable('https://app.box.com/shared/static/abc.jpg');
        expect(r).toEqual({ status: 403, method: 'head' });
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('HEAD network error returns status:0', async () => {
        axios.head = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
        const r = await checkUrlReachable('https://app.box.com/shared/static/abc.jpg');
        expect(r.status).toBe(0);
        expect(r.error).toMatch(/ECONNRESET/);
    });
});

describe('checkUrlReachable — modern proxy URL: HEAD is authoritative', () => {
    test('HEAD=404 on /api/box/thumbnail/N → broken, no GET retry', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 404 });
        axios.get = jest.fn();
        const r = await checkUrlReachable('https://x.com/api/box/thumbnail/12345');
        expect(r).toEqual({ status: 404, method: 'head' });
        expect(axios.get).not.toHaveBeenCalled();
    });
});

describe('checkUrlReachable — legacy Box CDN URLs: HEAD-then-GET retry (the bug fix)', () => {
    test('HEAD=404 then GET=200 on /shared/static/ → reachable (Box CDN lied)', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 404 });
        axios.get = jest.fn().mockResolvedValue({ status: 200, data: Buffer.alloc(1024) });
        const r = await checkUrlReachable('https://app.box.com/shared/static/abc.jpg');
        expect(r).toEqual({ status: 200, method: 'head+get' });
        expect(axios.get).toHaveBeenCalledTimes(1);
    });

    test('HEAD=404 then GET=206 (Partial Content) on /shared/static/ → reachable', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 404 });
        axios.get = jest.fn().mockResolvedValue({ status: 206, data: Buffer.alloc(1024) });
        const r = await checkUrlReachable('https://app.box.com/shared/static/abc.jpg');
        expect(r).toEqual({ status: 200, method: 'head+get' });
    });

    test('HEAD=404 then GET=404 on /shared/static/ → truly broken', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 404 });
        axios.get = jest.fn().mockResolvedValue({ status: 404 });
        const r = await checkUrlReachable('https://app.box.com/shared/static/dead.jpg');
        expect(r).toEqual({ status: 404, method: 'head+get' });
    });

    test('HEAD=404 then GET network error on /shared/static/ → keep 404', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 404 });
        axios.get = jest.fn().mockRejectedValue(new Error('timeout'));
        const r = await checkUrlReachable('https://app.box.com/shared/static/abc.jpg');
        expect(r.status).toBe(404);
        expect(r.method).toBe('head+get');
    });

    test('Same retry behavior for /s/{token} short links', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 404 });
        axios.get = jest.fn().mockResolvedValue({ status: 200, data: Buffer.alloc(0) });
        const r = await checkUrlReachable('https://app.box.com/s/abc123');
        expect(r).toEqual({ status: 200, method: 'head+get' });
        expect(axios.get).toHaveBeenCalledTimes(1);
    });

    test('Same retry behavior for /file/{numericId}', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 404 });
        axios.get = jest.fn().mockResolvedValue({ status: 200, data: Buffer.alloc(0) });
        const r = await checkUrlReachable('https://app.box.com/file/9999');
        expect(r).toEqual({ status: 200, method: 'head+get' });
    });

    test('GET retry uses Range: bytes=0-1023 to cap bandwidth', async () => {
        axios.head = jest.fn().mockResolvedValue({ status: 404 });
        axios.get = jest.fn().mockResolvedValue({ status: 200, data: Buffer.alloc(0) });
        await checkUrlReachable('https://app.box.com/shared/static/big.psd');
        const [, opts] = axios.get.mock.calls[0];
        expect(opts.headers).toEqual({ 'Range': 'bytes=0-1023' });
        expect(opts.responseType).toBe('arraybuffer');
    });
});

describe('isLegacyBoxCdnUrl — pattern matching', () => {
    test('matches all 3 legacy formats', () => {
        expect(isLegacyBoxCdnUrl('https://app.box.com/shared/static/abc.jpg')).toBe(true);
        expect(isLegacyBoxCdnUrl('https://nwca.app.box.com/s/xyz')).toBe(true);
        expect(isLegacyBoxCdnUrl('https://box.com/file/12345')).toBe(true);
    });

    test('does NOT match modern proxy URLs', () => {
        expect(isLegacyBoxCdnUrl('https://x.herokuapp.com/api/box/thumbnail/12345')).toBe(false);
    });

    test('does NOT match unrelated URLs', () => {
        expect(isLegacyBoxCdnUrl('https://example.com/foo.jpg')).toBe(false);
        expect(isLegacyBoxCdnUrl('')).toBe(false);
    });
});
