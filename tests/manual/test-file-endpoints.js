#!/usr/bin/env node

/**
 * Test script for File Upload API endpoints
 * Tests all file operations locally before deploying to Heroku
 */

const axios = require('axios');
const colors = require('colors');

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3002';
const API_BASE = `${BASE_URL}/api`;

// Small test image in base64 format (1x1 red pixel PNG)
const TEST_IMAGE_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Small test PDF in base64 format (minimal valid PDF)
const TEST_PDF_BASE64 = 'data:application/pdf;base64,JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKL01lZGlhQm94IFswIDAgNjEyIDc5Ml0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovUmVzb3VyY2VzIDw8Cj4+Cj4+CmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA3NCAwMDAwMCBuIAowMDAwMDAwMTkyIDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNAovUm9vdCAxIDAgUgo+PgpzdGFydHhyZWYKMjgxCiUlRU9G';

let uploadedExternalKey = null;
let testResults = [];

// Helper to display test results
function logTest(testName, success, details = '') {
    const status = success ? '✅ PASS'.green : '❌ FAIL'.red;
    console.log(`${status} - ${testName}`);
    if (details) console.log(`   ${details}`.gray);
    testResults.push({ testName, success, details });
}

// Helper to make API calls
async function makeRequest(method, endpoint, data = null) {
    try {
        const response = await axios({
            method,
            url: `${API_BASE}${endpoint}`,
            data,
            headers: {
                'Content-Type': 'application/json'
            },
            validateStatus: () => true // Don't throw on any status code
        });
        return response;
    } catch (error) {
        console.error(`Request failed: ${error.message}`.red);
        return null;
    }
}

// Test functions
async function testFileUpload() {
    console.log('\n📤 Testing File Upload...'.cyan);

    const timestamp = Date.now();
    const fileName = `test-image-${timestamp}.png`;

    const response = await makeRequest('POST', '/files/upload', {
        fileName,
        fileData: TEST_IMAGE_BASE64,
        description: 'Test upload from local testing script'
    });

    if (response && response.status === 200 && response.data.success) {
        uploadedExternalKey = response.data.externalKey;
        logTest('File Upload', true,
            `ExternalKey: ${uploadedExternalKey}, File: ${response.data.fileName}`);
        return true;
    } else {
        logTest('File Upload', false,
            response ? `Status: ${response.status}, Error: ${JSON.stringify(response.data)}` : 'No response');
        return false;
    }
}

async function testFileInfo() {
    console.log('\n📋 Testing File Info Retrieval...'.cyan);

    if (!uploadedExternalKey) {
        logTest('File Info', false, 'No ExternalKey available from upload test');
        return false;
    }

    const response = await makeRequest('GET', `/files/${uploadedExternalKey}/info`);

    if (response && response.status === 200 && response.data.success) {
        logTest('File Info', true,
            `Name: ${response.data.Name}, Size: ${response.data.Size}, Type: ${response.data.ContentType}`);
        return true;
    } else {
        logTest('File Info', false,
            response ? `Status: ${response.status}` : 'No response');
        return false;
    }
}

async function testFileDownload() {
    console.log('\n📥 Testing File Download...'.cyan);

    if (!uploadedExternalKey) {
        logTest('File Download', false, 'No ExternalKey available from upload test');
        return false;
    }

    try {
        const response = await axios({
            method: 'GET',
            url: `${API_BASE}/files/${uploadedExternalKey}`,
            responseType: 'arraybuffer',
            validateStatus: () => true
        });

        if (response.status === 200) {
            const contentType = response.headers['content-type'];
            const fileSize = response.data.length;
            logTest('File Download', true,
                `Content-Type: ${contentType}, Size: ${fileSize} bytes`);
            return true;
        } else {
            logTest('File Download', false, `Status: ${response.status}`);
            return false;
        }
    } catch (error) {
        logTest('File Download', false, error.message);
        return false;
    }
}

async function testInvalidUpload() {
    console.log('\n🚫 Testing Invalid File Upload...'.cyan);

    // Test with invalid base64
    const response = await makeRequest('POST', '/files/upload', {
        fileName: 'invalid.txt',
        fileData: 'not-valid-base64'
    });

    if (response && response.status === 400) {
        logTest('Invalid Upload Rejection', true,
            `Correctly rejected: ${response.data.error}`);
        return true;
    } else {
        logTest('Invalid Upload Rejection', false,
            'Should have returned 400 for invalid base64');
        return false;
    }
}

async function testPDFUpload() {
    console.log('\n📄 Testing PDF Upload...'.cyan);

    const timestamp = Date.now();
    const fileName = `test-document-${timestamp}.pdf`;

    const response = await makeRequest('POST', '/files/upload', {
        fileName,
        fileData: TEST_PDF_BASE64,
        description: 'Test PDF upload'
    });

    if (response && response.status === 200 && response.data.success) {
        logTest('PDF Upload', true,
            `ExternalKey: ${response.data.externalKey}`);

        // Clean up - delete the test PDF
        if (response.data.externalKey) {
            await makeRequest('DELETE', `/files/${response.data.externalKey}`);
        }
        return true;
    } else {
        logTest('PDF Upload', false,
            response ? `Status: ${response.status}` : 'No response');
        return false;
    }
}

async function testQuoteItemsWithFile() {
    console.log('\n🎯 Testing Quote Items with File Upload...'.cyan);

    const response = await makeRequest('POST', '/quote-items-with-file', {
        QuoteID: 'TEST-001',
        ProductName: 'Test Product',
        Quantity: 10,
        ImageUpload: TEST_IMAGE_BASE64
    });

    if (response && response.status === 200 && response.data.success) {
        const hasExternalKey = response.data.data.Image_Upload &&
                               response.data.data.Image_Upload.length > 0;
        logTest('Quote Items with File', true,
            hasExternalKey ? `File uploaded and linked: ${response.data.data.Image_Upload}` : 'Processed successfully');

        // Clean up if file was uploaded
        if (response.data.data._uploadedFile?.externalKey) {
            await makeRequest('DELETE', `/files/${response.data.data._uploadedFile.externalKey}`);
        }
        return true;
    } else {
        logTest('Quote Items with File', false,
            response ? JSON.stringify(response.data) : 'No response');
        return false;
    }
}

async function testFileDelete() {
    console.log('\n🗑️ Testing File Delete...'.cyan);

    if (!uploadedExternalKey) {
        logTest('File Delete', false, 'No ExternalKey available from upload test');
        return false;
    }

    const response = await makeRequest('DELETE', `/files/${uploadedExternalKey}`);

    if (response && response.status === 200 && response.data.success) {
        logTest('File Delete', true, 'File deleted successfully');

        // Verify deletion by trying to get info
        const verifyResponse = await makeRequest('GET', `/files/${uploadedExternalKey}/info`);
        if (verifyResponse && verifyResponse.status === 404) {
            logTest('Delete Verification', true, 'File confirmed deleted (404 on info request)');
        }
        return true;
    } else {
        logTest('File Delete', false,
            response ? `Status: ${response.status}` : 'No response');
        return false;
    }
}

// Main test runner
async function runTests() {
    console.log('========================================'.yellow);
    console.log('🧪 File Upload API Test Suite'.yellow.bold);
    console.log('========================================'.yellow);
    console.log(`📍 Testing against: ${BASE_URL}`.gray);
    console.log(`⏰ Started: ${new Date().toLocaleTimeString()}`.gray);
    console.log('');

    // Check if server is running
    try {
        await axios.get(`${BASE_URL}/api/health`);
        console.log('✅ Server is running'.green);
    } catch (error) {
        console.error('❌ Server is not running!'.red);
        console.log(`   Please start the server with: PORT=3002 node server.js`.gray);
        process.exit(1);
    }

    // Run tests in sequence
    await testFileUpload();
    await testFileInfo();
    await testFileDownload();
    await testInvalidUpload();
    await testPDFUpload();
    await testQuoteItemsWithFile();
    await testFileDelete();

    // Summary
    console.log('\n========================================'.yellow);
    console.log('📊 Test Summary'.yellow.bold);
    console.log('========================================'.yellow);

    const passed = testResults.filter(t => t.success).length;
    const failed = testResults.filter(t => !t.success).length;
    const total = testResults.length;

    console.log(`Total Tests: ${total}`);
    console.log(`Passed: ${passed}`.green);
    console.log(`Failed: ${failed}`.red);

    if (failed === 0) {
        console.log('\n🎉 All tests passed! Ready for deployment.'.green.bold);
    } else {
        console.log('\n⚠️  Some tests failed. Please fix before deploying.'.red.bold);
        process.exit(1);
    }
}

// Run the tests
runTests().catch(error => {
    console.error('Test suite failed:', error);
    process.exit(1);
});