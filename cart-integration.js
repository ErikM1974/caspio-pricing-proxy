// Cart integration for Caspio DataPages - Auto-detects embellishment type
// Updated to work with the latest API endpoints (April 2025)
(function() {
  "use strict";

  // --- Configuration ---
  const config = {
    apiBaseUrl: 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api',
    storageKeys: {
      sessionId: 'nwca_cart_session_id',
      cartItems: 'nwca_cart_items',
      lastSync: 'nwca_cart_last_sync'
    },
    cartUpdateIntervalMs: 60000, // 60 seconds
    // Enable debugging only in development environments
    debug: window.location.hostname === 'localhost' ||
           window.location.hostname === '127.0.0.1' ||
           window.location.hostname.includes('dev.') ||
           window.location.hostname.includes('staging.') ||
           window.location.search.includes('debug=true'), // Allow debug mode via URL parameter
    urls: {
      cart: '/cart.html',
      home: '/index.html'
    }
  };
  // --- End Configuration ---

  // Function to test API endpoints
  async function testApiEndpoints() {
    debugCart("API-TEST", "Starting API endpoint tests...");

    const endpoints = [
      { name: "Cart Sessions", url: `${config.apiBaseUrl}/cart-sessions` },
      { name: "Cart Items", url: `${config.apiBaseUrl}/cart-items` },
      { name: "Cart Item Sizes", url: `${config.apiBaseUrl}/cart-item-sizes` },
      { name: "Inventory", url: `${config.apiBaseUrl}/inventory?styleNumber=PC61&color=BLACK` }
    ];

    for (const endpoint of endpoints) {
      try {
        debugCart("API-TEST", `Testing endpoint: ${endpoint.name} (${endpoint.url})`);
        const startTime = Date.now();
        const response = await fetch(endpoint.url);
        const endTime = Date.now();

        if (response.ok) {
          const data = await response.json();
          debugCart("API-TEST", `✅ ${endpoint.name}: Success (${endTime - startTime}ms)`,
            Array.isArray(data) ? `Returned ${data.length} items` : 'Returned data');
        } else {
          debugCart("API-TEST", `❌ ${endpoint.name}: Failed with status ${response.status}`);
        }
      } catch (error) {
        debugCart("API-TEST", `❌ ${endpoint.name}: Error - ${error.message}`);
      }
    }

    debugCart("API-TEST", "API endpoint tests completed");
  }

  // Run API tests only in development environments
  if (config.debug && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    setTimeout(testApiEndpoints, 2000);
  }

  // --- Debugging Utilities ---
  function debugCart(area, ...args) {
    if (config.debug) console.log(`[CART:${area}]`, ...args);
  }

  // --- Cart System Detection ---
  function detectAvailableCartSystem() {
    // Check if NWCACart is in current window
    if (window.NWCACart && typeof window.NWCACart.addToCart === 'function') {
      debugCart("DETECT", "Found NWCACart in current window");
      return {source: 'current', api: window.NWCACart};
    }

    // Try to safely check parent window
    try {
      if (window.parent && window.parent !== window &&
          window.parent.NWCACart &&
          typeof window.parent.NWCACart.addToCart === 'function') {
        debugCart("DETECT", "Found NWCACart in parent window");
        return {source: 'parent', api: window.parent.NWCACart};
      }
    } catch (e) {
      debugCart("DETECT", "Error accessing parent window:", e.message);
    }

    // Fall back to DirectCartAPI
    if (window.DirectCartAPI) {
      debugCart("DETECT", "Using DirectCartAPI fallback");
      return {source: 'fallback', api: window.DirectCartAPI};
    }

    debugCart("DETECT", "No cart system found!");
    return null;
  }

  // Synchronize carts between DirectCartAPI and NWCACart
  async function synchronizeCartSystems() {
    debugCart("SYNC", "Starting cart synchronization");

    try {
      // First check if we have both cart systems
      let directCartAvailable = window.DirectCartAPI && typeof window.DirectCartAPI.getCartItems === 'function';
      let nwcaCartAvailable = false;
      let nwcaCartApi = null;

      // Check for NWCACart in current window
      if (window.NWCACart && typeof window.NWCACart.getCartItems === 'function') {
        nwcaCartAvailable = true;
        nwcaCartApi = window.NWCACart;
      } else {
        // Try parent window
        try {
          if (window.parent && window.parent !== window &&
              window.parent.NWCACart &&
              typeof window.parent.NWCACart.getCartItems === 'function') {
            nwcaCartAvailable = true;
            nwcaCartApi = window.parent.NWCACart;
          }
        } catch (e) {
          debugCart("SYNC", "Error accessing parent window NWCACart:", e.message);
        }
      }

      // If we don't have both, we can't sync
      if (!directCartAvailable || !nwcaCartAvailable) {
        debugCart("SYNC", "Can't synchronize - missing one or both cart systems");
        return false;
      }

      // Get cart items from DirectCartAPI
      const directCartResult = await window.DirectCartAPI.getCartItems();

      // If DirectCartAPI has no items, nothing to sync
      if (!directCartResult.success || !directCartResult.items || directCartResult.items.length === 0) {
        debugCart("SYNC", "DirectCartAPI has no items to sync");
        return true;
      }

      // Add DirectCartAPI items to NWCACart
      debugCart("SYNC", `Syncing ${directCartResult.items.length} items from DirectCartAPI to NWCACart`);

      let syncCount = 0;
      const syncedItemIds = []; // Track successfully synced items

      for (const item of directCartResult.items) {
        try {
          // Convert DirectCartAPI item to NWCACart format
          const productData = {
            styleNumber: item.styleNumber,
            color: item.color,
            colorCode: item.colorCode || item.color,
            embellishmentType: item.embellishmentType,
            embellishmentOptions: item.embellishmentOptions || {},
            sizes: item.sizes || [],
            imageUrl: item.imageUrl
          };

          // Add to NWCACart (using the detected API)
          const result = await nwcaCartApi.addToCart(productData);

          if (result.success) {
            syncCount++;
            syncedItemIds.push(item.id); // Track this item for removal
          } else {
            debugCart("SYNC", `Failed to sync item ${item.id || 'unknown'}: ${result.error || 'Unknown error'}`);
          }
        } catch (e) {
          debugCart("SYNC", `Error syncing item ${item.id || 'unknown'}:`, e);
        }
      }

      debugCart("SYNC", `Successfully synced ${syncCount} items to NWCACart`);

      // Remove successfully synced items from DirectCartAPI storage
      if (syncedItemIds.length > 0) {
        try {
          // Get current cart data from localStorage
          const storedData = localStorage.getItem(window.DirectCartAPI.storageKeys.cartItems);
          if (storedData) {
            const cartData = JSON.parse(storedData);

            // Filter out synced items
            if (cartData.items && Array.isArray(cartData.items)) {
              cartData.items = cartData.items.filter(item => !syncedItemIds.includes(item.id));

              // Save filtered data back to localStorage
              localStorage.setItem(window.DirectCartAPI.storageKeys.cartItems, JSON.stringify(cartData));
              debugCart("SYNC", `Removed ${syncedItemIds.length} synced items from DirectCartAPI storage`);
            }
          }
        } catch (e) {
          debugCart("SYNC-ERROR", "Error removing synced items from storage:", e);
        }
      }

      return true;
    } catch (error) {
      debugCart("SYNC-ERROR", error);
      return false;
    }
  }


  // Track initialization to prevent multiple instances
  window.cartIntegrationInitialized = window.cartIntegrationInitialized || false;

  // Expose the initialization function to the global scope
  // This is critical for the Caspio page to be able to call it
  window.initCartIntegration = function() {
    // Prevent multiple initializations
    if (window.cartIntegrationInitialized) {
      debugCart("INIT", "Cart integration already initialized, skipping");
      return;
    }

    debugCart("INIT", "Cart integration initialization started");
    window.cartIntegrationInitialized = true;

    try {
      // Check if NWCACart is available, and if not, try loading it
      if (!window.NWCACart && typeof window.loadCartScript === 'function') {
        debugCart("INIT", "NWCACart not available, attempting to load it");
        try {
          // Check if cart.js is already loaded to prevent duplicate declarations
          const cartScriptLoaded = Array.from(document.scripts).some(script =>
            script.src && (script.src.includes('/cart.js') || script.src.endsWith('cart.js')));

          if (!cartScriptLoaded) {
            debugCart("INIT", "Loading cart.js script");
            window.loadCartScript();
          } else {
            debugCart("INIT", "cart.js already loaded, but NWCACart not available");
          }
        } catch (e) {
          debugCart("INIT-ERROR", "Error loading cart script:", e);
        }
      }

      // Add the cart button with retry logic
      let retryCount = 0;
      const maxRetries = 5;

      function attemptToAddButton() {
        try {
          checkAndAddCartButton();
        } catch (e) {
          debugCart("INIT-ERROR", "Error adding cart button:", e);
          retryCount++;

          if (retryCount < maxRetries) {
            debugCart("INIT", `Retrying to add cart button (${retryCount}/${maxRetries})...`);
            setTimeout(attemptToAddButton, 1000); // Retry after 1 second
          } else {
            debugCart("INIT-ERROR", "Failed to add cart button after maximum retries");
          }
        }
      }

      // Start the attempt process
      attemptToAddButton();

    } catch (error) {
      debugCart("INIT-ERROR", "Fatal error in cart integration initialization:", error);
    }
  };

  function checkAndAddCartButton() {
    debugCart("CHECK", "Running checkAndAddCartButton");
    const priceTable = document.querySelector('table.matrix-price-table');
    // Find the note div using any of the known IDs
    const noteDiv = document.querySelector('#matrix-note, #cap-matrix-note, #dtg-matrix-note, #sp-matrix-note');
    // Find the title element using any of the known IDs
    const titleElement = document.querySelector('#matrix-title, #cap-matrix-title, #dtg-matrix-title, #sp-matrix-title');

    debugCart("CHECK", "Price Table Found:", !!priceTable);
    debugCart("CHECK", "Note Div Found:", !!noteDiv, noteDiv ? noteDiv.id : 'Not Found');
    debugCart("CHECK", "Title Element Found:", !!titleElement, titleElement ? titleElement.id : 'Not Found');

    if (priceTable && noteDiv && titleElement) {
      debugCart("CHECK", "All elements found, proceeding to add button and link.");
      // Prevent adding multiple times by checking if container exists
      if (!document.getElementById('cart-button-container')) {
        addCartButton(noteDiv);         // Pass the found noteDiv
      } else {
        debugCart("CHECK", "Cart button container already exists, skipping addCartButton call.");
      }
      // Prevent adding multiple times by checking if link exists
      if (!document.getElementById('view-cart-link')) {
        addViewCartLink(titleElement);  // Pass the found titleElement
      } else {
        debugCart("CHECK", "View cart link already exists, skipping addViewCartLink call.");
      }
    } else {
      debugCart("CHECK", "Required elements not found, attempting retry via init logic.");
      // Optional: Add more specific logging about which element is missing
      if (!priceTable) debugCart("CHECK", "Missing: table.matrix-price-table");
      if (!noteDiv) debugCart("CHECK", "Missing: A note div (#matrix-note, #cap-matrix-note, etc.)");
      if (!titleElement) debugCart("CHECK", "Missing: A title element (#matrix-title, #cap-matrix-title, etc.)");
      // NOTE: Relying on the initialization retry in initCartIntegration, removed the direct retry here
    }
  }

  /**
   * Adds the main 'Add to Cart' button container, size inputs, and options.
   * @param {HTMLElement} noteDiv - The specific note div element found by checkAndAddCartButton.
   */
  function addCartButton(noteDiv) {
    // const noteDiv = document.getElementById('matrix-note'); // Removed: noteDiv is now passed as an argument
    if (!noteDiv) {
      debugCart("UI-ERROR", "addCartButton called without a valid noteDiv element.");
      return; // Exit if the noteDiv wasn't found/passed correctly
    }

    // Prevent adding multiple times (check might already be here)
    if (document.getElementById('cart-button-container')) {
       debugCart("UI", "Cart button container already exists, skipping add.");
       return;
    }

    const container = document.createElement('div');
    container.id = 'cart-button-container';
    container.style.marginTop = '20px';
    container.style.padding = '15px';
    container.style.backgroundColor = '#f8f8f8';
    container.style.borderRadius = '5px';
    container.style.border = '1px solid #ddd';

    const heading = document.createElement('h4');
    heading.textContent = 'Add to Quote';
    heading.style.marginBottom = '15px';
    container.appendChild(heading);

    // Size inputs section
    const sizeInputs = document.createElement('div');
    sizeInputs.style.display = 'flex';
    sizeInputs.style.flexWrap = 'wrap';
    sizeInputs.style.gap = '10px';
    sizeInputs.style.marginBottom = '15px';

    // Loading message while fetching sizes
    const loadingMsg = document.createElement('div');
    loadingMsg.textContent = 'Loading available sizes...';
    loadingMsg.style.fontStyle = 'italic';
    loadingMsg.style.color = '#666';
    sizeInputs.appendChild(loadingMsg);

    // Get product info from URL
    const urlParams = new URLSearchParams(window.location.search);
    const styleNumber = urlParams.get('StyleNumber');
    const colorCode = urlParams.get('COLOR');

    if (styleNumber && colorCode) {
      // Fetch inventory data to get available sizes
      fetchInventoryData(styleNumber, colorCode)
        .then(sizes => {
          // Remove loading message
          sizeInputs.removeChild(loadingMsg);

          if (sizes && sizes.length > 0) {
            // Create size inputs
            sizes.forEach(size => {
              const group = document.createElement('div');
              group.style.display = 'flex';
              group.style.flexDirection = 'column';

              const label = document.createElement('label');
              label.textContent = size;
              label.style.marginBottom = '5px';
              label.style.fontWeight = 'bold';

              const input = document.createElement('input');
              input.type = 'number';
              input.min = '0';
              input.value = '0';
              input.className = 'size-quantity-input';
              input.dataset.size = size;
              input.style.width = '60px';
              input.style.padding = '5px';

              group.appendChild(label);
              group.appendChild(input);
              sizeInputs.appendChild(group);
            });
          } else {
            // Fallback if no sizes found
            const noSizesMsg = document.createElement('div');
            noSizesMsg.textContent = 'No size information available';
            noSizesMsg.style.fontStyle = 'italic';
            noSizesMsg.style.color = '#666';
            sizeInputs.appendChild(noSizesMsg);
             // Add fallback sizes if API fails or returns no sizes
            addSizeInputs(sizeInputs, getFallbackSizes());
          }
        })
        .catch(error => {
          debugCart("INVENTORY-ERROR", 'Error fetching inventory data:', error);

          // Remove loading message
          if (loadingMsg.parentNode === sizeInputs) {
            sizeInputs.removeChild(loadingMsg);
          }

          // Show error message
          const errorMsg = document.createElement('div');
          errorMsg.textContent = 'Error loading size information';
          errorMsg.style.fontStyle = 'italic';
          errorMsg.style.color = '#dc3545';
          sizeInputs.appendChild(errorMsg);

          // Add fallback sizes
          addSizeInputs(sizeInputs, getFallbackSizes());
        });
    } else {
      // No style/color info, use fallback
      loadingMsg.textContent = 'No product information available';

      // Add fallback sizes
      addSizeInputs(sizeInputs, getFallbackSizes());
    }

    container.appendChild(sizeInputs);

    // Add embellishment options section
    const embType = detectEmbellishmentType();
    const optionsSection = createEmbellishmentOptionsUI(embType);
    container.appendChild(optionsSection);

    // Error container
    const errorDiv = document.createElement('div');
    errorDiv.id = 'cart-error-container';
    errorDiv.style.color = '#dc3545';
    errorDiv.style.marginBottom = '15px';
    errorDiv.style.display = 'none';
    container.appendChild(errorDiv);

    // Add to Cart button
    const button = document.createElement('button');
    button.textContent = 'Add to Cart';
    button.id = 'add-to-cart-button';
    button.style.backgroundColor = '#0056b3';
    button.style.color = 'white';
    button.style.border = 'none';
    button.style.borderRadius = '4px';
    button.style.padding = '10px 20px';
    button.style.cursor = 'pointer';
    button.style.fontWeight = 'bold';

    button.addEventListener('click', handleAddToCart);
    container.appendChild(button);

    // Use the passed noteDiv to insert the container
    noteDiv.parentNode.insertBefore(container, noteDiv.nextSibling);
    debugCart("UI", "Cart button added successfully");
  }

  // Create UI elements for embellishment options based on type
  function createEmbellishmentOptionsUI(embType) {
    const container = document.createElement('div');
    container.id = 'embellishment-options';
    container.style.marginBottom = '15px';
    container.style.padding = '10px';
    container.style.backgroundColor = '#f0f0f0';
    container.style.borderRadius = '5px';

    const heading = document.createElement('h5');
    heading.textContent = 'Embellishment Options';
    heading.style.marginTop = '0';
    heading.style.marginBottom = '10px';
    container.appendChild(heading);

    // Create different options based on embellishment type
    switch (embType) {
      case 'embroidery':
      case 'cap-embroidery':
        // Stitch count selection
        const stitchGroup = document.createElement('div');
        stitchGroup.className = 'option-group';
        stitchGroup.style.marginBottom = '10px';

        const stitchLabel = document.createElement('label');
        stitchLabel.textContent = 'Stitch Count:';
        stitchLabel.style.display = 'block';
        stitchLabel.style.marginBottom = '5px';
        stitchGroup.appendChild(stitchLabel);

        const stitchSelect = document.createElement('select');
        stitchSelect.id = 'stitch-count';
        stitchSelect.style.padding = '5px';
        stitchSelect.style.width = '100%';

        const stitchOptions = [
          { value: 5000, text: '5,000 stitches' },
          { value: 8000, text: '8,000 stitches (standard)' },
          { value: 10000, text: '10,000 stitches' },
          { value: 15000, text: '15,000 stitches' }
        ];

        stitchOptions.forEach(option => {
          const optElement = document.createElement('option');
          optElement.value = option.value;
          optElement.textContent = option.text;
          if (option.value === 8000) optElement.selected = true;
          stitchSelect.appendChild(optElement);
        });

        stitchGroup.appendChild(stitchSelect);
        container.appendChild(stitchGroup);

        // Location selection
        const locationGroup = document.createElement('div');
        locationGroup.className = 'option-group';

        const locationLabel = document.createElement('label');
        locationLabel.textContent = 'Location:';
        locationLabel.style.display = 'block';
        locationLabel.style.marginBottom = '5px';
        locationGroup.appendChild(locationLabel);

        const locationSelect = document.createElement('select');
        locationSelect.id = 'location';
        locationSelect.style.padding = '5px';
        locationSelect.style.width = '100%';

        const locationOptions = embType === 'embroidery' ?
          [
            { value: 'left-chest', text: 'Left Chest (standard)' },
            { value: 'right-chest', text: 'Right Chest' },
            { value: 'left-sleeve', text: 'Left Sleeve' },
            { value: 'right-sleeve', text: 'Right Sleeve' },
            { value: 'back', text: 'Back' }
          ] :
          [
            { value: 'front', text: 'Front (standard)' },
            { value: 'side', text: 'Side' },
            { value: 'back', text: 'Back' }
          ];

        locationOptions.forEach(option => {
          const optElement = document.createElement('option');
          optElement.value = option.value;
          optElement.textContent = option.text;
          if (option.value === (embType === 'embroidery' ? 'left-chest' : 'front')) {
            optElement.selected = true;
          }
          locationSelect.appendChild(optElement);
        });

        locationGroup.appendChild(locationSelect);
        container.appendChild(locationGroup);
        break;

      case 'dtg':
      case 'dtf':
        // Location selection
        const dtgLocationGroup = document.createElement('div');
        dtgLocationGroup.className = 'option-group';
        dtgLocationGroup.style.marginBottom = '10px';

        const dtgLocationLabel = document.createElement('label');
        dtgLocationLabel.textContent = 'Print Location:';
        dtgLocationLabel.style.display = 'block';
        dtgLocationLabel.style.marginBottom = '5px';
        dtgLocationGroup.appendChild(dtgLocationLabel);

        const dtgLocationSelect = document.createElement('select');
        dtgLocationSelect.id = 'location';
        dtgLocationSelect.style.padding = '5px';
        dtgLocationSelect.style.width = '100%';

        const dtgLocationOptions = [
          { value: 'FF', text: 'Full Front (standard)' },
          { value: 'FB', text: 'Full Back' },
          { value: 'LC', text: 'Left Chest' },
          { value: 'JF', text: 'Jacket Front' },
          { value: 'JB', text: 'Jacket Back' }
        ];

        dtgLocationOptions.forEach(option => {
          const optElement = document.createElement('option');
          optElement.value = option.value;
          optElement.textContent = option.text;
          if (option.value === 'FF') optElement.selected = true;
          dtgLocationSelect.appendChild(optElement);
        });

        dtgLocationGroup.appendChild(dtgLocationSelect);
        container.appendChild(dtgLocationGroup);

        // Color type selection
        const colorTypeGroup = document.createElement('div');
        colorTypeGroup.className = 'option-group';

        const colorTypeLabel = document.createElement('label');
        colorTypeLabel.textContent = 'Color Type:';
        colorTypeLabel.style.display = 'block';
        colorTypeLabel.style.marginBottom = '5px';
        colorTypeGroup.appendChild(colorTypeLabel);

        const colorTypeSelect = document.createElement('select');
        colorTypeSelect.id = 'color-type';
        colorTypeSelect.style.padding = '5px';
        colorTypeSelect.style.width = '100%';

        const colorTypeOptions = [
          { value: 'full-color', text: 'Full Color (standard)' },
          { value: 'white-only', text: 'White Only' }
        ];

        colorTypeOptions.forEach(option => {
          const optElement = document.createElement('option');
          optElement.value = option.value;
          optElement.textContent = option.text;
          if (option.value === 'full-color') optElement.selected = true;
          colorTypeSelect.appendChild(optElement);
        });

        colorTypeGroup.appendChild(colorTypeSelect);
        container.appendChild(colorTypeGroup);
        break;

      case 'screen-print':
        // Color count selection
        const colorCountGroup = document.createElement('div');
        colorCountGroup.className = 'option-group';
        colorCountGroup.style.marginBottom = '10px';

        const colorCountLabel = document.createElement('label');
        colorCountLabel.textContent = 'Number of Colors:';
        colorCountLabel.style.display = 'block';
        colorCountLabel.style.marginBottom = '5px';
        colorCountGroup.appendChild(colorCountLabel);

        const colorCountSelect = document.createElement('select');
        colorCountSelect.id = 'color-count';
        colorCountSelect.style.padding = '5px';
        colorCountSelect.style.width = '100%';

        for (let i = 1; i <= 6; i++) {
          const optElement = document.createElement('option');
          optElement.value = i;
          optElement.textContent = `${i} color${i > 1 ? 's' : ''}`;
          if (i === 1) optElement.selected = true;
          colorCountSelect.appendChild(optElement);
        }

        colorCountGroup.appendChild(colorCountSelect);
        container.appendChild(colorCountGroup);

        // Location selection
        const spLocationGroup = document.createElement('div');
        spLocationGroup.className = 'option-group';
        spLocationGroup.style.marginBottom = '10px';

        const spLocationLabel = document.createElement('label');
        spLocationLabel.textContent = 'Print Location:';
        spLocationLabel.style.display = 'block';
        spLocationLabel.style.marginBottom = '5px';
        spLocationGroup.appendChild(spLocationLabel);

        const spLocationSelect = document.createElement('select');
        spLocationSelect.id = 'location';
        spLocationSelect.style.padding = '5px';
        spLocationSelect.style.width = '100%';

        const spLocationOptions = [
          { value: 'front', text: 'Front (standard)' },
          { value: 'back', text: 'Back' },
          { value: 'left-sleeve', text: 'Left Sleeve' },
          { value: 'right-sleeve', text: 'Right Sleeve' }
        ];

        spLocationOptions.forEach(option => {
          const optElement = document.createElement('option');
          optElement.value = option.value;
          optElement.textContent = option.text;
          if (option.value === 'front') optElement.selected = true;
          spLocationSelect.appendChild(optElement);
        });

        spLocationGroup.appendChild(spLocationSelect);
        container.appendChild(spLocationGroup);

        // Additional options
        const additionalGroup = document.createElement('div');
        additionalGroup.className = 'option-group';

        // White base option
        const whiteBaseDiv = document.createElement('div');
        whiteBaseDiv.style.marginBottom = '5px';

        const whiteBaseCheck = document.createElement('input');
        whiteBaseCheck.type = 'checkbox';
        whiteBaseCheck.id = 'white-base';
        whiteBaseCheck.style.marginRight = '5px';

        const whiteBaseLabel = document.createElement('label');
        whiteBaseLabel.textContent = 'Requires white base (for dark garments)';
        whiteBaseLabel.htmlFor = 'white-base';

        whiteBaseDiv.appendChild(whiteBaseCheck);
        whiteBaseDiv.appendChild(whiteBaseLabel);
        additionalGroup.appendChild(whiteBaseDiv);

        // Special ink option
        const specialInkDiv = document.createElement('div');

        const specialInkCheck = document.createElement('input');
        specialInkCheck.type = 'checkbox';
        specialInkCheck.id = 'special-ink';
        specialInkCheck.style.marginRight = '5px';

        const specialInkLabel = document.createElement('label');
        specialInkLabel.textContent = 'Special ink (metallic, reflective, etc.)';
        specialInkLabel.htmlFor = 'special-ink';

        specialInkDiv.appendChild(specialInkCheck);
        specialInkDiv.appendChild(specialInkLabel);
        additionalGroup.appendChild(specialInkDiv);

        container.appendChild(additionalGroup);
        break;

      default:
        // Generic options if type can't be determined
        const noteDiv = document.createElement('div');
        noteDiv.textContent = 'Standard embellishment options will be applied';
        noteDiv.style.fontStyle = 'italic';
        container.appendChild(noteDiv);
    }

    return container;
  }

  // Direct API client for cart operations - use window scope to prevent redeclaration
  // This serves as a fallback/temporary storage mechanism when the main NWCACart is not available
  // Items stored here will be synchronized to the main cart system when possible
  if (!window.DirectCartAPI) {
    window.DirectCartAPI = {
      // API base URL - use the same server that hosts the cart-integration.js file
      baseUrl: config.apiBaseUrl,

      // Storage keys
      storageKeys: config.storageKeys,

      // Get session ID from localStorage
      getSessionId: function() {
        return localStorage.getItem(this.storageKeys.sessionId);
      },

      // Save session ID to localStorage
      saveSessionId: function(sessionId) {
        localStorage.setItem(this.storageKeys.sessionId, sessionId);
      },

      // Create a new cart session - use a fixed session ID that we know exists
      async createSession() {
        try {
          // Generate a session ID in the same format as cart.js
          const sessionId = 'sess_' + Math.random().toString(36).substring(2, 10);
          this.saveSessionId(sessionId);

          // Create session on the server
          try {
            const response = await fetch(`${this.baseUrl}/cart-sessions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                SessionID: sessionId,
                CreateDate: new Date().toISOString(),
                LastActivity: new Date().toISOString(),
                UserAgent: 'Cart Integration',
                IPAddress: '',
                IsActive: true
              })
            });

            if (!response.ok) {
              console.warn(`Failed to create session on server: ${response.status}`);
            }
          } catch (apiError) {
            console.warn('API error creating session:', apiError);
          }

          // Store cart data in localStorage
          const cartData = {
            sessionId: sessionId,
            items: [],
            created: new Date().toISOString()
          };
          localStorage.setItem(this.storageKeys.cartItems, JSON.stringify(cartData));

          debugCart("SESSION", "Created new session ID:", sessionId);
          return sessionId;
        } catch (error) {
          console.error('Error creating cart session:', error);
          throw error;
        }
      },

      // Get or create a session ID
      getOrCreateSessionId: async function() {
        const existingSessionId = this.getSessionId();
        debugCart("SESSION", `Checking existing session ID: ${existingSessionId || 'none'}`);

        if (existingSessionId) {
          try {
            // Verify the session exists and is active - use the correct query parameter format
            debugCart("SESSION", `Verifying session at ${this.baseUrl}/cart-sessions?sessionID=${existingSessionId}`);
            const response = await fetch(`${this.baseUrl}/cart-sessions?sessionID=${existingSessionId}`);

            if (response.ok) {
              const sessions = await response.json();
              debugCart("SESSION", `Received ${sessions ? sessions.length : 0} sessions from API`);

              // Check if we got any sessions back and if the first one is active
              if (sessions && sessions.length > 0 && sessions[0].IsActive) {
                debugCart("SESSION", "Using existing active session");
                return existingSessionId;
              } else {
                debugCart("SESSION", "Session exists but is inactive or not found in response");
              }
            } else {
              debugCart("SESSION", `Session verification failed with status: ${response.status}`);
            }

            // Session not found or not active, create a new one
            debugCart("SESSION", "Creating new session because existing session is invalid");
            return await this.createSession();
          } catch (error) {
            debugCart("SESSION-ERROR", "Error verifying session:", error);
            debugCart("SESSION", "Creating new session after verification error");
            return await this.createSession();
          }
        } else {
          // No existing session, create a new one
          debugCart("SESSION", "No existing session found, creating new one");
          return await this.createSession();
        }
      },

      // Add an item to the cart - store in localStorage only
      addToCart: async function(productData) {
        try {
          debugCart("CART-ADD-START", "Starting add to cart in DirectCartAPI", {
            styleNumber: productData.styleNumber,
            color: productData.color,
            embellishmentType: productData.embellishmentType,
            sizesCount: productData.sizes ? productData.sizes.length : 0
          });

          // Get or create a session ID
          const sessionId = await this.getOrCreateSessionId();
          debugCart("CART-ADD-SESSION", "Using session ID:", sessionId);

          // Get existing cart data from localStorage
          let cartData;
          try {
            const storedData = localStorage.getItem(this.storageKeys.cartItems);
            cartData = storedData ? JSON.parse(storedData) : { sessionId, items: [] };

            // Ensure cartData.items is defined and is an array
            if (!cartData.items || !Array.isArray(cartData.items)) {
              cartData.items = [];
            }

            debugCart("CART-ADD", "Retrieved existing cart with", cartData.items.length, "items");
          } catch (e) {
            debugCart("CART-ERROR", "Error parsing stored cart data:", e);
            cartData = { sessionId, items: [] };
            debugCart("CART-ADD", "Created new empty cart");
          }

          // Create a new cart item
          const newItem = {
            id: 'item_' + Date.now(),
            styleNumber: productData.styleNumber,
            color: productData.color,
            // Include colorCode if available
            colorCode: productData.colorCode || productData.color,
            embellishmentType: productData.embellishmentType,
            embellishmentOptions: productData.embellishmentOptions || {},
            dateAdded: new Date().toISOString(),
            status: 'Active',
             // Include imageUrl if available
            imageUrl: productData.imageUrl || null,
            sizes: productData.sizes.map(size => ({
              size: size.size,
              quantity: size.quantity,
              unitPrice: size.unitPrice
            }))
          };

          debugCart("CART-ADD", "Created new cart item:", {
            id: newItem.id,
            styleNumber: newItem.styleNumber,
            color: newItem.color,
            embellishmentType: newItem.embellishmentType,
            sizesCount: newItem.sizes.length
          });

          // Add to cart items
          cartData.items.push(newItem);
          debugCart("CART-ADD", "Cart now has", cartData.items.length, "items");

          // Save to localStorage
          localStorage.setItem(this.storageKeys.cartItems, JSON.stringify(cartData));
          debugCart("CART-ADD", "Cart saved to localStorage");

          // Try to synchronize with NWCACart if available
          try {
            if (window.NWCACart && typeof window.NWCACart.syncWithServer === 'function') {
              debugCart("CART-ADD-SYNC", "Attempting to sync with NWCACart");
              const syncResult = await window.NWCACart.syncWithServer();
              debugCart("CART-ADD-SYNC", "Sync result:", syncResult);
            } else if (window.parent && window.parent.NWCACart && typeof window.parent.NWCACart.syncWithServer === 'function') {
              debugCart("CART-ADD-SYNC", "Attempting to sync with parent window NWCACart");
              const syncResult = await window.parent.NWCACart.syncWithServer();
              debugCart("CART-ADD-SYNC", "Sync result:", syncResult);
            } else {
              debugCart("CART-ADD-SYNC", "NWCACart not available for sync");
            }
          } catch (syncError) {
            debugCart("CART-ADD-SYNC-ERROR", "Error syncing with NWCACart:", syncError);
          }

          // Try to synchronize cart systems
          try {
            debugCart("CART-ADD-SYNC", "Attempting to synchronize cart systems");
            const syncResult = await synchronizeCartSystems();
            debugCart("CART-ADD-SYNC", `Cart synchronization ${syncResult ? 'successful' : 'failed'}`);
          } catch (syncError) {
            debugCart("CART-ADD-SYNC-ERROR", "Error during cart synchronization:", syncError);
          }

          return { success: true, itemId: newItem.id };
        } catch (error) {
          debugCart("CART-ERROR", "Error adding to cart:", error);
          return { success: false, error: error.message };
        }
      },

      // Get all cart items for a session
      getCartItems: async function() {
        try {
          const sessionId = this.getSessionId();

          if (!sessionId) {
            return { success: false, error: 'No active cart session', items: [] }; // Return empty array on failure
          }

          // First try to get items from localStorage
          try {
            const storedData = localStorage.getItem(this.storageKeys.cartItems);
            if (storedData) {
              const cartData = JSON.parse(storedData);

              // Ensure cartData.items is defined and is an array
              if (!cartData.items || !Array.isArray(cartData.items)) {
                cartData.items = [];
                // Save the corrected data back to localStorage
                localStorage.setItem(this.storageKeys.cartItems, JSON.stringify(cartData));
              }

              return { success: true, items: cartData.items };
            }
          } catch (e) {
            debugCart("CART-ERROR", "Error parsing stored cart data:", e);
          }

          // If no items in localStorage, return empty (don't try API for DirectCartAPI)
          return { success: true, items: [] };

        } catch (error) {
          debugCart("CART-ERROR", "Error getting cart items:", error);
          return { success: false, error: error.message, items: [] }; // Return empty array on failure
        }
      },


      // Remove an item from the cart
      removeCartItem: async function(cartItemId) {
        try {
          // Remove from localStorage
          try {
            const storedData = localStorage.getItem(this.storageKeys.cartItems);
            if (storedData) {
              const cartData = JSON.parse(storedData);

              // Ensure cartData.items is defined and is an array
              if (!cartData.items || !Array.isArray(cartData.items)) {
                cartData.items = [];
              } else {
                cartData.items = cartData.items.filter(item => item && item.id !== cartItemId);
              }

              localStorage.setItem(this.storageKeys.cartItems, JSON.stringify(cartData));
               debugCart("CART-REMOVE", `Removed item ${cartItemId} from localStorage`);
            }
          } catch (e) {
            debugCart("CART-ERROR", "Error updating stored cart data:", e);
             throw new Error(`Failed to remove item from storage: ${e.message}`); // Re-throw to indicate failure
          }

          // No need to call API for DirectCartAPI removal
          return { success: true };
        } catch (error) {
          debugCart("CART-ERROR", "Error removing cart item:", error);
          return { success: false, error: error.message };
        }
      },

      // Submit cart as an order (placeholder - should likely trigger NWCACart submission)
      submitOrder: async function(customerInfo) {
          debugCart("ORDER-SUBMIT", "Submit order called in DirectCartAPI (placeholder)");
          // In a real scenario, this might trigger synchronization or display a message
          // to use the main cart page. For now, just return an error.
          return { success: false, error: 'Please use the main cart page to submit your order.' };
      },

      // Get cart count (number of items)
      getCartCount: async function() {
        try {
          // Get count from localStorage
          try {
            const storedData = localStorage.getItem(this.storageKeys.cartItems);
            if (storedData) {
              const cartData = JSON.parse(storedData);
              let count = 0;

              // Ensure cartData.items is defined and is an array
              if (!cartData.items || !Array.isArray(cartData.items)) {
                cartData.items = [];
                // Save the corrected data back to localStorage
                localStorage.setItem(this.storageKeys.cartItems, JSON.stringify(cartData));
              }

              cartData.items.forEach(item => {
                // Ensure item.sizes is defined and is an array
                if (item && item.sizes && Array.isArray(item.sizes)) {
                  item.sizes.forEach(size => {
                    count += parseInt(size.quantity) || 0; // Ensure quantity is parsed as integer
                  });
                }
              });

              return count;
            }
          } catch (e) {
            debugCart("CART-ERROR", "Error parsing stored cart data for count:", e);
          }

          return 0; // Return 0 if no data in localStorage
        } catch (error) {
          debugCart("CART-ERROR", "Error getting cart count:", error);
          return 0;
        }
      },

      // Calculate total amount from cart items (Placeholder - Pricing should be handled by main cart)
      calculateTotalAmount: function(items) {
         debugCart("TOTAL", "Calculating total amount in DirectCartAPI (placeholder - uses unitPrice if available)");
         let total = 0;

         if (!items || !Array.isArray(items)) {
           debugCart("TOTAL", "No valid items to calculate total");
           return 0;
         }

         try {
           items.forEach(item => {
             if (item.sizes && Array.isArray(item.sizes)) {
               item.sizes.forEach(size => {
                 const quantity = parseInt(size.quantity) || 0;
                 const unitPrice = parseFloat(size.unitPrice) || 0; // Use stored unit price
                 total += quantity * unitPrice;
               });
             }
           });
           debugCart("TOTAL", `Calculated total amount: $${total.toFixed(2)}`);
           return parseFloat(total.toFixed(2));
         } catch (error) {
           debugCart("TOTAL-ERROR", "Error calculating total amount:", error);
           return 0;
         }
      }
    };
  } // End of DirectCartAPI definition


async function handleAddToCart() {
  debugCart("ADD", "Starting add to cart process");
  const button = document.getElementById('add-to-cart-button');
  const errorDiv = document.getElementById('cart-error-container');

  if (button) {
    button.disabled = true;
    button.textContent = 'Adding...';
    button.classList.add('adding');
  }

  if (errorDiv) {
    errorDiv.style.display = 'none';
    errorDiv.textContent = '';
  }

  // Add loading indicator
  const loadingIndicator = document.createElement('div');
  loadingIndicator.id = 'cart-loading-indicator';
  loadingIndicator.textContent = 'Preparing product data...';
  loadingIndicator.style.color = '#0056b3';
  loadingIndicator.style.marginBottom = '10px';
  loadingIndicator.style.fontStyle = 'italic';

  if (errorDiv && errorDiv.parentNode) {
    errorDiv.parentNode.insertBefore(loadingIndicator, errorDiv);
  }

  try {
    // Update loading status
    loadingIndicator.textContent = 'Collecting product information...';

    const productData = getProductData(); // Get data for the item being added
    debugCart("ADD", "Product data collected", {
      styleNumber: productData.styleNumber,
      color: productData.color,
      sizes: productData.sizes ? productData.sizes.length : 0,
      embType: productData.embellishmentType
    });

    // Validate product data
    if (!productData.styleNumber || !productData.color) {
      throw new Error('Missing product information (style or color)');
    }

    if (!productData.sizes || productData.sizes.length === 0) {
      throw new Error('Please select at least one size and quantity');
    }

    // Update loading status
    loadingIndicator.textContent = 'Detecting cart system...';

    // Find available cart system BEFORE the check
    const cartSystem = detectAvailableCartSystem();
    if (!cartSystem) {
        throw new Error('Cart system not available. Please refresh the page and try again.');
    }
    debugCart("ADD", `Using ${cartSystem.source} cart system for checks and adding.`);


    // --- START: Embellishment Type Check ---
    debugCart("ADD", "Checking cart for existing embellishment type");
    let currentCartItems = [];
    try {
        // Fetch items using the detected cart system's API
        const cartResult = await cartSystem.api.getCartItems(); // Assuming getCartItems might be async
        if (cartResult && cartResult.success && Array.isArray(cartResult.items)) {
            currentCartItems = cartResult.items;
        } else {
             debugCart("ADD-WARN", "Could not retrieve items from cart system or cart is empty.");
        }
    } catch (cartError) {
        debugCart("ADD-ERROR", "Error fetching current cart items for type check:", cartError);
        // Decide if you want to proceed or stop if fetching items fails.
        // Let's proceed for now, assuming an empty cart if fetch fails.
        currentCartItems = [];
    }

    const newEmbType = productData.embellishmentType;
    debugCart("ADD", "New item type:", newEmbType, "Existing items found:", currentCartItems.length);

    if (currentCartItems.length > 0) {
      // Get the embellishment type from the first item in the cart
      // ** IMPORTANT: Verify 'embellishmentType' is the correct property name in your cart item data structure **
      // It might be 'ImprintType', 'decorationType', etc. depending on how NWCACart stores it.
      const existingEmbType = currentCartItems[0].embellishmentType; // <--- CHECK THIS PROPERTY NAME
      debugCart("ADD", "Existing cart type found:", existingEmbType);

      if (existingEmbType && newEmbType !== existingEmbType) {
          // Use the formatter from cart-ui.js if available, otherwise use a simple string
          const formatEmbType = typeof formatEmbellishmentType === 'function' ? formatEmbellishmentType : type => type ? type.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Unknown';
          const errorMsg = `You can only add items with the same decoration type to the cart. Your cart currently contains '${formatEmbType(existingEmbType)}' items. Please empty the cart or start a new order to add '${formatEmbType(newEmbType)}' items.`;
          debugCart("ADD-ERROR", "Embellishment type mismatch", { new: newEmbType, existing: existingEmbType });

          // Show error message visually in the errorDiv
          if (errorDiv) {
            errorDiv.textContent = errorMsg;
            errorDiv.style.display = 'block';
            errorDiv.style.backgroundColor = '#fff3cd'; // Warning background
            errorDiv.style.color = '#856404'; // Warning text
            errorDiv.style.border = '1px solid #ffeeba';
            errorDiv.style.padding = '10px';
            errorDiv.style.borderRadius = '4px';
            errorDiv.style.marginTop = '10px';
          }

          // Re-enable the button
          if (button) {
            button.disabled = false;
            button.textContent = 'Add to Cart';
            button.classList.remove('adding');
          }

          // Remove loading indicator
          if (loadingIndicator && loadingIndicator.parentNode) {
            loadingIndicator.parentNode.removeChild(loadingIndicator);
          }

          return; // Stop the add-to-cart process here
      } else if (!existingEmbType) {
           debugCart("ADD-WARN", "Could not determine embellishment type of existing cart item(s). Allowing add.");
      }
    } else {
      debugCart("ADD", "Cart is empty, no type conflict.");
    }
    // --- END: Embellishment Type Check ---


    // Update loading status
    loadingIndicator.textContent = `Adding to cart using ${cartSystem.source} system...`;

    let result;
    try {
      // Use the already detected cartSystem
      result = await cartSystem.api.addToCart(productData);
      debugCart("ADD", "API response", result);
    } catch (apiError) {
      debugCart("ADD", "API error", apiError);
      throw new Error(`Failed to add to cart: ${apiError.message}`);
    }

    // Remove loading indicator
    if (loadingIndicator && loadingIndicator.parentNode) {
      loadingIndicator.parentNode.removeChild(loadingIndicator);
    }

    if (result.success) {
      debugCart("ADD", "Item added successfully", result);

      // Create success message with View Cart button
      showSuccessWithViewCartButton();

      if (button) {
        button.textContent = 'Added to Cart ✓';
        button.classList.remove('adding');
        button.classList.add('success');

        setTimeout(() => {
          if (button && !button.disabled) { // Check if button still exists and isn't disabled by another process
             button.disabled = false;
             button.textContent = 'Add to Cart';
             button.classList.remove('success');
          }
        }, 3000); // Increased timeout slightly
      }

      // Update cart count in View Cart link
      try {
        const viewCartLink = document.getElementById('view-cart-link');
        if (viewCartLink) {
          const link = viewCartLink.querySelector('a');
          if (link) {
            // Use the already detected cartSystem
            if (cartSystem && typeof cartSystem.api.getCartCount === 'function') {
              // Ensure getCartCount is awaited if it's async
              const count = await cartSystem.api.getCartCount();
              if (count > 0) {
                link.textContent = `View Cart (${count})`;
              } else {
                 link.textContent = 'View Cart'; // Reset if count is 0
              }
            } else {
               debugCart("ADD-WARN", "Cannot update cart count - getCartCount function not found on detected cart system API.");
            }
          }
        }
      } catch (e) {
        debugCart("ADD-ERROR", "Error updating cart count", e);
      }
    } else {
      debugCart("ADD", "Add to cart failed with result", result);
      if (errorDiv) {
        errorDiv.textContent = (result && result.error) ?
          `Failed to add to cart: ${result.error}` :
          'Failed to add to cart. Please try again.';
        errorDiv.style.display = 'block';
      }

      if (button) {
        button.disabled = false;
        button.textContent = 'Add to Cart';
        button.classList.remove('adding');
      }
    }
  } catch (error) {
    // Remove loading indicator
    if (loadingIndicator && loadingIndicator.parentNode) {
      loadingIndicator.parentNode.removeChild(loadingIndicator);
    }

    debugCart("ADD-ERROR", error);

    if (errorDiv) {
      errorDiv.textContent = error.message || 'Unknown error adding to cart';
      errorDiv.style.display = 'block';
    }

    if (button) {
      button.disabled = false;
      button.textContent = 'Add to Cart';
      button.classList.remove('adding');
    }
  }
}


  // Function to show success message with View Cart button
  function showSuccessWithViewCartButton() {
    // Remove any existing success message
    const existingMessage = document.getElementById('cart-success-message');
    if (existingMessage) {
      existingMessage.remove();
    }

    // Create success message container
    const successDiv = document.createElement('div');
    successDiv.id = 'cart-success-message';
    successDiv.style.backgroundColor = '#d4edda';
    successDiv.style.color = '#155724';
    successDiv.style.padding = '15px';
    successDiv.style.marginTop = '15px';
    successDiv.style.borderRadius = '5px';
    successDiv.style.display = 'flex';
    successDiv.style.justifyContent = 'space-between';
    successDiv.style.alignItems = 'center';

    // Success message
    const messageText = document.createElement('div');
    messageText.textContent = 'Item added to cart successfully!';
    messageText.style.fontWeight = 'bold';

    // View Cart button
    const viewCartBtn = document.createElement('button');
    viewCartBtn.textContent = 'View Cart';
    viewCartBtn.style.backgroundColor = '#28a745';
    viewCartBtn.style.color = 'white';
    viewCartBtn.style.border = 'none';
    viewCartBtn.style.borderRadius = '4px';
    viewCartBtn.style.padding = '8px 15px';
    viewCartBtn.style.cursor = 'pointer';
    viewCartBtn.style.fontWeight = 'bold';

    // Add click event to navigate to cart.html
    viewCartBtn.addEventListener('click', function() {
      // Navigate to cart.html in the parent window
      try {
        if (window.parent && window.parent !== window) {
          window.parent.location.href = config.urls.cart;
        } else {
          // Fallback to current window if parent is not accessible
          window.location.href = config.urls.cart;
        }
      } catch (e) {
        debugCart("VIEW-CART", "Error navigating to cart:", e);
        // Fallback to current window
        window.location.href = config.urls.cart;
      }
    });

    // Add elements to success div
    successDiv.appendChild(messageText);
    successDiv.appendChild(viewCartBtn);

    // Add success div to the page
    const container = document.getElementById('cart-button-container');
    if (container) {
      container.appendChild(successDiv);
    }

    // Auto-remove after 10 seconds
    setTimeout(() => {
      if (successDiv && successDiv.parentNode) {
        successDiv.remove();
      }
    }, 10000);
  }


  function getProductData() {
    try {
      debugCart("PRODUCT", "Getting product data from form");

      // Get URL parameters
      const urlParams = new URLSearchParams(window.location.search);
      const styleNumber = urlParams.get('StyleNumber');
      const colorCode = urlParams.get('COLOR'); // This is usually the Color Name from product page

      // Validate required parameters
      if (!styleNumber) {
        console.error("Missing style number in URL parameters");
        throw new Error('Missing style number. Please ensure you are on a valid product page.');
      }

      if (!colorCode) { // colorCode here is actually the color name from the URL
        console.error("Missing color name in URL parameters");
        throw new Error('Missing color information. Please ensure you are on a valid product page.');
      }

       // Treat the COLOR param directly as the colorName
       const colorName = colorCode;
       debugCart("PRODUCT", `Using Color Name from URL: "${colorName}"`);

       // We might still need the Catalog Color code if the API needs it for inventory
       // Let's assume it might be stored globally by product.html script (needs confirmation)
       const catalogColor = window.selectedCatalogColor || colorName; // Fallback to name if global var not set
       debugCart("PRODUCT", `Using Catalog Color Code: "${catalogColor}" (may fallback to name)`);


      debugCart("PRODUCT", `Processing product: Style ${styleNumber}, Color ${colorName}`);

      // Auto-detect embellishment type based on DataPage ID or title
      const embellishmentType = detectEmbellishmentType();
      debugCart("PRODUCT", `Detected embellishment type: ${embellishmentType}`);

      // Get embellishment options from UI inputs
      const embOptions = getEmbellishmentOptionsFromUI(embellishmentType);
      debugCart("PRODUCT", "Embellishment options:", embOptions);

      // Try to extract product image URL
      const productImage = extractProductImageUrl();
      debugCart("PRODUCT", "Product image URL:", productImage || "Not found");

      // Get sizes and quantities
      const sizes = [];
      const inputs = document.querySelectorAll('.size-quantity-input');

      if (!inputs || inputs.length === 0) {
        console.warn("No size inputs found on page. This might happen if inventory fetch failed.");
        // Allow adding even without inputs if fallback pricing is acceptable
        // throw new Error('Size selection inputs not found. Please refresh the page and try again.');
      } else {
         debugCart("PRODUCT", `Found ${inputs.length} size inputs`);
         inputs.forEach(input => {
            const size = input.dataset.size;
            const quantity = parseInt(input.value) || 0;

            if (quantity > 0) {
                console.log(`Processing size ${size} with quantity ${quantity}`);
                const price = getPrice(size, quantity); // Get price *per unit* for this size/qty tier
                debugCart("PRODUCT", `Calculated price for size ${size}: $${price}`);

                sizes.push({
                size: size,
                quantity: quantity,
                unitPrice: price,
                warehouseSource: 'API' // Assuming price implies availability
                });
            }
         });
      }


      if (sizes.length === 0) {
        console.error("No sizes selected with quantity > 0");
        throw new Error('Please select at least one size and quantity.');
      }

      debugCart("PRODUCT", `Added ${sizes.length} sizes to cart`);

      // Construct and return the product data object
      const productData = {
        styleNumber: styleNumber,
        color: colorName, // Use the name from URL
        colorCode: catalogColor, // Use the catalog code (or name fallback)
        embellishmentType: embellishmentType,
        embellishmentOptions: embOptions,
        sizes: sizes,
        imageUrl: productImage
      };

      debugCart("PRODUCT", "Final product data:", productData);
      return productData;

    } catch (error) {
      debugCart("PRODUCT-ERROR", "Error in getProductData:", error);
      throw error; // Re-throw to be handled by the caller
    }
  }


  // Extract product image URL from the page
  function extractProductImageUrl() {
    // Try to find the main product image in current window (likely embedded in iframe)
    const mainImage = document.getElementById('main-product-image-dp2');
    if (mainImage && mainImage.src) {
      return mainImage.src;
    }

    // Try to find the main product image in parent window (if product.html hosts the iframe)
    try {
      if (window.parent && window.parent !== window) {
        const parentMainImage = window.parent.document.getElementById('main-product-image-dp2');
        if (parentMainImage && parentMainImage.src) {
          return parentMainImage.src;
        }
      }
    } catch (e) {
       debugCart("IMAGE-ERROR", "Error accessing parent window image", e);
    }


    // Fallback: Look for any image inside common Caspio containers (less reliable)
    const caspioImage = document.querySelector('.cbResultSetData img, .cbFormElement img');
     if (caspioImage && caspioImage.src) {
         return caspioImage.src;
     }

    debugCart("IMAGE-WARN", "Could not find product image via common selectors.");
    return null; // Return null if no image found
  }


  // Get embellishment options from UI inputs
  function getEmbellishmentOptionsFromUI(embType) {
    const options = {};

    switch (embType) {
      case 'embroidery':
      case 'cap-embroidery':
        const stitchCount = document.getElementById('stitch-count');
        if (stitchCount) {
          options.stitchCount = parseInt(stitchCount.value) || 8000;
        }

        const location = document.getElementById('location');
        if (location) {
          options.location = location.value || (embType === 'embroidery' ? 'left-chest' : 'front');
        }
        break;

      case 'dtg':
      case 'dtf':
        const dtgLocation = document.getElementById('location');
        if (dtgLocation) {
          options.location = dtgLocation.value || 'FF';
        }

        const colorType = document.getElementById('color-type');
        if (colorType) {
          options.colorType = colorType.value || 'full-color';
        }
        break;

      case 'screen-print':
        const colorCount = document.getElementById('color-count');
        if (colorCount) {
          options.colorCount = parseInt(colorCount.value) || 1;
        }

        const spLocation = document.getElementById('location');
        if (spLocation) {
          options.location = spLocation.value || 'front';
        }

        const whiteBase = document.getElementById('white-base');
        if (whiteBase) {
          options.requiresWhiteBase = whiteBase.checked;
        }

        const specialInk = document.getElementById('special-ink');
        if (specialInk) {
          options.specialInk = specialInk.checked;
        }
        break;
    }

    return options;
  }

  // Function to fetch inventory data and extract unique sizes
  async function fetchInventoryData(styleNumber, colorCode) {
      try {
        // colorCode here should ideally be the CATALOG_COLOR for API lookup
        debugCart("INVENTORY", `Workspaceing inventory data for style ${styleNumber}, color ${colorCode}`);

        // Use the config.apiBaseUrl instead of hardcoding the URL
        const apiUrl = `${config.apiBaseUrl}/inventory?styleNumber=${encodeURIComponent(styleNumber)}&color=${encodeURIComponent(colorCode)}`;
        debugCart("INVENTORY", `Inventory API URL: ${apiUrl}`);

        const response = await fetch(apiUrl);

        if (!response.ok) {
          // Try to get error body for more details
          let errorBody = `Inventory API returned ${response.status}: ${response.statusText}`;
           try { errorBody = await response.text(); } catch(e){}
          throw new Error(errorBody);
        }

        const inventoryData = await response.json();

        if (!Array.isArray(inventoryData) || inventoryData.length === 0) {
          debugCart("INVENTORY-WARN", 'No inventory data returned from API');
          return []; // Return empty array if no data
        }

        // Extract unique sizes and sort them (using SizeSortOrder if available)
        const sizeMap = new Map();
        inventoryData.forEach(item => {
           // Check if size exists and if total qty > 0 for that size across warehouses
           const totalQty = inventoryData.filter(i => i.size === item.size).reduce((sum, i) => sum + (parseInt(i.quantity) || 0), 0);
            if (item.size && !sizeMap.has(item.size) && totalQty > 0) {
                // Store size and its sort order (default to 99 if missing)
                 sizeMap.set(item.size, parseInt(item.SizeSortOrder) || 99);
            } else if (item.size && !sizeMap.has(item.size)) {
                 debugCart("INVENTORY", `Size ${item.size} found but has 0 total quantity, excluding.`);
            }
        });


        // Convert map to array, sort by sort order, then extract just the size names
        const sizes = Array.from(sizeMap.entries())
            .sort((a, b) => a[1] - b[1]) // Sort by SizeSortOrder (second element in entry)
            .map(entry => entry[0]); // Get only the size name (first element in entry)


        debugCart("INVENTORY", 'Available sizes with quantity > 0:', sizes);
        return sizes;
      } catch (error) {
        debugCart("INVENTORY-ERROR", 'Error fetching or processing inventory data:', error);
        // Don't re-throw here, let the caller handle it and use fallbacks
         return []; // Return empty array on error
      }
  }


  // Helper function to add size inputs
  function addSizeInputs(container, sizes) {
    // Clear existing inputs first to prevent duplicates if called multiple times
    const existingInputs = container.querySelectorAll('.size-input-group');
    existingInputs.forEach(el => el.remove());

    sizes.forEach(size => {
      const group = document.createElement('div');
      group.className = 'size-input-group'; // Add class for easier removal
      group.style.display = 'flex';
      group.style.flexDirection = 'column';

      const label = document.createElement('label');
      label.textContent = size;
      label.style.marginBottom = '5px';
      label.style.fontWeight = 'bold';

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.value = '0';
      input.className = 'size-quantity-input';
      input.dataset.size = size;
      input.style.width = '60px';
      input.style.padding = '5px';

      group.appendChild(label);
      group.appendChild(input);
      container.appendChild(group);
    });
  }


  function detectEmbellishmentType() {
    // Try to detect based on DataPage ID or wrapper ID
    if (document.getElementById('dp5-wrapper') ||
        document.querySelector('[id*="embroidery"]:not([id*="cap"])')) {
      return 'embroidery';
    }

    if (document.getElementById('dp7-wrapper') ||
        document.querySelector('[id*="cap-emb"]')) {
      return 'cap-embroidery';
    }

    if (document.getElementById('dp6-wrapper') ||
        document.querySelector('[id*="dtg"]')) {
      return 'dtg';
    }

    if (document.getElementById('dp8-wrapper') ||
        document.querySelector('[id*="screen"]')) {
      return 'screen-print';
    }

    if (document.getElementById('dtf-wrapper') ||
        document.querySelector('[id*="dtf"]')) {
      return 'dtf';
    }

    // Try to detect from URL or page title
    const url = window.location.href.toLowerCase();
    const title = document.title.toLowerCase();

    if (url.includes('embroidery') || title.includes('embroidery')) {
      if (url.includes('cap') || title.includes('cap')) {
        return 'cap-embroidery';
      }
      return 'embroidery';
    }

    if (url.includes('dtg') || title.includes('dtg')) {
      return 'dtg';
    }

    if (url.includes('screen') || title.includes('screen')) {
      return 'screen-print';
    }

     if (url.includes('dtf') || title.includes('dtf')) {
      return 'dtf';
    }

    // Default to embroidery if we can't detect
    debugCart("EMB-WARN", "Could not detect embellishment type, defaulting to 'embroidery'");
    return 'embroidery';
  }


 function getPrice(size, quantity) {
    try {
      let embType = detectEmbellishmentType();
      // Map detected type to the expected variable prefix (handle case variations)
      let prefix = embType.toLowerCase().replace('-', ''); // e.g., 'embroidery', 'capembroidery', 'dtg', 'screenprint', 'dtf'
        // Special case for dp5 (seems like a primary embroidery page)
        if (document.getElementById('dp5-wrapper') && prefix !== 'embroidery') {
             debugCart("PRICE-INFO", "Detected dp5-wrapper, forcing prefix to 'dp5'");
             prefix = 'dp5';
        } else if (prefix === 'embroidery' && document.getElementById('dp5-wrapper')) {
             prefix = 'dp5'; // Prefer dp5 if it exists for embroidery
        } else if (prefix === 'capembroidery') {
            prefix = 'dp7'; // Assuming dp7 is cap embroidery
        } else if (prefix === 'dtg') {
             prefix = 'dp6'; // Assuming dp6 is dtg
        } else if (prefix === 'screenprint') {
            prefix = 'dp8'; // Assuming dp8 is screenprint
        }
         // Add mapping for dtf if needed, e.g., prefix = 'dpX';

      let headers, prices, tiers;

      debugCart("PRICE", `Getting price for Size: ${size}, Quantity: ${quantity}, Embellishment: ${embType} (using prefix: ${prefix})`);

      // Try specific prefixes first, then generic 'dp5' as fallback
      const possiblePrefixes = [prefix, 'dp5'];

      for (const pfx of possiblePrefixes) {
           if (!headers && window[`${pfx}GroupedHeaders`]) {
                headers = window[`${pfx}GroupedHeaders`];
                debugCart("PRICE", `Found headers source: ${pfx}GroupedHeaders`);
           } else if (!headers && window[`${pfx}Headers`]) { // Fallback to non-grouped
                headers = window[`${pfx}Headers`];
                debugCart("PRICE", `Found headers source: ${pfx}Headers`);
           }

           if (!prices && window[`${pfx}GroupedPrices`]) {
                prices = window[`${pfx}GroupedPrices`];
                debugCart("PRICE", `Found prices source: ${pfx}GroupedPrices`);
           } else if (!prices && window[`${pfx}Prices`]) { // Fallback to non-grouped
                prices = window[`${pfx}Prices`];
                debugCart("PRICE", `Found prices source: ${pfx}Prices`);
            }

            if (!tiers && window[`${pfx}ApiTierData`]) {
                 tiers = window[`${pfx}ApiTierData`];
                 debugCart("PRICE", `Found tiers source: ${pfx}ApiTierData`);
            } else if (!tiers && window[`${pfx}TierData`]) { // Fallback to non-Api
                 tiers = window[`${pfx}TierData`];
                 debugCart("PRICE", `Found tiers source: ${pfx}TierData`);
            }
            // If we found all components with this prefix, stop searching
            if (headers && prices && tiers) break;
      }


      // --- Robustness Checks ---
      if (!headers || !prices || !tiers) {
        debugCart("PRICE-ERROR", `Missing pricing data components for ${embType} (tried prefixes: ${possiblePrefixes.join(', ')}):`, {
          headers: !!headers,
          prices: !!prices,
          tiers: !!tiers
        });
        const missingComponents = [];
        if (!headers) missingComponents.push('headers');
        if (!prices) missingComponents.push('prices');
        if (!tiers) missingComponents.push('tiers');
        debugCart("PRICE-ERROR", `Missing pricing components: ${missingComponents.join(', ')}`);
        const dataPageId = document.querySelector('[id^="cb_div_dp"]')?.id || 'unknown_datapage_id';
        debugCart("PRICE-ERROR", `DataPage ID (approx): ${dataPageId}`);
        debugCart("PRICE-ERROR", "Global pricing variables checked:", possiblePrefixes.map(pfx => `${pfx}GroupedHeaders`).join(', '), 'etc.');

        return getFallbackPrice(size, quantity, embType);
      }

      // Find size group (case-insensitive comparison)
        let sizeGroup = null;
        const upperSize = size.toUpperCase(); // Convert input size to uppercase once

        for (const header of headers) {
            const upperHeader = header.toUpperCase(); // Convert header to uppercase

            // Direct match (case-insensitive)
            if (upperHeader === upperSize) {
                sizeGroup = header; // Use original header case for lookup
                 debugCart("PRICE", `Found direct size match for ${size}: ${sizeGroup}`);
                 break;
            }

            // Range match (e.g., "S-XL")
            if (upperHeader.includes('-')) {
                const parts = header.split('-'); // Use original case header for splitting
                 const rangeStart = parts[0].trim().toUpperCase();
                 const rangeEnd = parts[1].trim().toUpperCase();
                // Simple alphabetical range check (may need SizeSortOrder for complex cases)
                if (upperSize >= rangeStart && upperSize <= rangeEnd) {
                     sizeGroup = header;
                     debugCart("PRICE", `Found size range match for ${size}: ${sizeGroup}`);
                     break;
                 }
            }
         }


      if (!sizeGroup) {
        debugCart("PRICE-ERROR", `No size group found for size ${size} in headers:`, headers);
        return getFallbackPrice(size, quantity, embType);
      }

      // Get price profile using the found sizeGroup key (case matters for object keys)
      const profile = prices[sizeGroup];
      if (!profile) {
        debugCart("PRICE-ERROR", `No price profile found for size group ${sizeGroup}`);
        return getFallbackPrice(size, quantity, embType);
      }

      // Find tier
      let tier = null;
      let highestMin = -1;

      // Ensure tiers is an object before iterating
       if (typeof tiers !== 'object' || tiers === null) {
           debugCart("PRICE-ERROR", "Tiers data is not a valid object:", tiers);
           return getFallbackPrice(size, quantity, embType);
       }

      for (const tierLabel in tiers) {
        // Check if tierLabel is a valid key in the profile object
         if (!profile.hasOwnProperty(tierLabel)) {
             debugCart("PRICE-WARN", `Tier label "${tierLabel}" not found in price profile for size group "${sizeGroup}". Skipping.`);
             continue; // Skip this tier if it doesn't exist for this size group
         }

        const tierInfo = tiers[tierLabel];
         // Check if tierInfo is valid and has MinQuantity
         if (typeof tierInfo === 'object' && tierInfo !== null && typeof tierInfo.MinQuantity !== 'undefined') {
             const minQty = parseInt(tierInfo.MinQuantity);
             if (!isNaN(minQty) && quantity >= minQty && minQty > highestMin) {
                 tier = tierLabel;
                 highestMin = minQty;
             }
         } else {
              debugCart("PRICE-WARN", `Invalid tier info for label "${tierLabel}":`, tierInfo);
         }
      }


      if (!tier) {
        debugCart("PRICE-ERROR", `No pricing tier found for quantity ${quantity}. Tiers checked:`, tiers);
        return getFallbackPrice(size, quantity, embType);
      }

      debugCart("PRICE", `Using tier ${tier} for quantity ${quantity}`);

      // Get price
      const price = parseFloat(profile[tier]) || 0; // Ensure price is a number
      if (price <= 0) {
        debugCart("PRICE-ERROR", `Invalid or zero price (${price}) found for size ${size}, tier ${tier}`);
        // Optionally return fallback or throw error depending on desired behavior for zero price
         return getFallbackPrice(size, quantity, embType);
      }

      debugCart("PRICE", `Final price for ${size}, quantity ${quantity}: $${price}`);
      return price;
    } catch (error) {
      debugCart("PRICE-ERROR", "Error finding price:", error);
      return getFallbackPrice(size, quantity, 'unknown'); // Pass generic type on error
    }
  }


  // Fallback pricing function when pricing data is not available
  function getFallbackPrice(size, quantity, embType) {
    debugCart("PRICE-FALLBACK", `Using fallback pricing for ${size}, quantity ${quantity}, type ${embType}`);

    // Base price by size
    let basePrice = 18.00; // Default for S-XL

    if (size === '2XL' || size === 'XXL') {
      basePrice = 22.00;
    } else if (size === '3XL') {
      basePrice = 23.00;
    } else if (size === '4XL') {
      basePrice = 25.00;
    } else if (size === '5XL') {
      basePrice = 27.00;
    } else if (size === '6XL') {
      basePrice = 28.00;
    }

    // Apply quantity discount
    if (quantity >= 72) {
      basePrice -= 2.00;
    } else if (quantity >= 48) {
      basePrice -= 1.00;
    }

    // Add embellishment cost
    let embCost = 0;
    if (embType === 'embroidery' || embType === 'cap-embroidery') {
      embCost = 3.50;
    } else if (embType === 'dtg' || embType === 'dtf') {
      embCost = 4.00;
    } else if (embType === 'screen-print') {
      embCost = 2.50;
    }

    const finalPrice = basePrice + embCost;
    debugCart("PRICE-FALLBACK", `Fallback price calculated: $${finalPrice.toFixed(2)}`);

    // Show a warning message to the user that fallback pricing is being used
    showFallbackPricingWarning();

    return finalPrice;
  }

  // Function to show a warning message when fallback pricing is used
  function showFallbackPricingWarning() {
    // Check if warning already exists
    if (document.getElementById('fallback-pricing-warning')) return;

    // Create warning element
    const warningDiv = document.createElement('div');
    warningDiv.id = 'fallback-pricing-warning';
    warningDiv.style.backgroundColor = '#fff3cd';
    warningDiv.style.color = '#856404';
    warningDiv.style.padding = '10px 15px';
    warningDiv.style.marginBottom = '15px';
    warningDiv.style.borderRadius = '4px';
    warningDiv.style.border = '1px solid #ffeeba';
    warningDiv.style.fontSize = '14px';

    // Add warning icon
    const warningIcon = document.createElement('span');
    warningIcon.innerHTML = '⚠️ ';
    warningIcon.style.marginRight = '5px';
    warningDiv.appendChild(warningIcon);

    // Add warning text
    const warningText = document.createElement('span');
    warningText.textContent = 'Note: Estimated pricing is being used. Final pricing may vary.';
    warningDiv.appendChild(warningText);

    // Add to page - find a good location
    const container = document.getElementById('cart-button-container');
    if (container) {
      // Insert at the top of the container
      container.insertBefore(warningDiv, container.firstChild);
    } else {
      // Fallback - add to error container if it exists
      const errorDiv = document.getElementById('cart-error-container');
      if (errorDiv && errorDiv.parentNode) {
        errorDiv.parentNode.insertBefore(warningDiv, errorDiv);
      }
    }
  }


  // Helper function to get fallback sizes
  function getFallbackSizes() {
    return ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
  }


  // Add a "View Cart" link to the top of the DataPage
  function addViewCartLink(titleElement) { // <-- Add titleElement argument here
    // Check if it already exists
    if (document.getElementById('view-cart-link')) return;

    // Clear any existing interval
    if (window.cartUpdateInterval) {
      clearInterval(window.cartUpdateInterval);
      window.cartUpdateInterval = null;
    }

    // Create link container
    const linkContainer = document.createElement('div');
    linkContainer.id = 'view-cart-link';
    linkContainer.style.textAlign = 'right';
    linkContainer.style.padding = '10px';
    linkContainer.style.marginBottom = '10px';

    // Create link
    const link = document.createElement('a');
    link.href = 'javascript:void(0)'; // Prevent navigation before count loads
    link.textContent = 'View Cart';
    link.style.color = '#0056b3';
    link.style.textDecoration = 'none';
    link.style.fontWeight = 'bold';
    link.style.cursor = 'pointer'; // Indicate it's clickable

    // Function to update cart count
    async function updateCartCount() {
        try {
            let count = 0;
            const cartSystem = detectAvailableCartSystem(); // Detect which cart system to use

            if (cartSystem && typeof cartSystem.api.getCartCount === 'function') {
                try {
                    // Use await as getCartCount might be async
                    count = await cartSystem.api.getCartCount();
                    debugCart("VIEW-CART", `Got count from ${cartSystem.source} system:`, count);
                } catch (countError) {
                     debugCart("VIEW-CART-ERROR", `Error getting count from ${cartSystem.source}:`, countError);
                     count = 0; // Default to 0 on error
                }
            } else {
                 debugCart("VIEW-CART-WARN", "No cart system found or getCartCount method missing.");
                 count = 0; // Default to 0 if no system found
            }

            // Update link text based on count
            if (count > 0) {
                link.textContent = `View Cart (${count})`;
            } else {
                link.textContent = 'View Cart';
            }
            // Update href only after count is potentially loaded
            link.href = config.urls.cart;

        } catch (e) {
            debugCart("VIEW-CART-ERROR", "Error in updateCartCount logic:", e);
            link.textContent = 'View Cart'; // Default on error
            link.href = config.urls.cart;
        }
    }


    // Initial update
    updateCartCount();

    // Set interval to update cart count periodically
    window.cartUpdateInterval = setInterval(updateCartCount, config.cartUpdateIntervalMs);

    // Add click event
    link.addEventListener('click', function(event) {
      event.preventDefault(); // Prevent default link behavior
      try {
        if (window.parent && window.parent !== window) {
          // Try to access parent location safely
           try {
               window.parent.location.href = config.urls.cart;
           } catch(parentAccessError) {
                debugCart("VIEW-CART-ERROR", "Could not access parent window location, navigating current window", parentAccessError);
                window.location.href = config.urls.cart;
           }
        } else {
          // Fallback to current window if parent is not accessible or same window
          window.location.href = config.urls.cart;
        }
      } catch (e) {
        debugCart("VIEW-CART-ERROR", "Error navigating to cart:", e);
        // Fallback to current window
        window.location.href = config.urls.cart;
      }
    });

    linkContainer.appendChild(link);

    // Add to page - use the passed titleElement
    // const titleElement = document.querySelector('h4[id="matrix-title"]'); // Removed: titleElement is now passed as an argument
    if (titleElement && titleElement.parentNode) { // <-- Use the passed titleElement here and check parentNode
      // Insert the link container *before* the found title element
      titleElement.parentNode.insertBefore(linkContainer, titleElement);
      debugCart("VIEW-CART", "View Cart link added before title:", titleElement.id);
    } else {
      // Fallback - add to top of body if title wasn't found (shouldn't happen if checkAndAddCartButton worked)
      debugCart("VIEW-CART-WARN", "Title element not provided or not found in DOM, adding View Cart link to body start.");
      document.body.insertBefore(linkContainer, document.body.firstChild);
    }
  }


  // Improved initialization function
  async function initializeCartSystems() {
    debugCart("INIT", "Starting cart systems initialization");

    // First try to initialize NWCACart if it's available but not initialized
    if (window.NWCACart && typeof window.NWCACart.initializeCart === 'function') {
      try {
        debugCart("INIT", "Initializing NWCACart in current window");
        await window.NWCACart.initializeCart();
        debugCart("INIT", "NWCACart initialization complete");
      } catch (e) {
        debugCart("INIT", "Error initializing NWCACart:", e);
      }
    } else {
      debugCart("INIT", "NWCACart not available for initialization");

      // Try to find NWCACart in the global scope after a short delay
      // This helps in cases where cart.js is loaded but NWCACart isn't immediately available
      setTimeout(async () => {
        if (window.NWCACart && typeof window.NWCACart.initializeCart === 'function') {
          try {
            debugCart("INIT", "Initializing NWCACart after delay");
            await window.NWCACart.initializeCart();
            debugCart("INIT", "Delayed NWCACart initialization complete");

            // Try to synchronize again after successful initialization
            try {
              const syncResult = await synchronizeCartSystems();
              debugCart("INIT", `Delayed cart synchronization ${syncResult ? 'successful' : 'failed'}`);
            } catch (syncError) {
              debugCart("INIT-ERROR", "Error during delayed cart synchronization:", syncError);
            }
          } catch (e) {
            debugCart("INIT", "Error in delayed NWCACart initialization:", e);
          }
        }
      }, 1000);
    }

    // Then initialize our direct integration (if not already done)
    if (!window.cartIntegrationInitialized) {
      debugCart("INIT", "Initializing cart integration UI components");
      window.initCartIntegration(); // This sets the flag and adds UI
    }

    // Try to synchronize carts regardless of NWCACart init status now
    // (DirectCartAPI might have items even if NWCACart failed/was slow)
    try {
      debugCart("INIT", "Attempting cart synchronization");
      const syncResult = await synchronizeCartSystems();
      debugCart("INIT", `Cart synchronization ${syncResult ? 'successful' : 'failed'}`);
    } catch (e) {
      debugCart("INIT-ERROR", "Error during cart synchronization:", e);
    }
  }


  // Improved initialization - try to initialize in sequence with better error handling
  document.addEventListener('DOMContentLoaded', function() {
    debugCart("INIT", "DOM content loaded, initializing cart systems");
    initializeCartSystems().catch(e => {
      debugCart("INIT-ERROR", "Error during DOMContentLoaded cart initialization:", e);
    });
  });

  // Also try to initialize immediately if DOMContentLoaded already fired
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    debugCart("INIT", "Document already ready, initializing cart systems immediately");
    setTimeout(() => {
      initializeCartSystems().catch(e => {
        debugCart("INIT-ERROR", "Error during immediate cart initialization:", e);
      });
    }, 500); // Short delay to ensure other scripts potentially run
  }


  // Signal that the cart integration is available
  window.nwcaCartIntegrationLoaded = true;
  debugCart("LOAD", "Cart integration script fully loaded and ready");

})(); // End of IIFE