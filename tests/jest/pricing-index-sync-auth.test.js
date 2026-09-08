'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { pricingIndexHeaders } = require('../../src/utils/pricing-index-auth');
const priorSecret = process.env.CRM_API_SECRET;
beforeEach(() => { process.env.CRM_API_SECRET = 'unit-test-sync-secret'; });
afterEach(() => {
    if (priorSecret === undefined) delete process.env.CRM_API_SECRET;
    else process.env.CRM_API_SECRET = priorSecret;
});

function loadFunction(file, name, dependencies) {
    const text = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    // These top-level functions close at column zero; nested scopes are indented.
    const match = text.match(new RegExp('async function ' + name + '\\([^]*?^}', 'm'));
    if (!match) throw new Error('Missing production function: ' + name);
    return vm.runInNewContext('(' + match[0] + ')', {
        URL, Buffer, pricingIndexHeaders,
        PRICING_INDEX_BASE: 'https://pricing.example.test', ALERT_PATH: '/api/quote-sync-health/alert', TIMEOUT_MS: 30000,
        console: {log: jest.fn(), error: jest.fn(), warn: jest.fn()},
        process: {env: {PRICING_INDEX_BASE_URL: 'https://pricing.example.test'}, exit: jest.fn()},
        ...dependencies,
    });
}

function mockHttps() {
    const requests = [];
    const https = {request: jest.fn((options, callback) => {
        const request = new EventEmitter();
        let body = '';
        request.write = chunk => {body += chunk;};
        request.destroy = error => request.emit('error', error);
        request.end = () => {
            requests.push({options, body: JSON.parse(body)});
            const response = new EventEmitter();
            response.statusCode = 200;
            callback(response);
            response.emit('data', JSON.stringify({success: true, synced: 0}));
            response.emit('end');
        };
        return request;
    })};
    return {https, requests};
}

test('headers preserve content metadata and always use the configured credential', () => {
    expect(pricingIndexHeaders({'Content-Type': 'application/json', 'X-CRM-API-Secret': 'caller-value'}))
        .toEqual({'Content-Type': 'application/json', 'X-CRM-API-Secret': 'unit-test-sync-secret'});
});

test.each([undefined, ''])('missing credential %p fails before a request is made', value => {
    if (value === undefined) delete process.env.CRM_API_SECRET;
    else process.env.CRM_API_SECRET = value;
    expect(() => pricingIndexHeaders()).toThrow('CRM_API_SECRET is required');
});

describe.each([
    ['scripts/sync-quote-sessions-from-shopworks.js', '/api/quote-sessions/bulk-sync-from-shopworks'],
    ['scripts/sync-shipstation-tracking.js', '/api/quote-sessions/bulk-sync-shipstation-tracking'],
])('%s', (file, endpoint) => {
    test('the actual job request sends the secret and unchanged body', async () => {
        const h = mockHttps();
        const call = loadFunction(file, 'callBulkSync', {https: h.https});
        await expect(call({dryRun: true, daysBack: 7})).resolves.toMatchObject({success: true});
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0].options).toMatchObject({hostname: 'pricing.example.test', path: endpoint,
            headers: {'X-CRM-API-Secret': 'unit-test-sync-secret', 'Content-Type': 'application/json'}});
        expect(h.requests[0].body).toEqual({dryRun: true, daysBack: 7});
    });
    test('no credential means no outgoing job request', async () => {
        delete process.env.CRM_API_SECRET;
        const h = mockHttps();
        await expect(loadFunction(file, 'callBulkSync', {https: h.https})({dryRun: true})).rejects.toThrow('CRM_API_SECRET');
        expect(h.https.request).not.toHaveBeenCalled();
    });
});

test.each([
    ['scripts/check-quote-sync-health.js', 'main', undefined, '/api/quote-sync-health/alert'],
    ['src/routes/shipstation.js', 'forwardToTrackingCallback', {quoteId: 'OF-TEST', trackingNumber: 'TEST'}, '/api/quote-sessions/OF-TEST/shipstation-tracking'],
])('%s authenticates its actual callback', async (file, name, body, endpoint) => {
    const axios = {post: jest.fn().mockResolvedValue({data: {ok: true}})};
    await loadFunction(file, name, {axios})(body);
    expect(axios.post).toHaveBeenCalledWith('https://pricing.example.test' + endpoint,
        body || {}, expect.objectContaining({headers: expect.objectContaining({'X-CRM-API-Secret': 'unit-test-sync-secret'})}));
    delete process.env.CRM_API_SECRET;
    axios.post.mockClear();
    await loadFunction(file, name, {axios})(body);
    expect(axios.post).not.toHaveBeenCalled();
});
