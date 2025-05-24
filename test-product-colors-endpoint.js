// Test script to verify the /api/product-colors endpoint

const http = require('http');

// Style number to test
const styleNumber = 'PC61';

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

console.log(`Testing /api/product-colors endpoint for style: ${styleNumber}`);

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      
      console.log(`Product Title: ${response.productTitle}`);
      console.log(`Number of colors: ${response.colors.length}`);
      
      // Check if all image URLs are complete
      let incompleteUrls = 0;
      let completeUrls = 0;
      
      // Check the first color as a sample
      if (response.colors.length > 0) {
        const firstColor = response.colors[0];
        console.log(`\nSample color: ${firstColor.COLOR_NAME}`);
        
        // Check each image field
        const imageFields = [
          'COLOR_SQUARE_IMAGE', 
          'MAIN_IMAGE_URL', 
          'FRONT_MODEL_IMAGE_URL',
          'FRONT_MODEL',
          'FRONT_FLAT',
          'BACK_MODEL',
          'SIDE_MODEL',
          'THREE_Q_MODEL',
          'BACK_FLAT'
        ];
        
        imageFields.forEach(field => {
          const url = firstColor[field];
          if (url && url.length > 0) {
            if (url.startsWith('http')) {
              console.log(`✅ ${field}: ${url}`);
              completeUrls++;
            } else {
              console.log(`❌ ${field}: ${url} (incomplete URL)`);
              incompleteUrls++;
            }
          } else {
            console.log(`⚠️ ${field}: Empty or missing`);
          }
        });
        
        console.log(`\nComplete URLs: ${completeUrls}`);
        console.log(`Incomplete URLs: ${incompleteUrls}`);
        
        if (incompleteUrls === 0) {
          console.log('\n✅ All image URLs are complete!');
        } else {
          console.log('\n❌ Some image URLs are still incomplete.');
        }
      }
    } catch (error) {
      console.error('Error parsing response:', error);
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.end();