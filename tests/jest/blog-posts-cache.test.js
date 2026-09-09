// /api/blog-posts public reads come from ONE cached table read (2026-09-09).
//
// Crawlers walk every /blog/<slug> the way they walk products; the site's own
// 5-minute cache still read Blog_Posts through the proxy 439 times in 19 hours.
// Pinned here:
//   • list + every detail + every 404 after one read cost ZERO Caspio calls
//   • the list keeps its old semantics: Published only (drafts with the secret
//     and ?status=all), case-insensitive category filter, newest first, no bodies
//   • detail keeps its old semantics: full body; a draft is 404 without the secret
//   • a successful POST or PUT clears the cache so the editor's change shows next read
//   • ?refresh=true bypasses; an empty read is never pinned; a failure is a 502
//     and the next request retries

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(),
  makeCaspioRequest: jest.fn(async () => ({ success: true, status: 201 })),
  putWithRecordsAffected: jest.fn(async () => ({ RecordsAffected: 1 })),
}));

const express = require('express');
const { fetchAllCaspioPages, makeCaspioRequest, putWithRecordsAffected } = require('../../src/utils/caspio');
const { clearAll } = require('../../src/utils/ttl-cache');

process.env.CRM_API_SECRET = 'test-secret';
const router = require('../../src/routes/blog-posts');

const ROWS = [
  { Post_ID: 'dtg-vs-screen-print', Title: 'DTG vs screen print', Meta_Description: 'Which to pick', Category: 'Decoration', Hero_Image_URL: '', Video_URL: '', Author: 'Erik', Status: 'Published', Featured: 'Yes', Published_At: '2026-08-20T10:00:00.000Z', Updated_At: '2026-08-21T10:00:00.000Z', Body_Markdown: '# DTG\nlong body' },
  { Post_ID: 'uniform-sizing-guide', Title: 'Uniform sizing guide', Meta_Description: 'Sizes', Category: 'Ordering', Hero_Image_URL: '', Video_URL: '', Author: 'Erik', Status: 'Published', Featured: 'No', Published_At: '2026-09-01T10:00:00.000Z', Updated_At: '', Body_Markdown: 'sizing body' },
  { Post_ID: 'draft-post', Title: 'Draft', Meta_Description: '', Category: 'Decoration', Hero_Image_URL: '', Video_URL: '', Author: 'Erik', Status: 'Draft', Featured: 'No', Published_At: '', Updated_At: '', Body_Markdown: 'draft body' },
];

const fullLoads = () => fetchAllCaspioPages.mock.calls.filter(([, params]) => !params || !params['q.select']);

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/blog-posts', router);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  clearAll();
  fetchAllCaspioPages.mockReset();
  makeCaspioRequest.mockClear();
  putWithRecordsAffected.mockClear();
  // The POST dupe check and the PUT existence check select specific columns;
  // the cache load is the only call without q.select.
  fetchAllCaspioPages.mockImplementation(async (path, params) => {
    if (params && params['q.select'] === 'Post_ID') return []; // POST dupe check: no collision
    if (params && params['q.select']) return ROWS.filter((r) => params['q.where'].includes(`'${r.Post_ID}'`)); // PUT existence check
    return ROWS;
  });
});

const call = async (path, { method = 'GET', body, secret } = {}) => {
  const r = await fetch(`${baseUrl}/api/blog-posts${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(secret ? { 'x-crm-api-secret': 'test-secret' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

test('list, every detail and a 404 after one table read cost zero further Caspio calls', async () => {
  const list = await call('/');
  expect(list.status).toBe(200);
  expect(list.body.posts.map((p) => p.slug)).toEqual(['uniform-sizing-guide', 'dtg-vs-screen-print']); // newest first, no draft
  expect(list.body.posts[0].bodyMarkdown).toBeUndefined();
  expect(fullLoads()).toHaveLength(1);
  const [, params, options] = fullLoads()[0];
  expect(params['q.orderBy']).toBe('Post_ID');
  expect(options).toEqual({ maxPages: 10 });

  const detail = await call('/dtg-vs-screen-print');
  expect(detail.status).toBe(200);
  expect(detail.body.post).toMatchObject({ slug: 'dtg-vs-screen-print', bodyMarkdown: '# DTG\nlong body', featured: 'Yes' });
  await call('/uniform-sizing-guide');
  expect((await call('/no-such-post')).status).toBe(404);
  await call('/');
  expect(fullLoads()).toHaveLength(1);
  expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);
});

test('concurrent cold requests share one load', async () => {
  const results = await Promise.all(['/', '/dtg-vs-screen-print', '/uniform-sizing-guide', '/', '/dtg-vs-screen-print'].map((p) => call(p)));
  expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);
});

test('category filter is case-insensitive and limit applies', async () => {
  const r = await call('/?category=decoration&limit=1');
  expect(r.body.posts.map((p) => p.slug)).toEqual(['dtg-vs-screen-print']);
  expect((await call('/?category=Ordering')).body.posts.map((p) => p.slug)).toEqual(['uniform-sizing-guide']);
  expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);
});

test('drafts: hidden from the public, visible with the secret', async () => {
  expect((await call('/draft-post')).status).toBe(404);
  expect((await call('/draft-post', { secret: true })).status).toBe(200);
  expect((await call('/?status=all')).body.posts).toHaveLength(2);           // no secret → still published only
  expect((await call('/?status=all', { secret: true })).body.posts).toHaveLength(3);
  expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);
});

test('a bad slug is a 400 before any read', async () => {
  expect((await call('/Bad_Slug')).status).toBe(400);
  expect(fetchAllCaspioPages).not.toHaveBeenCalled();
});

test('a successful POST clears the cache; a rejected one does not', async () => {
  await call('/');
  expect(fullLoads()).toHaveLength(1);
  const bad = await call('/', { method: 'POST', body: { slug: 'x', title: '' } });
  expect(bad.status).toBe(400);
  await call('/');
  expect(fullLoads()).toHaveLength(1);
  const ok = await call('/', { method: 'POST', body: { slug: 'new-post', title: 'New post', status: 'Published', bodyMarkdown: 'hi' } });
  expect(ok.status).toBe(201);
  expect(makeCaspioRequest).toHaveBeenCalledTimes(1);
  await call('/');
  expect(fullLoads()).toHaveLength(2);
});

test('a successful PUT clears the cache', async () => {
  await call('/dtg-vs-screen-print');
  expect(fullLoads()).toHaveLength(1);
  const r = await call('/dtg-vs-screen-print', { method: 'PUT', body: { title: 'DTG vs screen print (updated)' } });
  expect(r.status).toBe(200);
  expect(putWithRecordsAffected).toHaveBeenCalledTimes(1);
  await call('/dtg-vs-screen-print');
  expect(fullLoads()).toHaveLength(2);
});

test('?refresh=true bypasses; an empty read is never pinned; a failure is a 502 then retries', async () => {
  await call('/');
  await call('/?refresh=true');
  expect(fullLoads()).toHaveLength(2);

  clearAll();
  fetchAllCaspioPages.mockResolvedValueOnce([]);
  expect((await call('/')).body.posts).toEqual([]);
  expect((await call('/')).body.posts).toHaveLength(2);
  expect(fullLoads()).toHaveLength(4);

  clearAll();
  fetchAllCaspioPages.mockRejectedValueOnce(new Error('Caspio down'));
  expect((await call('/dtg-vs-screen-print')).status).toBe(502);
  expect((await call('/dtg-vs-screen-print')).status).toBe(200);
  expect(fullLoads()).toHaveLength(6);
});
