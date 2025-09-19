#!/usr/bin/env node

/**
 * Test uploading real file to Caspio
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
require('dotenv').config();

const CASPIO_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
const ARTWORK_FOLDER = 'b91133c3-4413-4cb9-8337-444c730754dd';

async function getToken() {
    const response = await axios.post(`https://${CASPIO_DOMAIN}/oauth/token`, new URLSearchParams({
        'grant_type': 'client_credentials',
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return response.data.access_token;
}

async function uploadFile() {
    try {
        console.log('1. Getting token...');
        const token = await getToken();
        console.log('   ✓ Token obtained');

        console.log('\n2. Creating FormData with real file...');
        const filePath = '/mnt/c/Users/erik/Downloads/Kingfisher Charters Embroidered Cap Catalog Image.png';

        // Check file exists and get size
        const stats = fs.statSync(filePath);
        console.log(`   File size: ${stats.size} bytes`);

        const formData = new FormData();
        const fileStream = fs.createReadStream(filePath);
        formData.append('Files', fileStream, 'Kingfisher_Test.png');

        console.log('   ✓ FormData created');
        console.log('   Headers:', formData.getHeaders());

        console.log('\n3. Uploading to Caspio Artwork folder...');
        const url = `https://${CASPIO_DOMAIN}/rest/v3/files?externalKey=${ARTWORK_FOLDER}`;
        console.log('   URL:', url);

        const response = await axios.post(url, formData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                ...formData.getHeaders()
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        console.log('   ✓ Upload successful!');
        console.log('   Response:', JSON.stringify(response.data, null, 2));

        return response.data.Result[0].ExternalKey;
    } catch (error) {
        console.error('\n❌ Upload failed!');
        console.error('Status:', error.response?.status);
        console.error('Error:', error.response?.data || error.message);
        return null;
    }
}

// Run the test
(async () => {
    console.log('========================================');
    console.log('Real File Upload Test');
    console.log('========================================');
    console.log(`Domain: ${CASPIO_DOMAIN}`);
    console.log(`Artwork Folder: ${ARTWORK_FOLDER}\n`);

    const externalKey = await uploadFile();

    if (externalKey) {
        console.log(`\n✓ File uploaded with ExternalKey: ${externalKey}`);
    }

    console.log('\n========================================');
    console.log('Test Complete');
    console.log('========================================');
})();