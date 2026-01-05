# Answers for Claude Pricing - Sample Order Implementation

**Date:** October 27, 2025
**From:** Claude Code (caspio-pricing-proxy)
**To:** Claude Pricing (webstore implementation)
**Re:** Sample Order Checkout Configuration

---

## Quick Summary

Here are the specific answers to your 6 questions, based on the existing ManageOrders PUSH API configuration:

| Question | Answer |
|----------|--------|
| **Order Type ID** | Use **6** (current web order type) |
| **Order Number Format** | `SAMPLE-MMDD-sequence` (e.g., `SAMPLE-1027-1`) |
| **Customer Fields** | First Name, Last Name, Email, Phone, Company (optional), Shipping Address |
| **OSFA Size Column** | **Other XXXL** column, no modifier |
| **Production Notes** | `"FREE SAMPLE - Top Sellers Showcase - [Company Name]"` |
| **Email Notifications** | **NEEDS INPUT FROM ERIK** (see question 6 below) |

---

## Detailed Answers

### 1. Order Type ID for Samples ✅

**Answer:** Use **Order Type ID: 6**

**Why:** This is your current web order type configured in OnSite ManageOrders settings:

```
From: Utilities > Company Setup > ManageOrders.com Settings
Supplemental Settings:
  - Order Type ID: 6
```

**Important Notes:**
- Order Type ID 6 is already configured for web orders from ManageOrders
- Using the same type keeps all web orders (regular + samples) in one category
- Production team already knows Order Type 6 = web orders
- No need to create a new order type or change OnSite configuration

**If you want a separate order type for samples:**
- You would need Erik to create a new Order Type in OnSite (e.g., "Web Samples")
- Get the new Order Type ID
- Then use that ID in the API call

**Recommendation:** Start with Order Type 6, use production notes to distinguish samples.

---

### 2. Order Number Format ✅

**Answer:** Use `SAMPLE-MMDD-sequence`

**Format:** `SAMPLE-{month}{day}-{sequence}`

**Examples:**
- `SAMPLE-1027-1` (First sample on Oct 27)
- `SAMPLE-1027-2` (Second sample on Oct 27)
- `SAMPLE-1028-1` (First sample on Oct 28)

**Why This Format:**
- ✅ Matches your existing test order pattern (`NWCA-TEST-xxx`)
- ✅ Clearly identifies sample orders at a glance
- ✅ Date component helps with tracking/organizing
- ✅ Sequence prevents duplicates on same day
- ✅ Searches easily in OnSite: "SAMPLE-1027*"

**Generated ExtOrderID:**
```
Your order number: SAMPLE-1027-1
Becomes in OnSite: NWCA-SAMPLE-1027-1
```

**Alternative if shorter preferred:**
```
Format: SMPL-MMDD-seq
Example: SMPL-1027-1
ExtOrderID: NWCA-SMPL-1027-1
```

**Implementation:**
```javascript
// Generate sample order number
const now = new Date();
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');
const sequence = await getNextSequenceForDate(month, day); // Your DB function

const orderNumber = `SAMPLE-${month}${day}-${sequence}`;
// Result: SAMPLE-1027-1
```

---

### 3. Customer Contact Information Storage ✅

**Answer:** Collect these fields in your checkout form:

**Required Fields:**
- ✅ **First Name** - `customer.firstName`
- ✅ **Last Name** - `customer.lastName`
- ✅ **Email** - `customer.email`
- ✅ **Phone** - `customer.phone`

**Optional Fields:**
- ✅ **Company Name** - `customer.company` (optional, but recommended)
- ✅ **Full Shipping Address** - Required for shipping samples
  - `shipping.address1` (Required)
  - `shipping.address2` (Optional - Suite/Apt)
  - `shipping.city` (Required)
  - `shipping.state` (Required)
  - `shipping.zip` (Required)
  - `shipping.country` (Default: "USA")

**Billing Address:**
❌ **No separate billing address needed** - Samples are free, no payment processing
- Just use shipping address
- No payment fields required

**Why These Fields:**
- All orders in ManageOrders go to **Customer #2791**
- Actual customer info stored in **Contact fields** (FirstName, LastName, Email, Phone)
- Company name goes to shipping company field
- This matches your existing configuration

**Checkout Form Example:**
```html
<form id="sampleCheckout">
  <!-- Customer Info -->
  <input name="firstName" placeholder="First Name" required>
  <input name="lastName" placeholder="Last Name" required>
  <input name="email" type="email" placeholder="Email" required>
  <input name="phone" type="tel" placeholder="Phone" required>
  <input name="company" placeholder="Company Name (optional)">

  <!-- Shipping Address -->
  <input name="address1" placeholder="Street Address" required>
  <input name="address2" placeholder="Apt/Suite (optional)">
  <input name="city" placeholder="City" required>
  <select name="state" required><!-- US States --></select>
  <input name="zip" placeholder="ZIP Code" required>
</form>
```

**JSON Format for API:**
```json
{
  "orderNumber": "SAMPLE-1027-1",
  "orderDate": "2025-10-27",
  "customer": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "360-555-1234",
    "company": "ABC Company"
  },
  "shipping": {
    "company": "ABC Company",
    "address1": "123 Main St",
    "address2": "Suite 100",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101",
    "country": "USA"
  }
}
```

---

### 4. Size Column Mapping for "One Size" (OSFA) ✅

**Answer:** Use **Other XXXL** column with **no modifier**

**From the size translation table:**

| Webstore Size | OnSite Size | OnSite Column | Modifier |
|---------------|-------------|---------------|----------|
| OSFA, One Size | OSFA | **Other XXXL** | - (none) |

**What This Means:**
- For caps, bags, beanies, and other OSFA items
- Use size: `"OSFA"` in your API call
- The proxy will map it to **Other XXXL** column
- No modifier needed (unlike 3XL, 4XL which use `_3XL`, `_4XL`)

**Implementation:**
```json
{
  "lineItems": [
    {
      "partNumber": "C913",
      "description": "Port Authority Snapback Cap",
      "color": "Black",
      "size": "OSFA",          // ← Use "OSFA" for one-size items
      "quantity": 1,
      "price": 0.00
    }
  ]
}
```

**This will translate to in ManageOrders:**
```
Other XXXL: 1
(No modifier field needed)
```

**Why "Other XXXL" Column:**
- ShopWorks uses specific size columns: XS, S, M, LG, XL, XXL, Other XXXL
- All non-standard sizes go to "Other XXXL"
- This includes: OSFA, 3XL, 4XL, 5XL, 6XL, XS
- Modifiers like `_3XL` differentiate between them
- OSFA doesn't need a modifier since it's the base case

---

### 5. Production Notes Field ✅

**Answer:** Use this format in OrderInstructions field:

```
FREE SAMPLE - Top Sellers Showcase - {Company Name}
```

**Examples:**
```
FREE SAMPLE - Top Sellers Showcase - ABC Company
FREE SAMPLE - Top Sellers Showcase - Smith Construction
FREE SAMPLE - Top Sellers Showcase - Seattle Schools
```

**Why This Format:**
- ✅ **"FREE SAMPLE"** - Immediately identifies as no-charge order
- ✅ **"Top Sellers Showcase"** - Explains the program/purpose
- ✅ **Company Name** - Shows who the sample is for

**Implementation:**
```json
{
  "notes": [
    {
      "type": "Notes On Order",
      "text": "FREE SAMPLE - Top Sellers Showcase - ABC Company"
    }
  ]
}
```

**Alternative Notes to Include:**
```json
{
  "notes": [
    {
      "type": "Notes On Order",
      "text": "FREE SAMPLE - Top Sellers Showcase - ABC Company"
    },
    {
      "type": "Production Notes",
      "text": "Sample approved via online store. No decoration required. Ship as blank."
    }
  ]
}
```

**Full Example:**
```javascript
const orderData = {
  "orderNumber": orderNumber,
  "orderDate": new Date().toISOString().split('T')[0],
  "customer": customerData,
  "shipping": shippingData,
  "lineItems": lineItems,
  "notes": [
    {
      "type": "Notes On Order",
      "text": `FREE SAMPLE - Top Sellers Showcase - ${customerData.company || customerData.lastName}`
    }
  ]
};
```

**This will help:**
- Production team immediately sees it's a free sample
- CSRs can search for "FREE SAMPLE" to find all sample orders
- Company name makes it easy to identify who requested it
- Clear purpose ("Top Sellers Showcase") explains why it's free

---

### 6. Email Notifications ❓

**Answer:** **NEEDS INPUT FROM ERIK**

**Question for Erik:**

Who should receive email notifications when a sample order is submitted?

**Options:**

✅ **Customer (Confirmation Email):**
- [ ] Yes - Send order confirmation to customer's email
- [ ] No - Skip customer confirmation

✅ **Sales Team:**
- [ ] Yes - Notify sales team at: _____________________ (email address?)
- [ ] No - Sales team doesn't need notification

✅ **Production Team:**
- [ ] Yes - Notify production at: _____________________ (email address?)
- [ ] No - Production will see it in OnSite during hourly import

✅ **Specific Person:**
- [ ] Yes - Notify: _____________________ (name/email?)
- [ ] No

**Current Email Implementation:**
- The ManageOrders PUSH API doesn't have built-in email notifications
- Emails would need to be sent by your webstore application
- Or added as a webhook/notification in the proxy

**Recommendation:**

1. **Customer Confirmation** - Probably YES
   - Send immediately after successful API call
   - Include: order number, items requested, expected ship date

2. **Sales/Admin Notification** - Ask Erik
   - Could be important for high-value prospects
   - Might want to follow up with larger customers

3. **Production** - Probably NO
   - They'll see it in OnSite during hourly import
   - Order Entry system is their notification

**Implementation Example:**
```javascript
// After successful order creation
const orderResponse = await createOrder(orderData);

if (orderResponse.success) {
  // 1. Send customer confirmation
  await sendEmail({
    to: customerData.email,
    subject: `Sample Order Confirmation - ${orderNumber}`,
    body: `Your sample order has been received...`
  });

  // 2. Optionally notify sales team
  await sendEmail({
    to: 'sales@nwcustomapparel.com',
    subject: `New Sample Order - ${customerData.company}`,
    body: `A new sample order has been placed by ${customerData.company}...`
  });
}
```

**Erik: Please specify:**
1. Customer confirmation: Yes/No?
2. Sales team notification: Yes/No? (If yes, what email?)
3. Production notification: Yes/No? (If yes, what email?)
4. Anyone else to notify?

---

## Complete Working Example

Here's a complete sample order ready to send:

```json
{
  "orderNumber": "SAMPLE-1027-1",
  "isTest": false,
  "orderDate": "2025-10-27",

  "customer": {
    "firstName": "Sarah",
    "lastName": "Johnson",
    "email": "sarah@example.com",
    "phone": "425-555-1234",
    "company": "Johnson Marketing"
  },

  "shipping": {
    "company": "Johnson Marketing",
    "address1": "456 Business Blvd",
    "address2": "Suite 200",
    "city": "Bellevue",
    "state": "WA",
    "zip": "98004",
    "country": "USA",
    "method": "UPS Ground"
  },

  "lineItems": [
    {
      "partNumber": "PC54",
      "description": "Port & Company Core Cotton Tee",
      "color": "Navy",
      "size": "L",
      "quantity": 1,
      "price": 0.00
    },
    {
      "partNumber": "C913",
      "description": "Port Authority Snapback Cap",
      "color": "Black",
      "size": "OSFA",
      "quantity": 1,
      "price": 0.00
    }
  ],

  "notes": [
    {
      "type": "Notes On Order",
      "text": "FREE SAMPLE - Top Sellers Showcase - Johnson Marketing"
    }
  ]
}
```

**API Call:**
```javascript
const response = await fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(sampleOrderData)
});

const result = await response.json();

if (result.success) {
  console.log('Sample order created:', result.extOrderId);
  // result.extOrderId = "NWCA-SAMPLE-1027-1"

  // Send confirmation emails here
  await sendCustomerConfirmation(customerData, result.extOrderId);
}
```

---

## Quick Reference

**For Copy/Paste into Your Code:**

```javascript
// Sample order configuration
const SAMPLE_ORDER_CONFIG = {
  orderType: 6,                    // Web orders
  orderPrefix: 'SAMPLE',           // SAMPLE-MMDD-seq
  customerNumber: 2791,            // All web orders
  productionNote: (company) =>
    `FREE SAMPLE - Top Sellers Showcase - ${company}`,
  price: 0.00,                     // Always free

  // Size mappings
  sizes: {
    'OSFA': 'Other XXXL'           // One size items
  }
};

// Generate order number
function generateSampleOrderNumber() {
  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const sequence = getNextSequence(mmdd); // Your implementation
  return `SAMPLE-${mmdd}-${sequence}`;
}

// Build order payload
function buildSampleOrder(customerData, lineItems) {
  return {
    orderNumber: generateSampleOrderNumber(),
    orderDate: new Date().toISOString().split('T')[0],
    isTest: false,

    customer: {
      firstName: customerData.firstName,
      lastName: customerData.lastName,
      email: customerData.email,
      phone: customerData.phone,
      company: customerData.company || ''
    },

    shipping: {
      company: customerData.company || `${customerData.firstName} ${customerData.lastName}`,
      address1: customerData.address1,
      address2: customerData.address2 || '',
      city: customerData.city,
      state: customerData.state,
      zip: customerData.zip,
      country: 'USA',
      method: 'UPS Ground'
    },

    lineItems: lineItems.map(item => ({
      partNumber: item.partNumber,
      description: item.description,
      color: item.color,
      size: item.size, // Use "OSFA" for one-size items
      quantity: 1,     // Always 1 for samples
      price: 0.00      // Always free
    })),

    notes: [
      {
        type: 'Notes On Order',
        text: SAMPLE_ORDER_CONFIG.productionNote(
          customerData.company || customerData.lastName
        )
      }
    ]
  };
}
```

---

## Testing Checklist

Before going live with sample orders:

- [ ] Test with `isTest: true` flag (order will have `NWCA-TEST-SAMPLE-xxx` prefix)
- [ ] Verify order appears in ManageOrders after API call
- [ ] Check order imports into OnSite during next hourly sync
- [ ] Verify customer info is in Contact fields (not customer 2791 info)
- [ ] Verify production notes appear correctly
- [ ] Test OSFA items map to correct size column
- [ ] Test email notifications work (once Erik confirms who to notify)
- [ ] Create a few test orders with different scenarios
- [ ] Remove test orders from OnSite before going live

---

## Questions for Erik

Only one question remains unanswered:

**Question 6: Email Notifications**
- Who should receive email notifications when a sample order is submitted?
- Customer confirmation: Yes/No?
- Sales team: Yes/No? (If yes, what email address?)
- Production team: Yes/No? (If yes, what email address?)
- Anyone else?

**Once Erik answers this, you'll have everything you need to implement sample order checkout!**

---

## References

- [ManageOrders PUSH Integration Guide](memory/MANAGEORDERS_PUSH_INTEGRATION.md)
- [Online Store Developer Guide](memory/ONLINE_STORE_DEVELOPER_GUIDE.md)
- [Complete API Specification](memory/MANAGEORDERS_API_SPEC.yaml)

**API Endpoint:**
```
POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create
```

**Verify Endpoint:**
```
GET https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/verify/{extOrderId}
```

---

**Ready to implement? You now have answers to 5 out of 6 questions!**

Just need Erik to confirm email notification preferences, then you're all set.
