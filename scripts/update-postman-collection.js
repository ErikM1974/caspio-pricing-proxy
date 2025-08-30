#!/usr/bin/env node

/**
 * Script to update Postman collection with missing endpoints
 * This ensures the collection stays in sync with actual API endpoints
 */

const fs = require('fs');
const path = require('path');

// Read the existing collection
const collectionPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.json');
const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));

// Update collection info
collection.info.name = "NWCA Production API - Complete";
collection.info.description = "Complete API collection for Northwest Custom Apparel. Includes all production endpoints with enhanced product search, cart management, pricing, orders, and more. Keep this updated when adding new endpoints!";

// Add missing endpoints to Product Search category
const productSearchCategory = collection.item.find(cat => cat.name === "🛍️ Product Search");
if (productSearchCategory) {
  // Check if Enhanced Product Search exists
  const hasEnhancedSearch = productSearchCategory.item.some(ep => ep.name === "Enhanced Product Search");
  
  if (!hasEnhancedSearch) {
    // Add Enhanced Product Search at the beginning
    productSearchCategory.item.unshift({
      name: "Enhanced Product Search",
      request: {
        method: "GET",
        header: [],
        url: {
          raw: "{{baseUrl}}/api/products/search?q=polo&category=Polos&includeFacets=true&limit=24",
          host: ["{{baseUrl}}"],
          path: ["api", "products", "search"],
          query: [
            {
              key: "q",
              value: "polo",
              description: "Search query across style, title, description, keywords, brand"
            },
            {
              key: "category",
              value: "Polos",
              description: "Filter by category (can be array: category[]=Polos&category[]=T-Shirts)"
            },
            {
              key: "brand",
              value: "",
              description: "Filter by brand (can be array)",
              disabled: true
            },
            {
              key: "color",
              value: "",
              description: "Filter by color (can be array)",
              disabled: true
            },
            {
              key: "size",
              value: "",
              description: "Filter by size (can be array)",
              disabled: true
            },
            {
              key: "minPrice",
              value: "10",
              description: "Minimum price filter",
              disabled: true
            },
            {
              key: "maxPrice",
              value: "50",
              description: "Maximum price filter",
              disabled: true
            },
            {
              key: "status",
              value: "Active",
              description: "Product status (Active/Discontinued/all)",
              disabled: true
            },
            {
              key: "sort",
              value: "price_asc",
              description: "Sort order (name_asc, name_desc, price_asc, price_desc, newest, oldest)",
              disabled: true
            },
            {
              key: "page",
              value: "1",
              description: "Page number",
              disabled: true
            },
            {
              key: "limit",
              value: "24",
              description: "Results per page (max 100)"
            },
            {
              key: "includeFacets",
              value: "true",
              description: "Include filter counts for UI"
            }
          ]
        },
        description: "🆕 Advanced product search with smart grouping by style, faceted filtering, and comprehensive product data. Groups multiple records by STYLE to eliminate duplicates and aggregates colors/sizes. Perfect for catalog search pages."
      },
      response: []
    });
    console.log('✅ Added Enhanced Product Search endpoint');
  }
}

// Add missing Transfer endpoints
let transfersCategory = collection.item.find(cat => cat.name === "🎨 Transfers");
if (!transfersCategory) {
  // Create Transfers category if it doesn't exist
  transfersCategory = {
    name: "🎨 Transfers",
    item: [],
    description: "Transfer printing pricing and management"
  };
  collection.item.push(transfersCategory);
}

// Add transfer endpoints if missing
const transferEndpoints = [
  {
    name: "Get Transfer Price",
    method: "GET",
    path: ["api", "transfers", "lookup"],
    params: [
      { key: "size", value: "Adult", description: "Transfer size" },
      { key: "quantity", value: "10", description: "Quantity" },
      { key: "price_type", value: "Regular", description: "Price type" }
    ],
    description: "Lookup transfer price by size and quantity"
  },
  {
    name: "Get Transfer Matrix",
    method: "GET",
    path: ["api", "transfers", "matrix"],
    params: [
      { key: "size", value: "Adult", description: "Transfer size" }
    ],
    description: "Get transfer pricing matrix for a size"
  },
  {
    name: "Get Transfer Sizes",
    method: "GET",
    path: ["api", "transfers", "sizes"],
    params: [],
    description: "Get all available transfer sizes"
  }
];

transferEndpoints.forEach(endpoint => {
  if (!transfersCategory.item.some(item => item.name === endpoint.name)) {
    const newEndpoint = {
      name: endpoint.name,
      request: {
        method: endpoint.method,
        header: [],
        url: {
          raw: `{{baseUrl}}/${endpoint.path.join('/')}${endpoint.params.length ? '?' + endpoint.params.map(p => `${p.key}=${p.value}`).join('&') : ''}`,
          host: ["{{baseUrl}}"],
          path: endpoint.path,
          query: endpoint.params.map(p => ({ ...p, value: p.value || "" }))
        },
        description: endpoint.description
      },
      response: []
    };
    transfersCategory.item.push(newEndpoint);
    console.log(`✅ Added ${endpoint.name} endpoint`);
  }
});

// Add missing CRUD operations for Art Requests
const artCategory = collection.item.find(cat => cat.name === "🎨 Art & Invoicing");
if (artCategory) {
  const crudOps = [
    {
      name: "Update Art Request",
      method: "PUT",
      path: ["api", "artrequests", "{{id}}"],
      body: {
        "Status": "Completed",
        "Invoiced": true,
        "Invoiced_Date": "2025-01-15"
      },
      description: "Update existing art request. Accepts any fields from the ArtRequests table."
    },
    {
      name: "Delete Art Request",
      method: "DELETE",
      path: ["api", "artrequests", "{{id}}"],
      description: "Delete art request by ID"
    },
    {
      name: "Create Art Request",
      method: "POST",
      path: ["api", "artrequests"],
      body: {
        "CompanyName": "Test Company",
        "Status": "In Progress",
        "CustomerServiceRep": "John Doe",
        "Priority": "High",
        "Mockup": true,
        "GarmentStyle": "PC61",
        "GarmentColor": "Navy",
        "NOTES": "Rush order - need by Friday"
      },
      description: "Create new art request. Accepts any fields from the ArtRequests table."
    }
  ];

  crudOps.forEach(op => {
    if (!artCategory.item.some(item => item.name === op.name)) {
      const newOp = {
        name: op.name,
        request: {
          method: op.method,
          header: op.body ? [{ key: "Content-Type", value: "application/json" }] : [],
          url: {
            raw: `{{baseUrl}}/${op.path.join('/')}`,
            host: ["{{baseUrl}}"],
            path: op.path
          },
          description: op.description
        },
        response: []
      };
      
      if (op.body) {
        newOp.request.body = {
          mode: "raw",
          raw: JSON.stringify(op.body, null, 2)
        };
      }
      
      artCategory.item.push(newOp);
      console.log(`✅ Added ${op.name} endpoint`);
    }
  });
}

// Ensure we have environment variables
if (!collection.variable) {
  collection.variable = [];
}

// Update/add variables
const requiredVars = [
  { key: "baseUrl", value: "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com", type: "string", description: "Production Heroku URL" },
  { key: "styleNumber", value: "PC54", type: "string" },
  { key: "color", value: "Red", type: "string" },
  { key: "method", value: "DTG", type: "string" },
  { key: "sessionId", value: "test-session-123", type: "string" },
  { key: "id", value: "1", type: "string", description: "Generic ID for CRUD operations" }
];

requiredVars.forEach(reqVar => {
  const existing = collection.variable.find(v => v.key === reqVar.key);
  if (!existing) {
    collection.variable.push(reqVar);
    console.log(`✅ Added variable: ${reqVar.key}`);
  }
});

// Save the updated collection
fs.writeFileSync(collectionPath, JSON.stringify(collection, null, "\t"));
console.log('\n✅ Postman collection updated successfully!');
console.log(`📁 Saved to: ${collectionPath}`);
console.log('\n📝 Remember to:');
console.log('1. Import this collection into Postman');
console.log('2. Test the new endpoints');
console.log('3. Keep it updated when adding new API endpoints');

// Count endpoints
let totalEndpoints = 0;
collection.item.forEach(category => {
  if (category.item && Array.isArray(category.item)) {
    totalEndpoints += category.item.length;
  }
});
console.log(`\n📊 Total endpoints in collection: ${totalEndpoints}`);