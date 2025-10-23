#!/usr/bin/env node

/**
 * Postman Collection Generator
 *
 * Converts scanned Express routes into Postman collection format.
 * Generates proper Postman endpoint structures from route metadata.
 *
 * Usage:
 *   const generator = new PostmanGenerator();
 *   const collection = generator.generateCollection(routes);
 */

const fs = require('fs').promises;
const path = require('path');
const colors = require('colors');

class PostmanGenerator {
  constructor(options = {}) {
    this.collectionName = options.collectionName || 'NWCA Production API - Complete';
    this.baseUrl = options.baseUrl || '{{baseUrl}}';
    this.description = options.description || 'Complete API collection for Northwest Custom Apparel';
  }

  /**
   * Generate a complete Postman collection from scanned routes
   */
  generateCollection(routes) {
    console.log(`🏗️  Generating Postman collection...`.yellow);

    // Group routes by category
    const groupedRoutes = this.groupByCategory(routes);

    // Build collection structure
    const collection = {
      info: {
        name: this.collectionName,
        description: this.description,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: this.generateCategories(groupedRoutes),
      variable: this.generateVariables(routes)
    };

    console.log(`✅ Generated collection with ${routes.length} endpoints`.green);
    return collection;
  }

  /**
   * Group routes by category
   */
  groupByCategory(routes) {
    const grouped = {};

    routes.forEach(route => {
      const category = route.category || '📋 General';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(route);
    });

    return grouped;
  }

  /**
   * Generate category folders
   */
  generateCategories(groupedRoutes) {
    const categories = [];

    // Sort categories by importance
    const categoryOrder = [
      '🛍️ Product Search',
      '💰 Pricing',
      '💰 Pricing Matrix',
      '🛒 Cart Management',
      '📦 Orders',
      '💬 Quotes',
      '📊 Inventory',
      '🎨 Art & Invoicing',
      '🎨 Transfers',
      '📅 Production',
      '📎 File Management',
      '🖨️ DTG Printing',
      '🔧 Utilities'
    ];

    // Add ordered categories
    categoryOrder.forEach(categoryName => {
      if (groupedRoutes[categoryName]) {
        categories.push(this.generateCategory(categoryName, groupedRoutes[categoryName]));
      }
    });

    // Add any remaining categories not in order
    Object.entries(groupedRoutes).forEach(([categoryName, routes]) => {
      if (!categoryOrder.includes(categoryName)) {
        categories.push(this.generateCategory(categoryName, routes));
      }
    });

    return categories;
  }

  /**
   * Generate a single category folder
   */
  generateCategory(name, routes) {
    return {
      name: name,
      item: routes.map(route => this.generateEndpoint(route)),
      description: this.getCategoryDescription(name)
    };
  }

  /**
   * Generate description for category
   */
  getCategoryDescription(categoryName) {
    const descriptions = {
      '🛍️ Product Search': 'Search and browse products with advanced filtering',
      '💰 Pricing': 'Pricing tiers, costs, and rules',
      '💰 Pricing Matrix': 'Pricing matrix management',
      '🛒 Cart Management': 'Shopping cart sessions, items, and sizes',
      '📦 Orders': 'Order management and tracking',
      '💬 Quotes': 'Quote analytics, items, and sessions',
      '📊 Inventory': 'Inventory levels and availability',
      '🎨 Art & Invoicing': 'Art requests, invoices, and design notes',
      '🎨 Transfers': 'Transfer printing pricing',
      '📅 Production': 'Production schedules and tracking',
      '📎 File Management': 'File upload, download, and management',
      '🖨️ DTG Printing': 'Direct-to-garment printing services',
      '🔧 Utilities': 'Utility endpoints and helpers'
    };

    return descriptions[categoryName] || '';
  }

  /**
   * Generate a single endpoint
   */
  generateEndpoint(route) {
    const endpoint = {
      name: this.generateEndpointName(route),
      request: {
        method: route.method,
        header: this.generateHeaders(route),
        url: this.generateUrl(route),
        description: route.description || this.generateDefaultDescription(route)
      },
      response: []
    };

    // Add body for POST/PUT/PATCH
    if (route.requestBody) {
      endpoint.request.body = route.requestBody;
    }

    return endpoint;
  }

  /**
   * Generate endpoint name from route
   */
  generateEndpointName(route) {
    // Convert path to readable name
    // /products/search → Search Products
    // /cart-items → Get Cart Items
    // /artrequests/:id → Get Art Request

    const pathParts = route.path
      .split('/')
      .filter(p => p && !p.startsWith(':'))
      .map(part => {
        // Convert kebab-case to Title Case
        return part
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
      });

    const method = route.method.toLowerCase();
    let verb = '';

    if (method === 'get') {
      if (route.path.includes('/:id')) verb = 'Get Single';
      else verb = 'Get';
    } else if (method === 'post') {
      verb = 'Create';
    } else if (method === 'put') {
      verb = 'Update';
    } else if (method === 'delete') {
      verb = 'Delete';
    } else if (method === 'patch') {
      verb = 'Patch';
    }

    const name = pathParts.join(' ');
    return `${verb} ${name}`.trim() || route.path;
  }

  /**
   * Generate default description if none provided
   */
  generateDefaultDescription(route) {
    const method = route.method.toLowerCase();
    const resource = route.path.split('/').filter(p => p && !p.startsWith(':')).pop();

    if (method === 'get' && route.path.includes('/:id')) {
      return `Retrieve a single ${resource} by ID`;
    } else if (method === 'get') {
      return `Retrieve ${resource} with optional filtering and sorting`;
    } else if (method === 'post') {
      return `Create a new ${resource} record`;
    } else if (method === 'put') {
      return `Update an existing ${resource} record`;
    } else if (method === 'delete') {
      return `Delete a ${resource} record`;
    }

    return `${route.method} ${route.path}`;
  }

  /**
   * Generate headers for endpoint
   */
  generateHeaders(route) {
    const headers = [];

    if (route.requestBody) {
      headers.push({
        key: 'Content-Type',
        value: 'application/json'
      });
    }

    return headers;
  }

  /**
   * Generate URL object for endpoint
   */
  generateUrl(route) {
    // Build query parameters
    const query = route.queryParams || [];

    // Build raw URL
    const queryString = query
      .filter(q => !q.disabled)
      .map(q => `${q.key}=${q.value || ''}`)
      .join('&');

    const rawUrl = `${this.baseUrl}${route.fullPath}${queryString ? '?' + queryString : ''}`;

    // Build path array
    const pathArray = route.fullPath
      .split('/')
      .filter(p => p);

    return {
      raw: rawUrl,
      host: [this.baseUrl],
      path: pathArray,
      query: query.length > 0 ? query : undefined
    };
  }

  /**
   * Generate collection variables
   */
  generateVariables(routes) {
    const variables = [
      {
        key: 'baseUrl',
        value: 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com',
        type: 'string',
        description: 'Production Heroku URL'
      }
    ];

    // Extract common variables from routes
    const variableSet = new Set();

    routes.forEach(route => {
      // Check for path parameters
      const pathParams = route.path.match(/:(\w+)/g);
      if (pathParams) {
        pathParams.forEach(param => {
          variableSet.add(param.replace(':', ''));
        });
      }
    });

    // Add common variables
    const commonVars = {
      id: { value: '1', type: 'string', description: 'Generic ID for CRUD operations' },
      styleNumber: { value: 'PC54', type: 'string', description: 'Product style number' },
      color: { value: 'Red', type: 'string', description: 'Product color' },
      sessionId: { value: 'test-session-123', type: 'string', description: 'Session identifier' },
      externalKey: { value: 'example-key', type: 'string', description: 'External file key' }
    };

    variableSet.forEach(varName => {
      if (commonVars[varName]) {
        variables.push({
          key: varName,
          ...commonVars[varName]
        });
      } else {
        variables.push({
          key: varName,
          value: 'value',
          type: 'string'
        });
      }
    });

    return variables;
  }

  /**
   * Export collection to JSON file
   */
  async exportToFile(collection, outputPath) {
    await fs.writeFile(outputPath, JSON.stringify(collection, null, '\t'));
    console.log(`💾 Exported collection to ${outputPath}`.green);
  }

  /**
   * Generate report comparing scanned routes to generated endpoints
   */
  generateReport(routes, collection) {
    console.log('\n📊 Postman Generation Report'.cyan.bold);
    console.log('='.repeat(50).gray);

    const totalEndpoints = routes.length;
    const totalCategories = collection.item.length;

    console.log(`\n✅ Generated ${totalEndpoints} endpoints`.green);
    console.log(`📁 Organized into ${totalCategories} categories`.cyan);

    console.log('\nCategories:'.white.bold);
    collection.item.forEach(category => {
      console.log(`  ${category.name}: ${category.item.length} endpoints`.white);
    });

    console.log('\n' + '='.repeat(50).gray + '\n');
  }
}

// CLI usage
if (require.main === module) {
  async function main() {
    // Load scanned routes
    const scannedPath = path.join(__dirname, '../.cache/scanned-routes.json');
    const scannedData = JSON.parse(await fs.readFile(scannedPath, 'utf8'));

    console.log(`📥 Loaded ${scannedData.totalEndpoints} scanned routes\n`.cyan);

    // Generate collection
    const generator = new PostmanGenerator();
    const collection = generator.generateCollection(scannedData.endpoints);

    // Export to file
    const outputPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.AUTO.json');
    await generator.exportToFile(collection, outputPath);

    // Generate report
    generator.generateReport(scannedData.endpoints, collection);

    console.log('✅ Postman collection generation complete!\n'.green.bold);
  }

  main().catch(error => {
    console.error('❌ Postman generation failed:'.red, error.message);
    process.exit(1);
  });
}

module.exports = PostmanGenerator;
