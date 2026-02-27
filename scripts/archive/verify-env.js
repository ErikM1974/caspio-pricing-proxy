// Verify environment variables
require('dotenv').config();

console.log('Environment Variables Check:\n');
console.log('CASPIO_ACCOUNT_DOMAIN:', process.env.CASPIO_ACCOUNT_DOMAIN || '❌ NOT SET');
console.log('CASPIO_CLIENT_ID:', process.env.CASPIO_CLIENT_ID || '❌ NOT SET');
console.log('CASPIO_CLIENT_SECRET:', process.env.CASPIO_CLIENT_SECRET ? '✓ SET' : '❌ NOT SET');
console.log('PORT:', process.env.PORT || '3000 (default)');

// Check what's actually in the env
console.log('\nActual values (first few chars):');
console.log('Domain:', process.env.CASPIO_ACCOUNT_DOMAIN ? process.env.CASPIO_ACCOUNT_DOMAIN.substring(0, 10) + '...' : 'undefined');
console.log('Client ID:', process.env.CASPIO_CLIENT_ID ? process.env.CASPIO_CLIENT_ID.substring(0, 10) + '...' : 'undefined');