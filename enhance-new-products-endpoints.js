#!/usr/bin/env node

/**
 * Enhancement script for new products endpoints in Postman collection
 * Adds sample data, proper query parameters, and request bodies
 */

const fs = require('fs');
const path = require('path');

const collectionPath = path.join(__dirname, 'docs', 'NWCA-API.postman_collection.json');

console.log('📝 Enhancing new products endpoints with sample data...');

// Read collection
const data = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));

// Find Product Search folder
const folder = data.item.find(i => i.name && i.name.includes('Product Search'));
if (!folder) {
  console.error('❌ Could not find Product Search folder');
  process.exit(1);
}

// Remove existing new product endpoints
folder.item = folder.item.filter(i => !i.name.toLowerCase().includes('new'));

// Enhanced endpoints with sample data
const enhancedEndpoints = [
  {
    name: "Get Products New",
    request: {
      method: "GET",
      header: [],
      url: {
        raw: "{{baseUrl}}/api/products/new?limit=20",
        host: ["{{baseUrl}}"],
        path: ["api", "products", "new"],
        query: [
          {
            key: "limit",
            value: "20",
            description: "Maximum number of results (default: 20, max: 100)",
            disabled: false
          },
          {
            key: "category",
            value: "Sweatshirts/Fleece",
            description: "Filter by category name (e.g., 'Sweatshirts/Fleece', 'T-Shirts', etc.)",
            disabled: true
          },
          {
            key: "brand",
            value: "Eddie Bauer",
            description: "Filter by brand name (e.g., 'Eddie Bauer', 'OGIO', 'Port & Company')",
            disabled: true
          }
        ]
      },
      description: `**Returns products marked as new (IsNew=1)**

Supports filtering by category, brand, and limit. Results are cached for 5 minutes to reduce API calls.

**Query Parameters:**
- \`limit\` - Maximum number of results (default: 20, max: 100)
- \`category\` - Filter by category name
- \`brand\` - Filter by brand name

**Examples:**
- Get 20 newest products: \`?limit=20\`
- Get new sweatshirts: \`?category=Sweatshirts/Fleece\`
- Get new Eddie Bauer products: \`?brand=Eddie Bauer\`
- Get 5 new OGIO polos: \`?limit=5&brand=OGIO&category=Polos\`

**Response:**
\`\`\`json
{
  "products": [...],
  "count": 20,
  "cached": false
}
\`\`\``
    },
    response: []
  },
  {
    name: "Create Admin Products Add Isnew Field",
    request: {
      method: "POST",
      header: [
        {
          key: "Content-Type",
          value: "application/json"
        }
      ],
      body: {
        mode: "raw",
        raw: "",
        options: {
          raw: {
            language: "json"
          }
        }
      },
      url: {
        raw: "{{baseUrl}}/api/admin/products/add-isnew-field",
        host: ["{{baseUrl}}"],
        path: ["api", "admin", "products", "add-isnew-field"]
      },
      description: `**Creates the IsNew boolean field in the products table**

This endpoint is idempotent - if field already exists, returns success message without error.

**Request Body:**
No body needed.

**Response (Success - Field Created):**
\`\`\`json
{
  "success": true,
  "message": "IsNew field created successfully",
  "fieldName": "IsNew"
}
\`\`\`

**Response (Success - Field Already Exists):**
\`\`\`json
{
  "success": true,
  "message": "IsNew field already exists",
  "fieldName": "IsNew",
  "alreadyExists": true
}
\`\`\`

**Use Case:**
Run this endpoint once to initialize the IsNew field in the Sanmar products table before marking products as new.`
    },
    response: []
  },
  {
    name: "Create Admin Products Mark As New",
    request: {
      method: "POST",
      header: [
        {
          key: "Content-Type",
          value: "application/json"
        }
      ],
      body: {
        mode: "raw",
        raw: JSON.stringify({
          styles: [
            "EB120",
            "EB121",
            "EB122",
            "EB123",
            "EB124",
            "EB125",
            "EB130",
            "EB131",
            "OG734",
            "OG735",
            "PC54",
            "PC55",
            "LPC54",
            "ST350",
            "LST350"
          ]
        }, null, 2),
        options: {
          raw: {
            language: "json"
          }
        }
      },
      url: {
        raw: "{{baseUrl}}/api/admin/products/mark-as-new",
        host: ["{{baseUrl}}"],
        path: ["api", "admin", "products", "mark-as-new"]
      },
      description: `**Batch updates products to set IsNew=true**

Updates ALL variants (colors, sizes) for each style number provided. One style can have dozens of records (one per color+size combination).

**Request Body:**
\`\`\`json
{
  "styles": ["EB120", "EB121", "EB122", ...]
}
\`\`\`

**Response (Success):**
\`\`\`json
{
  "success": true,
  "message": "Successfully marked 150 records as new",
  "recordsAffected": 150,
  "styles": ["EB120", "EB121", ...],
  "styleCount": 15
}
\`\`\`

**Example Body (15 Featured Products):**
The body in this request contains 15 style numbers that will be marked as new:
- Eddie Bauer Fleece Collection (EB120-EB131)
- OGIO Polos (OG734-OG735)
- Port & Company Core Tees (PC54, PC55, LPC54)
- Sport-Tek Performance Tees (ST350, LST350)

**Notes:**
- Each style may have 10-30 variants (different colors/sizes)
- Total records affected = style count × variants per style
- Use this to feature new arrivals or seasonal favorites`
    },
    response: []
  }
];

// Add enhanced endpoints
folder.item.push(...enhancedEndpoints);

// Write back to file
fs.writeFileSync(collectionPath, JSON.stringify(data, null, 2));

console.log('✅ Successfully enhanced 3 endpoints with sample data:');
console.log('   1. GET /api/products/new (with query param examples)');
console.log('   2. POST /api/admin/products/add-isnew-field (with response examples)');
console.log('   3. POST /api/admin/products/mark-as-new (with 15-product sample body)');
console.log('\n📤 Syncing to Postman API...');

// Sync to Postman
const { exec } = require('child_process');
exec('npm run sync-postman', (error, stdout, stderr) => {
  if (error) {
    console.error('⚠️  Could not auto-sync to Postman. Run manually: npm run sync-postman');
    return;
  }
  console.log(stdout);
  console.log('🎉 Collection enhanced and synced!');
});
