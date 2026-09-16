jest.mock('../../src/utils/caspio', () => ({
    fetchAllCaspioPages: jest.fn(), getCaspioAccessToken: jest.fn(async () => 'test-token')
}));
jest.mock('axios', () => ({ put: jest.fn(async () => ({})), post: jest.fn(async () => ({})) }));
const axios = require('axios');
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../../src/utils/caspio');
const router = require('../../src/routes/creditcard-lookups');
const handler = router.stack.find(l => l.route?.path === '/creditcard-atmos/upsert').route.stack[0].handle;
const reference = '12345678901234567890123';
function row(overrides = {}) {
    return { Reference_ID: 'R' + reference, PayableDate: '8/12/2026',
        PayableDueDateOverride: '8/12/2026', InvoiceNumber: 'Test merchant', Amount: '-1.60',
        Vendor_Charged_To: 'Test vendor', id_Vendor: '2872', id_Vendor_Charge: '2708',
        PONumber: '', Month_Reconciled: '26-Aug', Reconciled: 'No', GL_Account: '99', ...overrides };
}
async function invoke(rows, dryRun = false) {
    let status = 200, body;
    const res = { status(code) { status = code; return res; }, json(data) { body = data; return res; } };
    await handler({ body: { rows, dryRun } }, res);
    return { status, body };
}
beforeEach(() => { jest.clearAllMocks(); fetchAllCaspioPages.mockResolvedValue([]); });

test.each(['', '654321'])('existing PO survives incoming PO %p and protected accounting fields are omitted', async incoming => {
    fetchAllCaspioPages.mockResolvedValue([{ Reference_ID: reference, PONumber: '112233' }]);
    const response = await invoke([row({ PONumber: incoming })]);
    expect(response.body).toMatchObject({ success: true, updated: 1, inserted: 0, preservedPOs: 1 });
    const [url, payload] = axios.put.mock.calls[0];
    expect(url).toContain(`Reference_ID='${reference}'`);
    expect(payload).toMatchObject({ Reference_ID: 'R' + reference, Amount: -1.60 });
    for (const field of ['PONumber', 'GL_Account', 'Reconciled', 'id_Vendor']) expect(payload).not.toHaveProperty(field);
});
test('fills a missing existing PO when a new match is available', async () => {
    fetchAllCaspioPages.mockResolvedValue([{ Reference_ID: 'R' + reference, PONumber: null }]);
    await invoke([row({ PONumber: '112233' })]);
    expect(axios.put.mock.calls[0][1].PONumber).toBe('112233');
});
test('new charge retains credit, initializes reconciliation, and excludes formula/GL', async () => {
    await invoke([row()]);
    expect(axios.post.mock.calls[0][1]).toMatchObject({ Amount: -1.60, Reconciled: false, PONumber: '' });
    expect(axios.post.mock.calls[0][1]).not.toHaveProperty('id_Vendor');
    expect(axios.post.mock.calls[0][1]).not.toHaveProperty('GL_Account');
});
test('dry run returns PO preservation count without any writes', async () => {
    fetchAllCaspioPages.mockResolvedValue([{ Reference_ID: reference, PONumber: '112233' }]);
    const result = await invoke([row()], true);
    expect(result.body).toMatchObject({ toInsert: 0, toUpdate: 1, preservedPOs: 1 });
    expect(axios.post).not.toHaveBeenCalled(); expect(axios.put).not.toHaveBeenCalled();
    expect(getCaspioAccessToken).not.toHaveBeenCalled();
});
test.each([true, false])('duplicate canonical/legacy references block entire batch (dryRun=%s)', async dryRun => {
    const result = await invoke([row(), row({ Reference_ID: reference, Amount: '20.00' })], dryRun);
    expect(result.status).toBe(400);
    expect(result.body.validationErrors.join(' ')).toContain('duplicate');
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled(); expect(axios.put).not.toHaveBeenCalled();
});
test.each([
    { Amount: 'NaN' }, { Amount: 'Infinity' }, { Amount: '12garbage' }, { Amount: '' },
    { Amount: '1.234' }, { Reference_ID: '' }, { Reference_ID: 12345678901234567890 },
    { PayableDate: '2/30/2026' }, { PayableDueDateOverride: '' },
    { Vendor_Charged_To: '' }, { InvoiceNumber: 'x'.repeat(256) }, { id_Vendor_Charge: 'oops' }
])('invalid transaction blocks valid siblings too: %p', async invalid => {
    const result = await invoke([row({ Reference_ID: 'R22345678901234567890123' }), row(invalid)]);
    expect(result.status).toBe(400);
    expect(fetchAllCaspioPages).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});
