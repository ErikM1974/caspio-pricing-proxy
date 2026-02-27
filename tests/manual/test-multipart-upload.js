#!/usr/bin/env node

/**
 * Test multipart/form-data file upload to our simplified endpoint
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:3002';

// Create a test image file
const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function createTestFile() {
    const buffer = Buffer.from(TEST_IMAGE_BASE64, 'base64');
    const testFilePath = path.join(__dirname, 'test-logo.png');
    fs.writeFileSync(testFilePath, buffer);
    console.log('✓ Created test file: test-logo.png');
    return testFilePath;
}

async function testFileUpload(filePath) {
    try {
        console.log('\n1. Testing file upload endpoint...');

        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), 'test-logo.png');

        console.log('   Uploading file to server...');
        const response = await axios.post(`${SERVER_URL}/api/files/upload`, formData, {
            headers: {
                ...formData.getHeaders()
            }
        });

        console.log('   ✓ Upload successful!');
        console.log('   Response:', JSON.stringify(response.data, null, 2));

        return response.data.externalKey;
    } catch (error) {
        console.error('   ❌ Upload failed!');
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Error:', error.response.data);
        } else {
            console.error('   Error:', error.message);
        }
        return null;
    }
}

async function testFileInfo(externalKey) {
    if (!externalKey) return;

    try {
        console.log('\n2. Testing file info endpoint...');

        const response = await axios.get(`${SERVER_URL}/api/files/${externalKey}/info`);

        console.log('   ✓ File info retrieved!');
        console.log('   Response:', JSON.stringify(response.data, null, 2));

        return true;
    } catch (error) {
        console.error('   ❌ Failed to get file info!');
        if (error.response) {
            console.error('   Error:', error.response.data);
        }
        return false;
    }
}

async function testFileDownload(externalKey) {
    if (!externalKey) return;

    try {
        console.log('\n3. Testing file download endpoint...');

        const response = await axios.get(`${SERVER_URL}/api/files/${externalKey}`, {
            responseType: 'arraybuffer'
        });

        console.log('   ✓ File downloaded!');
        console.log('   Size:', response.data.length, 'bytes');
        console.log('   Content-Type:', response.headers['content-type']);

        return true;
    } catch (error) {
        console.error('   ❌ Failed to download file!');
        if (error.response) {
            console.error('   Error:', error.response.data);
        }
        return false;
    }
}

async function testFileDelete(externalKey) {
    if (!externalKey) return;

    try {
        console.log('\n4. Testing file delete endpoint...');

        const response = await axios.delete(`${SERVER_URL}/api/files/${externalKey}`);

        console.log('   ✓ File deleted!');
        console.log('   Response:', JSON.stringify(response.data, null, 2));

        return true;
    } catch (error) {
        console.error('   ❌ Failed to delete file!');
        if (error.response) {
            console.error('   Error:', error.response.data);
        }
        return false;
    }
}

async function cleanup() {
    const testFilePath = path.join(__dirname, 'test-logo.png');
    if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
        console.log('\n✓ Cleaned up test file');
    }
}

// Run all tests
(async () => {
    console.log('========================================');
    console.log('Testing Multipart File Upload');
    console.log('========================================');
    console.log(`Server: ${SERVER_URL}`);

    try {
        // Create test file
        const testFilePath = await createTestFile();

        // Test upload
        const externalKey = await testFileUpload(testFilePath);

        if (externalKey) {
            // Test other endpoints
            await testFileInfo(externalKey);
            await testFileDownload(externalKey);
            await testFileDelete(externalKey);
        }

        // Clean up
        await cleanup();

    } catch (error) {
        console.error('\nTest failed:', error.message);
        await cleanup();
    }

    console.log('\n========================================');
    console.log('Test Complete');
    console.log('========================================');
})();