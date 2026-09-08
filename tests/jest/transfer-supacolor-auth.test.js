'use strict';
jest.mock('../../src/utils/caspio', () => ({
    getCaspioAccessToken: jest.fn().mockResolvedValue('mock-token'),
    fetchAllCaspioPages: jest.fn().mockResolvedValue([]),
    makeCaspioRequest: jest.fn().mockResolvedValue({ RecordsAffected: 1 })
}));
jest.mock('axios', () => Object.assign(jest.fn(), {
    get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(), create: jest.fn()
}));
jest.mock('../../src/utils/box-client', () => ({
    boxGetFileInfo: jest.fn(), boxFetchFileBytes: jest.fn(),
    boxResolveSharedLink: jest.fn(), parseBoxFileUrl: jest.fn()
}));
jest.mock('../../src/utils/supacolor-api', () => ({ getActiveJobs: jest.fn(), getJob: jest.fn() }));
jest.mock('../../src/utils/slack-supacolor-health-notify', () => ({ notifySupacolorHealth: jest.fn() }));
jest.mock('../../src/utils/slack-screenprint-new-order-notify', () => ({ notifyScreenprintNewOrder: jest.fn() }));
jest.mock('../../src/utils/slack-transfer-new-order-notify', () => ({ notifyTransferNewOrder: jest.fn() }));

const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const express = require('express');
const axios = require('axios');
const caspio = require('../../src/utils/caspio');
const box = require('../../src/utils/box-client');
const supacolor = require('../../src/utils/supacolor-api');
const notify = require('../../src/utils/slack-supacolor-health-notify');
const { requireCrmApiSecret } = require('../../src/middleware');
const transferOrdersRoutes = require('../../src/routes/transfer-orders');
const supacolorJobsRoutes = require('../../src/routes/supacolor-jobs');
const visionRoutes = require('../../src/routes/vision');
const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
const originalSecret = process.env.CRM_API_SECRET;
let server, base, warn, error;
const auth = { 'X-CRM-API-Secret': 'transfer-auth-test-secret', 'Content-Type': 'application/json' };

beforeAll(done => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.use(express.json());
    // Execute production mount declarations in their actual order. Testing a
    // router mounted independently cannot prove the server's authentication.
    const mounts = source.split('\n').filter(line => /^app\.use\(/.test(line) && (
        line.includes("['/api/transfer-orders'") ||
        line.includes("['/api/vision/extract-shopworks'") ||
        /, (transferOrdersRoutes|supacolorJobsRoutes)\);/.test(line) ||
        line.includes('visionLimiter, visionRoutes')));
    expect(mounts).toHaveLength(5);
    vm.runInNewContext(mounts.join('\n'), {
        app, requireCrmApiSecret, transferOrdersRoutes, supacolorJobsRoutes,
        visionRoutes, visionLimiter: (req, res, next) => next()
    });
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
beforeEach(() => { jest.clearAllMocks(); process.env.CRM_API_SECRET = auth['X-CRM-API-Secret']; });
afterAll(() => new Promise(resolve => {
    if (originalSecret === undefined) delete process.env.CRM_API_SECRET;
    else process.env.CRM_API_SECRET = originalSecret;
    warn.mockRestore(); error.mockRestore();
    server.closeAllConnections(); server.close(resolve);
}));

function noUpstreamCalls() {
    for (const group of [caspio, box, supacolor, notify, axios]) {
        if (jest.isMockFunction(group)) expect(group).not.toHaveBeenCalled();
        for (const value of Object.values(group)) if (jest.isMockFunction(value)) expect(value).not.toHaveBeenCalled();
    }
}

test.each([
    ['GET', '/api/transfer-orders'], ['HEAD', '/api/transfer-orders/stats'],
    ['POST', '/api/transfer-orders'], ['POST', '/api/transfer-orders/analyze-link'],
    ['PUT', '/api/transfer-orders/ST-TEST/status'], ['DELETE', '/api/transfer-orders/ST-TEST'],
    ['POST', '/api/transfer-order-notes'], ['GET', '/api/transfer-orders/ST-TEST/notes'],
    ['GET', '/api/supacolor-jobs'], ['HEAD', '/api/supacolor-jobs/101'],
    ['POST', '/api/supacolor-jobs/upsert'], ['DELETE', '/api/supacolor-jobs/101'],
    ['POST', '/api/supacolor-jobs/101/history/replace'],
    ['GET', '/api/supacolor-jobs/proxy-image?url=https%3A%2F%2Fcdn.supacolor.com%2Ftest.png'],
    ['POST', '/api/supacolor-jobs/sync/all?includeClosed=true'],
    ['POST', '/api/supacolor-jobs/health/alert'],
    ['POST', '/api/vision/extract-supacolor'],
    ['POST', '/api/vision/extract-supacolor-jobs-list'],
    ['POST', '/api/vision/extract-supacolor-job-detail'],
])('%s %s refuses anonymous, spoofed-origin and incorrect-secret requests before services', async (method, url) => {
    for (const headers of [{}, { Origin: 'https://teamnwca.com' }, { 'X-CRM-API-Secret': 'incorrect-secret' }]) {
        const response = await fetch(base + url, { method, headers });
        expect(response.status).toBe(401);
        noUpstreamCalls();
    }
});

test('authenticated resource reads still reach the real routers', async () => {
    for (const url of ['/api/transfer-orders?supacolorOrderNumber=TEST', '/api/supacolor-jobs?refresh=true']) {
        const response = await fetch(base + url, { headers: auth });
        expect(response.status).toBe(200);
        expect((await response.json()).success).toBe(true);
    }
    expect(caspio.fetchAllCaspioPages).toHaveBeenCalled();
});

test('authenticated notes, image and vision requests retain handler validation', async () => {
    for (const [method, url] of [['POST', '/api/transfer-order-notes'], ['GET', '/api/supacolor-jobs/proxy-image'],
        ['POST', '/api/vision/extract-supacolor'], ['POST', '/api/vision/extract-supacolor-jobs-list'], ['POST', '/api/vision/extract-supacolor-job-detail']]) {
        const response = await fetch(base + url, { method, headers: auth, ...(method === 'POST' ? { body: '{}' } : {}) });
        expect(response.status).toBe(400);
    }
    noUpstreamCalls();
});

test('missing server configuration fails closed', async () => {
    delete process.env.CRM_API_SECRET;
    expect((await fetch(base + '/api/transfer-orders', { headers: auth })).status).toBe(500);
    noUpstreamCalls();
});

describe.each([
    ['scripts/sync-supacolor.js', '/api/supacolor-jobs/sync/all?includeClosed=true'],
    ['scripts/check-supacolor-health.js', '/api/supacolor-jobs/health/alert']
])('%s scheduled authentication', (file, endpoint) => {
    function job(secret) {
        const client = { post: jest.fn().mockResolvedValue({ data: { ok: true, fetched: 1 } }) };
        const context = { module: { exports: {} }, process: { env: { BASE_URL: 'https://proxy.example.test', CRM_API_SECRET: secret }, exit: jest.fn() },
            console: { log: jest.fn(), error: jest.fn() }, require: name => { if (name !== 'axios') throw Error('Unexpected dependency'); return client; } };
        const script = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8').replace(/\nmain\(\);\s*$/, '\nmodule.exports = main;');
        vm.runInNewContext(script, context);
        return { client, context, run: context.module.exports };
    }
    test('the actual job preserves its request, timeout and cadence while authenticating', async () => {
        const instance = job('cron-test-secret'); await instance.run();
        expect(instance.client.post).toHaveBeenCalledWith('https://proxy.example.test' + endpoint, {}, {
            headers: { 'Content-Type': 'application/json', 'X-CRM-API-Secret': 'cron-test-secret' }, timeout: 30000
        });
        expect(instance.context.process.exit).not.toHaveBeenCalled();
    });
    test.each([undefined, ''])('missing credential %p makes no outgoing request', async secret => {
        const instance = job(secret); await instance.run();
        expect(instance.client.post).not.toHaveBeenCalled();
        expect(instance.context.process.exit).toHaveBeenCalledWith(1);
        expect(instance.context.console.error).toHaveBeenCalledWith(expect.stringContaining('CRM_API_SECRET is required'));
    });
});
