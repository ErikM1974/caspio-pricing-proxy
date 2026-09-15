/**
 * GET /api/files/:externalKey must be cacheable (2026-09-15).
 *
 * A Caspio external key names one immutable file (a same-name re-upload gets a
 * new key), yet the main file GET sent no Cache-Control at all — only the
 * /sw.jpg variant did. The Policies Hub alone embeds ~290 slide images as
 * <img src="/api/files/:key">, so every page view re-fetched every slide
 * through Caspio's Files API, and until the same day each of those reads also
 * spent the office's shared write budget. Mounts the real router with axios
 * mocked — no network.
 */

jest.mock('axios', () => {
    const fn = jest.fn();
    fn.post = jest.fn();
    return fn;
});

const express = require('express');
const axios = require('axios');
const { Readable } = require('stream');
const filesRouter = require('../../src/routes/files-simple');

const KEY_OK = '8b0239d0-0cd1-4f8a-a024-22bdf17bc7e8';
const KEY_MISSING = '8b0239d0-0cd1-4f8a-a024-22bdf17bc7e9';
const IMMUTABLE = 'public, max-age=31536000, immutable';

let server;
let base;

beforeAll(async () => {
    const app = express();
    app.use('/api', filesRouter);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
    axios.mockReset();
    axios.post.mockReset();
    // The router fetches its own Caspio token via axios.post.
    axios.post.mockResolvedValue({ data: { access_token: 'test-token', expires_in: 3600 } });
});

test('a served file carries a one-year immutable Cache-Control and the real image type', async () => {
    axios.mockResolvedValue({
        headers: {
            'content-type': 'text/plain', // Caspio's usual wrong type — the route derives image/png from the name
            'content-disposition': 'inline; filename="slide-01.png"'
        },
        data: Readable.from([Buffer.from('png-bytes')])
    });

    const res = await fetch(`${base}/api/files/${KEY_OK}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('png-bytes');
});

test('the ?download=1 variant is cached the same way (same immutable bytes)', async () => {
    axios.mockResolvedValue({
        headers: { 'content-disposition': 'inline; filename="proof.pdf"' },
        data: Readable.from([Buffer.from('%PDF-')])
    });

    const res = await fetch(`${base}/api/files/${KEY_OK}?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="proof.pdf"');
    await res.arrayBuffer();
});

test('a Caspio 404 is NOT cached', async () => {
    axios.mockRejectedValue({ response: { status: 404 }, message: 'not found' });

    const res = await fetch(`${base}/api/files/${KEY_MISSING}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBeNull();
    expect(await res.json()).toEqual({ success: false, error: 'File not found', code: 'FILE_NOT_FOUND' });
});

test('a Caspio failure is NOT cached either', async () => {
    axios.mockRejectedValue(new Error('socket hang up'));

    const res = await fetch(`${base}/api/files/${KEY_MISSING}`);
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBeNull();
    await res.json();
});
