/**
 * upload-filename-traversal.test.js
 *
 * Locks two auth/filesystem fixes from 2026-08-05. Both were reachable WITHOUT
 * credentials, so they are guarded by tests rather than by review:
 *
 *  1. lib/file-upload-service.js interpolated a caller-supplied `fileName`
 *     straight into a temp path. `path.join` normalises, and the `upload_<ts>_`
 *     prefix is just one more segment for `..` to pop, so
 *     `../../../app/server.js` resolved to `/app/server.js`. Reached via
 *     POST /api/manageorders/orders/create, which is not gated (see 2), and the
 *     write happens before the Caspio token call — an unauthenticated arbitrary
 *     file write, with the error path unlink()ing the same traversed path.
 *
 *  2. guardReadsOnly tested `req.method === 'GET'`. Express routes HEAD to GET
 *     handlers but leaves req.method === 'HEAD', so HEAD sailed past the gate.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { createFormDataFromBase64 } = require('../../lib/file-upload-service');
const { guardReadsOnly } = require('../../src/middleware');

// A tiny, genuinely-decodable payload so the function reaches its write.
const PNG_DATA_URL = 'data:image/png;base64,QUJD'; // "ABC"

function cleanup(p) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best effort */ }
}

describe('upload temp path cannot escape the temp directory', () => {
    const tempDir = path.resolve(os.tmpdir());

    // Each of these used to land outside tempDir.
    const HOSTILE = [
        '../../../app/server.js',
        '../../../app/.env',
        '../../../../../../etc/cron.d/x',
        '..',
        '../',
        'a/../../b.js',
        'sub/dir/nested.png',
        '/etc/absolute.png',
        'C:\\Windows\\win.ini',
        '..\\..\\windows\\system32\\x.dll',
    ];

    test.each(HOSTILE)('stays inside tmpdir for %p', (fileName) => {
        let written = null;
        try {
            const { tempFilePath } = createFormDataFromBase64(PNG_DATA_URL, fileName);
            written = tempFilePath;
            const resolved = path.resolve(tempFilePath);
            // The whole point: the write target is under tempDir, nowhere else.
            expect(resolved.startsWith(tempDir + path.sep)).toBe(true);
            // And it is a single flat file, not a nested path we just created.
            expect(path.dirname(resolved)).toBe(tempDir);
            expect(fs.existsSync(resolved)).toBe(true);
        } finally {
            cleanup(written);
        }
    });

    test('the specific historical exploit no longer reaches /app', () => {
        let written = null;
        try {
            const { tempFilePath } = createFormDataFromBase64(
                PNG_DATA_URL, '../../../app/server.js');
            written = tempFilePath;
            expect(path.resolve(tempFilePath)).not.toMatch(/[\\/]app[\\/]server\.js$/);
            expect(path.basename(tempFilePath)).toMatch(/^upload_\d+_/);
        } finally {
            cleanup(written);
        }
    });

    test('a normal filename still round-trips readably', () => {
        let written = null;
        try {
            const { tempFilePath } = createFormDataFromBase64(PNG_DATA_URL, 'logo-2026_v2.png');
            written = tempFilePath;
            expect(path.basename(tempFilePath)).toMatch(/^upload_\d+_logo-2026_v2\.png$/);
            expect(fs.readFileSync(tempFilePath, 'utf8')).toBe('ABC');
        } finally {
            cleanup(written);
        }
    });

    test('empty / null / non-string names degrade to a safe default, never throw', () => {
        for (const name of ['', null, undefined, 12345, {}]) {
            let written = null;
            try {
                const { tempFilePath } = createFormDataFromBase64(PNG_DATA_URL, name);
                written = tempFilePath;
                expect(path.dirname(path.resolve(tempFilePath))).toBe(tempDir);
            } finally {
                cleanup(written);
            }
        }
    });
});

describe('guardReadsOnly gates HEAD as well as GET', () => {
    const run = (method) => {
        let enforced = false;
        let passedThrough = false;
        const mw = (req, res, next) => { enforced = true; };
        guardReadsOnly(mw)({ method }, {}, () => { passedThrough = true; });
        return { enforced, passedThrough };
    };

    test('GET is enforced', () => {
        expect(run('GET')).toEqual({ enforced: true, passedThrough: false });
    });

    // The bug: HEAD reached the handler without credentials.
    test('HEAD is enforced — Express routes it to the GET handler', () => {
        expect(run('HEAD')).toEqual({ enforced: true, passedThrough: false });
    });

    test.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
        '%s still passes through (writes keep their own gates)', (method) => {
            expect(run(method)).toEqual({ enforced: false, passedThrough: true });
        });
});
