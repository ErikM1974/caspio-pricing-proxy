// utils/caspio.js (2026-09-06):
//   • paged reads send q.getPaginationInfo=true and stop EXACTLY on Pagination.TotalCount —
//     a result set that is a whole multiple of the page size no longer costs a trailing
//     empty page, and the strict truncation guard no longer guesses
//   • makeCaspioRequest('post', ..., { response: 'rows' }) surfaces the created row:
//     PK_ID from the row (the Location header is not always sent) and Result[]

process.env.CASPIO_ACCOUNT_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN || 'c3eku948.caspio.com';
process.env.CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID || 'id';
process.env.CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET || 'secret';

const mockAxios = jest.fn();
jest.mock('axios', () => Object.assign((...a) => mockAxios(...a), {
  get: (...a) => mockAxios(...a), post: (...a) => mockAxios(...a),
  interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
}));

const { fetchAllCaspioPages, makeCaspioRequest } = require('../../src/utils/caspio');

function serve(rowsTotal, { withTotal = true } = {}) {
  mockAxios.mockImplementation(async (cfg) => {
    const url = typeof cfg === 'string' ? cfg : cfg.url;
    if (/\/oauth\/token$/.test(url)) return { data: { access_token: 'tok', expires_in: 86000 } };
    const p = cfg.params || {};
    const size = p['q.pageSize'], page = p['q.pageNumber'] || 1;
    const start = (page - 1) * size;
    const Result = Array.from({ length: Math.max(0, Math.min(size, rowsTotal - start)) }, (_, i) => ({ PK_ID: start + i + 1 }));
    return { status: 200, headers: {}, data: withTotal ? { Result, Pagination: { TotalCount: rowsTotal, PageNumber: page, PageSize: size } } : { Result } };
  });
}
const pageCalls = () => mockAxios.mock.calls.map(([c]) => c).filter(c => c && c.params && c.params['q.pageSize']);

beforeEach(() => mockAxios.mockReset());

describe('fetchAllCaspioPages with q.getPaginationInfo', () => {
  test('page 1 asks for the pagination info', async () => {
    serve(3);
    await fetchAllCaspioPages('/tables/T/records', { 'q.pageSize': 10 });
    expect(pageCalls()[0].params['q.getPaginationInfo']).toBe(true);
  });

  test('an exact multiple of the page size stops on the total: 20 rows / 10 per page = 2 requests, not 3', async () => {
    serve(20);
    const out = await fetchAllCaspioPages('/tables/T/records', { 'q.pageSize': 10 });
    expect(out).toHaveLength(20);
    expect(pageCalls()).toHaveLength(2);
  });

  test('a partial last page still stops: 25 rows = 3 requests', async () => {
    serve(25);
    const out = await fetchAllCaspioPages('/tables/T/records', { 'q.pageSize': 10 });
    expect(out).toHaveLength(25);
    expect(pageCalls().map(c => c.params['q.pageNumber'])).toEqual([1, 2, 3]);
  });

  test('without Pagination in the answer the old full-page rule still applies (20 rows = 3 requests)', async () => {
    serve(20, { withTotal: false });
    const out = await fetchAllCaspioPages('/tables/T/records', { 'q.pageSize': 10 });
    expect(out).toHaveLength(20);
    expect(pageCalls()).toHaveLength(3);
  });

  test('strict mode: hitting maxPages with rows still owed THROWS, using the exact total', async () => {
    serve(35);
    await expect(fetchAllCaspioPages('/tables/T/records', { 'q.pageSize': 10 }, { maxPages: 2, strict: true }))
      .rejects.toThrow(/truncated/);
  });

  test('q.limit below the page minimum stays a single request without the flag', async () => {
    serve(1);
    await fetchAllCaspioPages('/tables/T/records', { 'q.limit': 1 });
    const [c] = mockAxios.mock.calls.map(([x]) => x).filter(x => x.params);
    expect(c.params['q.limit']).toBe(1);
    expect(c.params['q.getPaginationInfo']).toBeUndefined();
  });
});

describe('makeCaspioRequest POST', () => {
  test('with response=rows the created row and its PK_ID come back', async () => {
    mockAxios.mockImplementation(async (cfg) => {
      if (/\/oauth\/token$/.test(cfg.url)) return { data: { access_token: 'tok', expires_in: 86000 } };
      return { status: 201, headers: {}, data: { Result: [{ PK_ID: 4242, Design_ID: '9001', Mockup_Slot: 'Mockup_1' }] } };
    });
    const r = await makeCaspioRequest('post', '/tables/Mockup_AI_Analysis/records', { response: 'rows' }, { Design_ID: '9001' });
    expect(r).toMatchObject({ success: true, status: 201, PK_ID: '4242' });
    expect(r.Result).toEqual([{ PK_ID: 4242, Design_ID: '9001', Mockup_Slot: 'Mockup_1' }]);
    const post = mockAxios.mock.calls.map(([c]) => c).find(c => c.method === 'post');
    expect(post.params).toEqual({ response: 'rows' });
  });

  test('without a body the PK_ID still comes from the Location header, and no Result key is added', async () => {
    mockAxios.mockImplementation(async (cfg) => {
      if (/\/oauth\/token$/.test(cfg.url)) return { data: { access_token: 'tok', expires_in: 86000 } };
      return { status: 201, headers: { location: '/tables/T/records/77' }, data: '' };
    });
    const r = await makeCaspioRequest('post', '/tables/T/records', {}, { a: 1 });
    expect(r).toEqual({ success: true, status: 201, location: '/tables/T/records/77', PK_ID: '77' });
  });
});
