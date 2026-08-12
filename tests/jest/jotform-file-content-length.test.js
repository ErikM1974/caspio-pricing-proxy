/**
 * jotform-file-content-length.test.js — /api/jotform/file must never forward a
 * length it did not measure.
 *
 * WHY THIS EXISTS
 * 2026-08-12 the app's Box forwarder was found truncating responses: it copied
 * `content-length` from upstream and piped the body, but the HTTP client had
 * transparently INFLATED that body, so the header described the COMPRESSED
 * bytes. Browsers honour the framing and stop reading early — Steve's Box
 * picker died on "Unterminated string in JSON at position 476".
 *
 * `/api/jotform/file` (src/routes/jotform.js) is the same shape: axios with
 * `responseType: 'stream'`, copy content-length, `upstream.data.pipe(res)`.
 * It is arguably worse placed — the route is deliberately UNGATED (see the
 * comment at jotform.js:152-156) and serves Leads-drawer attachments.
 *
 * THE AXIOS-SPECIFIC TRAP, which is why the fix is unconditional:
 * node-fetch leaves `content-encoding` visible after inflating, so there the
 * bug *could* have been fixed by copying the length only when the body was not
 * encoded. **axios DELETES content-encoding while keeping the stale length**
 * (measured 1.8.4: `content-length: 47` on a 3008-byte stream, encoding
 * `undefined`). There is no header left to test, so the only correct rule is
 * "never forward a length you did not measure" — asserted below.
 *
 * TWO TRAPS THIS FILE AVOIDS
 * 1. The upstream MUST be a raw http.createServer writing `Content-Encoding:
 *    gzip` AND `Content-Length: <gzip size>` by hand. An express+compression()
 *    upstream does NOT reproduce the bug, because compression() removes
 *    Content-Length when it compresses — such a harness passes against the bug.
 * 2. Comment lines are stripped before the source assertion. The fix's own
 *    comment explains content-length at length; prose about a symbol is not a
 *    use of it.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const axios = require('axios');

const ROUTE_SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'routes', 'jotform.js'), 'utf8');

/** The /jotform/file handler with comments stripped. */
const HANDLER = (() => {
    const start = ROUTE_SRC.indexOf("router.get('/jotform/file'");
    expect(start).toBeGreaterThan(-1);
    const end = ROUTE_SRC.indexOf('\nrouter.', start + 1);
    const block = ROUTE_SRC.slice(start, end === -1 ? ROUTE_SRC.length : end);
    return block.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
})();

/**
 * Does the SHIPPED handler still copy the upstream length? The behavioural
 * suite below is driven by this rather than by a hardcoded `false`, so it
 * exercises what the route actually does. A harness that hardcodes the fixed
 * behaviour is testing a copy of the code, not the code — it would stay green
 * while the real route regressed.
 */
const HANDLER_COPIES_LENGTH = /Content-Length/i.test(HANDLER);

// ── Harness ──────────────────────────────────────────────────────────────────

/** Raw upstream: gzip + a gzip-sized Content-Length, as a CDN in front of a
 *  chunked origin emits. axios will inflate the body and keep the stale length. */
function startUpstream(getBody, contentType) {
    const server = http.createServer((req, res) => {
        const raw = Buffer.from(getBody());
        const gz = zlib.gzipSync(raw);
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Encoding': 'gzip',
            'Content-Length': String(gz.length),
        });
        res.end(gz);
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/** The proxy hop, mirroring the real route: axios stream → set headers → pipe. */
function startProxy(upstreamPort, { copyContentLength }) {
    const app = express();
    app.use(compression());                       // proxy server.js:27-34
    app.get('/f', async (req, res) => {
        const upstream = await axios.get(`http://127.0.0.1:${upstreamPort}/`, {
            responseType: 'stream', timeout: 10000,
        });
        res.set('Content-Type', upstream.headers['content-type'] || 'application/octet-stream');
        if (copyContentLength && upstream.headers['content-length']) {
            res.set('Content-Length', upstream.headers['content-length']);   // the bug
        }
        res.set('Content-Disposition', 'inline; filename="artwork.svg"');
        res.set('Cache-Control', 'private, max-age=3600');
        upstream.data.pipe(res);
    });
    return new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () => r(s));
    });
}

function dechunk(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
        const nl = buf.indexOf('\r\n', i);
        if (nl === -1) break;
        const size = parseInt(buf.slice(i, nl).toString('ascii'), 16);
        if (!Number.isFinite(size) || size === 0) break;
        out.push(buf.slice(nl + 2, nl + 2 + size));
        i = nl + 2 + size + 2;
    }
    return Buffer.concat(out);
}

/** Browser-accurate: obeys Content-Length framing; resolves (never rejects) on
 *  a protocol error, because a desynchronised connection is a failure mode
 *  under test rather than a broken test. */
function rawGet(port) {
    return new Promise((resolve) => {
        const chunks = [];
        const socket = net.connect(port, '127.0.0.1', () => {
            socket.write('GET /f HTTP/1.1\r\nHost: t\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n');
        });
        socket.on('data', (d) => chunks.push(d));
        socket.on('error', () => resolve({ protocolError: true, body: Buffer.alloc(0) }));
        socket.on('close', () => {
            const all = Buffer.concat(chunks);
            const sep = all.indexOf('\r\n\r\n');
            if (sep === -1) return resolve({ protocolError: true, body: Buffer.alloc(0) });
            const head = all.slice(0, sep).toString('ascii');
            let body = all.slice(sep + 4);
            if (/transfer-encoding:\s*chunked/i.test(head)) body = dechunk(body);
            if (/content-encoding:\s*gzip/i.test(head)) {
                try { body = zlib.gunzipSync(body); } catch { return resolve({ protocolError: true, body: Buffer.alloc(0) }); }
            }
            const cl = /^content-length:\s*(\d+)/im.exec(head);
            if (cl) body = body.slice(0, Number(cl[1]));      // what a client accepts
            resolve({ head, contentLength: cl ? Number(cl[1]) : null, body });
        });
    });
}

/** A compressible attachment — image/svg+xml is exactly what would gzip. */
function svgAttachment(n) {
    const paths = Array.from({ length: n }, (_, i) =>
        `  <path d="M${i} ${i}L${i + 10} ${i + 20}Z" fill="#1a5632" stroke="#fff" stroke-width="2"/>`
    ).join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500">\n${paths}\n</svg>`;
}

const SIZES = [5, 20, 60, 150, 400];

/**
 * Whether copying the length actually corrupts THIS payload.
 *
 * It is a band, not a threshold, and that is the whole reason the twin bug in
 * the app survived a week in production. Our compression() only leaves the
 * copied (wrong, short) Content-Length alone when it declines to compress —
 * i.e. when that length is below its 1024 threshold. Above it, compression()
 * re-compresses, REMOVES Content-Length, goes chunked, and the response is
 * accidentally correct. So big attachments self-heal and small-to-middling ones
 * truncate, which is exactly the pattern that reads as "flaky" to a user.
 */
function corruptsWhenLengthCopied(body) {
    return zlib.gzipSync(Buffer.from(body)).length < 1024;   // compression()'s default threshold
}

describe('the /jotform/file handler source', () => {
    test('was actually located (guard against a vacuous pass)', () => {
        expect(HANDLER).toContain("responseType: 'stream'");
        expect(HANDLER).toContain('upstream.data.pipe(res)');
    });

    test('never sets Content-Length from the upstream response', () => {
        expect(HANDLER).not.toMatch(/Content-Length/i);
    });

    test('still forwards the headers that make an attachment behave', () => {
        expect(HANDLER).toMatch(/Content-Type/);
        expect(HANDLER).toMatch(/Content-Disposition/);
    });
});

describe('behaviour: a gzipped upstream attachment arrives intact', () => {
    let upstream; let proxy; let n;

    beforeAll(async () => {
        upstream = await startUpstream(() => svgAttachment(n), 'image/svg+xml');
        // Driven by the real source, not a hardcoded false — see HANDLER_COPIES_LENGTH.
        proxy = await startProxy(upstream.address().port,
            { copyContentLength: HANDLER_COPIES_LENGTH });
    });
    afterAll(() => { proxy?.close(); upstream?.close(); });

    test('precondition: the upstream really inflates-and-lies (axios keeps the stale length)', async () => {
        n = 60;
        const r = await axios.get(`http://127.0.0.1:${upstream.address().port}/`,
            { responseType: 'arraybuffer' });
        const real = Buffer.byteLength(svgAttachment(60));
        expect(Number(r.headers['content-length'])).toBeLessThan(real);  // compressed size
        expect(r.headers['content-encoding']).toBeUndefined();           // axios deleted it
        expect(r.data.length).toBe(real);                                // body is inflated
    });

    test.each(SIZES)('%i-path SVG is delivered byte-identical', async (size) => {
        n = size;
        const expected = Buffer.from(svgAttachment(size));
        const res = await rawGet(proxy.address().port);
        expect(res.protocolError).toBeFalsy();
        expect(res.body.length).toBe(expected.length);
        expect(crypto.createHash('sha256').update(res.body).digest('hex'))
            .toBe(crypto.createHash('sha256').update(expected).digest('hex'));
    });
});

describe('negative control: copying the length really did corrupt attachments', () => {
    // Without this the harness could silently stop reproducing the bug and this
    // whole file would go green while proving nothing.
    let upstream; let proxy; let n;

    beforeAll(async () => {
        upstream = await startUpstream(() => svgAttachment(n), 'image/svg+xml');
        proxy = await startProxy(upstream.address().port, { copyContentLength: true });
    });
    afterAll(() => { proxy?.close(); upstream?.close(); });

    test('the sizes under test straddle the band (guard against a vacuous control)', () => {
        const inBand = SIZES.filter((s) => corruptsWhenLengthCopied(svgAttachment(s)));
        const outOfBand = SIZES.filter((s) => !corruptsWhenLengthCopied(svgAttachment(s)));
        // If every size fell on one side, this control would prove nothing about
        // the band — and the band is the reason the bug hid for a week.
        expect(inBand.length).toBeGreaterThan(0);
        expect(outOfBand.length).toBeGreaterThan(0);
    });

    test.each(SIZES)('%i-path SVG corrupts exactly when the band predicts it', async (size) => {
        n = size;
        const body = svgAttachment(size);
        const expected = Buffer.from(body);
        const res = await rawGet(proxy.address().port);
        const broke = res.protocolError || res.body.length !== expected.length;
        // Large attachments escape only because compression() strips the bad
        // header for us — accidental, not by design, which is why the fix is at
        // the source rather than a reliance on this.
        expect(`${size}: ${broke}`).toBe(`${size}: ${corruptsWhenLengthCopied(body)}`);
    });
});
