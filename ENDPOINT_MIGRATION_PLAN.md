# Endpoint Migration Plan: Server.js to Modular Routes

## Executive Summary

This document provides a comprehensive plan to safely migrate all endpoints from the monolithic `server.js` file to a modular route structure. The migration will be done incrementally with extensive testing at each step to ensure zero downtime and no broken functionality.

**Current State**: Mixed architecture with endpoints in both server.js and modular files, causing conflicts and confusion.

**Goal State**: All endpoints in modular files, organized by domain, with server.js only handling setup and route mounting.

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Migration Strategy](#migration-strategy)
3. [Risk Assessment](#risk-assessment)
4. [Step-by-Step Migration Plan](#step-by-step-migration-plan)
5. [Testing Strategy](#testing-strategy)
6. [Rollback Plan](#rollback-plan)
7. [Post-Migration Checklist](#post-migration-checklist)

## Current State Analysis

### Endpoint Count Summary

**In server.js (main file):**
- Active endpoints: ~53
- Commented endpoints: ~40 (previously migrated)
- Total: ~93 endpoint definitions

**In modular files (src/routes/):**
- cart.js: ~16 endpoints
- inventory.js: ~8 endpoints
- misc.js: ~15 endpoints
- orders.js: ~10 endpoints
- pricing-matrix.js: ~6 endpoints
- pricing.js: ~12 endpoints
- products.js: ~20 endpoints
- quotes.js: ~12 endpoints
- transfers.js: ~5 endpoints

### Critical Findings

1. **Duplicate Endpoints**: Many endpoints exist in both locations
2. **Unique to Modules**: Some endpoints (like `/api/staff-announcements`) only exist in modular files
3. **Active Conflicts**: When both versions exist, Express uses the first one registered
4. **Dashboard Dependencies**: The staff dashboard specifically requires:
   - `/api/order-dashboard` (in orders.js)
   - `/api/staff-announcements` (in misc.js)

### Module Loading Status

Currently, only 2 modules are loaded:
```javascript
const orderRoutes = require('./src/routes/orders');
app.use('/api', orderRoutes);

const miscRoutes = require('./src/routes/misc');
app.use('/api', miscRoutes);
```

Other modules are NOT loaded, meaning their endpoints are inaccessible.

## Migration Strategy

### Guiding Principles

1. **Zero Downtime**: No endpoint should be unavailable during migration
2. **Incremental Changes**: Small, testable changes with commits after each success
3. **Test First**: Test endpoints before AND after each change
4. **Document Everything**: Track what was moved, when, and test results
5. **Easy Rollback**: Each step should be easily reversible

### Migration Approach

We will use a **"Parallel-First, Then Cleanup"** approach:

1. **Phase 1**: Enable ALL modular routes (endpoints work from both locations)
2. **Phase 2**: Test extensively to ensure modular versions work correctly
3. **Phase 3**: Remove duplicates from server.js in small batches
4. **Phase 4**: Clean up and optimize

## Risk Assessment

### High-Risk Areas

1. **Endpoint Behavior Differences**: The modular version might behave differently than the server.js version
   - **Mitigation**: Compare response structures before migration
   
2. **Missing Dependencies**: Modular files might reference code that only exists in server.js
   - **Mitigation**: Test each module independently first
   
3. **Unknown Consumers**: External systems might depend on endpoints we're not aware of
   - **Mitigation**: Monitor error logs during migration, have quick rollback ready

4. **Authentication/Middleware**: Some endpoints might depend on middleware defined in server.js
   - **Mitigation**: Verify middleware is properly applied to modular routes

### Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Endpoint returns different data | Medium | High | Test response structure |
| Missing endpoint | Low | High | Complete inventory first |
| Performance degradation | Low | Medium | Monitor response times |
| Breaking dashboard | Low | Critical | Test dashboard after each step |

## Step-by-Step Migration Plan

### Pre-Migration Setup (30 minutes)

1. **Create Test Suite**
   ```bash
   # Create comprehensive test file
   touch test-all-endpoints-before-migration.js
   ```

2. **Backup Current State**
   ```bash
   # Create backup branch
   git checkout -b backup-before-migration
   git checkout main
   git checkout -b endpoint-migration
   ```

3. **Document Current Endpoints**
   - Run test against ALL endpoints
   - Save results to `migration-logs/baseline-test-results.json`

### Phase 1: Enable All Modular Routes (1 hour)

**Step 1.1: Enable Routes One by One**

```javascript
// In server.js, add after current route declarations:

// --- Pricing Routes ---
const pricingRoutes = require('./src/routes/pricing');
app.use('/api', pricingRoutes);
console.log('✓ Pricing routes loaded');

// Test immediately after adding each one
```

**Order of enabling** (safest to riskiest):
1. ✅ orders.js (already enabled)
2. ✅ misc.js (already enabled)
3. 🔄 pricing.js
4. 🔄 inventory.js
5. 🔄 products.js
6. 🔄 cart.js
7. 🔄 quotes.js
8. 🔄 pricing-matrix.js
9. 🔄 transfers.js

**After each module**:
- Run health check: `curl http://localhost:3002/api/health`
- Test 2-3 endpoints from that module
- Check server logs for errors
- Commit if successful

### Phase 2: Comprehensive Testing (2 hours)

**Step 2.1: Test Every Endpoint**
```bash
node test-all-endpoints-before-migration.js > migration-logs/phase1-test-results.log
```

**Step 2.2: Compare Responses**
For duplicate endpoints, compare responses from both versions:
- Save response from current version
- Temporarily modify route path to test modular version
- Compare JSON structures

**Step 2.3: Load Testing**
Test critical endpoints under load:
- `/api/order-dashboard`
- `/api/inventory`
- `/api/pricing-tiers`

### Phase 3: Remove Duplicates from server.js (4 hours)

**Batch 1: System/Health Endpoints**
- [ ] Comment out `/api/health` (line ~240)
- [ ] Comment out `/status` (line ~250)
- [ ] Comment out `/test` (line ~260)
- Test all three endpoints
- Commit: "migration: batch 1 - system endpoints"

**Batch 2: Pricing Endpoints** (10 endpoints)
- [ ] `/api/pricing-tiers`
- [ ] `/api/embroidery-costs`
- [ ] `/api/dtg-costs`
- [ ] `/api/screenprint-costs`
- [ ] `/api/pricing-rules`
- [ ] `/api/pricing-bundle`
- [ ] `/api/base-item-costs`
- [ ] `/api/size-pricing`
- [ ] `/api/size-upcharges`
- [ ] `/api/size-sort-order`
- Test all pricing endpoints
- Commit: "migration: batch 2 - pricing endpoints"

**Batch 3: Product Endpoints** (15 endpoints)
- [ ] `/api/stylesearch`
- [ ] `/api/product-details`
- [ ] `/api/color-swatches`
- [ ] `/api/all-brands`
- [ ] `/api/all-categories`
- [ ] `/api/all-subcategories`
- [ ] `/api/products-by-brand`
- [ ] `/api/products-by-category`
- [ ] `/api/products-by-subcategory`
- [ ] `/api/products-by-category-subcategory`
- Test product search functionality
- Test dashboard product features
- Commit: "migration: batch 3 - product endpoints"

**Batch 4: Inventory Endpoints** (5 endpoints)
- [ ] `/api/inventory`
- [ ] `/api/size-pricing`
- [ ] `/api/max-prices-by-style`
- Test inventory queries
- Commit: "migration: batch 4 - inventory endpoints"

**Batch 5: Order Management** (8 endpoints)
- [ ] `/api/orders` (GET, POST, PUT, DELETE)
- [ ] `/api/customers` (GET, POST, PUT, DELETE)
- [ ] `/api/order-odbc`
- Test order creation and retrieval
- Commit: "migration: batch 5 - order endpoints"

**Batch 6: Cart Endpoints** (12 endpoints)
- [ ] `/api/cart-sessions` (GET, POST, PUT, DELETE)
- [ ] `/api/cart-items` (GET, POST, PUT, DELETE)
- [ ] `/api/cart-item-sizes` (GET, POST, PUT, DELETE)
- Test cart functionality
- Commit: "migration: batch 6 - cart endpoints"

**Batch 7: Remaining Endpoints**
- [ ] `/api/art-invoices` (GET, POST, PUT, DELETE)
- [ ] `/api/production-schedules`
- [ ] Any other endpoints
- Commit: "migration: batch 7 - remaining endpoints"

### Phase 4: Cleanup and Optimization (1 hour)

1. **Remove Commented Code**
   - Delete all commented endpoint definitions from server.js
   - Keep only server setup, middleware, and route mounting

2. **Organize Route Loading**
   ```javascript
   // Load all routes in a clean, organized way
   const routes = [
     { path: '/api', router: require('./src/routes/cart') },
     { path: '/api', router: require('./src/routes/inventory') },
     // ... etc
   ];
   
   routes.forEach(({ path, router }) => {
     app.use(path, router);
   });
   ```

3. **Update Documentation**
   - Update README.md
   - Update API_DOCUMENTATION.md
   - Create MIGRATION_COMPLETE.md with final state

## Testing Strategy

### Test Levels

1. **Unit Tests** (Each Endpoint)
   - Status code (200, 400, 404, 500)
   - Response structure
   - Data accuracy

2. **Integration Tests**
   - Dashboard functionality
   - Cart-to-order flow
   - Pricing calculations

3. **Load Tests**
   - 100 concurrent requests
   - Response time < 1 second
   - No memory leaks

### Critical Test Scenarios

1. **Dashboard Health Check**
   ```bash
   # These must work after EVERY batch
   curl http://localhost:3002/api/staff-announcements
   curl http://localhost:3002/api/order-dashboard
   curl http://localhost:3002/api/order-dashboard?compareYoY=true
   ```

2. **Order Creation Flow**
   - Create cart session
   - Add items
   - Convert to order
   - Verify in dashboard

3. **Product Search**
   - Search by style number
   - Filter by category
   - Get product details

### Test Automation

Create `test-critical-paths.js`:
```javascript
const criticalEndpoints = [
  '/api/health',
  '/api/order-dashboard',
  '/api/staff-announcements',
  '/api/products-by-category?category=T-Shirts',
  '/api/inventory?styleNumber=PC54',
  '/api/pricing-tiers?method=DTG'
];

// Test each endpoint, measure response time, verify structure
```

## Rollback Plan

### Immediate Rollback (< 5 minutes)

If critical issues occur:
```bash
# Revert last commit
git revert HEAD
node start-server.js

# Or switch branches
git checkout main
node start-server.js
```

### Partial Rollback

If specific module causes issues:
1. Comment out the problematic route import
2. Uncomment those endpoints in server.js
3. Test and commit

### Emergency Contacts

Document who to contact if issues arise:
- Primary developer: [Your name]
- Dashboard owner: [Dashboard team contact]
- On-call support: [Support contact]

## Post-Migration Checklist

### Immediate (Day 1)
- [ ] All endpoints responding correctly
- [ ] Dashboard fully functional
- [ ] No errors in server logs
- [ ] Performance metrics normal

### Week 1
- [ ] Monitor error logs daily
- [ ] Check for any 404 errors
- [ ] Verify no customer complaints
- [ ] Review server memory usage

### Documentation Updates
- [ ] Update API documentation
- [ ] Update developer onboarding guide
- [ ] Create architecture diagram
- [ ] Document lessons learned

### Code Cleanup
- [ ] Remove all commented code
- [ ] Optimize route loading
- [ ] Add route documentation
- [ ] Create endpoint index

## Success Criteria

The migration is considered successful when:

1. ✅ All endpoints respond with correct data
2. ✅ Staff dashboard works without errors
3. ✅ No increase in error rates
4. ✅ Response times remain stable
5. ✅ All tests pass
6. ✅ server.js is under 500 lines (from 6000+)
7. ✅ Clear separation of concerns achieved

## Appendix A: Endpoint Inventory

### Complete Endpoint List

[This would contain the full detailed list of every endpoint, but I'll summarize the structure]

#### Pricing Endpoints (in server.js)
1. GET /api/pricing-tiers - Get pricing tiers by method (line ~1806)
2. GET /api/embroidery-costs - Get embroidery pricing (line ~2193)
3. GET /api/dtg-costs - Get DTG printing costs (line ~2081)
... [complete list]

#### Pricing Endpoints (in src/routes/pricing.js)
1. GET /pricing-tiers - Get pricing tiers by method
2. GET /embroidery-costs - Get embroidery pricing
... [complete list]

## Appendix B: Testing Scripts

[Include actual test scripts that can be used during migration]

## Appendix C: Troubleshooting Guide

Common issues and solutions during migration...

---

**Document Version**: 1.0
**Created**: July 8, 2025
**Author**: Claude (with Erik)
**Confidence Level**: 95% (with this plan, success rate should be very high)