#!/usr/bin/env node

/**
 * Direct test of Caspio Files API to debug 415 error
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

const CASPIO_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
const ARTWORK_FOLDER = 'b91133c3-4413-4cb9-8337-444c730754dd';

// Test image
const TEST_IMAGE_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

async function testDirectUpload() {
    try {
        console.log('1. Getting token...');
        const token = await getToken();
        console.log('   ✓ Token obtained');

        console.log('\n2. Creating temp file and FormData...');
        const base64String = TEST_IMAGE_BASE64.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(base64String, 'base64');

        // Save to temp file
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `test_upload_${Date.now()}.png`);
        fs.writeFileSync(tempFilePath, buffer);
        console.log('   Temp file created:', tempFilePath);

        const formData = new FormData();
        formData.append('Files', fs.createReadStream(tempFilePath), 'test-image.png');

        console.log('   ✓ FormData created with file stream');
        console.log('   Headers from FormData:', formData.getHeaders());

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
        console.error('Status Text:', error.response?.statusText);
        console.error('Error Data:', error.response?.data);
        console.error('Request Headers:', error.config?.headers);
        return null;
    }
}

async function testFileInfo(externalKey) {
    if (!externalKey) return;

    try {
        console.log('\n4. Testing file info retrieval...');
        const token = await getToken();

        const response = await axios.get(
            `https://${CASPIO_DOMAIN}/rest/v3/files/${externalKey}/fileInfo`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        console.log('   ✓ File info retrieved:');
        console.log('   ', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('   ❌ Failed to get file info:', error.message);
    }
}

async function deleteFile(externalKey) {
    if (!externalKey) return;

    try {
        console.log('\n5. Cleaning up test file...');
        const token = await getToken();

        await axios.delete(
            `https://${CASPIO_DOMAIN}/rest/v3/files/${externalKey}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        console.log('   ✓ Test file deleted');
    } catch (error) {
        console.error('   ❌ Failed to delete file:', error.message);
    }
}

// Run the test
(async () => {
    console.log('========================================');
    console.log('Direct Caspio Files API Test');
    console.log('========================================');
    console.log(`Domain: ${CASPIO_DOMAIN}`);
    console.log(`Artwork Folder: ${ARTWORK_FOLDER}\n`);

    const externalKey = await testDirectUpload();
    await testFileInfo(externalKey);
    await deleteFile(externalKey);

    console.log('\n========================================');
    console.log('Test Complete');
    console.log('========================================');
})();