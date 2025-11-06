// Unified Configuration for Caspio Pricing Proxy
// This is the single source of truth for all configuration

require('dotenv').config();

const config = {
  // Server configuration
  server: {
    port: process.env.PORT || 3002,
    env: process.env.NODE_ENV || 'development'
  },
  
  // Caspio configuration - Using v2 API for stability, v3 for Files
  caspio: {
    domain: process.env.CASPIO_ACCOUNT_DOMAIN,
    clientId: process.env.CASPIO_CLIENT_ID,
    clientSecret: process.env.CASPIO_CLIENT_SECRET,
    tokenUrl: `https://${process.env.CASPIO_ACCOUNT_DOMAIN}/oauth/token`,
    apiBaseUrl: `https://${process.env.CASPIO_ACCOUNT_DOMAIN}/rest/v2`, // v2 API for consistency
    apiV3BaseUrl: `https://${process.env.CASPIO_ACCOUNT_DOMAIN}/integrations/rest/v3`, // v3 API for Files
    apiVersion: 'v2',
    artworkFolderKey: 'b91133c3-4413-4cb9-8337-444c730754dd' // Artwork folder for file uploads
  },
  
  // Request timeouts
  timeouts: {
    perRequest: 20000,      // 20 seconds per request (increased for large queries)
    totalPagination: 90000, // 90 seconds total for pagination (allows 4-5 pages)
    tokenBuffer: 60         // 60 seconds buffer for token refresh
  },
  
  // Pagination defaults
  pagination: {
    defaultLimit: 1000,
    maxPages: 20  // Increased to handle brands with many products (e.g., Port & Company has 114 styles)
  },
  
  // CORS settings
  cors: {
    origin: '*', // Allow all origins for testing (restrict in production)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  },
  
  // Logging
  logging: {
    enabled: true,
    level: process.env.LOG_LEVEL || 'info'
  },

  // ManageOrders API configuration
  manageOrders: {
    baseUrl: 'https://manageordersapi.com/v1',
    username: process.env.MANAGEORDERS_USERNAME,
    password: process.env.MANAGEORDERS_PASSWORD,
    tokenCacheDuration: 3600000, // 1 hour in milliseconds
    customerCacheDuration: 86400000, // 1 day in milliseconds
    defaultDaysBack: 60 // Default to 60 days of orders
  },

  // JDS Industries API configuration
  jds: {
    baseUrl: process.env.JDS_API_URL || 'https://api.jdsapp.com',
    apiToken: process.env.JDS_API_TOKEN,
    endpoint: '/get-product-details-by-skus',
    requestTimeout: 30000, // 30 seconds
    cacheDuration: 3600000, // 1 hour in milliseconds
    rateLimitPerMinute: 60 // Max 60 requests per minute
  }
};

// Validate required configuration
function validateConfig() {
  const errors = [];
  
  if (!config.caspio.domain) {
    errors.push('CASPIO_ACCOUNT_DOMAIN environment variable not set');
  }
  
  if (!config.caspio.clientId) {
    errors.push('CASPIO_CLIENT_ID environment variable not set');
  }
  
  if (!config.caspio.clientSecret) {
    errors.push('CASPIO_CLIENT_SECRET environment variable not set');
  }
  
  if (errors.length > 0) {
    console.error('Configuration validation failed:');
    errors.forEach(error => console.error(`  - ${error}`));
    console.error('\nPlease check your .env file and ensure all required variables are set.');
    process.exit(1);
  }
  
  console.log('✅ Configuration validated successfully');
  console.log(`   Port: ${config.server.port}`);
  console.log(`   Caspio Domain: ${config.caspio.domain}`);
  console.log(`   API Version: ${config.caspio.apiVersion}`);
}

// Run validation on load
validateConfig();

module.exports = config;