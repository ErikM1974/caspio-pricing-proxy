# ManageOrders PUSH API - Test Scenarios

This document provides step-by-step testing scenarios for the ManageOrders PUSH API integration.

---

## Pre-Testing Checklist

- [ ] Server is running (locally or on Heroku)
- [ ] Environment variables are set (`MANAGEORDERS_USERNAME`, `MANAGEORDERS_PASSWORD`)
- [ ] OnSite ManageOrders integration is enabled
- [ ] OnSite auto-import is enabled

---

## Test 1: Authentication Test

**Purpose:** Verify API credentials are working

**Command:**
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/auth/test
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Authentication successful",
  "tokenExpires": "2025-10-27T11:30:00Z",
  "tokenLength": 1024
}
```

**If Failed:**
- Check environment variables
- Verify credentials with ShopWorks support
- Check network connectivity

---

## Test 2: Minimal Order (Test Order)

**Purpose:** Push simplest possible order to verify basic functionality

**Command:**
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d @examples/push-api/minimal-order.json
```

**Expected Response:**
```json
{
  "success": true,
  "extOrderId": "NWCA-TEST-001",
  "message": "Order successfully pushed to ManageOrders",
  "timestamp": "2025-10-27T10:30:00Z",
  "onsiteImportExpected": "2025-10-27T11:30:00Z"
}
```

**Verify:**
1. Response has `success: true`
2. `extOrderId` is `NWCA-TEST-001`
3. Proceed to Test 3

---

## Test 3: Verify Order Receipt

**Purpose:** Confirm order was received by ManageOrders

**Command:**
```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/verify/NWCA-TEST-001
```

**Expected Response:**
```json
{
  "success": true,
  "found": true,
  "extOrderId": "NWCA-TEST-001",
  "uploadedAt": "2025-10-27",
  "orderData": {
    "ExtOrderID": "NWCA-TEST-001",
    "ContactNameFirst": "Test",
    "ContactNameLast": "Customer"
  }
}
```

**If Not Found:**
- Wait a few seconds and try again
- Order may still be processing
- Check if push was successful in Test 2

---

## Test 4: Complete Order (All Features)

**Purpose:** Test order with all optional fields (designs, payments, notes)

**Command:**
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d @examples/push-api/complete-order.json
```

**Expected Response:**
```json
{
  "success": true,
  "extOrderId": "NWCA-12345",
  "message": "Order successfully pushed to ManageOrders"
}
```

**Verify:**
1. Order created successfully
2. Verify with: `curl .../verify/NWCA-12345`

---

## Test 5: Size Translation

**Purpose:** Test all supported sizes are translated correctly

**Create test file:** `size-test-order.json`
```json
{
  "orderNumber": "SIZE-TEST-001",
  "isTest": true,
  "orderDate": "2025-10-27",
  "customer": {
    "firstName": "Size",
    "lastName": "Test",
    "email": "size@test.com"
  },
  "lineItems": [
    {"partNumber": "TEST", "size": "S", "quantity": 1, "price": 10},
    {"partNumber": "TEST", "size": "M", "quantity": 1, "price": 10},
    {"partNumber": "TEST", "size": "L", "quantity": 1, "price": 10},
    {"partNumber": "TEST", "size": "XL", "quantity": 1, "price": 10},
    {"partNumber": "TEST", "size": "2XL", "quantity": 1, "price": 10},
    {"partNumber": "TEST", "size": "3XL", "quantity": 1, "price": 10},
    {"partNumber": "TEST", "size": "4XL", "quantity": 1, "price": 10},
    {"partNumber": "TEST", "size": "XS", "quantity": 1, "price": 10},
    {"partNumber": "TEST", "size": "OSFA", "quantity": 1, "price": 10}
  ],
  "shipping": {
    "address1": "123 Test St",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101"
  }
}
```

**Command:**
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d @size-test-order.json
```

**Expected:** All sizes accepted without errors

---

## Test 6: Invalid Size (Error Handling)

**Purpose:** Verify error handling for unsupported sizes

**Create test file:** `invalid-size-order.json`
```json
{
  "orderNumber": "INVALID-SIZE-001",
  "isTest": true,
  "orderDate": "2025-10-27",
  "customer": {
    "firstName": "Invalid",
    "lastName": "Size",
    "email": "invalid@test.com"
  },
  "lineItems": [
    {"partNumber": "TEST", "size": "7XL", "quantity": 1, "price": 10}
  ],
  "shipping": {
    "address1": "123 Test St",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101"
  }
}
```

**Command:**
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d @invalid-size-order.json
```

**Expected Response:**
```json
{
  "success": false,
  "error": "Line item 1: Invalid size: \"7XL\" not in size mapping...",
  "message": "Failed to push order to ManageOrders"
}
```

---

## Test 7: Missing Required Fields

**Purpose:** Verify validation of required fields

**Create test file:** `missing-fields-order.json`
```json
{
  "customer": {
    "firstName": "Missing",
    "lastName": "OrderNumber"
  }
}
```

**Command:**
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d @missing-fields-order.json
```

**Expected Response:**
```json
{
  "success": false,
  "error": "orderNumber is required",
  "message": "Failed to push order to ManageOrders"
}
```

---

## Test 8: OnSite Import Verification (After 1 Hour)

**Purpose:** Verify order appears in OnSite after auto-import

**Steps:**

1. **Note the time** you created the test order (Test 2)
2. **Wait for next hourly import** (check "Last Server Import" in OnSite)
3. **Open OnSite** Order Entry
4. **Search for order:** `NWCA-TEST-001`

**Verify in OnSite:**
- [ ] Order exists with ExtOrderID: `NWCA-TEST-001`
- [ ] Customer: #2791
- [ ] Contact Name: Test Customer
- [ ] Contact Email: test@example.com
- [ ] Line Item: TEST-PART, Red, Size M (or LG in OnSite), Qty 1
- [ ] Shipping Address: 123 Test St, Seattle, WA 98101
- [ ] Order is ready for production (not on hold)

**If Order Not Found:**
- Check "Last Server Import" timestamp
- Verify order was pushed successfully
- Check OnSite integration settings (enabled? correct APISource filter?)
- Contact ShopWorks support

---

## Test 9: Production Order (Remove Test Flag)

**Purpose:** Create a real production order (not a test)

**Modify `minimal-order.json`:**
```json
{
  "orderNumber": "PROD-001",
  "isTest": false,  ← Change to false
  ...
}
```

**Command:**
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d @production-order.json
```

**Expected ExtOrderID:** `NWCA-PROD-001` (without "TEST-" prefix)

**Verify in OnSite after import:**
- Order appears as `NWCA-PROD-001`
- Ready for actual production

---

## Test 10: Health Check

**Purpose:** Verify API service is running

**Command:**
```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/push/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "service": "ManageOrders PUSH API",
  "timestamp": "2025-10-27T10:30:00Z",
  "endpoints": {
    "createOrder": "POST /api/manageorders/orders/create",
    "verifyOrder": "GET /api/manageorders/orders/verify/:extOrderId",
    "testAuth": "POST /api/manageorders/auth/test"
  }
}
```

---

## Testing Checklist

After running all tests:

- [ ] Test 1: Authentication successful
- [ ] Test 2: Minimal order pushed
- [ ] Test 3: Order verified in ManageOrders
- [ ] Test 4: Complete order with all features pushed
- [ ] Test 5: All sizes translated correctly
- [ ] Test 6: Invalid size rejected with clear error
- [ ] Test 7: Missing fields rejected with clear error
- [ ] Test 8: Order appeared in OnSite after hourly import
- [ ] Test 9: Production order created (without TEST prefix)
- [ ] Test 10: Health check passed

---

## Common Test Issues

### Issue: 401 Unauthorized
**Cause:** Invalid credentials
**Fix:** Check environment variables, test with `/auth/test`

### Issue: 400 Bad Request
**Cause:** Invalid data format or missing required fields
**Fix:** Check request JSON format, verify all required fields present

### Issue: Order not found in ManageOrders
**Cause:** Order may still be processing
**Fix:** Wait a few seconds and try verification again

### Issue: Order not in OnSite after 1 hour
**Cause:** Auto-import may not be running or filtering incorrectly
**Fix:**
- Check "Last Server Import" timestamp in OnSite
- Verify "Auto Import via Server" is enabled
- Check APISource filter matches "NWCA"
- Contact ShopWorks support

---

## Integration Testing with Your Website

Once API tests pass, integrate with your website:

1. **Test from browser console:**
   ```javascript
   fetch('https://caspio-pricing-proxy.herokuapp.com/api/manageorders/orders/create', {
     method: 'POST',
     headers: {'Content-Type': 'application/json'},
     body: JSON.stringify({
       orderNumber: 'WEB-001',
       orderDate: '2025-10-27',
       customer: {firstName: 'Web', lastName: 'Test', email: 'web@test.com'},
       lineItems: [{partNumber: 'PC54', size: 'M', quantity: 1, price: 10}],
       shipping: {address1: '123 St', city: 'Seattle', state: 'WA', zip: '98101'}
     })
   }).then(r => r.json()).then(console.log);
   ```

2. **Verify response**
3. **Check order in OnSite after 1 hour**
4. **Proceed with full website integration**

---

## Success Criteria

✅ All 10 tests pass
✅ Test orders appear in OnSite
✅ Data maps correctly (customer, line items, shipping)
✅ Sizes translate properly
✅ Error messages are clear and actionable
✅ Ready for production use
