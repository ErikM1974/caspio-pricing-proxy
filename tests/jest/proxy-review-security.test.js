// Real routers and mount declarations, with upstream services replaced by mocks.
jest.mock('../../src/utils/caspio', () => ({
    getCaspioAccessToken: jest.fn().mockResolvedValue('mock-token'),
    fetchAllCaspioPages: jest.fn().mockResolvedValue([]),
    makeCaspioRequest: jest.fn().mockResolvedValue({ RecordsAffected: 1 })
}));
jest.mock('axios', () => jest.fn().mockResolvedValue({ data: { RecordsAffected: 1 } }));
jest.mock('../../lib/shipstation-client', () => ({
    getOrder: jest.fn().mockResolvedValue({ orderId: 123 }),
    listShipmentsByOrderId: jest.fn().mockResolvedValue([])
}));
jest.mock('../../src/utils/slack-shipstation-notify', () => ({}));

const express = require('express');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const axios = require('axios');
const caspio = require('../../src/utils/caspio');
const { requireCrmApiSecret } = require('../../src/middleware');
const cartRoutes = require('../../src/routes/cart');
const companyContactsRoutes = require('../../src/routes/company-contacts');
const companyContacts2026Routes = require('../../src/routes/company-contacts-2026');
const shipstationRoutes = require('../../src/routes/shipstation');
const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
let server, base;
const savedSecret = process.env.CRM_API_SECRET;

beforeAll(done => {
    process.env.CRM_API_SECRET = 'review-test-secret';
    const app = express();
    app.use(express.json());
    // Execute the actual access-control registrations in their source order.
    const lines = source.split('\n').filter(line =>
        /^app\.use\(/.test(line) && (
            line.includes("['/api/cart-sessions'") ||
            line.includes("['/api/company-contacts'") ||
            line.includes('shipstationRoutes.router') ||
            /, (cartRoutes|companyContactsRoutes|companyContacts2026Routes)\)/.test(line)
        ));
    expect(lines).toHaveLength(6);
    vm.runInNewContext(lines.join('\n'), { app, requireCrmApiSecret, cartRoutes,
        companyContactsRoutes, companyContacts2026Routes, shipstationRoutes });
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll(() => new Promise(resolve => {
    if (savedSecret === undefined) delete process.env.CRM_API_SECRET;
    else process.env.CRM_API_SECRET = savedSecret;
    server.closeAllConnections(); server.close(resolve);
}));
beforeEach(() => jest.clearAllMocks());
const auth = { 'X-CRM-API-Secret': 'review-test-secret', 'Content-Type': 'application/json' };

test.each([
    ['GET', '/api/cart-sessions'], ['HEAD', '/api/cart-items'],
    ['POST', '/api/cart-items'], ['DELETE', '/api/cart-item-sizes/123'],
    ['GET', '/api/company-contacts/search?q=Acme'], ['PUT', '/api/company-contacts/123'],
    ['POST', '/api/company-contacts/sync'], ['HEAD', '/api/company-contacts-2026/search?q=Acme'],
    ['GET', '/api/shipstation/orders/123'], ['GET', '/api/shipstation/shipments?orderId=123'],
    ['HEAD', '/api/shipstation/orders/123']
])('%s %s refuses anonymous and spoofed-origin callers', async (method, url) => {
    const res = await fetch(base + url, { method, headers: { Origin: 'https://teamnwca.com' } });
    expect(res.status).toBe(401);
    expect(axios).not.toHaveBeenCalled();
    expect(caspio.makeCaspioRequest).not.toHaveBeenCalled();
    expect(caspio.fetchAllCaspioPages).not.toHaveBeenCalled();
});

test('authenticated contact update and ShipStation read continue working', async () => {
    const contact = await fetch(base + '/api/company-contacts/123', {
        method: 'PUT', headers: auth, body: JSON.stringify({ ContactNumbersEmail: 'review@example.invalid' })
    });
    expect(contact.status).toBe(200);
    expect(caspio.makeCaspioRequest).toHaveBeenCalledWith('put', '/tables/CompanyContactsMerge2026/records',
        { 'q.where': 'ID_Contact=123' }, { Email: 'review@example.invalid' });
    expect((await fetch(base + '/api/shipstation/orders/123', { headers: auth })).status).toBe(200);
});

test.each(['0 OR 1=1', '1&other=value', '1.5', '-1', '1e3', '9007199254740992'])('rejects unsafe numeric cart ID %s', async id => {
    for (const resource of ['cart-items', 'cart-item-sizes']) {
        for (const method of ['PUT', 'DELETE']) {
            const res = await fetch(`${base}/api/${resource}/${encodeURIComponent(id)}`, {
                method, headers: auth, ...(method === 'PUT' ? { body: '{}' } : {})
            });
            expect(res.status).toBe(400);
        }
    }
    expect(axios).not.toHaveBeenCalled();
    expect(caspio.fetchAllCaspioPages).not.toHaveBeenCalled();
});

test('valid numeric deletion remains scoped to one ID', async () => {
    expect((await fetch(base + '/api/cart-items/123', { method: 'DELETE', headers: auth })).status).toBe(200);
    const request = axios.mock.calls[0][0];
    expect(new URL(request.url).searchParams.get('q.where')).toBe('PK_ID=123');
});

test('session IDs are quoted as literals and encoded separately from the URL', async () => {
    const id = "x' OR '1'='1&other=value";
    const res = await fetch(base + '/api/cart-sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: auth });
    expect(res.status).toBe(200);
    expect(axios.mock.calls[0][0]).toMatchObject({
        params: { 'q.where': "SessionID='x'' OR ''1''=''1&other=value'" }
    });
    expect(axios.mock.calls[0][0].url).not.toContain('?');
});

test('read filters reject numeric expressions and quote text literals', async () => {
    expect((await fetch(base + '/api/cart-items?orderID=0%20OR%201%3D1', { headers: auth })).status).toBe(400);
    expect(caspio.fetchAllCaspioPages).not.toHaveBeenCalled();
    const color = "O'Brien";
    expect((await fetch(base + '/api/cart-items?color=' + encodeURIComponent(color), { headers: auth })).status).toBe(200);
    expect(caspio.fetchAllCaspioPages.mock.calls[0][1]['q.where']).toBe("Color='O''Brien'");
});
