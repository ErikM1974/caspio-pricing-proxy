/**
 * Route tests for GET /api/box/folder-files?designNumber=…
 *
 * WHY THIS EXISTS
 * Steve's Box folders are named "{Design_Num_SW} {Company}" — the SHOPWORKS
 * design number. Caspio's ArtRequests.ID_Design is an unrelated autonumber
 * (across 2,710 rows the two series coincide 4 times, all hand-typed). The
 * Send Mockup picker used to pass ID_Design here, so the search never matched a
 * folder and Steve saw "No Box folder found for this design" on every job while
 * his artwork sat in Box the whole time.
 *
 * The route cannot tell which number it was handed, so what is pinned here is
 * the contract: a ShopWorks number resolves, and anything else comes back as an
 * HONEST 200 + found:false rather than an error or a wrong folder. The empty
 * result is load-bearing — the frontend renders it as the yellow empty state.
 *
 * Mounts the real router on an ephemeral express server with axios mocked, so
 * no Box calls leave the process.
 */

jest.mock('../../src/utils/caspio', () => ({
    getCaspioAccessToken: jest.fn().mockResolvedValue('test-caspio-token'),
    fetchAllCaspioPages: jest.fn().mockResolvedValue([])
}));
jest.mock('axios');

// Read at module load — must be set BEFORE the router is required.
process.env.BOX_ART_FOLDER_ID = '73634541055';   // AAA...Steve Art Box 2020
process.env.BOX_CLIENT_ID = 'test-client';
process.env.BOX_CLIENT_SECRET = 'test-secret';
process.env.BOX_ENTERPRISE_ID = 'test-enterprise';

const express = require('express');
const axios = require('axios');
const boxRouter = require('../../src/routes/box-upload');

// The single folder that exists in this fake Box, mirroring a real 2026-08-05
// record: ArtRequests ID_Design 53069 / Design_Num_SW 40733, Ironside Marine.
const FOLDER = { id: '405880783028', name: '40733 Ironside Marine', type: 'folder' };
const FILES = [
    { id: '2390624188322', name: '40733 Ironside Marine Mock1 WF copy.jpg', type: 'file', size: 2892674, extension: 'jpg' },
    { id: '2390615115964', name: '40733 Ironside Marine Mock1 WF.psd', type: 'file', size: 79044670, extension: 'psd' },
    { id: '2390607066881', name: 'Miss Alyssa.psd', type: 'file', size: 131795, extension: 'psd' }
];

let server;
let baseUrl;
let searchCalls;

beforeAll((done) => {
    const app = express();
    app.use('/api', boxRouter);
    server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        done();
    });
});

// Swallow the close callback's argument — passing it straight to done() makes
// jest treat a lingering keep-alive handle as a test failure.
afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
    searchCalls = [];
    axios.post.mockResolvedValue({ data: { access_token: 'fake-box-token', expires_in: 3600 } });
    axios.get.mockImplementation((url, opts) => {
        const params = (opts && opts.params) || {};
        if (url.endsWith('/search')) {
            searchCalls.push(params);
            // Box name search: the folder matches only its own leading number.
            const q = String(params.query || '');
            const hit = q && FOLDER.name.includes(q);
            return Promise.resolve({ data: { entries: hit ? [FOLDER] : [] } });
        }
        if (url.includes(`/folders/${FOLDER.id}/items`)) {
            return Promise.resolve({ data: { entries: FILES } });
        }
        return Promise.reject(new Error(`unexpected GET ${url}`));
    });
});

const get = (qs) => fetch(`${baseUrl}/api/box/folder-files?${qs}`).then(async (r) => ({
    status: r.status,
    body: await r.json()
}));

describe('folder-files resolves on the ShopWorks design number', () => {
    test('Design_Num_SW 40733 finds "40733 Ironside Marine" and lists its files', async () => {
        const { status, body } = await get('designNumber=40733');
        expect(status).toBe(200);
        expect(body.found).toBe(true);
        expect(body.folderName).toBe('40733 Ironside Marine');
        expect(body.files).toHaveLength(3);
        expect(body.files.map(f => f.name)).toContain('40733 Ironside Marine Mock1 WF copy.jpg');
    });

    test('the search is scoped to Steve\'s art tree, never the whole enterprise', async () => {
        await get('designNumber=40733');
        expect(searchCalls[0]).toMatchObject({
            query: '40733',
            type: 'folder',
            ancestor_folder_ids: '73634541055'
        });
    });

    test('a jpg gets a RELATIVE thumbnail url — absolute proxy urls 401 behind the gate', async () => {
        const { body } = await get('designNumber=40733');
        const jpg = body.files.find(f => f.extension === 'jpg');
        expect(jpg.thumbnailUrl).toBe('/api/box/thumbnail/2390624188322');
        expect(jpg.thumbnailUrl.startsWith('/')).toBe(true);
    });
});

describe('folder-files misses honestly', () => {
    test('a Caspio ID_Design (53069) returns 200 + found:false, NOT an error', async () => {
        const { status, body } = await get('designNumber=53069');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.found).toBe(false);
        expect(body.folderId).toBeNull();
        expect(body.files).toEqual([]);
    });

    test('a prefix that only appears mid-name does not count as a match', async () => {
        // "Ironside" is in the folder name but the folder does not START with it.
        const { body } = await get('designNumber=Ironside');
        expect(body.found).toBe(false);
    });

    test('neither designNumber nor folderId is a 400, not a silent empty', async () => {
        const { status, body } = await get('');
        expect(status).toBe(400);
        expect(body.error).toMatch(/designNumber or folderId/);
    });
});
