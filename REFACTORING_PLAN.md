# Caspio Pricing Proxy Refactoring Plan

## Overview
This document outlines the step-by-step plan to refactor the caspio-pricing-proxy from a monolithic 6,042-line server.js file into a well-organized modular structure. The refactoring will be done incrementally to ensure zero downtime and no breaking changes.

## Current State Analysis

### Problems:
- **Monolithic server.js**: 6,042 lines containing everything
- **Unused modular files**: 9 route modules created but never connected
- **Mixed responsibilities**: Routes, business logic, utilities all in one file
- **Difficult maintenance**: Finding specific endpoints requires searching thousands of lines
- **No clear organization**: Endpoints scattered without pattern

### Existing Modular Structure (Partially Implemented):
```
src/routes/
├── cart.js          (NOT connected)
├── inventory.js     (NOT connected)
├── misc.js          (NOT connected)
├── orders.js        (NOT connected)
├── pricing-matrix.js (NOT connected)
├── pricing.js       (✓ Connected and working)
├── products.js      (NOT connected)
├── quotes.js        (✓ Connected and working)
├── transfers.js     (NOT connected)
```

## Refactoring Strategy

### Core Principles:
1. **No Breaking Changes**: All endpoints maintain exact same URLs and behavior
2. **Incremental Migration**: Move one module at a time
3. **Test After Each Step**: Verify functionality before proceeding
4. **Maintain Backward Compatibility**: Ensure all existing integrations continue working

## Step-by-Step Implementation Plan

### Phase 1: Preparation and Documentation (Day 1)

#### 1.1 Create Endpoint Inventory
- Document all endpoints currently in server.js
- Note their current line numbers
- Identify which module they should belong to

#### 1.2 Set Up Testing Framework
```bash
# Create test checklist
- Run existing test scripts
- Document current working state
- Create endpoint verification script
```

#### 1.3 Create Backup
```bash
# Backup current working state
cp server.js server.js.backup-YYYY-MM-DD
git commit -m "backup: pre-refactoring snapshot"
```

### Phase 2: Connect Existing Modules (Day 1-2)

#### 2.1 Cart Module
```javascript
// In server.js, add:
const cartRoutes = require('./src/routes/cart');
app.use('/api', cartRoutes);

// Move these endpoints from server.js to cart.js:
- GET /api/cart-sessions
- GET /api/cart-sessions/:id
- POST /api/cart-sessions
- PUT /api/cart-sessions/:id
- DELETE /api/cart-sessions/:id
- GET /api/cart-items
- GET /api/cart-items/:id
- POST /api/cart-items
- PUT /api/cart-items/:id
- DELETE /api/cart-items/:id
- GET /api/cart-item-sizes
- GET /api/cart-item-sizes/:id
- POST /api/cart-item-sizes
- PUT /api/cart-item-sizes/:id
- DELETE /api/cart-item-sizes/:id
```

**Testing after cart migration:**
```bash
node test-scripts/test-endpoints.js
# Specifically test cart endpoints
```

#### 2.2 Orders Module
```javascript
// Move these endpoints:
- GET /api/orders
- GET /api/orders/:id
- POST /api/orders
- PUT /api/orders/:id
- DELETE /api/orders/:id
- GET /api/customers
- GET /api/customers/:id
- POST /api/customers
- PUT /api/customers/:id
- DELETE /api/customers/:id
- GET /api/order-dashboard
- GET /api/order-odbc
```

#### 2.3 Products Module
```javascript
// Move these endpoints:
- GET /api/products/search
- GET /api/products/categories
- GET /api/products/colors
- GET /api/products/base-categories
```

#### 2.4 Continue with Other Modules
- inventory.js
- pricing-matrix.js
- transfers.js
- misc.js

### Phase 3: Create New Modules (Day 2-3)

#### 3.1 Art Invoices Module
Create `src/routes/art-invoices.js`:
```javascript
// Move these endpoints:
- GET /api/art-invoices
- GET /api/art-invoices/:id
- POST /api/art-invoices
- PUT /api/art-invoices/:id
- DELETE /api/art-invoices/:id
```

#### 3.2 Production Schedules Module
Create `src/routes/production-schedules.js`:
```javascript
// Move these endpoints:
- GET /api/production-schedules
```

### Phase 4: Extract Shared Utilities (Day 3)

#### 4.1 Create Common CRUD Utility
Create `src/utils/crud-generator.js`:
```javascript
// Generic CRUD operations that can be reused
function createCrudRoutes(router, tableName, options = {}) {
  // Implementation for standard CRUD operations
}
```

#### 4.2 Standardize Error Handling
Create `src/middleware/error-handler.js`:
```javascript
// Centralized error handling
function errorHandler(err, req, res, next) {
  // Consistent error responses
}
```

### Phase 5: Clean Up Server.js (Day 3-4)

#### 5.1 Final Server.js Structure
```javascript
// server.js should only contain:
// 1. Express setup
// 2. Middleware configuration
// 3. Route mounting
// 4. Server startup

// Target size: ~200 lines
```

#### 5.2 Remove Deprecated Code
- Remove commented-out code
- Remove duplicate functions
- Clean up imports

### Phase 6: Testing and Verification (Day 4)

#### 6.1 Comprehensive Testing
```bash
# Run all test scripts
npm test

# Test each endpoint group
node test-scripts/test-cart.js
node test-scripts/test-orders.js
node test-scripts/test-products.js
# ... etc
```

#### 6.2 Create Endpoint Map
Create `API_ENDPOINT_MAP.md`:
```markdown
# API Endpoint Map
## Cart Endpoints -> src/routes/cart.js
- GET /api/cart-sessions
- POST /api/cart-sessions
...

## Order Endpoints -> src/routes/orders.js
- GET /api/orders
- POST /api/orders
...
```

### Phase 7: Documentation Update (Day 4)

#### 7.1 Update README
- Document new structure
- Update setup instructions
- Add developer guidelines

#### 7.2 Update API Documentation
- Ensure all endpoints are documented
- Add examples for each module

## Testing Strategy

### After Each Module Migration:
1. **Unit Test**: Test the specific endpoints that were moved
2. **Integration Test**: Ensure the module works with others
3. **Regression Test**: Verify nothing else broke
4. **Manual Test**: Use Postman to verify responses

### Test Commands:
```bash
# Quick health check
curl http://localhost:3002/api/health

# Test specific endpoint
node test-scripts/test-endpoints.js --module=cart

# Full regression test
npm test
```

## Rollback Plan

If any issues arise:
1. **Immediate Rollback**: 
   ```bash
   cp server.js.backup-YYYY-MM-DD server.js
   git checkout -- src/routes/
   ```

2. **Partial Rollback**: Revert only the problematic module

3. **Fix Forward**: If issue is minor, fix in place

## Success Criteria

The refactoring is successful when:
- [ ] All endpoints respond with same data as before
- [ ] All tests pass
- [ ] Server.js is under 300 lines
- [ ] Each route module is focused and under 500 lines
- [ ] No breaking changes for API consumers
- [ ] Documentation is updated
- [ ] Team can easily find and modify code

## Timeline

- **Day 1**: Preparation, documentation, start module connections
- **Day 2**: Complete module connections, create new modules
- **Day 3**: Extract utilities, clean up server.js
- **Day 4**: Testing, documentation, deployment prep

## Next Steps

1. Review this plan with the team
2. Schedule refactoring during low-traffic period
3. Set up monitoring to catch any issues
4. Begin with Phase 1

## Notes for Junior Developers

**Remember:**
- Test after EVERY change
- Commit working code frequently
- Ask questions if unsure
- Use version control as safety net
- Focus on one module at a time
- Keep original functionality intact

**Common Pitfalls to Avoid:**
- Don't change endpoint URLs
- Don't modify response formats
- Don't refactor business logic (just move it)
- Don't skip testing steps
- Don't rush - better slow and correct

This refactoring will make our codebase more maintainable, scalable, and developer-friendly without any disruption to our API consumers.