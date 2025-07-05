// Simple test to verify the endpoint exists in server.js
const fs = require('fs');

// Read server.js and check for the endpoint
const serverCode = fs.readFileSync('./server.js', 'utf8');

// Check if the endpoint exists
if (serverCode.includes("app.get('/api/production-schedules'")) {
    console.log('✅ Production Schedules endpoint found in server.js');
    
    // Find the endpoint code
    const startIndex = serverCode.indexOf("app.get('/api/production-schedules'");
    const endIndex = serverCode.indexOf('});', startIndex) + 3;
    const endpointCode = serverCode.substring(startIndex, endIndex);
    
    console.log('\nEndpoint implementation:');
    console.log('------------------------');
    console.log(endpointCode.substring(0, 500) + '...');
    
    // Check for key features
    const features = [
        { name: 'q.where parameter', pattern: "req.query['q.where']" },
        { name: 'q.orderBy parameter', pattern: "req.query['q.orderBy']" },
        { name: 'q.limit parameter', pattern: "req.query['q.limit']" },
        { name: 'fetchAllCaspioPages', pattern: 'fetchAllCaspioPages' },
        { name: 'Error handling', pattern: 'res.status(500)' }
    ];
    
    console.log('\nFeature verification:');
    console.log('--------------------');
    features.forEach(feature => {
        if (endpointCode.includes(feature.pattern)) {
            console.log(`✅ ${feature.name}: Implemented`);
        } else {
            console.log(`❌ ${feature.name}: Not found`);
        }
    });
    
} else {
    console.log('❌ Production Schedules endpoint NOT found in server.js');
}

console.log('\n📝 Note: You need to restart the server for the new endpoint to be available.');
console.log('   Run: node server.js');