const express = require('express');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { requireCrmApiSecret } = require('../../src/middleware');
const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
let server, base;
const savedSecret = process.env.CRM_API_SECRET;
beforeAll(done => {
    process.env.CRM_API_SECRET = 'parser-test-secret';
    const app = express();
    // Exercise production registration order and the actual error handler,
    // without starting the real server or any production schedulers.
    const start = source.indexOf("app.use('/api/payroll/parse'");
    const end = source.indexOf('// --- Keep crawlers', start);
    expect(start).toBeLessThan(source.indexOf('app.use(express.json({'));
    vm.runInNewContext(source.slice(start, end), { app, express, requireCrmApiSecret });
    app.post('/api/payroll/parse', (req, res) => res.status(202).json({ length: req.body.dataBase64.length }));
    app.post('/api/other', (req, res) => res.json({ ok: true }));
    const errorStart = source.indexOf('app.use((err, req, res, next) => {');
    const errorEnd = source.indexOf('// --- Graceful Shutdown', errorStart);
    vm.runInNewContext(source.slice(errorStart, errorEnd), { app, config: { server: { env: 'test' } }, console: { error() {} } });
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll(() => new Promise(resolve => {
    if (savedSecret === undefined) delete process.env.CRM_API_SECRET;
    else process.env.CRM_API_SECRET = savedSecret;
    server.closeAllConnections(); server.close(resolve);
}));
function post(url, body, authorized = true) {
    return fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(authorized ? { 'X-CRM-API-Secret': 'parser-test-secret' } : {}) }, body });
}
test('a payroll payload over 10 MB reaches the route', async () => {
    const res = await post('/api/payroll/parse', JSON.stringify({ dataBase64: 'A'.repeat(11 * 1024 * 1024) }));
    expect(res.status).toBe(202);
    expect((await res.json()).length).toBe(11 * 1024 * 1024);
});
test('the larger payroll allowance does not affect other routes', async () => {
    const res = await post('/api/other', JSON.stringify({ dataBase64: 'A'.repeat(11 * 1024 * 1024) }));
    expect(res.status).toBe(413);
});
test('payroll authenticates before parsing the request', async () => {
    expect((await post('/api/payroll/parse', '{invalid', false)).status).toBe(401);
});
test('malformed JSON reports 400 instead of 500', async () => {
    expect((await post('/api/payroll/parse', '{invalid')).status).toBe(400);
});
