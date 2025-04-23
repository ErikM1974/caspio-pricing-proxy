// test-frontend-image-url.js - Test script to verify frontend imageUrl handling
const fs = require('fs');
const path = require('path');

// Function to analyze the cart-integration.js file for imageUrl handling
function analyzeCartIntegrationJs() {
    try {
        console.log('=== FRONTEND IMAGE URL HANDLING ANALYSIS ===');
        
        // Read the cart-integration.js file
        const filePath = path.join(__dirname, 'cart-integration.js');
        console.log(`Reading file from: ${filePath}`);
        
        const data = fs.readFileSync(filePath, 'utf8');
        console.log(`Successfully read ${data.length} characters from cart-integration.js`);
        
        // Check if the file contains code for handling imageUrl
        const imageUrlMentions = (data.match(/imageUrl/g) || []).length;
        console.log(`Found ${imageUrlMentions} mentions of 'imageUrl' in the file`);
        
        // Look for specific patterns related to imageUrl handling
        const patterns = [
            { name: 'imageUrl in addToCart function', regex: /addToCart.*imageUrl/s },
            { name: 'imageUrl being set', regex: /imageUrl\s*=/ },
            { name: 'imageUrl in POST request', regex: /post.*imageUrl/s },
            { name: 'imageUrl in request body', regex: /body.*imageUrl/s },
            { name: 'imageUrl in JSON data', regex: /JSON\.stringify.*imageUrl/s }
        ];
        
        console.log('\nChecking for specific imageUrl handling patterns:');
        let foundPatterns = 0;
        
        patterns.forEach(pattern => {
            const match = data.match(pattern.regex);
            const found = match !== null;
            console.log(`- ${pattern.name}: ${found ? '✅ Found' : '❌ Not found'}`);
            
            if (found) {
                foundPatterns++;
                console.log(`  Context: "${match[0].substring(0, 100).replace(/\s+/g, ' ')}..."`);
            }
        });
        
        // Check for specific image-related functions
        console.log('\nChecking for image-related functions:');
        
        const imageFunctions = [
            { name: 'getProductImage', regex: /function\s+getProductImage/ },
            { name: 'setProductImage', regex: /function\s+setProductImage/ },
            { name: 'updateProductImage', regex: /function\s+updateProductImage/ },
            { name: 'handleImageUrl', regex: /function\s+handleImageUrl/ }
        ];
        
        let foundImageFunctions = 0;
        
        imageFunctions.forEach(func => {
            const match = data.match(func.regex);
            const found = match !== null;
            console.log(`- ${func.name}: ${found ? '✅ Found' : '❌ Not found'}`);
            
            if (found) {
                foundImageFunctions++;
                // Extract the function definition (first 200 chars)
                const functionStart = data.indexOf(match[0]);
                const functionSnippet = data.substring(functionStart, functionStart + 200).replace(/\s+/g, ' ');
                console.log(`  Definition: "${functionSnippet}..."`);
            }
        });
        
        // Check for DOM elements that might contain image URLs
        console.log('\nChecking for DOM elements that might contain image URLs:');
        
        const domElements = [
            { name: 'Image elements', regex: /document\.querySelector.*img/s },
            { name: 'Image src attributes', regex: /\.src\s*=/ },
            { name: 'Data attributes for images', regex: /data-image/ }
        ];
        
        let foundDomElements = 0;
        
        domElements.forEach(element => {
            const match = data.match(element.regex);
            const found = match !== null;
            console.log(`- ${element.name}: ${found ? '✅ Found' : '❌ Not found'}`);
            
            if (found) {
                foundDomElements++;
                console.log(`  Context: "${match[0].substring(0, 100).replace(/\s+/g, ' ')}..."`);
            }
        });
        
        // Overall assessment
        console.log('\n=== ASSESSMENT ===');
        
        if (imageUrlMentions === 0) {
            console.log('❌ CRITICAL ISSUE: The imageUrl field is not mentioned at all in the frontend code.');
            console.log('This suggests that the frontend is not designed to handle image URLs.');
        } else if (foundPatterns === 0) {
            console.log('❌ MAJOR ISSUE: While imageUrl is mentioned, no specific handling patterns were found.');
            console.log('The frontend might not be properly sending the imageUrl to the server.');
        } else if (foundPatterns < 3) {
            console.log('⚠️ POTENTIAL ISSUE: Some imageUrl handling patterns were found, but not all expected ones.');
            console.log('The frontend might be inconsistently handling the imageUrl.');
        } else {
            console.log('✅ GOOD: Multiple imageUrl handling patterns were found.');
            console.log('The frontend appears to be designed to handle image URLs.');
        }
        
        // Recommendations
        console.log('\n=== RECOMMENDATIONS ===');
        
        if (imageUrlMentions === 0 || foundPatterns === 0) {
            console.log('1. Add explicit imageUrl handling to the frontend code.');
            console.log('2. Ensure the imageUrl is included in the request body when adding items to the cart.');
            console.log('3. Update the addToCart function to capture and send the imageUrl.');
        } else if (foundPatterns < 3) {
            console.log('1. Review the imageUrl handling in the frontend code for consistency.');
            console.log('2. Ensure the imageUrl is correctly captured from the product page.');
            console.log('3. Verify that the imageUrl is included in all relevant API requests.');
        } else {
            console.log('1. Verify that the imageUrl is correctly being populated at runtime.');
            console.log('2. Check for any conditional logic that might prevent the imageUrl from being sent.');
            console.log('3. Add console logging in the frontend to confirm the imageUrl value before sending.');
        }
        
        // Specific code suggestions
        console.log('\n=== CODE SUGGESTIONS ===');
        
        if (imageUrlMentions === 0 || foundPatterns === 0) {
            console.log('Add the following code to the addToCart function:');
            console.log(`
// Get the product image URL
const productImage = document.querySelector('.product-image img');
const imageUrl = productImage ? productImage.src : null;

// Include imageUrl in the cart item data
const cartItemData = {
    // ... existing fields ...
    imageUrl: imageUrl
};

// Log the data being sent
console.log('Adding to cart with image URL:', imageUrl);
console.log('Cart item data:', cartItemData);

// Send the request
fetch('/api/cart-items', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify(cartItemData)
})
.then(response => response.json())
.then(data => {
    console.log('Success:', data);
})
.catch(error => {
    console.error('Error:', error);
});
`);
        } else {
            console.log('Add the following debugging code before sending the request:');
            console.log(`
// Debug logging for imageUrl
console.log('DEBUG - Image URL before sending:', cartItemData.imageUrl);

// Ensure imageUrl is not undefined
if (!cartItemData.imageUrl) {
    console.warn('WARNING: imageUrl is undefined or null');
    // Try to get it from another source if available
    const productImage = document.querySelector('.product-image img');
    cartItemData.imageUrl = productImage ? productImage.src : null;
    console.log('DEBUG - Updated Image URL:', cartItemData.imageUrl);
}
`);
        }
        
        return {
            imageUrlMentions,
            foundPatterns,
            foundImageFunctions,
            foundDomElements,
            overallAssessment: imageUrlMentions > 0 && foundPatterns > 0 ? 'Partial imageUrl handling found' : 'No proper imageUrl handling found'
        };
    } catch (error) {
        console.error('Error analyzing cart-integration.js:', error.message);
        return {
            error: error.message
        };
    }
}

// Run the analysis
const result = analyzeCartIntegrationJs();
console.log('\nAnalysis completed with result:', result);