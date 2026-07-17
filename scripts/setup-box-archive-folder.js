// Setup: create/find the "ShopWorks Thumbnails Archive" Box folder under
// BOX_ART_FOLDER_ID (writable by the CCG service account) and print its ID.
// Run once on Heroku (has the Box env vars):  heroku run node scripts/setup-box-archive-folder.js
// Then set:  heroku config:set BOX_THUMBNAIL_ARCHIVE_FOLDER_ID=<printed id>
try { require('dotenv').config(); } catch (_) { /* env already present on Heroku */ }
const { getBoxAccessToken, boxRequest, BOX_API_BASE } = require('../src/utils/box-client');

const NAME = 'ShopWorks Thumbnails Archive';
const PARENT = process.env.BOX_ART_FOLDER_ID;

async function main() {
  if (!PARENT) { console.error('BOX_ART_FOLDER_ID not set'); process.exit(1); }
  await getBoxAccessToken();
  try {
    const resp = await boxRequest('POST', `${BOX_API_BASE}/folders`,
      { name: NAME, parent: { id: PARENT } }, { 'Content-Type': 'application/json' });
    console.log('CREATED  BOX_THUMBNAIL_ARCHIVE_FOLDER_ID =', resp.data.id);
  } catch (e) {
    if (e.response && e.response.status === 409) {
      const list = await boxRequest('GET', `${BOX_API_BASE}/folders/${PARENT}/items?limit=1000&fields=name,type`);
      const found = (list.data.entries || []).find(x => x.type === 'folder' && x.name === NAME);
      if (found) { console.log('EXISTS  BOX_THUMBNAIL_ARCHIVE_FOLDER_ID =', found.id); return; }
    }
    console.error('FAILED:', e.response ? e.response.status + ' ' + JSON.stringify(e.response.data) : e.message);
    process.exit(1);
  }
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
