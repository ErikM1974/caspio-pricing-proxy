require('dotenv').config();
const axios = require('axios');

const BOX_API_BASE = 'https://api.box.com/2.0';
let boxToken = null;
let boxTokenExpiry = 0;

async function getBoxToken() {
    const now = Math.floor(Date.now() / 1000);
    if (boxToken && now < boxTokenExpiry - 60) return boxToken;
    const resp = await axios.post('https://api.box.com/oauth2/token', new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.BOX_CLIENT_ID,
        client_secret: process.env.BOX_CLIENT_SECRET,
        box_subject_type: 'enterprise',
        box_subject_id: process.env.BOX_ENTERPRISE_ID
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    boxToken = resp.data.access_token;
    boxTokenExpiry = now + resp.data.expires_in;
    return boxToken;
}

async function inspectFile(fileId, label) {
    const token = await getBoxToken();
    console.log(`\n=== ${label} | fileId=${fileId} ===`);
    // Try active file lookup
    try {
        const resp = await axios.get(`${BOX_API_BASE}/files/${fileId}`, {
            params: { fields: 'id,name,parent,path_collection,trashed_at,modified_at,owned_by,size' },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000,
            validateStatus: () => true
        });
        if (resp.status === 200) {
            const f = resp.data;
            const path = (f.path_collection?.entries || []).map(e => e.name).join(' / ');
            console.log(`  STATUS: ACTIVE`);
            console.log(`  Name: ${f.name}`);
            console.log(`  Path: ${path}`);
            console.log(`  Parent: ${f.parent?.name} (id ${f.parent?.id})`);
            console.log(`  Modified: ${f.modified_at}`);
            console.log(`  Size: ${f.size} bytes`);
        } else if (resp.status === 404) {
            console.log(`  STATUS: NOT FOUND in active files (404)`);
            // Try trash
            try {
                const trashResp = await axios.get(`${BOX_API_BASE}/files/${fileId}/trash`, {
                    params: { fields: 'id,name,parent,trashed_at,owned_by' },
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000,
                    validateStatus: () => true
                });
                if (trashResp.status === 200) {
                    console.log(`  TRASH STATUS: FOUND IN TRASH`);
                    console.log(`  Name: ${trashResp.data.name}`);
                    console.log(`  Trashed at: ${trashResp.data.trashed_at}`);
                    console.log(`  Original parent: ${trashResp.data.parent?.name} (id ${trashResp.data.parent?.id})`);
                    console.log(`  Owned by: ${trashResp.data.owned_by?.name} (${trashResp.data.owned_by?.login})`);
                } else {
                    console.log(`  TRASH STATUS: ${trashResp.status} — gone permanently or never existed`);
                }
            } catch (e) {
                console.log(`  TRASH lookup error: ${e.message}`);
            }
        } else {
            console.log(`  STATUS: ${resp.status} — ${JSON.stringify(resp.data).slice(0, 200)}`);
        }
    } catch (err) {
        console.log(`  ERROR: ${err.message}`);
    }
}

(async () => {
    // FileIds from cards Erik shows still broken
    const targets = [
        ['40329 Regalo International',     '2205420145336'],
        ['40298 King County Metro',        '2205423779113'],
        ['40280 Osborn Concrete',          '2205422260795'],
        ['40205 Sysco - Pacific NW',       '2205421938555'],
    ];
    for (const [label, fid] of targets) {
        await inspectFile(fid, label);
    }
})();
