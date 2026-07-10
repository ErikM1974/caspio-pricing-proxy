/**
 * Route tests for /api/image-uploads (src/routes/image-uploads.js).
 * Mounts the real router on an ephemeral express server with Caspio mocked —
 * no network. Test-side HTTP uses Node's global fetch/FormData/Blob because
 * axios itself is mocked (the route calls it directly for v3 writes).
 */

jest.mock('../../src/utils/caspio', () => ({
    getCaspioAccessToken: jest.fn().mockResolvedValue('test-token'),
    fetchAllCaspioPages: jest.fn()
}));
jest.mock('axios');

const express = require('express');
const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const imageUploadsRouter = require('../../src/routes/image-uploads');
const { normalizeVendor, vendorValues, sanitizeImageFilename, buildImageUrl } = imageUploadsRouter;

const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

// v2-shaped rows as fetchAllCaspioPages returns them (Vendor = list object)
const ROWS = [
    { PK_ID: 2, Image_ID: 'AAAA1111', Description: 'Purchasing tab', Style: '', Vendor: { '4': 'Sanmar' }, AI_Text: 'ShopWorks purchasing tab screenshot', URL: 'https://proxy/api/files/key-a', Image_Database: '/Artwork/a.png', Date: '2026-07-10T10:00:00' },
    { PK_ID: 1, Image_ID: 'BBBB2222', Description: 'Cap render', Style: 'C112', Vendor: { '3': 'Richardson' }, AI_Text: 'navy cap', URL: 'https://proxy/api/files/key-b', Image_Database: '/Artwork/b.png', Date: '2026-07-09T10:00:00' }
];

let server;
let baseUrl;

beforeAll((done) => {
    const app = express();
    app.use('/api', imageUploadsRouter);
    server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        done();
    });
});

afterAll(() => new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
}));

beforeEach(() => {
    fetchAllCaspioPages.mockReset();
    axios.post.mockReset();
    axios.delete.mockReset();
});

function postImage(fields = {}) {
    const fd = new FormData();
    fd.append('file', new Blob([TINY_PNG], { type: 'image/png' }), 'test image.png');
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fetch(`${baseUrl}/api/image-uploads`, { method: 'POST', body: fd });
}

describe('helpers', () => {
    test('normalizeVendor canonicalizes case, passes unknowns through, null on empty', () => {
        expect(normalizeVendor('sanmar')).toBe('Sanmar');
        expect(normalizeVendor('JDS')).toBe('JDS');
        expect(normalizeVendor('nwca')).toBe('NWCA');
        expect(normalizeVendor('FutureVendor')).toBe('FutureVendor'); // Caspio stays authoritative
        expect(normalizeVendor('')).toBeNull();
        expect(normalizeVendor(undefined)).toBeNull();
    });

    test('vendorValues tolerates v2 object, array, null', () => {
        expect(vendorValues({ '4': 'Sanmar' })).toEqual(['Sanmar']);
        expect(vendorValues(['JDS'])).toEqual(['JDS']);
        expect(vendorValues(null)).toEqual([]);
    });

    test('sanitizeImageFilename strips path separators and odd chars', () => {
        expect(sanitizeImageFilename('../../etc/passwd.png')).not.toContain('/');
        expect(sanitizeImageFilename('my logo (final).png')).toBe('my logo _final_.png');
        expect(sanitizeImageFilename('')).toBe('image.png');
    });

    test('buildImageUrl points at the proxy file streamer', () => {
        expect(buildImageUrl('abc-123')).toMatch(/\/api\/files\/abc-123$/);
    });
});

describe('POST /api/image-uploads', () => {
    test('uploads file then inserts record; 201 with API-shaped image', async () => {
        axios.post.mockImplementation((url) => {
            if (url.includes('/files')) {
                return Promise.resolve({ data: { Result: [{ Name: 'test image.png', ExternalKey: 'file-key-1' }] } });
            }
            if (url.includes(`/tables/Image_Uploads_Data_Base/records`)) {
                return Promise.resolve({
                    data: { Result: [{ PK_ID: 9, Image_ID: 'NEW12345', Description: 'desc', Style: 'PC54', Vendor: ['Sanmar'], AI_Text: 'ai', URL: 'u', Image_Database: '/Artwork/test image.png', Date: '2026-07-10T11:00:00' }] }
                });
            }
            return Promise.reject(new Error('unexpected POST ' + url));
        });

        const res = await postImage({ description: 'desc', style: 'PC54', vendor: 'sanmar', aiText: 'ai' });
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body.success).toBe(true);
        expect(body.image.imageId).toBe('NEW12345');
        expect(body.image.vendor).toEqual(['Sanmar']);
        expect(body.image.fileExternalKey).toBe('file-key-1');

        // record insert carried the file path + canonicalized vendor
        const recordCall = axios.post.mock.calls.find(([url]) => url.includes('/tables/'));
        expect(recordCall[0]).toContain('response=rows');
        expect(recordCall[1].Image_Database).toBe('/Artwork/test image.png');
        expect(recordCall[1].Vendor).toEqual(['Sanmar']);
        expect(recordCall[1].URL).toContain('/api/files/file-key-1');
    });

    test('record insert failure rolls back the uploaded file — no orphan, visible error', async () => {
        axios.post.mockImplementation((url) => {
            if (url.includes('/files')) {
                return Promise.resolve({ data: { Result: [{ Name: 'x.png', ExternalKey: 'orphan-key' }] } });
            }
            const err = new Error('Request failed with status code 400');
            err.response = { status: 400, data: { Message: 'Bad list value' } };
            return Promise.reject(err);
        });
        axios.delete.mockResolvedValue({ status: 204 });

        const res = await postImage({ vendor: 'Sanmar' });
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.error).toContain('Bad list value');
        expect(axios.delete).toHaveBeenCalledWith(
            expect.stringContaining('/files/orphan-key'),
            expect.anything());
    });

    test('no file → 400 NO_FILE, nothing hits Caspio', async () => {
        const res = await fetch(`${baseUrl}/api/image-uploads`, { method: 'POST', body: new FormData() });
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.code).toBe('NO_FILE');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('oversize description → 400 FIELD_TOO_LONG before any upload', async () => {
        const res = await postImage({ description: 'x'.repeat(300) });
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.code).toBe('FIELD_TOO_LONG');
        expect(axios.post).not.toHaveBeenCalled();
    });
});

describe('GET /api/image-uploads', () => {
    test('lists newest-first rows in API shape (v2 vendor object → array)', async () => {
        fetchAllCaspioPages.mockResolvedValue(ROWS);

        const res = await fetch(`${baseUrl}/api/image-uploads`);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.total).toBe(2);
        expect(body.images[0].imageId).toBe('AAAA1111');
        expect(body.images[0].vendor).toEqual(['Sanmar']);
        const [path, params] = fetchAllCaspioPages.mock.calls[0];
        expect(path).toContain('Image_Uploads_Data_Base');
        expect(params['q.orderBy']).toContain('Date DESC');
    });

    test('vendor + q filters apply in JS', async () => {
        fetchAllCaspioPages.mockResolvedValue(ROWS);

        const byVendor = await (await fetch(`${baseUrl}/api/image-uploads?vendor=sanmar`)).json();
        expect(byVendor.images.map(i => i.imageId)).toEqual(['AAAA1111']);

        fetchAllCaspioPages.mockResolvedValue(ROWS);
        const byText = await (await fetch(`${baseUrl}/api/image-uploads?q=navy`)).json();
        expect(byText.images.map(i => i.imageId)).toEqual(['BBBB2222']);
    });

    test('Caspio failure → visible 500, no silent fallback', async () => {
        fetchAllCaspioPages.mockRejectedValue(new Error('Caspio down'));
        const res = await fetch(`${baseUrl}/api/image-uploads`);
        expect(res.status).toBe(500);
        expect((await res.json()).success).toBe(false);
    });
});

describe('GET /api/image-uploads/:imageId', () => {
    test('returns the record when found', async () => {
        fetchAllCaspioPages.mockResolvedValue([ROWS[0]]);
        const res = await fetch(`${baseUrl}/api/image-uploads/AAAA1111`);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.image.imageId).toBe('AAAA1111');
        expect(fetchAllCaspioPages.mock.calls[0][1]['q.where']).toBe("Image_ID='AAAA1111'");
    });

    test('404 when missing', async () => {
        fetchAllCaspioPages.mockResolvedValue([]);
        const res = await fetch(`${baseUrl}/api/image-uploads/ZZZZ9999`);
        expect(res.status).toBe(404);
    });

    test('injection-shaped id → 400 without touching Caspio', async () => {
        const res = await fetch(`${baseUrl}/api/image-uploads/${encodeURIComponent("X' OR 1=1--")}`);
        expect(res.status).toBe(400);
        expect(fetchAllCaspioPages).not.toHaveBeenCalled();
    });
});
