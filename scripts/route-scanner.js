#!/usr/bin/env node

/**
 * Route Scanner for Express.js Applications
 *
 * Automatically extracts API endpoint definitions from Express router files.
 * Parses route handlers to detect methods, paths, query parameters, and descriptions.
 *
 * Usage:
 *   const scanner = new RouteScanner();
 *   const routes = await scanner.scanDirectory('./src/routes');
 */

const fs = require('fs').promises;
const path = require('path');
const colors = require('colors');

class RouteScanner {
  constructor(options = {}) {
    this.basePrefix = options.basePrefix || '/api';
    this.routeFiles = [];
    this.endpoints = [];
  }

  /**
   * Scan a directory for route files
   */
  async scanDirectory(dirPath) {
    console.log(`🔍 Scanning directory: ${dirPath}`.yellow);

    try {
      const files = await fs.readdir(dirPath);
      const jsFiles = files.filter(f => f.endsWith('.js'));

      for (const file of jsFiles) {
        const filePath = path.join(dirPath, file);
        await this.scanFile(filePath);
      }

      console.log(`✅ Scanned ${jsFiles.length} route files`.green);
      console.log(`📊 Found ${this.endpoints.length} total endpoints`.cyan);

      return this.endpoints;
    } catch (error) {
      console.error(`❌ Failed to scan directory:`.red, error.message);
      throw error;
    }
  }

  /**
   * Scan a single route file
   */
  async scanFile(filePath) {
    const fileName = path.basename(filePath);
    console.log(`  📄 Scanning ${fileName}...`.gray);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const routes = this.extractRoutes(content, fileName);

      this.endpoints.push(...routes);
      console.log(`     Found ${routes.length} endpoints`.gray);

    } catch (error) {
      console.error(`  ❌ Failed to scan ${fileName}:`.red, error.message);
    }
  }

  /**
   * Extract route definitions from file content
   */
  extractRoutes(content, fileName) {
    const routes = [];

    // Match router.METHOD(path, ...) patterns
    const routeRegex = /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]\s*,/g;

    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const [fullMatch, method, routePath] = match;
      const lineNumber = content.substring(0, match.index).split('\n').length;

      // Extract the handler function to analyze parameters
      const handlerStart = match.index;
      const handlerEnd = this.findHandlerEnd(content, handlerStart);
      const handlerCode = content.substring(handlerStart, handlerEnd);

      // Extract description from JSDoc or inline comments
      const description = this.extractDescription(content, match.index);

      // Extract query parameters from handler code
      const queryParams = this.extractQueryParams(handlerCode);

      // Extract request body structure (for POST/PUT/PATCH)
      const requestBody = this.extractRequestBody(handlerCode, method);

      // Determine category from filename
      const category = this.categorizeEndpoint(fileName, routePath);

      routes.push({
        method: method.toUpperCase(),
        path: routePath,
        fullPath: this.basePrefix + routePath,
        category: category,
        description: description,
        queryParams: queryParams,
        requestBody: requestBody,
        sourceFile: fileName,
        lineNumber: lineNumber
      });
    }

    return routes;
  }

  /**
   * Find the end of a route handler function
   */
  findHandlerEnd(content, startIndex) {
    let depth = 0;
    let inFunction = false;

    for (let i = startIndex; i < content.length; i++) {
      const char = content[i];

      if (char === '(') {
        depth++;
        inFunction = true;
      } else if (char === ')') {
        depth--;
        if (inFunction && depth === 0) {
          // Find the closing brace of the handler
          let braceDepth = 0;
          for (let j = i; j < content.length; j++) {
            if (content[j] === '{') braceDepth++;
            if (content[j] === '}') {
              braceDepth--;
              if (braceDepth === 0) {
                return j + 1;
              }
            }
          }
          return i + 500; // Fallback: return reasonable chunk
        }
      }
    }

    return startIndex + 500; // Fallback
  }

  /**
   * Extract description from JSDoc or comments above route
   */
  extractDescription(content, routeIndex) {
    const beforeRoute = content.substring(Math.max(0, routeIndex - 500), routeIndex);
    const lines = beforeRoute.split('\n').reverse();

    // Look for JSDoc comment
    const jsdocMatch = beforeRoute.match(/\/\*\*\s*([\s\S]*?)\*\//);
    if (jsdocMatch) {
      const comment = jsdocMatch[1]
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, '').trim())
        .filter(line => !line.startsWith('@'))
        .join(' ')
        .trim();
      if (comment) return comment;
    }

    // Look for single-line comment
    for (const line of lines) {
      const commentMatch = line.match(/\/\/\s*(.+)/);
      if (commentMatch && commentMatch[1].trim()) {
        return commentMatch[1].trim();
      }
      // Stop at empty line or code
      if (line.trim() && !line.includes('//') && !line.includes('/*')) {
        break;
      }
    }

    return '';
  }

  /**
   * Extract query parameters from handler code
   */
  extractQueryParams(handlerCode) {
    const params = new Set();

    // Pattern 1: const { param1, param2 } = req.query
    const destructureMatch = handlerCode.match(/(?:const|let|var)\s*{\s*([^}]+)\s*}\s*=\s*req\.query/);
    if (destructureMatch) {
      const paramsList = destructureMatch[1].split(',').map(p => p.trim());
      paramsList.forEach(param => {
        // Handle renaming: 'q.where': where → q.where
        const renamed = param.match(/['"`]([^'"`]+)['"`]\s*:\s*\w+/);
        if (renamed) {
          params.add(renamed[1]);
        } else {
          params.add(param);
        }
      });
    }

    // Pattern 2: req.query.param or req.query['param']
    const directAccessRegex = /req\.query(?:\[['"`]([^'"`]+)['"`]\]|\.(\w+))/g;
    let match;
    while ((match = directAccessRegex.exec(handlerCode)) !== null) {
      const param = match[1] || match[2];
      if (param) params.add(param);
    }

    return Array.from(params).map(name => ({
      key: name,
      value: '',
      description: this.guessParamDescription(name),
      disabled: this.isOptionalParam(handlerCode, name)
    }));
  }

  /**
   * Extract request body structure from handler code
   */
  extractRequestBody(handlerCode, method) {
    if (!['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      return null;
    }

    const bodyFields = new Set();

    // Pattern: req.body.field or req.body['field']
    const bodyAccessRegex = /req\.body(?:\[['"`]([^'"`]+)['"`]\]|\.(\w+))/g;
    let match;
    while ((match = bodyAccessRegex.exec(handlerCode)) !== null) {
      const field = match[1] || match[2];
      if (field) bodyFields.add(field);
    }

    if (bodyFields.size === 0) return null;

    // Create example body object
    const exampleBody = {};
    bodyFields.forEach(field => {
      exampleBody[field] = this.guessFieldValue(field);
    });

    return {
      mode: 'raw',
      raw: JSON.stringify(exampleBody, null, 2)
    };
  }

  /**
   * Guess parameter description from name
   */
  guessParamDescription(paramName) {
    const descriptions = {
      'q.where': 'Filter records using SQL-like WHERE clause',
      'q.orderBy': 'Sort order (e.g., "Field ASC" or "Field DESC")',
      'q.limit': 'Maximum number of records to return (1-1000)',
      'q.pageNumber': 'Page number for pagination',
      'q.pageSize': 'Number of records per page',
      'q.select': 'Comma-separated list of fields to return',
      'q.groupBy': 'Fields to group by',
      'term': 'Search term',
      'styleNumber': 'Product style number',
      'color': 'Product color',
      'brand': 'Brand name',
      'category': 'Category name',
      'status': 'Status filter',
      'limit': 'Maximum results',
      'page': 'Page number',
      'sort': 'Sort order',
      'id': 'Record ID',
      'sessionId': 'Session identifier',
      'includeDetails': 'Include detailed information',
      'includeFacets': 'Include filter facet counts',
      'days': 'Number of days',
      'compareYoY': 'Include year-over-year comparison'
    };

    return descriptions[paramName] || `${paramName} parameter`;
  }

  /**
   * Guess if parameter is optional based on usage
   */
  isOptionalParam(handlerCode, paramName) {
    // Escape special regex characters in param name
    const escapedName = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Check if there's a default value or null check
    const patterns = [
      new RegExp(`${escapedName}\\s*[|]{2}\\s*['"\`]`), // param || 'default'
      new RegExp(`${escapedName}\\s*\\?\\s*`),           // param?.something
      new RegExp(`if\\s*\\([^)]*${escapedName}`),        // if (param)
      new RegExp(`${escapedName}\\s*=\\s*.*\\|\\|`)      // param = something || default
    ];

    return patterns.some(pattern => {
      try {
        return pattern.test(handlerCode);
      } catch (error) {
        return false; // If regex fails, assume not optional
      }
    });
  }

  /**
   * Guess example value for body field
   */
  guessFieldValue(fieldName) {
    const lower = fieldName.toLowerCase();

    if (lower.includes('date')) return '2025-01-15';
    if (lower.includes('email')) return 'user@example.com';
    if (lower.includes('phone')) return '555-1234';
    if (lower.includes('price') || lower.includes('cost')) return 10.99;
    if (lower.includes('quantity') || lower.includes('count')) return 1;
    if (lower.includes('status')) return 'Active';
    if (lower.includes('name')) return 'Example Name';
    if (lower.includes('description') || lower.includes('notes')) return 'Description here';
    if (lower.includes('is') || lower.includes('has')) return true;
    if (lower.includes('id')) return 1;

    return 'value';
  }

  /**
   * Categorize endpoint based on filename and path
   */
  categorizeEndpoint(fileName, routePath) {
    const categories = {
      'products.js': '🛍️ Product Search',
      'pricing.js': '💰 Pricing',
      'cart.js': '🛒 Cart Management',
      'orders.js': '📦 Orders',
      'inventory.js': '📊 Inventory',
      'quotes.js': '💬 Quotes',
      'art.js': '🎨 Art & Invoicing',
      'transfers.js': '🎨 Transfers',
      'misc.js': '🔧 Utilities',
      'pricing-matrix.js': '💰 Pricing Matrix',
      'production-schedules.js': '📅 Production',
      'files.js': '📎 File Management',
      'files-simple.js': '📎 File Management',
      'dtg.js': '🖨️ DTG Printing'
    };

    return categories[fileName] || '📋 General';
  }

  /**
   * Generate summary report
   */
  generateReport() {
    const byCategory = {};
    const byMethod = {};

    this.endpoints.forEach(endpoint => {
      // Count by category
      if (!byCategory[endpoint.category]) {
        byCategory[endpoint.category] = 0;
      }
      byCategory[endpoint.category]++;

      // Count by method
      if (!byMethod[endpoint.method]) {
        byMethod[endpoint.method] = 0;
      }
      byMethod[endpoint.method]++;
    });

    console.log('\n📊 Route Scan Summary'.cyan.bold);
    console.log('='.repeat(50).gray);

    console.log('\nBy Category:'.white.bold);
    Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        console.log(`  ${cat}: ${count} endpoints`.white);
      });

    console.log('\nBy Method:'.white.bold);
    Object.entries(byMethod)
      .sort((a, b) => b[1] - a[1])
      .forEach(([method, count]) => {
        const color = {
          'GET': 'green',
          'POST': 'yellow',
          'PUT': 'blue',
          'DELETE': 'red',
          'PATCH': 'magenta'
        }[method] || 'white';
        console.log(`  ${method}: ${count} endpoints`[color]);
      });

    console.log(`\n📈 Total: ${this.endpoints.length} endpoints`.green.bold);
    console.log('='.repeat(50).gray + '\n');
  }

  /**
   * Export endpoints to JSON
   */
  async exportToJson(outputPath) {
    const data = {
      scannedAt: new Date().toISOString(),
      totalEndpoints: this.endpoints.length,
      endpoints: this.endpoints
    };

    await fs.writeFile(outputPath, JSON.stringify(data, null, 2));
    console.log(`💾 Exported to ${outputPath}`.green);
  }
}

// CLI usage
if (require.main === module) {
  async function main() {
    const scanner = new RouteScanner({ basePrefix: '/api' });

    const routesDir = path.join(__dirname, '../src/routes');
    const endpoints = await scanner.scanDirectory(routesDir);

    scanner.generateReport();

    // Export to JSON for use by other scripts
    const outputPath = path.join(__dirname, '../.cache/scanned-routes.json');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await scanner.exportToJson(outputPath);

    console.log('✅ Route scan complete!\n'.green.bold);
  }

  main().catch(error => {
    console.error('❌ Route scanner failed:'.red, error.message);
    process.exit(1);
  });
}

module.exports = RouteScanner;
