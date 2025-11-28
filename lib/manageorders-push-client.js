/**
 * ManageOrders PUSH API - Client Module
 *
 * Handles order transformation and communication with ManageOrders PUSH API:
 * - Transform incoming orders to ManageOrders format
 * - Push orders to ManageOrders API
 * - Verify orders were received
 * - Handle errors and retries
 */

const axios = require('axios');
const { getToken, MANAGEORDERS_PUSH_BASE_URL } = require('./manageorders-push-auth');
const {
  ONSITE_DEFAULTS,
  translateSize,
  generateExtOrderID,
  isValidNoteType,
  NOTE_TYPES,
  PAYMENT_STATUS
} = require('../config/manageorders-push-config');

/**
 * Convert date from YYYY-MM-DD to MM/DD/YYYY format for OnSite
 *
 * @param {string} dateString - Date in YYYY-MM-DD format
 * @returns {string|null} Date in MM/DD/YYYY format, or null if input is empty
 */
function formatDateForOnSite(dateString) {
  if (!dateString) return null;

  // Handle ISO datetime strings (extract just the date part)
  const dateOnly = dateString.split('T')[0];

  const [year, month, day] = dateOnly.split('-');
  return `${month}/${day}/${year}`;
}

/**
 * Transform incoming order data to ManageOrders PUSH API format
 *
 * @param {Object} orderData - Order data from webstore/external system
 * @returns {Promise<Object>} Transformed order in ManageOrders format
 * @throws {Error} If required fields are missing or invalid
 */
async function transformOrder(orderData) {
  // Validate required fields
  if (!orderData.orderNumber) {
    throw new Error('orderNumber is required');
  }
  if (!orderData.customer) {
    throw new Error('customer object is required');
  }
  if (!orderData.lineItems || !Array.isArray(orderData.lineItems) || orderData.lineItems.length === 0) {
    throw new Error('lineItems array is required and must contain at least one item');
  }

  // Handle file uploads (if provided)
  let uploadedFiles = [];
  if (orderData.files && Array.isArray(orderData.files) && orderData.files.length > 0) {
    console.log(`[ManageOrders PUSH] Uploading ${orderData.files.length} files to Caspio...`);
    uploadedFiles = await uploadFilesToCaspio(orderData.files);
    console.log(`[ManageOrders PUSH] Successfully uploaded ${uploadedFiles.length} files`);
  }

  // Generate ExtOrderID
  const isTest = orderData.isTest || false;
  const extOrderID = generateExtOrderID(orderData.orderNumber, isTest);

  // Build base order object with OnSite defaults
  const manageOrdersOrder = {
    ExtOrderID: extOrderID,
    ExtSource: ONSITE_DEFAULTS.ExtSource,
    ExtCustomerID: `${ONSITE_DEFAULTS.ExtCustomerPref}-CUST-${orderData.orderNumber}`,
    ExtCustomerPref: ONSITE_DEFAULTS.ExtCustomerPref,

    // Dates - Convert from YYYY-MM-DD to MM/DD/YYYY for OnSite
    date_OrderPlaced: formatDateForOnSite(orderData.orderDate || new Date().toISOString().split('T')[0]),
    date_OrderRequestedToShip: formatDateForOnSite(orderData.requestedShipDate),
    date_OrderDropDead: formatDateForOnSite(orderData.dropDeadDate),

    // OnSite configuration defaults
    id_Customer: ONSITE_DEFAULTS.id_Customer,
    id_OrderType: ONSITE_DEFAULTS.id_OrderType,
    id_CompanyLocation: ONSITE_DEFAULTS.id_CompanyLocation,
    id_EmpCreatedBy: ONSITE_DEFAULTS.id_EmpCreatedBy,
    OnHold: ONSITE_DEFAULTS.AutoHold,

    // Customer contact information (stored in Contact fields since all orders go to Customer #2791)
    ContactNameFirst: orderData.customer.firstName || '',
    ContactNameLast: orderData.customer.lastName || '',
    ContactEmail: orderData.customer.email || '',
    ContactPhone: orderData.customer.phone || '',

    // Additional order fields
    CustomerPurchaseOrder: orderData.purchaseOrderNumber || '',
    CustomerServiceRep: orderData.salesRep || '',
    Terms: orderData.terms || '',

    // Status fields
    id_SalesStatus: orderData.salesStatus || 0,
    id_ReceivingStatus: orderData.receivingStatus || 0,
    id_ShippingStatus: orderData.shippingStatus || 0,

    // Financial fields
    // Only include TaxTotal if explicitly provided (don't default to 0)
    // Tax fields work together: TaxTotal + TaxPartNumber + TaxPartDescription
    // ShopWorks auto-creates tax line item from these three fields
    ...(orderData.taxTotal !== undefined && orderData.taxTotal !== null && orderData.taxTotal > 0
        ? {
            TaxTotal: orderData.taxTotal,
            TaxPartNumber: orderData.taxPartNumber || '',
            TaxPartDescription: orderData.taxPartDescription || ''
          }
        : {}),
    TotalDiscounts: orderData.totalDiscounts || 0,

    // Discount fields
    DiscountPartNumber: orderData.discountPartNumber || '',
    DiscountPartDescription: orderData.discountPartDescription || '',

    // Tax and shipping handled by OnSite (not sent via API per configuration)
    cur_Shipping: orderData.cur_Shipping || 0,
  };

  // Add Customer object with billing address and business information
  manageOrdersOrder.Customer = {
    // Billing Address (7 fields)
    BillingCompany: orderData.billing?.company || orderData.customer?.company || '',
    BillingAddress01: orderData.billing?.address1 || '',
    BillingAddress02: orderData.billing?.address2 || '',
    BillingCity: orderData.billing?.city || '',
    BillingState: orderData.billing?.state || '',
    BillingZip: orderData.billing?.zip || '',
    BillingCountry: orderData.billing?.country || 'USA',

    // Company Info (3 fields)
    CompanyName: orderData.customer?.company || '',
    MainEmail: orderData.customer?.email || '',
    WebSite: orderData.customer?.website || '',

    // Tax Info (2 fields)
    TaxExempt: orderData.customer?.taxExempt || '',
    TaxExemptNumber: orderData.customer?.taxExemptNumber || '',

    // Business Classification (3 fields)
    CustomerSource: orderData.customer?.source || '',
    CustomerType: orderData.customer?.type || '',
    SalesGroup: orderData.customer?.salesGroup || '',

    // Notes (2 fields)
    InvoiceNotes: orderData.customer?.invoiceNotes || '',
    CustomerReminderInvoiceNotes: orderData.customer?.reminderNotes || '',

    // Custom Fields (10 fields - support both nested and flat formats)
    CustomField01: orderData.customer?.customFields?.CustomField01 || orderData.customer?.customField01 || '',
    CustomField02: orderData.customer?.customFields?.CustomField02 || orderData.customer?.customField02 || '',
    CustomField03: orderData.customer?.customFields?.CustomField03 || orderData.customer?.customField03 || '',
    CustomField04: orderData.customer?.customFields?.CustomField04 || orderData.customer?.customField04 || '',
    CustomField05: orderData.customer?.customFields?.CustomField05 || orderData.customer?.customField05 || '',
    CustomField06: orderData.customer?.customFields?.CustomField06 || orderData.customer?.customField06 || '',
    CustomDateField01: orderData.customer?.customDateFields?.CustomDateField01 || orderData.customer?.customDateField01 || '',
    CustomDateField02: orderData.customer?.customDateFields?.CustomDateField02 || orderData.customer?.customDateField02 || '',
    CustomDateField03: orderData.customer?.customDateFields?.CustomDateField03 || orderData.customer?.customDateField03 || '',
    CustomDateField04: orderData.customer?.customDateFields?.CustomDateField04 || orderData.customer?.customDateField04 || ''
  };

  // Transform line items
  manageOrdersOrder.LinesOE = transformLineItems(orderData.lineItems);

  // Transform shipping addresses (if provided)
  if (orderData.shipping) {
    manageOrdersOrder.ShippingAddresses = [transformShippingAddress(orderData.shipping, 1)];

    // Link all line items to the shipping address
    manageOrdersOrder.LinesOE.forEach(lineItem => {
      lineItem.ExtShipID = 'SHIP-1';
    });
  }

  // Transform designs (if provided)
  if (orderData.designs && Array.isArray(orderData.designs) && orderData.designs.length > 0) {
    manageOrdersOrder.Designs = transformDesigns(orderData.designs);
  }

  // Transform payments (if provided)
  if (orderData.payments && Array.isArray(orderData.payments) && orderData.payments.length > 0) {
    manageOrdersOrder.Payments = transformPayments(orderData.payments);
  }

  // Transform notes (if provided)
  if (orderData.notes && Array.isArray(orderData.notes) && orderData.notes.length > 0) {
    manageOrdersOrder.Notes = transformNotes(orderData.notes);
  }

  // Add customer info note
  if (!manageOrdersOrder.Notes) {
    manageOrdersOrder.Notes = [];
  }
  manageOrdersOrder.Notes.push({
    Type: NOTE_TYPES.ORDER,
    Note: `Customer: ${orderData.customer.firstName} ${orderData.customer.lastName}\nEmail: ${orderData.customer.email || 'N/A'}\nPhone: ${orderData.customer.phone || 'N/A'}${orderData.customer.company ? '\nCompany: ' + orderData.customer.company : ''}`
  });

  // Handle direct attachments array (from 3-Day Tees and other sources)
  if (orderData.attachments && Array.isArray(orderData.attachments) && orderData.attachments.length > 0) {
    if (!manageOrdersOrder.Attachments) {
      manageOrdersOrder.Attachments = [];
    }

    // Transform attachments from camelCase to PascalCase
    const transformedAttachments = orderData.attachments.map(attachment => ({
      MediaURL: attachment.mediaUrl || '',
      MediaName: attachment.mediaName || '',
      LinkURL: attachment.linkUrl || '',
      LinkNote: attachment.linkNote || '',
      Link: attachment.link || 0
    }));

    manageOrdersOrder.Attachments.push(...transformedAttachments);
    console.log(`[ManageOrders PUSH] Added ${orderData.attachments.length} direct attachment(s)`);
  }

  // Handle uploaded files - Add to Designs (for artwork) and Attachments (for all files)
  if (uploadedFiles.length > 0) {
    // Separate artwork files for Designs
    const artworkFiles = uploadedFiles.filter(f => f.category === 'artwork');

    if (artworkFiles.length > 0) {
      // Create or append to Designs array
      if (!manageOrdersOrder.Designs) {
        manageOrdersOrder.Designs = [];
      }

      // Add a design with all artwork locations
      manageOrdersOrder.Designs.push({
        DesignName: `Order ${orderData.orderNumber} Artwork`,
        ExtDesignID: `ARTWORK-${orderData.orderNumber}`,
        id_DesignType: ONSITE_DEFAULTS.id_DesignType,
        id_Artist: ONSITE_DEFAULTS.id_Artist,
        Locations: artworkFiles.map(file => ({
          Location: file.decorationLocation || 'Unspecified',
          ImageURL: file.caspioUrl,
          Notes: file.description || `Uploaded: ${file.fileName}`
        }))
      });

      console.log(`[ManageOrders PUSH] Added ${artworkFiles.length} artwork file(s) to Designs`);
    }

    // Add ALL files to Attachments array
    manageOrdersOrder.Attachments = transformAttachments(uploadedFiles);
    console.log(`[ManageOrders PUSH] Added ${uploadedFiles.length} file(s) to Attachments`);
  }

  return manageOrdersOrder;
}

/**
 * Transform line items to ManageOrders format
 *
 * @param {Array} lineItems - Array of line items
 * @returns {Array} Transformed line items
 */
function transformLineItems(lineItems) {
  return lineItems.map((item, index) => {
    if (!item.partNumber) {
      throw new Error(`Line item ${index + 1}: partNumber is required`);
    }
    if (!item.quantity || item.quantity <= 0) {
      throw new Error(`Line item ${index + 1}: quantity must be greater than 0`);
    }

    // Translate size using SIZE_MAPPING
    let translatedSize = null;
    if (item.size) {
      try {
        translatedSize = translateSize(item.size);
      } catch (error) {
        throw new Error(`Line item ${index + 1}: ${error.message}`);
      }
    }

    const lineItem = {
      PartNumber: item.partNumber,
      Description: item.description || '',
      Color: item.color || '',
      Size: translatedSize,
      Qty: item.quantity,
      Price: item.price || 0,
      id_ProductClass: item.productClass || ONSITE_DEFAULTS.id_ProductClass,
      DisplayAsPartNumber: item.displayPartNumber || '',
      DisplayAsDescription: item.displayDescription || '',
      ExtDesignIDBlock: item.extDesignIdBlock || item.ExtDesignIDBlock || '',
      DesignIDBlock: item.designIdBlock || item.DesignIDBlock || '',
    };

    // Handle Size01 column for fee items (like LTM fee)
    // When useSizeColumn is true, put quantity in Size01 instead of size breakdown
    if (item.useSizeColumn) {
      lineItem.Size01 = item.quantity;
    }

    // Player names (for personalization)
    if (item.playerName) {
      lineItem.NameFirst = item.playerName.first || '';
      lineItem.NameLast = item.playerName.last || '';
    }

    // Line item notes (only add if non-empty)
    if (item.notes && item.notes.trim()) {
      lineItem.LineItemNotes = item.notes;
    }
    if (item.workOrderNotes && item.workOrderNotes.trim()) {
      lineItem.WorkOrderNotes = item.workOrderNotes;
    }

    // Custom fields - support both nested (item.customFields.CustomField01) and flat (item.customField01) formats
    if (item.customFields) {
      for (let i = 1; i <= 5; i++) {
        const fieldName = `CustomField0${i}`;
        if (item.customFields[fieldName]) {
          lineItem[fieldName] = item.customFields[fieldName];
        }
      }
    }
    // Also support flat format for consistency with other transformations
    lineItem.CustomField01 = lineItem.CustomField01 || item.customField01 || '';
    lineItem.CustomField02 = lineItem.CustomField02 || item.customField02 || '';
    lineItem.CustomField03 = lineItem.CustomField03 || item.customField03 || '';
    lineItem.CustomField04 = lineItem.CustomField04 || item.customField04 || '';
    lineItem.CustomField05 = lineItem.CustomField05 || item.customField05 || '';

    return lineItem;
  });
}

/**
 * Transform shipping address to ManageOrders format
 *
 * @param {Object} shipping - Shipping address data
 * @param {number} index - Address index (for ExtShipID)
 * @returns {Object} Transformed shipping address
 */
function transformShippingAddress(shipping, index) {
  return {
    ShipCompany: shipping.company || '',
    ShipMethod: shipping.method || '',
    ShipAddress01: shipping.address1 || '',
    ShipAddress02: shipping.address2 || '',
    ShipCity: shipping.city || '',
    ShipState: shipping.state || '',
    ShipZip: shipping.zip || '',
    ShipCountry: shipping.country || 'USA',
    ExtShipID: `SHIP-${index}`,
  };
}

/**
 * Transform designs to ManageOrders format
 *
 * @param {Array} designs - Array of designs
 * @returns {Array} Transformed designs
 */
function transformDesigns(designs) {
  return designs.map((design, index) => {
    const transformedDesign = {
      DesignName: design.name || `Design ${index + 1}`,
      ExtDesignID: design.externalId || `DESIGN-${index + 1}`,
      id_Design: design.idDesign || design.id_Design || 0,
      id_DesignType: design.designTypeId || ONSITE_DEFAULTS.id_DesignType,
      id_Artist: design.artistId || ONSITE_DEFAULTS.id_Artist,
      ForProductColor: design.productColor || '',
      VendorDesignID: design.vendorId || '',
      CustomField01: design.customField01 || '',
      CustomField02: design.customField02 || '',
      CustomField03: design.customField03 || '',
      CustomField04: design.customField04 || '',
      CustomField05: design.customField05 || '',
    };

    // Transform locations
    if (design.locations && Array.isArray(design.locations)) {
      transformedDesign.Locations = design.locations.map((location, locIndex) => {
        const transformedLocation = {
          Location: location.location || `Location ${locIndex + 1}`,
          TotalColors: location.colors || '',
          TotalFlashes: location.flashes || '',
          TotalStitches: location.stitches || '',
          DesignCode: location.code || '',
          ImageURL: location.imageUrl || design.imageUrl || '',
          Notes: location.notes || '',
          CustomField01: location.customField01 || '',
          CustomField02: location.customField02 || '',
          CustomField03: location.customField03 || '',
          CustomField04: location.customField04 || '',
          CustomField05: location.customField05 || '',
        };

        // Transform location details
        if (location.details && Array.isArray(location.details)) {
          transformedLocation.LocationDetails = location.details.map(detail => ({
            Color: detail.color || '',
            ThreadBreak: detail.threadBreak || '',
            ParameterLabel: detail.paramLabel || '',
            ParameterValue: detail.paramValue || '',
            Text: detail.text || '',
            CustomField01: detail.customField01 || '',
            CustomField02: detail.customField02 || '',
            CustomField03: detail.customField03 || '',
            CustomField04: detail.customField04 || '',
            CustomField05: detail.customField05 || '',
          }));
        }

        return transformedLocation;
      });
    }

    return transformedDesign;
  });
}

/**
 * Transform payments to ManageOrders format
 *
 * @param {Array} payments - Array of payments
 * @returns {Array} Transformed payments
 */
function transformPayments(payments) {
  return payments.map(payment => ({
    date_Payment: formatDateForOnSite(payment.date || new Date().toISOString().split('T')[0]),
    AccountNumber: payment.accountNumber || '',
    Amount: payment.amount || 0,
    AuthCode: payment.authCode || '',
    CreditCardCompany: payment.cardCompany || payment.gateway || '',
    Gateway: payment.gateway || '',
    ResponseCode: payment.responseCode || '',
    ResponseReasonCode: payment.reasonCode || '',
    ResponseReasonText: payment.reasonText || '',
    Status: payment.status || PAYMENT_STATUS.SUCCESS,
    FeeOther: payment.feeOther || 0,
    FeeProcessing: payment.feeProcessing || 0,
  }));
}

/**
 * Transform notes to ManageOrders format
 *
 * @param {Array} notes - Array of notes
 * @returns {Array} Transformed notes
 */
function transformNotes(notes) {
  return notes.map(note => {
    const noteType = note.type || NOTE_TYPES.ORDER;

    if (!isValidNoteType(noteType)) {
      throw new Error(`Invalid note type: "${noteType}". Valid types: ${Object.values(NOTE_TYPES).join(', ')}`);
    }

    return {
      Type: noteType,
      Note: note.text || note.note || '',
    };
  });
}

/**
 * Upload multiple files to Caspio and return URLs
 *
 * @param {Array} files - Array of file objects with fileName, fileData, category, description
 * @returns {Promise<Array>} Array of uploaded file objects with URLs
 */
async function uploadFilesToCaspio(files) {
  if (!files || !Array.isArray(files) || files.length === 0) {
    return [];
  }

  // Import the shared upload service (direct function call - NO HTTP)
  const { uploadFileToCaspio } = require('./file-upload-service');
  const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

  const uploadedFiles = [];

  for (const file of files) {
    try {
      // Validate file has required fields
      if (!file.fileData || !file.fileName) {
        console.warn('[File Upload] Skipping file - missing fileData or fileName');
        continue;
      }

      // Call the upload function directly (NO HTTP - avoids Heroku router issues)
      console.log(`[File Upload] Uploading ${file.fileName}...`);
      const uploadResult = await uploadFileToCaspio(
        file.fileName,
        file.fileData,
        file.description || `File for order`
      );

      if (uploadResult.success) {
        uploadedFiles.push({
          fileName: file.fileName,
          externalKey: uploadResult.externalKey,
          caspioUrl: `${PROXY_BASE_URL}/api/files/${uploadResult.externalKey}`,
          category: file.category || 'document',
          decorationLocation: file.decorationLocation || '',
          description: file.description || '',
          size: uploadResult.size,
          mimeType: uploadResult.mimeType
        });

        console.log(`[File Upload] Uploaded: ${file.fileName} → ${uploadResult.externalKey}`);
      }
    } catch (error) {
      console.error(`[File Upload] Failed to upload ${file.fileName}:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      // Continue with other files even if one fails
    }
  }

  return uploadedFiles;
}

/**
 * Transform uploaded files to ManageOrders Attachments format
 *
 * @param {Array} uploadedFiles - Array of uploaded file objects
 * @returns {Array} Transformed attachments
 */
function transformAttachments(uploadedFiles) {
  if (!uploadedFiles || uploadedFiles.length === 0) {
    return [];
  }

  return uploadedFiles.map(file => ({
    MediaURL: file.caspioUrl || '',
    MediaName: file.fileName || '',
    LinkURL: file.linkUrl || '',
    LinkNote: file.description || `${file.category === 'artwork' ? 'Design file' : 'Order document'}: ${file.fileName}`,
    Link: file.link || 0  // 0 = media file hosted on Caspio, 1 = external URL reference
  }));
}

/**
 * Push order to ManageOrders PUSH API
 *
 * @param {Object} orderData - Order data from webstore/external system
 * @returns {Promise<Object>} Response from ManageOrders API
 * @throws {Error} If push fails
 */
async function pushOrder(orderData) {
  try {
    // Transform order to ManageOrders format
    console.log('[ManageOrders PUSH] Transforming order:', orderData.orderNumber);
    const manageOrdersOrder = await transformOrder(orderData);

    // Get authentication token
    const token = await getToken();

    // Push order to ManageOrders
    console.log('[ManageOrders PUSH] Pushing order to ManageOrders:', manageOrdersOrder.ExtOrderID);
    const response = await axios.post(
      `${MANAGEORDERS_PUSH_BASE_URL}/order-push`,
      manageOrdersOrder,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      }
    );

    console.log('[ManageOrders PUSH] Order pushed successfully:', manageOrdersOrder.ExtOrderID);

    return {
      success: true,
      extOrderId: manageOrdersOrder.ExtOrderID,
      response: response.data,
      timestamp: new Date().toISOString(),
      onsiteImportExpected: new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour from now
    };
  } catch (error) {
    console.error('[ManageOrders PUSH] Order push failed:', error.message);

    if (error.response) {
      console.error('[ManageOrders PUSH] Error response:', error.response.status, error.response.data);
      throw new Error(`ManageOrders API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error('[ManageOrders PUSH] No response from ManageOrders API');
      throw new Error('No response from ManageOrders API. Check network connection.');
    } else {
      throw error;
    }
  }
}

/**
 * Verify order was received by ManageOrders (using order-pull endpoint)
 *
 * @param {string} extOrderId - External order ID (e.g., "NWCA-12345")
 * @returns {Promise<Object>} Verification result
 */
async function verifyOrder(extOrderId) {
  try {
    const token = await getToken();

    // Use current date for query
    const today = new Date().toISOString().split('T')[0];

    console.log(`[ManageOrders PUSH] Verifying order ${extOrderId}...`);

    const response = await axios.get(
      `${MANAGEORDERS_PUSH_BASE_URL}/order-pull`,
      {
        params: {
          date_from: today,
          date_to: today,
          api_source: ONSITE_DEFAULTS.ExtSource
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        },
        timeout: 15000
      }
    );

    // Search for our order in the results
    const orders = response.data.result || [];
    const foundOrder = orders.find(order => {
      const orderJson = order.order_json || {};
      return orderJson.ExtOrderID === extOrderId;
    });

    if (foundOrder) {
      console.log(`[ManageOrders PUSH] Order ${extOrderId} verified successfully`);
      return {
        success: true,
        found: true,
        extOrderId,
        uploadedAt: foundOrder.order_json.date_OrderPlaced || 'unknown',
        orderData: foundOrder.order_json
      };
    } else {
      console.log(`[ManageOrders PUSH] Order ${extOrderId} not found (may still be processing)`);
      return {
        success: true,
        found: false,
        extOrderId,
        message: 'Order not found in ManageOrders. It may still be processing or was uploaded on a different date.'
      };
    }
  } catch (error) {
    console.error('[ManageOrders PUSH] Verification failed:', error.message);
    return {
      success: false,
      found: false,
      extOrderId,
      error: error.message
    };
  }
}

module.exports = {
  pushOrder,
  verifyOrder,
  transformOrder,
  transformLineItems,
  transformShippingAddress,
  transformDesigns,
  transformPayments,
  transformNotes,
  transformAttachments,
  uploadFilesToCaspio,
};
