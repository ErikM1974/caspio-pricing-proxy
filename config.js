// Unified Configuration for Caspio Pricing Proxy
// This is the single source of truth for all configuration

require('dotenv').config();

const config = {
  // Server configuration
  server: {
    port: process.env.PORT || 3002,
    env: process.env.NODE_ENV || 'development'
  },
  
  // Caspio configuration - Using v2 API for stability
  caspio: {
    domain: process.env.CASPIO_ACCOUNT_DOMAIN,
    clientId: process.env.CASPIO_CLIENT_ID,
    clientSecret: process.env.CASPIO_CLIENT_SECRET,
    tokenUrl: `https://${process.env.CASPIO_ACCOUNT_DOMAIN}/oauth/token`,
    apiBaseUrl: `https://${process.env.CASPIO_ACCOUNT_DOMAIN}/rest/v2`, // v2 API for consistency
    apiVersion: 'v2'
  },
  
  // Request timeouts
  timeouts: {
    perRequest: 15000,      // 15 seconds per request
    totalPagination: 25000, // 25 seconds total for pagination
    tokenBuffer: 60         // 60 seconds buffer for token refresh
  },
  
  // Pagination defaults
  pagination: {
    defaultLimit: 1000,
    maxPages: 10
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