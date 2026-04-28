/**
 * Walk all Caspio Bridge Apps and dump every DataPage to JSON.
 * Used for the table-usage audit (matches DataPage names to table names).
 * Read-only.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let token = null;
let tokenExp = 0;

async function getToken() {
    const now = Math.floor(Date.now() / 1000);
    if (token && now < tokenExp - 60) return token;
    const domain = process.env.CASPIO_ACCOUNT_DOMAIN;
    const resp = await axios.post(`https://${domain}/oauth/token`, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.CASPIO_CLIENT_ID,
        client_secret: process.env.CASPIO_CLIENT_SECRET
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    token = resp.data.access_token;
    tokenExp = now + resp.data.expires_in;
    return token;
}

async function get(p) {
    const tok = await getToken();
    const domain = process.env.CASPIO_ACCOUNT_DOMAIN;
    const resp = await axios.get(`https://${domain}/integrations/rest/v3${p}`, {
        headers: { 'Authorization': `Bearer ${tok}`, 'Accept': 'application/json' },
        timeout: 30000
    });
    return resp.data;
}

(async () => {
    const apps = (await get('/bridgeApplications')).Result || [];
    console.log(`Apps: ${apps.length}`);

    const allDataPages = [];
    for (const app of apps) {
        if ((app.DataPagesCount || 0) === 0) continue;
        try {
            const resp = await get(`/bridgeApplications/${app.ExternalKey}/datapages`);
            const dps = resp.Result || [];
            for (const dp of dps) {
                allDataPages.push({
                    AppName: app.AppName,
                    AppKey: app.ExternalKey,
                    Name: dp.Name,
                    DataPageKey: dp.AppKey,
                    Type: dp.Type,
                    Path: dp.Path,
                    DateCreated: dp.DateCreated,
                    DateModified: dp.DateModified,
                    CreatedBy: dp.CreatedBy,
                    ModifiedBy: dp.ModifiedBy,
                    Note: dp.Note
                });
            }
            console.log(`  ${app.AppName}: ${dps.length} DataPages`);
        } catch (e) {
            console.log(`  ${app.AppName}: ERROR ${e.response?.status}`);
        }
    }

    const out = path.join(__dirname, '..', '..', 'Pricing Index File 2025', 'tests', 'caspio-datapages.json');
    fs.writeFileSync(out, JSON.stringify(allDataPages, null, 2));
    console.log(`\nTotal DataPages: ${allDataPages.length}`);
    console.log(`Saved to: ${out}`);
})();
