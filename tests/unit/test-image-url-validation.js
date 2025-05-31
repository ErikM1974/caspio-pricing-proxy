// Test script to validate image URLs from the /api/product-colors endpoint

const http = require('http');
const https = require('https');

// Style number to test
const styleNumber = 'PC61';

// Function to check if an image URL is valid
async function checkImageUrl(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http')) {
      resolve({ url, valid: false, reason: 'Invalid URL format' });
      return;
    }

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Check content type to ensure it's an image
        const contentType = res.headers['content-type'] || '';
        if (contentType.startsWith('image/')) {
          resolve({ url, valid: true, statusCode: res.statusCode, contentType });
        } else {
          resolve({ url, valid: false, statusCode: res.statusCode, reason: `Not an image: ${contentType}` });
        }
      } else {
        resolve({ url, valid: false, statusCode: res.statusCode, reason: 'HTTP error' });
      }
    });

    req.on('error', (err) => {
      resolve({ url, valid: false, reason: `Request error: ${err.message}` });
    });

    // Set a timeout of 5 seconds
    req.setTimeout(5000, () => {
      req.abort();
      resolve({ url, valid: false, reason: 'Request timeout' });
    });
  });
}

// Make a request to the /api/product-colors endpoint
const options = {
  hostname: 'localhost',
  port: 3000,
  path: `/api/product-colors?styleNumber=${styleNumber}`,
  method: 'GET',
  headers: {
    'Accept': 'application/json'
  }
};

console.log(`Testing image URLs from /api/product-colors endpoint for style: ${styleNumber}`);

// Make sure to start the server separately before running this test
(async () => {
  const req = http.request(options, async (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', async () => {
      try {
        const response = JSON.parse(data);
        
        console.log(`Product Title: ${response.productTitle}`);
        console.log(`Number of colors: ${response.colors.length}`);
        
        // Check image URLs for the first few colors
        const colorsToCheck = response.colors.slice(0, 3); // Check first 3 colors
        
        for (const color of colorsToCheck) {
          console.log(`\nChecking image URLs for color: ${color.COLOR_NAME}`);
          
          // Collect all image URLs for this color
          const imageUrls = [
            { field: 'COLOR_SQUARE_IMAGE', url: color.COLOR_SQUARE_IMAGE },
            { field: 'MAIN_IMAGE_URL', url: color.MAIN_IMAGE_URL },
            { field: 'FRONT_MODEL_IMAGE_URL', url: color.FRONT_MODEL_IMAGE_URL },
            { field: 'FRONT_MODEL', url: color.FRONT_MODEL },
            { field: 'FRONT_FLAT', url: color.FRONT_FLAT },
            { field: 'BACK_MODEL', url: color.BACK_MODEL },
            { field: 'SIDE_MODEL', url: color.SIDE_MODEL },
            { field: 'THREE_Q_MODEL', url: color.THREE_Q_MODEL },
            { field: 'BACK_FLAT', url: color.BACK_FLAT }
          ].filter(item => item.url); // Filter out empty URLs
          
          // Check each URL
          for (const imageUrl of imageUrls) {
            const result = await checkImageUrl(imageUrl.url);
            if (result.valid) {
              console.log(`✅ ${imageUrl.field}: ${imageUrl.url} (${result.statusCode}, ${result.contentType})`);
            } else {
              console.log(`❌ ${imageUrl.field}: ${imageUrl.url} (${result.reason})`);
            }
          }
        }
        
        // Exit the process
        process.exit(0);
      } catch (error) {
        console.error('Error parsing response:', error);
        console.log('Raw response:', data);
        process.exit(1);
      }
    });
  });
  
  req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
    process.exit(1);
  });
  
  req.end();
})();