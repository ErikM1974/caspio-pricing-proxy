// Cart integration for Caspio DataPages - Auto-detects embellishment type
function initCartIntegration() {
  console.log("Cart integration initialization started");
  checkAndAddCartButton();
}

function checkAndAddCartButton() {
  const noteDiv = document.getElementById('matrix-note');
  const tableBody = document.getElementById('matrix-price-body');
  
  if (noteDiv && tableBody && tableBody.children.length > 0) {
    addCartButton();
    addViewCartLink();
  } else {
    setTimeout(checkAndAddCartButton, 500);
  }
}

function addCartButton() {
  const noteDiv = document.getElementById('matrix-note');
  if (!noteDiv) return;
  
  if (document.getElementById('cart-button-container')) return;
  
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
        }
      })
      .catch(error => {
        console.error('Error fetching inventory data:', error);
        
        // Remove loading message
        sizeInputs.removeChild(loadingMsg);
        
        // Show error message
        const errorMsg = document.createElement('div');
        errorMsg.textContent = 'Error loading size information';
        errorMsg.style.fontStyle = 'italic';
        errorMsg.style.color = '#dc3545';
        sizeInputs.appendChild(errorMsg);
        
        // Add fallback sizes
        const fallbackSizes = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
        addSizeInputs(sizeInputs, fallbackSizes);
      });
  } else {
    // No style/color info, use fallback
    loadingMsg.textContent = 'No product information available';
    
    // Add fallback sizes
    const fallbackSizes = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
    addSizeInputs(sizeInputs, fallbackSizes);
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
  
  noteDiv.parentNode.insertBefore(container, noteDiv.nextSibling);
  console.log("Cart button added successfully");
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
if (!window.DirectCartAPI) {
  window.DirectCartAPI = {
  // API base URL - use the same server that hosts the cart-integration.js file
  baseUrl: 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api',
  
  // Storage keys
  storageKeys: {
    sessionId: 'nwca_cart_session_id',
    cartItems: 'nwca_cart_items'
  },
  
  // Get session ID from localStorage
  getSessionId: function() {
    return localStorage.getItem(this.storageKeys.sessionId);
  },
  
  // Save session ID to localStorage
  saveSessionId: function(sessionId) {
    localStorage.setItem(this.storageKeys.sessionId, sessionId);
  },
  
  // Create a new cart session
  createSession: async function() {
    try {
      // First try to use a fixed session ID that we know exists
      const sessionId = "9876";
      this.saveSessionId(sessionId);
      
      // Store cart data in localStorage
      const cartData = {
        sessionId: sessionId,
        items: [],
        created: new Date().toISOString()
      };
      localStorage.setItem(this.storageKeys.cartItems, JSON.stringify(cartData));
      
      return sessionId;
      
      /*
      // Uncomment this section if you want to create real sessions via API
      // This is currently disabled because the API returns 400 Bad Request
      
      // Create a simple session object - minimal data needed
      const sessionData = {
        // The server will generate a SessionID
        CreateDate: new Date().toISOString(),
        UserAgent: navigator.userAgent,
        IsActive: true
      };
      
      console.log("Creating session with data:", sessionData);
      
      const response = await fetch(`${this.baseUrl}/cart-sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sessionData)
      });
      
      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.status}`);
      }
      
      const result = await response.json();
      console.log("Session created:", result);
      
      // Extract session ID from response
      const newSessionId = result.cartSession || sessionId;
      this.saveSessionId(newSessionId);
      return newSessionId;
      */
    } catch (error) {
      console.error('Error creating cart session:', error);
      throw error;
    }
  },
  
  // Get or create a session ID
  getOrCreateSessionId: async function() {
    const existingSessionId = this.getSessionId();
    
    if (existingSessionId) {
      try {
        // Verify the session exists and is active
        const response = await fetch(`${this.baseUrl}/cart-sessions/${existingSessionId}`);
        
        if (response.ok) {
          const session = await response.json();
          if (session.IsActive) {
            return existingSessionId;
          }
        }
        
        // Session not found or not active, create a new one
        return await this.createSession();
      } catch (error) {
        console.error('Error verifying session:', error);
        return await this.createSession();
      }
    } else {
      // No existing session, create a new one
      return await this.createSession();
    }
  },
  
  // Add an item to the cart - store in localStorage only
  addToCart: async function(productData) {
    try {
      // Get or create a session ID
      const sessionId = await this.getOrCreateSessionId();
      
      // Get existing cart data from localStorage
      let cartData;
      try {
        const storedData = localStorage.getItem(this.storageKeys.cartItems);
        cartData = storedData ? JSON.parse(storedData) : { sessionId, items: [] };
      } catch (e) {
        console.error('Error parsing stored cart data:', e);
        cartData = { sessionId, items: [] };
      }
      
      // Create a new cart item
      const newItem = {
        id: 'item_' + Date.now(),
        styleNumber: productData.styleNumber,
        color: productData.color,
        embellishmentType: productData.embellishmentType,
        embellishmentOptions: productData.embellishmentOptions || {},
        dateAdded: new Date().toISOString(),
        status: 'Active',
        sizes: productData.sizes.map(size => ({
          size: size.size,
          quantity: size.quantity,
          unitPrice: size.unitPrice
        }))
      };
      
      // Add to cart items
      cartData.items.push(newItem);
      
      // Save to localStorage
      localStorage.setItem(this.storageKeys.cartItems, JSON.stringify(cartData));
      
      return { success: true };
    } catch (error) {
      console.error('Error adding to cart:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Get all cart items for a session
  getCartItems: async function() {
    try {
      const sessionId = this.getSessionId();
      
      if (!sessionId) {
        return { success: false, error: 'No active cart session' };
      }
      
      // First try to get items from localStorage
      try {
        const storedData = localStorage.getItem(this.storageKeys.cartItems);
        if (storedData) {
          const cartData = JSON.parse(storedData);
          return { success: true, items: cartData.items || [] };
        }
      } catch (e) {
        console.error('Error parsing stored cart data:', e);
      }
      
      // If no items in localStorage, try the API
      const response = await fetch(`${this.baseUrl}/cart-items?SessionID=${sessionId}`);
      
      if (!response.ok) {
        throw new Error(`Failed to get cart items: ${response.status}`);
      }
      
      const items = await response.json();
      
      // Get sizes for each item
      const itemsWithSizes = await Promise.all(items.map(async (item) => {
        try {
          const sizesResponse = await fetch(`${this.baseUrl}/cart-item-sizes?CartItemID=${item.CartItemID}`);
          
          if (sizesResponse.ok) {
            const sizes = await sizesResponse.json();
            return { ...item, sizes };
          }
          
          return item;
        } catch (error) {
          console.error(`Error fetching sizes for item ${item.CartItemID}:`, error);
          return item;
        }
      }));
      
      return { success: true, items: itemsWithSizes };
    } catch (error) {
      console.error('Error getting cart items:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Remove an item from the cart
  removeCartItem: async function(cartItemId) {
    try {
      // First try to remove from localStorage
      try {
        const storedData = localStorage.getItem(this.storageKeys.cartItems);
        if (storedData) {
          const cartData = JSON.parse(storedData);
          cartData.items = cartData.items.filter(item => item.id !== cartItemId);
          localStorage.setItem(this.storageKeys.cartItems, JSON.stringify(cartData));
          return { success: true };
        }
      } catch (e) {
        console.error('Error updating stored cart data:', e);
      }
      
      // If not in localStorage, try the API
      const response = await fetch(`${this.baseUrl}/cart-items/${cartItemId}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) {
        throw new Error(`Failed to remove cart item: ${response.status}`);
      }
      
      return { success: true };
    } catch (error) {
      console.error('Error removing cart item:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Submit cart as an order
  submitOrder: async function(customerInfo) {
    try {
      const sessionId = this.getSessionId();
      
      if (!sessionId) {
        return { success: false, error: 'No active cart session' };
      }
      
      // Get cart items
      const cartResult = await this.getCartItems();
      
      if (!cartResult.success || !cartResult.items || cartResult.items.length === 0) {
        return { success: false, error: 'No items in cart' };
      }
      
      // Create order data
      const orderData = {
        SessionID: sessionId,
        CustomerInfo: customerInfo,
        OrderDate: new Date().toISOString(),
        OrderStatus: 'New',
        Items: cartResult.items
      };
      
      // Submit order to API
      const response = await fetch(`${this.baseUrl}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderData)
      });
      
      if (!response.ok) {
        throw new Error(`Failed to submit order: ${response.status}`);
      }
      
      const orderResult = await response.json();
      
      // Clear cart in localStorage
      try {
        const storedData = localStorage.getItem(this.storageKeys.cartItems);
        if (storedData) {
          const cartData = JSON.parse(storedData);
          cartData.items = [];
          localStorage.setItem(this.storageKeys.cartItems, JSON.stringify(cartData));
        }
      } catch (e) {
        console.error('Error clearing stored cart data:', e);
      }
      
      return { success: true, order: orderResult };
    } catch (error) {
      console.error('Error submitting order:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Get cart count (number of items)
  getCartCount: async function() {
    try {
      // First try to get count from localStorage
      try {
        const storedData = localStorage.getItem(this.storageKeys.cartItems);
        if (storedData) {
          const cartData = JSON.parse(storedData);
          let count = 0;
          
          if (cartData.items && Array.isArray(cartData.items)) {
            cartData.items.forEach(item => {
              if (item.sizes && Array.isArray(item.sizes)) {
                item.sizes.forEach(size => {
                  count += size.quantity || 0;
                });
              }
            });
          }
          
          return count;
        }
      } catch (e) {
        console.error('Error parsing stored cart data for count:', e);
      }
      
      // If not in localStorage, try the API
      const cartResult = await this.getCartItems();
      
      if (!cartResult.success || !cartResult.items) {
        return 0;
      }
      
      let count = 0;
      
      cartResult.items.forEach(item => {
        if (item.sizes && Array.isArray(item.sizes)) {
          item.sizes.forEach(size => {
            count += size.quantity || 0;
          });
        }
      });
      
      return count;
    } catch (error) {
      console.error('Error getting cart count:', error);
      return 0;
    }
  }
  };
}

async function handleAddToCart() {
  const button = document.getElementById('add-to-cart-button');
  const errorDiv = document.getElementById('cart-error-container');
  
  if (button) {
    button.disabled = true;
    button.textContent = 'Adding...';
  }
  
  if (errorDiv) {
    errorDiv.style.display = 'none';
    errorDiv.textContent = '';
  }
  
  try {
    const productData = getProductData();
    
    if (!productData.styleNumber || !productData.color) {
      throw new Error('Missing product information');
    }
    
    if (!productData.sizes || productData.sizes.length === 0) {
      throw new Error('Please select at least one size and quantity');
    }
    
    let result;
    
    // Try to use parent window's NWCACart if available
    if (window.parent && window.parent.NWCACart && typeof window.parent.NWCACart.addToCart === 'function') {
      result = await window.parent.NWCACart.addToCart(productData);
    } else {
      // Use direct API client as fallback
      console.log("Parent NWCACart not available, using direct API client");
      result = await DirectCartAPI.addToCart(productData);
    }
    
    if (result.success) {
      // Create success message with View Cart button
      showSuccessWithViewCartButton();
      
      if (button) {
        button.textContent = 'Added to Cart ✓';
        setTimeout(() => {
          button.disabled = false;
          button.textContent = 'Add to Cart';
        }, 2000);
      }
    } else {
      if (errorDiv) {
        errorDiv.textContent = result.error || 'Failed to add to cart';
        errorDiv.style.display = 'block';
      }
      
      if (button) {
        button.disabled = false;
        button.textContent = 'Add to Cart';
      }
    }
  } catch (error) {
    if (errorDiv) {
      errorDiv.textContent = error.message;
      errorDiv.style.display = 'block';
    }
    
    if (button) {
      button.disabled = false;
      button.textContent = 'Add to Cart';
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
    if (window.parent) {
      window.parent.location.href = '/cart.html';
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
    if (successDiv.parentNode) {
      successDiv.remove();
    }
  }, 10000);
}

function getProductData() {
  const urlParams = new URLSearchParams(window.location.search);
  const styleNumber = urlParams.get('StyleNumber');
  const colorCode = urlParams.get('COLOR');
  const colorName = document.getElementById('matrix-color-info')?.textContent.replace('Color:', '').trim() || colorCode;
  
  // Auto-detect embellishment type based on DataPage ID or title
  const embellishmentType = detectEmbellishmentType();
  
  // Get embellishment options from UI inputs
  const embOptions = getEmbellishmentOptionsFromUI(embellishmentType);
  
  // Try to extract product image URL
  const productImage = extractProductImageUrl();
  
  // Get sizes and quantities
  const sizes = [];
  const inputs = document.querySelectorAll('.size-quantity-input');
  
  inputs.forEach(input => {
    const size = input.dataset.size;
    const quantity = parseInt(input.value) || 0;
    
    if (quantity > 0) {
      const price = getPrice(size, quantity);
      
      sizes.push({
        size: size,
        quantity: quantity,
        unitPrice: price,
        warehouseSource: 'API'
      });
    }
  });
  
  return {
    styleNumber: styleNumber,
    color: colorName,
    colorCode: colorCode,
    embellishmentType: embellishmentType,
    embellishmentOptions: embOptions,
    sizes: sizes,
    imageUrl: productImage
  };
}

// Extract product image URL from the page
function extractProductImageUrl() {
  // Try to find the main product image
  const mainImage = document.getElementById('main-product-image-dp2');
  if (mainImage && mainImage.src) {
    return mainImage.src;
  }
  
  // Try to find any product image in the parent window
  try {
    if (window.parent) {
      const parentMainImage = window.parent.document.getElementById('main-product-image-dp2');
      if (parentMainImage && parentMainImage.src) {
        return parentMainImage.src;
      }
    }
  } catch (e) {
    console.error("Error accessing parent window image:", e);
  }
  
  // Return null if no image found
  return null;
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
    const apiUrl = `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/inventory?styleNumber=${encodeURIComponent(styleNumber)}&color=${encodeURIComponent(colorCode)}`;
    
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      throw new Error(`Inventory API returned ${response.status}: ${response.statusText}`);
    }
    
    const inventoryData = await response.json();
    
    if (!Array.isArray(inventoryData) || inventoryData.length === 0) {
      console.warn('No inventory data returned');
      return [];
    }
    
    // Extract unique sizes and sort them
    const sizeMap = new Map();
    
    inventoryData.forEach(item => {
      if (item.size && !sizeMap.has(item.size)) {
        sizeMap.set(item.size, item.SizeSortOrder || 0);
      }
    });
    
    // Convert to array and sort by SizeSortOrder
    const sizes = Array.from(sizeMap.entries())
      .sort((a, b) => a[1] - b[1])
      .map(entry => entry[0]);
    
    console.log('Available sizes:', sizes);
    return sizes;
  } catch (error) {
    console.error('Error fetching inventory data:', error);
    throw error;
  }
}

// Helper function to add size inputs
function addSizeInputs(container, sizes) {
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
  console.warn("Could not detect embellishment type, defaulting to 'embroidery'");
  return 'embroidery';
}

function getPrice(size, quantity) {
  try {
    // Try to detect which pricing data variables are available
    let headers, prices, tiers;
    
    if (window.dp5GroupedHeaders && window.dp5GroupedPrices && window.dp5ApiTierData) {
      headers = window.dp5GroupedHeaders;
      prices = window.dp5GroupedPrices;
      tiers = window.dp5ApiTierData;
    } else if (window.dp6GroupedHeaders && window.dp6GroupedPrices && window.dp6ApiTierData) {
      headers = window.dp6GroupedHeaders;
      prices = window.dp6GroupedPrices;
      tiers = window.dp6ApiTierData;
    } else if (window.dp7GroupedHeaders && window.dp7GroupedPrices && window.dp7ApiTierData) {
      headers = window.dp7GroupedHeaders;
      prices = window.dp7GroupedPrices;
      tiers = window.dp7ApiTierData;
    } else if (window.dp8GroupedHeaders && window.dp8GroupedPrices && window.dp8ApiTierData) {
      headers = window.dp8GroupedHeaders;
      prices = window.dp8GroupedPrices;
      tiers = window.dp8ApiTierData;
    } else if (window.dtfGroupedHeaders && window.dtfGroupedPrices && window.dtfApiTierData) {
      headers = window.dtfGroupedHeaders;
      prices = window.dtfGroupedPrices;
      tiers = window.dtfApiTierData;
    } else {
      // Generic fallback - look for any variables with these patterns
      for (const key in window) {
        if (key.endsWith('GroupedHeaders')) headers = window[key];
        if (key.endsWith('GroupedPrices')) prices = window[key];
        if (key.endsWith('ApiTierData')) tiers = window[key];
      }
    }
    
    if (!headers || !prices || !tiers) return 0;
    
    // Find size group
    let sizeGroup = null;
    for (const header of headers) {
      if (header === size || 
          (header.includes('-') && 
           size >= header.split('-')[0] && 
           size <= header.split('-')[1])) {
        sizeGroup = header;
        break;
      }
    }
    
    if (!sizeGroup) return 0;
    
    // Get price profile
    const profile = prices[sizeGroup];
    if (!profile) return 0;
    
    // Find tier
    let tier = null;
    let highestMin = -1;
    
    for (const tierLabel in tiers) {
      const tierInfo = tiers[tierLabel];
      if (quantity >= tierInfo.MinQuantity && tierInfo.MinQuantity > highestMin) {
        tier = tierLabel;
        highestMin = tierInfo.MinQuantity;
      }
    }
    
    if (!tier) return 0;
    
    // Get price
    return profile[tier] || 0;
  } catch (error) {
    console.error("Error finding price:", error);
    return 0;
  }
}

// Add a "View Cart" link to the top of the DataPage
function addViewCartLink() {
  // Check if it already exists
  if (document.getElementById('view-cart-link')) return;
  
  // Create link container
  const linkContainer = document.createElement('div');
  linkContainer.id = 'view-cart-link';
  linkContainer.style.textAlign = 'right';
  linkContainer.style.padding = '10px';
  linkContainer.style.marginBottom = '10px';
  
  // Create link
  const link = document.createElement('a');
  link.href = 'javascript:void(0)';
  link.textContent = 'View Cart';
  link.style.color = '#0056b3';
  link.style.textDecoration = 'none';
  link.style.fontWeight = 'bold';
  
  // Add cart count if available
  updateCartCount();
  
  // Function to update cart count
  async function updateCartCount() {
    try {
      let count = 0;
      
      // Try to use parent window's NWCACart if available
      if (window.parent && window.parent.NWCACart && typeof window.parent.NWCACart.getCartCount === 'function') {
        count = window.parent.NWCACart.getCartCount();
      } else if (window.DirectCartAPI && typeof window.DirectCartAPI.getCartCount === 'function') {
        // Use DirectCartAPI as fallback
        count = await window.DirectCartAPI.getCartCount();
      }
      
      if (count > 0) {
        link.textContent = `View Cart (${count})`;
      } else {
        link.textContent = 'View Cart';
      }
    } catch (e) {
      console.error("Error getting cart count:", e);
    }
  }
  
  // Update cart count every 30 seconds
  setInterval(updateCartCount, 30000);
  
  // Add click event
  link.addEventListener('click', function() {
    if (window.parent) {
      window.parent.location.href = '/cart.html';
    }
  });
  
  linkContainer.appendChild(link);
  
  // Add to page - find a good location
  const titleElement = document.querySelector('h4[id="matrix-title"]');
  if (titleElement) {
    titleElement.parentNode.insertBefore(linkContainer, titleElement);
  } else {
    // Fallback - add to top of body
    document.body.insertBefore(linkContainer, document.body.firstChild);
  }
}

// Start the initialization
document.addEventListener('DOMContentLoaded', function() {
  console.log("Cart integration script loaded, waiting for DOM content loaded");
  initCartIntegration();
});

// Also try to initialize immediately in case DOMContentLoaded already fired
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  console.log("Cart integration script loaded, DOM already ready");
  setTimeout(initCartIntegration, 500);
}
