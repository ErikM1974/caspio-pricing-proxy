#!/usr/bin/env node

/**
 * Test access to Artwork folder in Caspio
 */

const axios = require('axios');
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

async function testFolderAccess() {
    try {
        console.log('Getting token...');
        const token = await getToken();
        console.log('✓ Token obtained\n');

        // Try to get folder info
        console.log('Checking Artwork folder access...');
        const url = `https://${CASPIO_DOMAIN}/rest/v3/files?externalKey=${ARTWORK_FOLDER}`;

        try {
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });

            console.log('✓ Folder accessible!');
            console.log('Files in folder:', JSON.stringify(response.data, null, 2));
        } catch (error) {
            if (error.response?.status === 404) {
                console.log('❌ Folder not found with key:', ARTWORK_FOLDER);
                console.log('   This might be a different Caspio account');
            } else {
                console.log('❌ Error accessing folder:', error.response?.status, error.response?.statusText);
                console.log('   Details:', error.response?.data);
            }
        }

        // Try to list all folders
        console.log('\nListing available folders...');
        try {
            const foldersUrl = `https://${CASPIO_DOMAIN}/rest/v3/files/folders`;
            const response = await axios.get(foldersUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });

            console.log('Available folders:', JSON.stringify(response.data, null, 2));
        } catch (error) {
            console.log('Could not list folders:', error.response?.status, error.response?.data || error.message);
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Run the test
(async () => {
    console.log('========================================');
    console.log('Caspio Folder Access Test');
    console.log('========================================');
    console.log(`Domain: ${CASPIO_DOMAIN}`);
    console.log(`Artwork Folder Key: ${ARTWORK_FOLDER}\n`);

    await testFolderAccess();

    console.log('\n========================================');
    console.log('Test Complete');
    console.log('========================================');
})();