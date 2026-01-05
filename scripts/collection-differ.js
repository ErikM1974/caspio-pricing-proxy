#!/usr/bin/env node

/**
 * Postman Collection Differ
 *
 * Intelligently compares existing Postman collection with auto-generated collection.
 * Preserves manual customizations while updating from scanned routes.
 *
 * Features:
 * - Detects new, updated, and removed endpoints
 * - Preserves custom descriptions and examples
 * - Merges collections intelligently
 *
 * Usage:
 *   const differ = new CollectionDiffer();
 *   const merged = differ.merge(existingCollection, generatedCollection);
 */

const fs = require('fs').promises;
const path = require('path');
const colors = require('colors');

class CollectionDiffer {
  constructor(options = {}) {
    this.preserveDescriptions = options.preserveDescriptions !== false;
    this.preserveExamples = options.preserveExamples !== false;
    this.preserveQueryValues = options.preserveQueryValues !== false;
  }

  /**
   * Merge existing collection with generated collection
   */
  merge(existing, generated) {
    console.log('🔄 Merging collections...'.yellow);

    const merged = {
      info: {
        ...generated.info,
        _postman_id: existing.info?._postman_id // Preserve Postman ID
      },
      item: this.mergeCategories(existing.item || [], generated.item),
      variable: this.mergeVariables(existing.variable || [], generated.variable)
    };

    const stats = this.generateMergeStats(existing, generated, merged);
    this.printMergeStats(stats);

    return merged;
  }

  /**
   * Merge category folders
   */
  mergeCategories(existingCategories, generatedCategories) {
    const mergedCategories = [];
    const processedCategories = new Set();

    // Process each generated category
    generatedCategories.forEach(genCat => {
      const existingCat = existingCategories.find(cat => cat.name === genCat.name);

      if (existingCat) {
        // Merge existing category with generated
        mergedCategories.push({
          name: genCat.name,
          description: this.preserveDescriptions && existingCat.description
            ? existingCat.description
            : genCat.description,
          item: this.mergeEndpoints(existingCat.item || [], genCat.item)
        });
      } else {
        // New category - use generated
        mergedCategories.push(genCat);
      }

      processedCategories.add(genCat.name);
    });

    // Add existing categories not in generated (preserve manual additions)
    existingCategories.forEach(existingCat => {
      if (!processedCategories.has(existingCat.name)) {
        console.log(`  ℹ️  Preserving manual category: ${existingCat.name}`.cyan);
        mergedCategories.push(existingCat);
      }
    });

    return mergedCategories;
  }

  /**
   * Merge endpoints within a category
   */
  mergeEndpoints(existingEndpoints, generatedEndpoints) {
    const mergedEndpoints = [];
    const processedEndpoints = new Set();

    // Process each generated endpoint
    generatedEndpoints.forEach(genEndpoint => {
      const existingEndpoint = this.findMatchingEndpoint(existingEndpoints, genEndpoint);

      if (existingEndpoint) {
        // Merge existing with generated
        mergedEndpoints.push(this.mergeEndpoint(existingEndpoint, genEndpoint));
      } else {
        // New endpoint - use generated
        mergedEndpoints.push(genEndpoint);
        console.log(`  ✨ New endpoint: ${genEndpoint.request.method} ${this.getEndpointPath(genEndpoint)}`.green);
      }

      processedEndpoints.add(this.getEndpointKey(genEndpoint));
    });

    // Check for endpoints that exist but weren't generated (might be removed from code)
    existingEndpoints.forEach(existingEndpoint => {
      const key = this.getEndpointKey(existingEndpoint);
      if (!processedEndpoints.has(key)) {
        console.log(`  ⚠️  Endpoint in Postman but not in code: ${existingEndpoint.request.method} ${this.getEndpointPath(existingEndpoint)}`.yellow);
        // Still include it (don't auto-delete manual additions)
        mergedEndpoints.push(existingEndpoint);
      }
    });

    return mergedEndpoints;
  }

  /**
   * Merge a single endpoint
   */
  mergeEndpoint(existing, generated) {
    return {
      name: existing.name, // Preserve custom names
      request: {
        method: generated.request.method,
        header: generated.request.header,
        url: this.mergeUrl(existing.request.url, generated.request.url),
        description: this.preserveDescriptions && existing.request.description
          ? existing.request.description
          : generated.request.description,
        body: generated.request.body // Use generated body structure
      },
      response: existing.response || [] // Preserve example responses
    };
  }

  /**
   * Merge URL objects, preserving custom query parameter values
   */
  mergeUrl(existingUrl, generatedUrl) {
    if (!this.preserveQueryValues || !existingUrl || !existingUrl.query) {
      return generatedUrl;
    }

    // Merge query parameters
    const mergedQuery = (generatedUrl.query || []).map(genParam => {
      const existingParam = (existingUrl.query || []).find(p => p.key === genParam.key);

      if (existingParam) {
        // Preserve custom values and disabled state
        return {
          ...genParam,
          value: existingParam.value || genParam.value,
          disabled: existingParam.disabled !== undefined ? existingParam.disabled : genParam.disabled
        };
      }

      return genParam;
    });

    // Rebuild raw URL
    const queryString = mergedQuery
      .filter(q => !q.disabled)
      .map(q => `${q.key}=${q.value || ''}`)
      .join('&');

    const pathString = (generatedUrl.path || []).join('/');
    const rawUrl = `{{baseUrl}}/${pathString}${queryString ? '?' + queryString : ''}`;

    return {
      ...generatedUrl,
      raw: rawUrl,
      query: mergedQuery.length > 0 ? mergedQuery : undefined
    };
  }

  /**
   * Merge collection variables
   */
  mergeVariables(existingVars, generatedVars) {
    const merged = [...generatedVars];
    const generatedKeys = new Set(generatedVars.map(v => v.key));

    // Preserve existing variables not in generated
    existingVars.forEach(existingVar => {
      if (!generatedKeys.has(existingVar.key)) {
        console.log(`  ℹ️  Preserving custom variable: ${existingVar.key}`.cyan);
        merged.push(existingVar);
      } else {
        // Update value from existing if present
        const genIndex = merged.findIndex(v => v.key === existingVar.key);
        if (genIndex >= 0 && existingVar.value) {
          merged[genIndex].value = existingVar.value;
        }
      }
    });

    return merged;
  }

  /**
   * Find matching endpoint in existing collection
   */
  findMatchingEndpoint(existingEndpoints, generatedEndpoint) {
    const genPath = this.getEndpointPath(generatedEndpoint);
    const genMethod = generatedEndpoint.request.method;

    return existingEndpoints.find(endpoint => {
      const existPath = this.getEndpointPath(endpoint);
      const existMethod = endpoint.request.method;

      return existMethod === genMethod && existPath === genPath;
    });
  }

  /**
   * Get endpoint path from URL
   */
  getEndpointPath(endpoint) {
    // Guard against malformed endpoints
    if (!endpoint || !endpoint.request || !endpoint.request.url) {
      return '';
    }

    if (endpoint.request.url.path) {
      return '/' + endpoint.request.url.path.join('/');
    }
    if (endpoint.request.url.raw) {
      const match = endpoint.request.url.raw.match(/\/api[^?]*/);
      return match ? match[0] : '';
    }
    return '';
  }

  /**
   * Get unique key for endpoint
   */
  getEndpointKey(endpoint) {
    if (!endpoint || !endpoint.request) {
      return 'INVALID:ENDPOINT';
    }
    const method = endpoint.request.method || 'GET';
    return `${method}:${this.getEndpointPath(endpoint)}`;
  }

  /**
   * Generate merge statistics
   */
  generateMergeStats(existing, generated, merged) {
    const existingEndpoints = this.countEndpoints(existing);
    const generatedEndpoints = this.countEndpoints(generated);
    const mergedEndpoints = this.countEndpoints(merged);

    const existingKeys = new Set(this.getAllEndpointKeys(existing));
    const generatedKeys = new Set(this.getAllEndpointKeys(generated));

    const newEndpoints = [...generatedKeys].filter(k => !existingKeys.has(k));
    const removedEndpoints = [...existingKeys].filter(k => !generatedKeys.has(k));
    const updatedEndpoints = [...generatedKeys].filter(k => existingKeys.has(k));

    return {
      existingTotal: existingEndpoints,
      generatedTotal: generatedEndpoints,
      mergedTotal: mergedEndpoints,
      newCount: newEndpoints.length,
      removedCount: removedEndpoints.length,
      updatedCount: updatedEndpoints.length,
      newEndpoints,
      removedEndpoints
    };
  }

  /**
   * Count total endpoints in collection
   */
  countEndpoints(collection) {
    if (!collection || !collection.item) return 0;

    return collection.item.reduce((total, category) => {
      return total + (category.item ? category.item.length : 0);
    }, 0);
  }

  /**
   * Get all endpoint keys from collection
   */
  getAllEndpointKeys(collection) {
    if (!collection || !collection.item) return [];

    const keys = [];
    collection.item.forEach(category => {
      if (category.item) {
        category.item.forEach(endpoint => {
          keys.push(this.getEndpointKey(endpoint));
        });
      }
    });
    return keys;
  }

  /**
   * Print merge statistics
   */
  printMergeStats(stats) {
    console.log('\n📊 Merge Statistics'.cyan.bold);
    console.log('='.repeat(50).gray);

    console.log(`\n📥 Existing collection: ${stats.existingTotal} endpoints`.white);
    console.log(`🏗️  Generated collection: ${stats.generatedTotal} endpoints`.white);
    console.log(`📤 Merged collection: ${stats.mergedTotal} endpoints`.green.bold);

    console.log(`\n✨ New endpoints: ${stats.newCount}`.green);
    console.log(`🔄 Updated endpoints: ${stats.updatedCount}`.cyan);
    console.log(`⚠️  Not in code (preserved): ${stats.removedCount}`.yellow);

    console.log('\n' + '='.repeat(50).gray + '\n');
  }

  /**
   * Export merged collection
   */
  async exportToFile(collection, outputPath) {
    await fs.writeFile(outputPath, JSON.stringify(collection, null, '\t'));
    console.log(`💾 Exported merged collection to ${outputPath}`.green);
  }
}

// CLI usage
if (require.main === module) {
  async function main() {
    // Load existing collection
    const existingPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.json');
    let existing;
    try {
      existing = JSON.parse(await fs.readFile(existingPath, 'utf8'));
      console.log(`📥 Loaded existing collection: ${existing.info.name}`.cyan);
    } catch (error) {
      console.log(`⚠️  No existing collection found, will use generated only`.yellow);
      existing = { item: [], variable: [] };
    }

    // Load generated collection
    const generatedPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.AUTO.json');
    const generated = JSON.parse(await fs.readFile(generatedPath, 'utf8'));
    console.log(`📥 Loaded generated collection: ${generated.info.name}\n`.cyan);

    // Merge collections
    const differ = new CollectionDiffer({
      preserveDescriptions: true,
      preserveExamples: true,
      preserveQueryValues: true
    });

    const merged = differ.merge(existing, generated);

    // Export merged collection
    const outputPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.MERGED.json');
    await differ.exportToFile(merged, outputPath);

    console.log('✅ Collection merge complete!\n'.green.bold);
  }

  main().catch(error => {
    console.error('❌ Collection merge failed:'.red, error.message);
    console.error(error.stack);
    process.exit(1);
  });
}

module.exports = CollectionDiffer;
