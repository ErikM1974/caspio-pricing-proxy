/**
 * Exploration script: test Caspio Bridge Apps API.
 * Goal: determine whether the API exposes which tables a DataPage queries.
 * Read-only, no Caspio mutations.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

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
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });
    token = resp.data.access_token;
    tokenExp = now + resp.data.expires_in;
    return token;
}

async function get(path) {
    const tok = await getToken();
    const domain = process.env.CASPIO_ACCOUNT_DOMAIN;
    const resp = await axios.get(`https://${domain}/integrations/rest/v3${path}`, {
        headers: { 'Authorization': `Bearer ${tok}`, 'Accept': 'application/json' },
        timeout: 30000
    });
    return resp.data;
}

(async () => {
    try {
        console.log('=== STEP 1: List Bridge Applications ===');
        const apps = await get('/bridgeApplications');
        const appList = apps.Result || [];
        console.log(`Found ${appList.length} apps:`);
        appList.forEach((a, i) => {
            console.log(`  ${i+1}. ${a.AppName} — ${a.DataPagesCount} DataPages — key=${a.ExternalKey}`);
        });

        if (appList.length === 0) {
            console.log('No apps found. Cannot proceed.');
            return;
        }

        // Pick the app with the most DataPages
        const app = appList.sort((a, b) => (b.DataPagesCount || 0) - (a.DataPagesCount || 0))[0];
        console.log(`\n=== STEP 2: List DataPages in app "${app.AppName}" ===`);
        const datapages = await get(`/bridgeApplications/${app.ExternalKey}/datapages`);
        const dpList = datapages.Result || [];
        console.log(`Found ${dpList.length} DataPages. First 5:`);
        dpList.slice(0, 5).forEach((dp, i) => {
            console.log(`  ${i+1}. ${dp.Name} (${dp.Type}) — appKey=${dp.AppKey}`);
        });

        if (dpList.length === 0) {
            console.log('No DataPages.');
            return;
        }

        console.log(`\n=== STEP 3: Inspect single DataPage details ===`);
        const dp = dpList[0];
        const detail = await get(`/bridgeApplications/${app.ExternalKey}/datapages/${dp.AppKey}`);
        console.log('Full response keys:', Object.keys(detail.Result || detail));
        console.log('Full response JSON:');
        console.log(JSON.stringify(detail, null, 2));

        console.log(`\n=== STEP 4: Check for table reference fields ===`);
        const result = detail.Result || detail;
        const fieldNames = Object.keys(result);
        const tableHints = fieldNames.filter(k => /table|source|datasource|object/i.test(k));
        if (tableHints.length > 0) {
            console.log('Possible table-reference fields:', tableHints);
            tableHints.forEach(k => console.log(`  ${k} = ${JSON.stringify(result[k])}`));
        } else {
            console.log('NO field name suggests a table reference. The API does NOT expose DataPage data sources.');
            console.log('Available fields:', fieldNames.join(', '));
        }
    } catch (err) {
        console.error('ERROR:', err.response?.status, err.response?.data || err.message);
    }
})();
