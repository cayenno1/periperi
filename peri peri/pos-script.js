// POS (Point of Sale) System Script

let posProducts = [];
let posCart = [];
let posFilteredProducts = [];
let posDailyServings = {}; // Cache for today's serving counts
let posSelectedCategory = 'all'; // Currently selected category filter
let posPaymentMethod = 'cash'; // Current payment method: 'cash' or 'gcash'
let posServiceType = 'dine-in'; // Current service type: 'dine-in' or 'take-out'
let walkInOrdersState = []; // Cached walk-in orders for log pagination
let walkInOrdersPage = 1;
const WALK_IN_ORDERS_PER_PAGE = 10;

let posPendingLinkedItems = null; // { product, quantity } when linked items modal is open

function generateCartLineId() {
    return 'line_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

// Initialize POS when page loads
document.addEventListener('DOMContentLoaded', async function() {
    await waitForFirebaseReady();
    await loadPOSProducts();
    renderPOSProducts();
    
    // Initialize service type (default to dine-in)
    selectServiceType('dine-in');
    
    // Don't load orders log on page load - will load when modal opens
});

// Wait for Firebase to be ready
async function waitForFirebaseReady() {
    if (window.db && window.firestoreFunctions) {
        return;
    }
    return new Promise((resolve) => {
        window.addEventListener('firebaseReady', resolve, { once: true });
    });
}

// Get today's date string (YYYY-MM-DD)
function getTodayDateString() {
    return new Date().toISOString().split('T')[0];
}

// Get today's date string in YYYYMMDD format for order IDs
function getTodayDateStringForOrderId() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

// Get and increment the daily order counter
async function getNextOrderNumber() {
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firestore is not ready yet.');
        }
        
        const dateString = getTodayDateStringForOrderId();
        const counterDocRef = fns.doc(window.db, 'order_counter', dateString);
        
        let orderNumber = 1;
        
        // Use transaction to safely get and increment the counter
        await fns.runTransaction(window.db, async (transaction) => {
            const counterDoc = await transaction.get(counterDocRef);
            
            if (counterDoc.exists) {
                const data = counterDoc.data();
                if (!data) {
                    // Document exists but data is null/undefined - treat as new document
                    orderNumber = 1;
                    transaction.set(counterDocRef, {
                        date: dateString,
                        count: 1,
                        createdAt: fns.serverTimestamp(),
                        updatedAt: fns.serverTimestamp()
                    });
                } else {
                    orderNumber = (data.count || 0) + 1;
                    transaction.update(counterDocRef, {
                        count: orderNumber,
                        updatedAt: fns.serverTimestamp()
                    });
                }
            } else {
                // First order of the day - initialize counter
                orderNumber = 1;
                transaction.set(counterDocRef, {
                    date: dateString,
                    count: 1,
                    createdAt: fns.serverTimestamp(),
                    updatedAt: fns.serverTimestamp()
                });
            }
        });
        
        return orderNumber;
    } catch (error) {
        console.error('Error getting next order number:', error);
        throw error;
    }
}

// Generate formatted order ID (e.g., 20260117-001)
function generateOrderId(dateString, orderNumber) {
    const paddedNumber = String(orderNumber).padStart(3, '0');
    return `${dateString}-${paddedNumber}`;
}

// Load daily servings from Firebase
async function loadDailyServings() {
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            return;
        }
        
        const today = getTodayDateString();
        posDailyServings = {};
        
        // Get all today's servings
        const servingsSnapshot = await fns.getDocs(fns.collection(window.db, 'dailyServings'));
        servingsSnapshot.forEach(doc => {
            const data = doc.data();
            if (data && data.date === today && data.menuItemId) {
                posDailyServings[data.menuItemId] = data.count || 0;
            }
        });
        
        // Also check for variation IDs
        posProducts.forEach(product => {
            if (product.isVariation && product.parentId) {
                // Use parent's serving count if variation doesn't have its own
                if (!posDailyServings[product.id] && posDailyServings[product.parentId] !== undefined) {
                    posDailyServings[product.id] = posDailyServings[product.parentId];
                }
            }
        });
        
    } catch (error) {
        console.error('Error loading daily servings:', error);
    }
}

// Load products from menu collection
async function loadPOSProducts() {
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firestore is not ready yet.');
        }
        
        const menuSnapshot = await fns.getDocs(fns.collection(window.db, 'menu'));
        posProducts = [];
        
        menuSnapshot.forEach(doc => {
            const data = doc.data();
            if (data && data.availability !== false && data.isActive !== false) {
                // Get maxServingsPerDay from menu item
                const maxServingsPerDay = data.maxServingsPerDay !== undefined && data.maxServingsPerDay !== null 
                    ? Number(data.maxServingsPerDay) 
                    : null;
                
                // Check if item has variations
                if (data.variations && Array.isArray(data.variations) && data.variations.length > 0) {
                    const baseName = data.foodName || data.name || data.displayName || 'Product';
                    // Add each variation as a separate product
                    data.variations.forEach((variation, index) => {
                        // Naming: "default name - variation" (e.g. chicken - whole)
                        const variationPart = variation.name || variation.size || '';
                        const variationDisplayName = variationPart ? `${baseName} - ${variationPart}` : baseName;
                        const variationPrice = variation.price || data.price || 0;
                        // Quantity: use only this variation's individual quantity (e.g. Large: 10, Small: 20).
                        // Do not use or display the overall/parent product quantity.
                        const variationQty = (variation.quantity !== undefined && variation.quantity !== null)
                            ? Number(variation.quantity)
                            : 0;
                        const variationId = variation.variationId || variation.id || `${doc.id}_var_${index}`;
                        
                        // Get variation's maxServingsPerDay (if set), otherwise use parent's
                        const varMaxServings = variation.maxServingsPerDay !== undefined && variation.maxServingsPerDay !== null
                            ? Number(variation.maxServingsPerDay)
                            : maxServingsPerDay;
                        
                        posProducts.push({
                            id: variationId,
                            menuId: doc.id,
                            name: variationDisplayName,
                            price: Number(variationPrice),
                            quantity: variationQty,
                            maxServingsPerDay: varMaxServings,
                            image: data.image || data.imageUrl || data.imageDataUrl || '',
                            category: data.category || '',
                            isVariation: true,
                            variationIndex: index,
                            parentId: doc.id,
                            includedSauces: data.includedSauces || null // Store linked sauces from parent
                        });
                    });
                } else {
                    // Add main product
                    // Non-variation: quantity from default (top-level)
                    posProducts.push({
                        id: doc.id,
                        menuId: doc.id,
                        name: data.foodName || data.name || data.displayName || 'Product',
                        price: Number(data.price || 0),
                        quantity: Number(data.quantity ?? 0),
                        maxServingsPerDay: maxServingsPerDay,
                        image: data.image || data.imageUrl || data.imageDataUrl || '',
                        category: data.category || '',
                        isVariation: false,
                        includedSauces: data.includedSauces || null // Store linked sauces
                    });
                }
            }
        });
        
        // Update category filters based on loaded products
        updatePOSCategoryFilters();
        
        // Apply filters after loading
        applyPOSFilters();
    } catch (error) {
        console.error('Error loading POS products:', error);
        document.getElementById('posProductsGrid').innerHTML = `
            <div class="pos-loading" style="grid-column: 1 / -1;">
                <i class="fas fa-exclamation-circle"></i>
                <p>Error loading products. Please refresh the page.</p>
            </div>
        `;
    }
}

// Update category filter buttons based on available products
function updatePOSCategoryFilters() {
    // Get all unique categories from loaded products
    const categories = new Set();
    posProducts.forEach(product => {
        if (product.category && product.category.trim()) {
            categories.add(product.category.trim());
        }
    });
    
    // Sort categories alphabetically
    const sortedCategories = Array.from(categories).sort();
    
    // Get the category filters container
    const filtersContainer = document.querySelector('.pos-category-filters');
    if (!filtersContainer) return;
    
    // Build HTML for category buttons
    let categoryButtonsHTML = `
        <button class="pos-category-btn active" onclick="filterByCategory('all')" data-category="all">
            <i class="fas fa-th"></i> All
        </button>
    `;
    
    // Add a button for each category
    sortedCategories.forEach(category => {
        categoryButtonsHTML += `
            <button class="pos-category-btn" onclick="filterByCategory('${escapeHtml(category)}')" data-category="${escapeHtml(category)}">
                ${escapeHtml(category)}
            </button>
        `;
    });
    
    // Update the container
    filtersContainer.innerHTML = categoryButtonsHTML;
    
    // Re-apply current filter to update active state
    filterByCategory(posSelectedCategory);
}

// Filter products by category
function filterByCategory(category) {
    posSelectedCategory = category;
    
    // Update active button state
    document.querySelectorAll('.pos-category-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.category === category) {
            btn.classList.add('active');
        }
    });
    
    // Apply filters
    applyPOSFilters();
}

// Apply all filters (category + search)
function applyPOSFilters() {
    const searchTerm = document.getElementById('posProductSearch').value.toLowerCase();
    
    posFilteredProducts = posProducts.filter(product => {
        // Category filter
        const categoryMatch = posSelectedCategory === 'all' || 
                             (product.category && product.category === posSelectedCategory);
        
        // Search filter
        const searchMatch = !searchTerm || 
                           product.name.toLowerCase().includes(searchTerm) ||
                           (product.category && product.category.toLowerCase().includes(searchTerm));
        
        return categoryMatch && searchMatch;
    });
    
    renderPOSProducts();
}

// Filter products (search only - maintains category filter)
function filterPOSProducts() {
    applyPOSFilters();
}

// Get remaining servings for a product
function getRemainingServings(product) {
    if (!product.maxServingsPerDay || product.maxServingsPerDay === 0) {
        return null; // Unlimited
    }
    
    const todayCount = posDailyServings[product.id] || 0;
    const remaining = Math.max(0, product.maxServingsPerDay - todayCount);
    return remaining;
}

// Get available quantity for a sauce (for modal display and availability).
// Always uses quantity, not maxServingsPerDay.
function getSauceAvailable(sauce) {
    if (sauce.quantity != null) return Number(sauce.quantity);
    return null;
}

// Get sauces from posProducts (category Sauce or similar) for the modal
function getSaucesForModal() {
    const cat = (c) => (c || '').toLowerCase();
    return posProducts.filter(p => 
        cat(p.category) === 'sauce' || cat(p.category).includes('sauce')
    );
}

// Check if product is available. Always uses quantity, not maxServingsPerDay.
function isProductAvailable(product, requestedQty = 1) {
    if (product.quantity == null || product.quantity === 0) return false;
    return true;
}

// Render products grid
function renderPOSProducts() {
    const grid = document.getElementById('posProductsGrid');
    
    if (posFilteredProducts.length === 0) {
        grid.innerHTML = `
            <div class="pos-loading" style="grid-column: 1 / -1;">
                <i class="fas fa-box-open"></i>
                <p>No products found</p>
            </div>
        `;
        return;
    }
    
    grid.innerHTML = posFilteredProducts.map(product => {
        const isAvailable = isProductAvailable(product);
        let stockClass = '';
        let stockText = '';
        // Always use quantity, not maxServingsPerDay
        const q = product.quantity;
        if (q == null || q === 0) {
            stockClass = 'out';
            stockText = 'Out of Stock';
        } else if (q < 5) {
            stockClass = 'low';
            stockText = `Stock: ${q}`;
        } else {
            stockText = `Stock: ${q}`;
        }
        return `
            <div class="pos-product-card ${!isAvailable ? 'disabled' : ''}" 
                 onclick="${isAvailable ? `addToCart('${product.id}')` : ''}">
                ${product.image ? 
                    `<img src="${product.image}" alt="${product.name}" class="pos-product-image" onerror="this.style.display='none'">` :
                    `<div class="pos-product-image" style="background: #e9ecef; display: flex; align-items: center; justify-content: center; color: #6c757d;">
                        <i class="fas fa-image" style="font-size: 2em;"></i>
                    </div>`
                }
                <div class="pos-product-name">${product.name}</div>
                <div class="pos-product-price">₱${product.price.toFixed(2)}</div>
                <div class="pos-product-stock ${stockClass}">${stockText}</div>
            </div>
        `;
    }).join('');
}

// Add product to cart (with optional quantity)
function addToCart(productId, quantity = 1) {
    const product = posProducts.find(p => p.id === productId);
    if (!product) return;
    
    // Check for linked items (includedSauces) - show modal if present
    if (product.includedSauces && Array.isArray(product.includedSauces) && product.includedSauces.length > 0) {
        if (!isProductAvailable(product, quantity)) {
            alert((product.quantity != null && product.quantity > 0) ? `Only ${product.quantity} in stock.` : 'This product is out of stock.');
            return;
        }
        openLinkedItemsModal(product, quantity);
        return;
    }
    
    if (!isProductAvailable(product, quantity)) {
        alert((product.quantity != null && product.quantity > 0) ? `Only ${product.quantity} in stock.` : 'This product is out of stock.');
        return;
    }
    
    // Check if product already in cart (never stack paid with free sauce — extra sauce is a separate line)
    const existingItem = posCart.find(item => item.id === productId && !item.freeWithPeriRibs);
    const newQty = existingItem ? existingItem.quantity + quantity : quantity;
    
    // Always use quantity, not maxServingsPerDay
    const cap = (product.quantity != null) ? Number(product.quantity) : 0;
    if (newQty > cap) {
        alert(cap === 0 ? 'This product is out of stock.' : `Only ${cap} in stock.`);
        return;
    }
    
    if (existingItem) {
        existingItem.quantity += quantity;
    } else {
        posCart.push({
            lineId: generateCartLineId(),
            id: productId,
            menuId: product.menuId,
            name: product.name,
            price: product.price,
            quantity: quantity,
            image: product.image,
            maxServingsPerDay: product.maxServingsPerDay,
            isVariation: product.isVariation,
            variationIndex: product.variationIndex,
            parentId: product.parentId
        });
    }
    
    updateCart();
    updatePaymentButton();
}


// Open linked items modal (for products with includedSauces)
function openLinkedItemsModal(product, quantity) {
    posPendingLinkedItems = { product, quantity };
    const titleEl = document.getElementById('posLinkedItemsModalTitle');
    if (titleEl) titleEl.textContent = `Linked Items for ${product.name}`;
    
    const listEl = document.getElementById('posLinkedItemsList');
    if (!listEl) return;
    
    // Get linked sauce IDs from includedSauces
    const linkedSauceIds = (product.includedSauces || []).map(s => s.sauceId || s.menuId || s.id).filter(Boolean);
    
    if (linkedSauceIds.length === 0) {
        listEl.innerHTML = '<p class="pos-sauce-none">No linked items found.</p>';
        document.getElementById('posLinkedItemsModal').style.display = 'block';
        return;
    }
    
    // Find sauce products that match the linked IDs
    const linkedSauces = posProducts.filter(p => linkedSauceIds.includes(p.id) || linkedSauceIds.includes(p.menuId));
    
    const inCartQty = (sauceId) => 
        posCart.filter(i => i.freeWithPeriRibs && (i.id === sauceId || i.menuId === sauceId)).reduce((s, c) => s + c.quantity, 0);
    
    if (linkedSauces.length === 0) {
        listEl.innerHTML = '<p class="pos-sauce-none">Linked items not found in products list.</p>';
    } else {
        listEl.innerHTML = linkedSauces.map(sauce => {
            const base = getSauceAvailable(sauce);
            const inCart = inCartQty(sauce.id);
            const avail = (base != null ? base : 0) - inCart;
            const isUnavailable = avail <= 0;
            const qtyLabel = avail != null ? `Qty: ${avail}` : '—';
            const sauceName = product.includedSauces.find(s => (s.sauceId || s.menuId || s.id) === sauce.id)?.sauceName || sauce.name;
            return `
                <div class="pos-sauce-item ${isUnavailable ? 'unavailable' : ''}" data-sauce-id="${sauce.id}">
                    <div class="pos-sauce-info">
                        <span class="pos-sauce-name">${escapeHtml(sauceName)}</span>
                        <span class="pos-sauce-qty">${qtyLabel}</span>
                    </div>
                    <button type="button" class="btn btn-outline-primary btn-sm pos-sauce-select" 
                            ${isUnavailable ? 'disabled' : ''} 
                            onclick="selectLinkedItem('${sauce.id}')">
                        <i class="fas fa-circle" style="font-size: 6px; margin-right: 6px; opacity: 0;"></i>Select
                    </button>
                </div>
            `;
        }).join('');
    }
    
    // Reset selected items and update button state
    selectedLinkedItems = [];
    updateAddButtonState();
    
    document.getElementById('posLinkedItemsModal').style.display = 'block';
}

// Track selected linked items
let selectedLinkedItems = [];

function selectLinkedItem(sauceId) {
    const item = document.querySelector(`.pos-sauce-item[data-sauce-id="${sauceId}"]`);
    if (!item) return;
    
    if (item.classList.contains('unavailable')) return;
    
    // Toggle selection
    const selectBtn = item.querySelector('.pos-sauce-select');
    const icon = selectBtn.querySelector('i');
    
    if (selectedLinkedItems.includes(sauceId)) {
        selectedLinkedItems = selectedLinkedItems.filter(id => id !== sauceId);
        item.classList.remove('selected');
        selectBtn.innerHTML = '<i class="fas fa-circle" style="font-size: 6px; margin-right: 6px; opacity: 0;"></i>Select';
        selectBtn.classList.remove('btn-primary');
        selectBtn.classList.add('btn-outline-primary');
    } else {
        selectedLinkedItems.push(sauceId);
        item.classList.add('selected');
        selectBtn.innerHTML = '<i class="fas fa-check" style="margin-right: 6px;"></i>Selected';
        selectBtn.classList.remove('btn-outline-primary');
        selectBtn.classList.add('btn-primary');
    }
    
    // Update Add button state
    updateAddButtonState();
}

function updateAddButtonState() {
    const addBtn = document.getElementById('posAddSelectedBtn');
    if (addBtn) {
        addBtn.disabled = selectedLinkedItems.length === 0;
    }
}

function closeLinkedItemsModal() {
    posPendingLinkedItems = null;
    selectedLinkedItems = [];
    const m = document.getElementById('posLinkedItemsModal');
    if (m) m.style.display = 'none';
    updateAddButtonState();
}

function confirmLinkedItems(selectedIds) {
    if (!posPendingLinkedItems) return;
    const { product, quantity } = posPendingLinkedItems;
    posPendingLinkedItems = null;
    closeLinkedItemsModal();
    
    // Add main item
    addToCartInternal(product, quantity);
    
    // Add selected linked items (or all if selectedIds is null)
    const linkedSauceIds = (product.includedSauces || []).map(s => s.sauceId || s.menuId || s.id).filter(Boolean);
    // If selectedIds is null, add all. If it's an empty array, add nothing. Otherwise use the provided array or selectedLinkedItems
    let itemsToAdd = [];
    if (selectedIds === null) {
        itemsToAdd = linkedSauceIds; // Add all
    } else if (Array.isArray(selectedIds)) {
        itemsToAdd = selectedIds; // Use provided array (could be empty for skip, or selected items for Add)
    } else {
        itemsToAdd = selectedLinkedItems; // Fallback to selectedLinkedItems
    }
    
    itemsToAdd.forEach(sauceId => {
        const sauce = posProducts.find(p => p.id === sauceId || p.menuId === sauceId);
        if (sauce) {
            const avail = getSauceAvailable(sauce);
            const inCart = posCart.filter(i => i.freeWithPeriRibs && (i.id === sauce.id || i.menuId === sauce.id)).reduce((s, c) => s + c.quantity, 0);
            const effective = (avail != null ? avail : 0) - inCart;
            if (effective >= quantity) {
                posCart.push({
                    lineId: generateCartLineId(),
                    id: sauce.id,
                    menuId: sauce.menuId,
                    name: sauce.name,
                    price: 0,
                    quantity: quantity,
                    image: sauce.image,
                    freeWithPeriRibs: true,
                    maxServingsPerDay: sauce.maxServingsPerDay,
                    isVariation: sauce.isVariation,
                    variationIndex: sauce.variationIndex,
                    parentId: sauce.parentId
                });
            }
        }
    });
    
    selectedLinkedItems = [];
    updateCart();
    updatePaymentButton();
}

// Internal add (no sauce popup) — used by confirmLinkedItems
function addToCartInternal(product, quantity) {
    const existingItem = posCart.find(item => item.id === product.id && !item.freeWithPeriRibs);
    const newQty = existingItem ? existingItem.quantity + quantity : quantity;
    
    // Always use quantity, not maxServingsPerDay
    const cap = (product.quantity != null) ? Number(product.quantity) : 0;
    if (newQty > cap) {
        alert(cap === 0 ? 'This product is out of stock.' : `Only ${cap} in stock.`);
        return;
    }
    
    if (existingItem) {
        existingItem.quantity += quantity;
    } else {
        posCart.push({
            lineId: generateCartLineId(),
            id: product.id,
            menuId: product.menuId,
            name: product.name,
            price: product.price,
            quantity: quantity,
            image: product.image,
            maxServingsPerDay: product.maxServingsPerDay,
            isVariation: product.isVariation,
            variationIndex: product.variationIndex,
            parentId: product.parentId
        });
    }
}

// Remove item from cart (by lineId so free and paid lines for same product stay separate)
function removeFromCart(lineId) {
    posCart = posCart.filter(item => item.lineId !== lineId);
    updateCart();
    updatePaymentButton();
}

// Update item quantity in cart (by increment/decrement)
function updateCartItemQuantity(lineId, change) {
    const item = posCart.find(i => i.lineId === lineId);
    if (!item) return;
    
    // Free sauces cannot be increased, only decreased
    if (item.freeWithPeriRibs && change > 0) {
        return; // Prevent increasing free sauce quantity
    }
    
    const newQty = item.quantity + change;
    if (newQty <= 0) {
        removeFromCart(lineId);
        return;
    }
    
    // Limit to double digits (99 max)
    if (newQty > 99) {
        alert('Maximum quantity is 99.');
        return;
    }
    
    // Always use quantity, not maxServingsPerDay
    const product = posProducts.find(p => p.id === item.id);
    if (product) {
        const cap = (product.quantity != null) ? Number(product.quantity) : 0;
        if (newQty > cap) {
            alert(cap === 0 ? 'This product is out of stock.' : `Only ${cap} in stock.`);
            return;
        }
    }
    
    item.quantity = newQty;
    updateCart();
    updatePaymentButton();
}

// Update item quantity directly (from input field)
function updateCartItemQuantityDirect(lineId, newQtyStr) {
    const item = posCart.find(i => i.lineId === lineId);
    if (!item) return;
    
    // Free sauces cannot have quantity changed by typing - only decrease button works
    if (item.freeWithPeriRibs) {
        // Reset to current quantity
        updateCart();
        return;
    }
    
    let newQty = parseInt(newQtyStr, 10);
    
    // Validate input
    if (isNaN(newQty) || newQty < 1) {
        // Reset to current quantity if invalid
        updateCart();
        return;
    }
    
    // Limit to double digits (99 max)
    if (newQty > 99) {
        newQty = 99;
        alert('Maximum quantity is 99.');
    }
    
    if (newQty <= 0) {
        removeFromCart(lineId);
        return;
    }
    
    // Always use quantity, not maxServingsPerDay
    const product = posProducts.find(p => p.id === item.id);
    if (product) {
        const cap = (product.quantity != null) ? Number(product.quantity) : 0;
        if (newQty > cap) {
            newQty = cap;
            alert(cap === 0 ? 'This product is out of stock.' : `Only ${cap} in stock.`);
        }
    }
    
    item.quantity = newQty;
    updateCart();
    updatePaymentButton();
}

// Update cart display
function updateCart() {
    const cartItems = document.getElementById('posCartItems');
    const clearBtn = document.getElementById('clearCartBtn');
    
    if (posCart.length === 0) {
        cartItems.innerHTML = `
            <div class="pos-empty-cart">
                <i class="fas fa-shopping-cart"></i>
                <p>Cart is empty</p>
            </div>
        `;
        clearBtn.style.display = 'none';
    } else {
        cartItems.innerHTML = posCart.map(item => {
            const lineId = item.lineId || (item.lineId = generateCartLineId());
            const itemTotal = item.price * item.quantity;
            const isFree = item.freeWithPeriRibs;
            const nameDisplay = item.name;
            const priceDisplay = isFree ? 'Free' : `₱${item.price.toFixed(2)} each`;
            return `
                <div class="pos-cart-item">
                    <div class="pos-cart-item-info">
                        <div class="pos-cart-item-name">${nameDisplay}</div>
                        <div class="pos-cart-item-price">${priceDisplay}</div>
                    </div>
                    <div class="pos-cart-item-controls">
                        <div class="pos-cart-item-qty">
                            <button onclick="updateCartItemQuantity('${lineId}', -1)" ${isFree ? '' : ''}>-</button>
                            <input type="number" 
                                   class="pos-cart-qty-input ${isFree ? 'disabled-input' : ''}" 
                                   value="${item.quantity}" 
                                   min="1" 
                                   max="99" 
                                   ${isFree ? 'readonly disabled' : ''}
                                   onchange="${isFree ? '' : `updateCartItemQuantityDirect('${lineId}', this.value)`}"
                                   onkeydown="${isFree ? 'return false;' : `return event.key !== 'Enter' || (event.preventDefault(), updateCartItemQuantityDirect('${lineId}', this.value), false)`}"
                                   onclick="${isFree ? '' : 'this.select()'}">
                            <button onclick="updateCartItemQuantity('${lineId}', 1)" ${isFree ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>+</button>
                        </div>
                        <div class="pos-cart-item-total">${isFree ? 'Free' : '₱' + itemTotal.toFixed(2)}</div>
                        <button class="pos-cart-item-remove" onclick="removeFromCart('${lineId}')" title="Remove">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
        clearBtn.style.display = 'block';
    }
    
    calculateChange();
}

// Select service type (Dine In / Take Out)
function selectServiceType(type) {
    posServiceType = type;
    
    // Update button styles
    document.querySelectorAll('.pos-service-type-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const tableNumberSection = document.getElementById('tableNumberSection');
    
    if (type === 'dine-in') {
        document.getElementById('dineInBtn').classList.add('active');
        // Show table number section for dine-in
        if (tableNumberSection) {
            tableNumberSection.style.display = 'flex';
        }
    } else if (type === 'take-out') {
        document.getElementById('takeOutBtn').classList.add('active');
        // Hide table number section for take-out
        if (tableNumberSection) {
            tableNumberSection.style.display = 'none';
        }
        // Clear table number when switching to take-out
        const tableInput = document.getElementById('posTableNumber');
        if (tableInput) {
            tableInput.value = '';
        }
    }
}

// Validate table number (1-10)
function validateTableNumber() {
    const tableInput = document.getElementById('posTableNumber');
    if (!tableInput) return;
    
    let value = parseInt(tableInput.value, 10);
    
    if (isNaN(value) || value < 1) {
        tableInput.value = '';
    } else if (value > 10) {
        tableInput.value = 10;
        alert('Maximum table number is 10.');
    }
}

// Select payment method
function selectPaymentMethod(method) {
    posPaymentMethod = method;
    
    // Update button styles
    document.querySelectorAll('.pos-payment-method-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    if (method === 'cash') {
        document.getElementById('cashPaymentBtn').classList.add('active');
        document.getElementById('cashPaymentSection').style.display = 'block';
        document.getElementById('cashChangeSection').style.display = 'block';
    } else if (method === 'gcash') {
        document.getElementById('gcashPaymentBtn').classList.add('active');
        document.getElementById('cashPaymentSection').style.display = 'none';
        document.getElementById('cashChangeSection').style.display = 'none';
        document.getElementById('posCashReceived').value = '';
    }
    
    calculateChange();
}

// Calculate change and totals
function calculateChange() {
    const subtotal = posCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    // Check for discount
    const hasDiscount = document.getElementById('posDiscountToggle').checked;
    const discountPercent = hasDiscount ? 20 : 0;
    const discountAmount = hasDiscount ? subtotal * 0.20 : 0;
    const total = subtotal - discountAmount;
    
    // Update display
    document.getElementById('posSubtotalDisplay').textContent = `₱${subtotal.toFixed(2)}`;
    
    if (hasDiscount) {
        document.getElementById('posDiscountRow').style.display = 'flex';
        document.getElementById('posDiscountAmount').textContent = `-₱${discountAmount.toFixed(2)}`;
    } else {
        document.getElementById('posDiscountRow').style.display = 'none';
    }
    
    document.getElementById('posTotalDisplay').textContent = `₱${total.toFixed(2)}`;
    
    // Calculate change (only for cash payments)
    if (posPaymentMethod === 'cash') {
        const cashReceived = parseFloat(document.getElementById('posCashReceived').value) || 0;
        const change = cashReceived - total;
        
        document.getElementById('posChange').value = change >= 0 ? `₱${change.toFixed(2)}` : '₱0.00';
        document.getElementById('posChange').style.color = change >= 0 ? '#7E2021' : '#dc3545';
    } else {
        // GCash - exact amount, no change
        document.getElementById('posChange').value = '₱0.00';
        document.getElementById('posChange').style.color = '#7E2021';
    }
    
    updatePaymentButton();
}

// Update payment button state
function updatePaymentButton() {
    const subtotal = posCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const hasDiscount = document.getElementById('posDiscountToggle').checked;
    const discountAmount = hasDiscount ? subtotal * 0.20 : 0;
    const total = subtotal - discountAmount;
    
    const processBtn = document.getElementById('processPaymentBtn');
    
    if (posCart.length === 0) {
        processBtn.disabled = true;
        return;
    }
    
    if (posPaymentMethod === 'cash') {
        const cashReceived = parseFloat(document.getElementById('posCashReceived').value) || 0;
        processBtn.disabled = cashReceived < total;
    } else if (posPaymentMethod === 'gcash') {
        // GCash always enabled if cart has items (exact amount, no change needed)
        processBtn.disabled = false;
    } else {
        processBtn.disabled = true;
    }
}

// Clear cart
function clearCart() {
    if (posCart.length === 0) return;
    if (confirm('Clear all items from cart?')) {
        posCart = [];
        updateCart();
        updatePaymentButton();
    }
}

// Clear all (new transaction)
function clearAll() {
    if (confirm('Start a new transaction? This will clear the cart and payment.')) {
        posCart = [];
        document.getElementById('posCashReceived').value = '';
        document.getElementById('posCustomerName').value = '';
        document.getElementById('posTableNumber').value = '';
        document.getElementById('posDiscountToggle').checked = false;
        document.getElementById('posProductSearch').value = '';
        selectPaymentMethod('cash'); // Reset to cash
        selectServiceType('dine-in'); // Reset to dine-in
        updateCart();
        calculateChange();
        filterPOSProducts();
    }
}

// Process payment and save order
async function processPayment() {
    if (posCart.length === 0) {
        alert('Cart is empty.');
        return;
    }
    
    const subtotal = posCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const hasDiscount = document.getElementById('posDiscountToggle').checked;
    const discountPercent = hasDiscount ? 20 : 0;
    const discountAmount = hasDiscount ? subtotal * 0.20 : 0;
    const total = subtotal - discountAmount;
    
    // Validate payment based on method
    if (posPaymentMethod === 'cash') {
        const cashReceived = parseFloat(document.getElementById('posCashReceived').value) || 0;
        if (cashReceived < total) {
            alert('Cash received is less than total amount.');
            return;
        }
    } else if (posPaymentMethod === 'gcash') {
        // GCash - exact amount, no validation needed
    }
    
    // Get customer name (optional but recommended)
    const customerName = document.getElementById('posCustomerName').value.trim();
    if (!customerName) {
        const proceed = confirm('No customer name entered. Do you want to proceed without a customer name?');
        if (!proceed) {
            document.getElementById('posCustomerName').focus();
            return;
        }
    }
    
    // Get table number (only for dine-in, 1-10)
    let tableNumber = null;
    if (posServiceType === 'dine-in') {
        const tableInput = document.getElementById('posTableNumber').value.trim();
        if (tableInput) {
            const tableNum = parseInt(tableInput, 10);
            if (!isNaN(tableNum) && tableNum >= 1 && tableNum <= 10) {
                tableNumber = tableNum.toString();
            }
        }
    }
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firestore is not ready yet.');
        }
        
        // Prepare order items with all necessary fields for Firebase
        const orderItems = posCart.map(item => {
            const orderItem = {
                itemId: item.menuId, // Parent menu item ID
                id: item.id, // Variation ID or menu item ID
                name: item.name,
                price: item.price,
                quantity: item.quantity
            };
            
            // Add variation info if it's a variation
            if (item.isVariation) {
                orderItem.variationIndex = item.variationIndex;
                orderItem.isVariation = true;
                orderItem.variationId = item.id;
            }
            
            if (item.freeWithPeriRibs) {
                orderItem.freeWithPeriRibs = true;
            }
            
            return orderItem;
        });
        
        // Get staff session info for order tracking
        let staffInfo = null;
        try {
            const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
            if (session) {
                const staffSession = JSON.parse(session);
                staffInfo = {
                    staffId: staffSession.staffId || staffSession.id || '',
                    staffName: staffSession.firstName && staffSession.lastName 
                        ? `${staffSession.firstName} ${staffSession.lastName}` 
                        : staffSession.email || 'Staff',
                    role: staffSession.role || ''
                };
            }
        } catch (e) {
            console.warn('Could not get staff session:', e);
        }
        
        // Get next order number for today
        const orderNumber = await getNextOrderNumber();
        const dateString = getTodayDateStringForOrderId();
        const formattedOrderId = generateOrderId(dateString, orderNumber);
        
        // Create order document with walkin label
        const orderData = {
            orderId: formattedOrderId, // Store the formatted order ID
            items: orderItems,
            subtotal: subtotal,
            discount: hasDiscount ? {
                type: 'Senior/PWD',
                percent: discountPercent,
                amount: discountAmount
            } : null,
            total: total,
            paymentMode: posPaymentMethod === 'gcash' ? 'GCash' : 'Cash',
            paymentAmount: posPaymentMethod === 'gcash' ? total : parseFloat(document.getElementById('posCashReceived').value) || 0,
            change: posPaymentMethod === 'cash' ? (parseFloat(document.getElementById('posCashReceived').value) || 0) - total : 0,
            status: 'completed',
            serviceType: posServiceType, // 'dine-in' or 'take-out'
            isGuest: true,
            walkin: true, // Label to identify POS/walk-in orders
            customerName: customerName || 'Walk-in Customer', // Customer name from input
            tableNumber: tableNumber || null, // Table number if provided (only for dine-in)
            paymentVerified: true,
            paymentVerifiedAt: fns.serverTimestamp(),
            createdAt: fns.serverTimestamp(),
            updatedAt: fns.serverTimestamp(),
            deliveryInfo: {
                serviceType: posServiceType,
                deliveryMethod: posServiceType === 'take-out' ? 'take-out' : 'dine-in',
                walkin: true,
                customerName: customerName || 'Walk-in Customer',
                tableNumber: tableNumber || null
            },
            // Add staff info if available
            ...(staffInfo ? {
                processedBy: staffInfo.staffId,
                processedByName: staffInfo.staffName,
                processedByRole: staffInfo.role
            } : {})
        };
        
        // Save order to Firestore orders collection with custom ID
        const orderRef = fns.doc(window.db, 'orders', formattedOrderId);
        await fns.setDoc(orderRef, orderData);
        const orderId = formattedOrderId;
        
        console.log('Order saved to Firebase:', orderId, orderData);
        
        // Deduct daily servings for each item (this also updates Firebase)
        await deductStockForOrder(orderItems);
        
        // Verify order was saved
        const savedOrder = await fns.getDoc(orderRef);
        if (!savedOrder.exists) {
            throw new Error('Order was not saved to Firebase');
        }
        
        console.log('Order successfully saved to Firebase orders collection with ID:', orderId);
        
        // Get payment details for receipt
        const paymentAmount = posPaymentMethod === 'gcash' ? total : parseFloat(document.getElementById('posCashReceived').value) || 0;
        const change = posPaymentMethod === 'cash' ? paymentAmount - total : 0;
        
        // Show receipt with all details
        showReceipt(orderId, orderData, paymentAmount, change, customerName, tableNumber);
        
        // Clear cart and reset
        posCart = [];
        document.getElementById('posCashReceived').value = '';
        document.getElementById('posCustomerName').value = '';
        document.getElementById('posTableNumber').value = '';
        document.getElementById('posDiscountToggle').checked = false;
        selectPaymentMethod('cash'); // Reset to cash
        selectServiceType('dine-in'); // Reset to dine-in
        updateCart();
        calculateChange();
        
        renderPOSProducts();
        
        // Refresh walk-in orders log to show the new order
        await loadWalkInOrdersLog();
        
    } catch (error) {
        console.error('Error processing payment:', error);
        alert('Error processing payment: ' + (error.message || 'Please try again.'));
    }
}

// Deduct menu quantity for order items. Always uses quantity (variation.quantity or menu.quantity), not maxServingsPerDay.
// When quantity becomes 0, product is unavailable on next load.
async function deductStockForOrder(orderItems) {
    try {
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            console.error('Firestore not ready for deducting');
            return;
        }
        // Build map of menuId -> { mainQty, variations: { varId: qty } } for quantity deduction
        const menuUpdates = {};
        for (const orderItem of orderItems) {
            const orderQty = Number(orderItem.quantity) || 1;
            const product = posProducts.find(p => p.id === orderItem.id);
            if (!product) {
                console.warn('Product not found for order item:', orderItem.id);
                continue;
            }
            const menuId = product.menuId || product.id;
            if (!menuUpdates[menuId]) menuUpdates[menuId] = { mainQty: 0, variations: {} };
            if (product.isVariation) {
                const varId = product.id;
                menuUpdates[menuId].variations[varId] = (menuUpdates[menuId].variations[varId] || 0) + orderQty;
            } else {
                menuUpdates[menuId].mainQty += orderQty;
            }
        }
        // Deduct menu quantity for each affected menu document (variation.quantity or menu.quantity)
        for (const menuId of Object.keys(menuUpdates)) {
            const { mainQty, variations: varMap } = menuUpdates[menuId];
            const hasMain = mainQty > 0;
            const hasVars = Object.keys(varMap).length > 0;
            if (!hasMain && !hasVars) continue;
            
            try {
                await fns.runTransaction(window.db, async (transaction) => {
                    const menuRef = fns.doc(window.db, 'menu', menuId);
                    const snap = await transaction.get(menuRef);
                    if (!snap.exists()) return;
                    const data = snap.data();
                    const upd = {};
                    if (hasMain) {
                        upd.quantity = Math.max(0, (data.quantity || 0) - mainQty);
                    }
                    if (hasVars && Array.isArray(data.variations)) {
                        upd.variations = data.variations.map((v) => {
                            const varId = v.variationId || v.id;
                            const dec = varMap[varId];
                            if (dec == null) return v;
                            const newVarQty = Math.max(0, (v.quantity || 0) - dec);
                            return { ...v, quantity: newVarQty };
                        });
                    }
                    if (Object.keys(upd).length > 0) {
                        upd.updatedAt = fns.serverTimestamp();
                        transaction.update(menuRef, upd);
                        console.log(`Deducted menu quantity for ${menuId}: main -${mainQty}, variations updated`);
                    }
                });
            } catch (error) {
                console.error(`Error deducting menu quantity for ${menuId}:`, error);
                throw error;
            }
        }
        
        console.log('Menu quantity updated in Firebase');
        await loadPOSProducts();
    } catch (error) {
        console.error('Error deducting menu quantity:', error);
        throw error;
    }
}

// Show receipt
function showReceipt(orderId, orderData, paymentAmount, change, customerName = '', tableNumber = '') {
    const receiptContent = document.getElementById('posReceiptContent');
    const subtotal = orderData.subtotal || orderData.total;
    const discount = orderData.discount;
    const total = orderData.total;
    const paymentMode = orderData.paymentMode || 'Cash';
    const displayCustomerName = customerName || orderData.customerName || 'Walk-in Customer';
    const displayTableNumber = tableNumber || orderData.tableNumber || '';
    
    const cashierName = orderData.processedByName || 'Staff';
    
    // Generate customer copy receipt
    const customerReceiptHTML = `
        <div class="pos-receipt-content pos-receipt-customer">
            <div class="pos-receipt-header">
                <h3>PABLO'S PERI PERI</h3>
                <p>P2RW+RJ4, Zabarte Rd, Novaliches, Quezon City, Metro Manila – Pablo's Peri Peri</p>
                <p>Contact: 0929 666 6474</p>
                <p>TIN: 309-845-627-000</p>
                <p>NON-VAT REGISTERED</p>
                <p><strong>CUSTOMER COPY</strong></p>
                <p><strong>${orderData.serviceType === 'take-out' ? 'TAKE OUT' : 'DINE IN'}</strong></p>
                <p>Order ID: ${orderId}</p>
                <p>Customer: ${displayCustomerName}</p>
                ${orderData.serviceType === 'dine-in' && displayTableNumber ? `<p>Table: ${displayTableNumber}</p>` : ''}
                <p>Cashier: ${cashierName}</p>
                <p>Date: ${new Date().toLocaleString()}</p>
            </div>
            <div class="pos-receipt-items">
                ${orderData.items.map(item => `
                    <div class="pos-receipt-item">
                        <div class="pos-receipt-item-name">${item.name}${item.freeWithPeriRibs ? ' (Free)' : ''}</div>
                        <div class="pos-receipt-item-qty">${item.quantity}x</div>
                        <div class="pos-receipt-item-price">₱${(item.price * item.quantity).toFixed(2)}</div>
                    </div>
                `).join('')}
            </div>
            <div class="pos-receipt-total">
                <div class="pos-receipt-total-row">
                    <span>Subtotal:</span>
                    <span>₱${subtotal.toFixed(2)}</span>
                </div>
                ${discount ? `
                    <div class="pos-receipt-total-row">
                        <span>Discount (${discount.type} ${discount.percent}%):</span>
                        <span>-₱${discount.amount.toFixed(2)}</span>
                    </div>
                ` : ''}
                <div class="pos-receipt-total-row">
                    <span>Total:</span>
                    <span>₱${total.toFixed(2)}</span>
                </div>
                <div class="pos-receipt-total-row">
                    <span>Payment Method:</span>
                    <span><strong>${paymentMode}</strong></span>
                </div>
                ${paymentMode === 'Cash' ? `
                    <div class="pos-receipt-total-row">
                        <span>Amount Paid:</span>
                        <span>₱${paymentAmount.toFixed(2)}</span>
                    </div>
                    <div class="pos-receipt-total-row final">
                        <span>Change:</span>
                        <span>₱${change.toFixed(2)}</span>
                    </div>
                ` : `
                    <div class="pos-receipt-total-row final">
                        <span>Amount Paid:</span>
                        <span>₱${paymentAmount.toFixed(2)}</span>
                    </div>
                `}
            </div>
            <div class="pos-receipt-footer">
                <p>Thank you for your order!</p>
                <p>Please come again</p>
            </div>
        </div>
    `;
    
    // Generate kitchen copy receipt
    const kitchenReceiptHTML = `
        <div class="pos-receipt-content pos-receipt-kitchen">
            <div class="pos-receipt-header">
                <h3>PABLO'S PERI PERI</h3>
                <p><strong>KITCHEN COPY</strong></p>
                <p><strong>${orderData.serviceType === 'take-out' ? 'TAKE OUT' : 'DINE IN'}</strong></p>
                <p>Order ID: ${orderId}</p>
                <p>Customer: ${displayCustomerName}</p>
                ${orderData.serviceType === 'dine-in' && displayTableNumber ? `<p>Table: ${displayTableNumber}</p>` : ''}
                <p>Cashier: ${cashierName}</p>
                <p>Date: ${new Date().toLocaleString()}</p>
            </div>
            <div class="pos-receipt-items">
                ${orderData.items.map(item => `
                    <div class="pos-receipt-item">
                        <div class="pos-receipt-item-name">${item.name}${item.freeWithPeriRibs ? ' (Free)' : ''}</div>
                        <div class="pos-receipt-item-qty">${item.quantity}x</div>
                        <div class="pos-receipt-item-price">—</div>
                    </div>
                `).join('')}
            </div>
            <div class="pos-receipt-total">
                <div class="pos-receipt-total-row">
                    <span>Total Items:</span>
                    <span>${orderData.items.reduce((sum, item) => sum + item.quantity, 0)}</span>
                </div>
            </div>
            <div class="pos-receipt-footer">
                <p>Please prepare order</p>
            </div>
        </div>
    `;
    
    // Combine both receipts
    receiptContent.innerHTML = `
        <div class="pos-receipts-container">
            ${customerReceiptHTML}
            ${kitchenReceiptHTML}
        </div>
    `;
    document.getElementById('posReceiptModal').style.display = 'block';
}

// Close receipt modal
function closeReceiptModal() {
    const modal = document.getElementById('posReceiptModal');
    if (modal) {
        modal.style.display = 'none';
        modal.style.zIndex = '';
    }
}

// Print receipt
function printReceipt() {
    const receiptContent = document.getElementById('posReceiptContent').innerHTML;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
            <head>
                <title>Receipt - Pablo's Peri Peri</title>
                <meta charset="UTF-8">
                <style>
                    @page {
                        size: 80mm auto;
                        margin: 0;
                        padding: 0;
                    }
                    @media print {
                        body { 
                            margin: 0; 
                            padding: 5mm 5mm; 
                            width: 80mm;
                            font-size: 10px;
                        }
                        * {
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }
                        .pos-receipts-container {
                            page-break-after: always;
                        }
                        .pos-receipt-kitchen {
                            page-break-before: always;
                        }
                    }
                    body { 
                        font-family: 'Courier New', monospace; 
                        padding: 5mm; 
                        margin: 0;
                        background: white;
                        width: 80mm;
                        max-width: 80mm;
                        font-size: 10px;
                        line-height: 1.2;
                    }
                    .pos-receipts-container {
                        display: flex;
                        flex-direction: column;
                        gap: 20px;
                    }
                    .pos-receipt-content { 
                        background: white; 
                        width: 100%;
                        max-width: 80mm;
                        margin: 0;
                        padding: 0;
                    }
                    .pos-receipt-header { 
                        text-align: center; 
                        margin-bottom: 8px; 
                        border-bottom: 1px dashed #000; 
                        padding-bottom: 8px; 
                    }
                    .pos-receipt-header h3 { 
                        margin: 0 0 4px 0; 
                        font-size: 14px; 
                        font-weight: bold; 
                        line-height: 1.2;
                    }
                    .pos-receipt-header p { 
                        margin: 2px 0; 
                        font-size: 9px; 
                        line-height: 1.2;
                    }
                    .pos-receipt-items {
                        margin: 8px 0;
                    }
                    .pos-receipt-item { 
                        display: flex; 
                        justify-content: space-between; 
                        margin-bottom: 4px; 
                        padding-bottom: 4px; 
                        border-bottom: 1px dotted #ccc; 
                        font-size: 9px;
                        line-height: 1.3;
                    }
                    .pos-receipt-item-name { 
                        flex: 1; 
                        text-align: left;
                        word-wrap: break-word;
                        padding-right: 4px;
                    }
                    .pos-receipt-item-qty { 
                        margin: 0 4px; 
                        text-align: center; 
                        min-width: 20px; 
                        flex-shrink: 0;
                    }
                    .pos-receipt-item-price { 
                        text-align: right; 
                        min-width: 50px; 
                        flex-shrink: 0;
                    }
                    .pos-receipt-total { 
                        border-top: 1px solid #000; 
                        padding-top: 6px; 
                        margin-top: 8px; 
                    }
                    .pos-receipt-total-row { 
                        display: flex; 
                        justify-content: space-between; 
                        margin-bottom: 3px; 
                        font-size: 10px;
                        line-height: 1.3;
                    }
                    .pos-receipt-total-row.final { 
                        font-weight: bold; 
                        font-size: 12px; 
                        margin-top: 6px; 
                        padding-top: 6px; 
                        border-top: 1px dashed #000; 
                    }
                    .pos-receipt-footer { 
                        text-align: center; 
                        margin-top: 10px; 
                        padding-top: 8px; 
                        border-top: 1px dashed #000; 
                        font-size: 9px; 
                        line-height: 1.3;
                    }
                </style>
            </head>
            <body>
                ${receiptContent}
            </body>
        </html>
    `);
    printWindow.document.close();
    // Wait a bit for content to load, then print
    setTimeout(() => {
        printWindow.print();
    }, 250);
}

// Check if Firestore is ready
function isFirestoreReady() {
    return !!(window.db && window.firestoreFunctions);
}

// Close modal when clicking outside
window.onclick = function(event) {
    const receiptModal = document.getElementById('posReceiptModal');
    const ordersLogModal = document.getElementById('posOrdersLogModal');
    const linkedItemsModal = document.getElementById('posLinkedItemsModal');
    
    if (event.target === receiptModal) {
        closeReceiptModal();
    }
    
    if (event.target === ordersLogModal) {
        closeWalkInOrdersLog();
    }
    
    if (event.target === linkedItemsModal) {
        closeLinkedItemsModal();
    }
}

// Mobile menu toggle
function toggleMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar && overlay) {
        sidebar.classList.toggle('mobile-open');
        overlay.classList.toggle('active');
    }
}

// Prevent dropdowns from closing when clicking submenu items
// This must be a global handler (not in DOMContentLoaded) to work consistently
// Use IIFE to ensure it runs immediately and works across page navigations
(function() {
    // Global handler to prevent dropdown closing when clicking submenu items
    // Use capture phase to run BEFORE other click handlers (including script.js handlers)
    // This handler MUST run first to prevent any other handlers from closing dropdowns
    function preventDropdownClose(event) {
        // Check if clicking inside an open submenu (most common case)
        const submenu = event.target.closest('.menu-nav-submenu');
        if (submenu && submenu.classList.contains('show')) {
            // CRITICAL: Stop all propagation to prevent ANY other handler from closing dropdown
            event.stopPropagation();
            event.stopImmediatePropagation();
            return; // Exit early - we've handled it
        }
        
        // Also check if clicking on any element that's inside an open submenu
        // This catches cases where the click target might be nested (e.g., icon inside link)
        const clickedElement = event.target;
        let currentElement = clickedElement;
        
        // Walk up the DOM tree to check if we're inside an open submenu
        while (currentElement && currentElement !== document.body) {
            if (currentElement.classList && currentElement.classList.contains('menu-nav-submenu')) {
                if (currentElement.classList.contains('show')) {
                    // We're inside an open submenu - prevent closing
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    return;
                }
                break; // Found submenu but it's closed, stop checking
            }
            currentElement = currentElement.parentElement;
        }
        
        // Check if clicking on a link that's inside an open submenu
        const clickedLink = clickedElement.closest('a');
        if (clickedLink) {
            const parentSubmenu = clickedLink.closest('.menu-nav-submenu');
            if (parentSubmenu && parentSubmenu.classList.contains('show')) {
                // Prevent dropdown from closing when clicking submenu links
                event.stopPropagation();
                event.stopImmediatePropagation();
                return;
            }
        }
    }
    
    // Add the handler in capture phase with highest priority (runs first)
    // Use {capture: true, passive: false} to ensure we can stop propagation
    document.addEventListener('click', preventDropdownClose, {capture: true, passive: false});
})();

// Additional protection on DOMContentLoaded to ensure it works after navigation
document.addEventListener('DOMContentLoaded', function() {
    // Re-apply protection to any submenus that exist
    const submenus = document.querySelectorAll('.menu-nav-submenu');
    submenus.forEach(submenu => {
        submenu.addEventListener('click', function(event) {
            if (submenu.classList.contains('show')) {
                // Keep dropdown open when clicking inside it
                event.stopPropagation();
                event.stopImmediatePropagation();
            }
        }, true); // Capture phase
    });
    
    // Also handle submenu links specifically
    const submenuLinks = document.querySelectorAll('.menu-nav-submenu a');
    submenuLinks.forEach(link => {
        link.addEventListener('click', function(event) {
            const parentSubmenu = link.closest('.menu-nav-submenu');
            if (parentSubmenu && parentSubmenu.classList.contains('show')) {
                // Prevent dropdown from closing
                event.stopPropagation();
                event.stopImmediatePropagation();
            }
        }, true); // Capture phase
    });
});

// Close mobile menu when clicking outside
document.addEventListener('click', function(event) {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    const toggleBtn = document.querySelector('.mobile-menu-toggle');
    
    // Don't close if clicking anywhere inside the sidebar (including dropdowns)
    const isInsideSidebar = sidebar && sidebar.contains(event.target);
    const isToggleButton = toggleBtn && toggleBtn.contains(event.target);
    
    // Don't close if clicking on dropdown toggle buttons or submenu items
    const isDropdownToggle = event.target.closest('.menu-toggle');
    const isSubmenuItem = event.target.closest('.menu-nav-submenu a');
    
    if (sidebar && overlay && toggleBtn) {
        // Only close if clicking outside the sidebar and not on the toggle button
        // Also exclude dropdown toggles and submenu items from closing the sidebar
        if (!isInsideSidebar && !isToggleButton && !isDropdownToggle && !isSubmenuItem && sidebar.classList.contains('mobile-open')) {
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('active');
        }
    }
});

// Close mobile menu when window is resized to desktop size
window.addEventListener('resize', function() {
    if (window.innerWidth > 768) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar && overlay) {
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('active');
        }
    }
});

// Close mobile menu when navigation links are clicked (mobile UX improvement)
document.addEventListener('DOMContentLoaded', function() {
    // Only attach to actual navigation links, not dropdown toggle buttons
    const navLinks = document.querySelectorAll('.sidebar .nav-link:not(.menu-toggle), .sidebar .menu-nav-submenu a');
    navLinks.forEach(link => {
        link.addEventListener('click', function(event) {
            // Don't close if this is a dropdown toggle button
            if (link.classList.contains('menu-toggle') || link.closest('.menu-toggle')) {
                return;
            }
            
            // Check if this is a submenu link
            const isSubmenuLink = link.closest('.menu-nav-submenu');
            
            // For submenu links, don't interfere at all - let them handle navigation naturally
            // The dropdown close prevention handlers above will keep dropdown open
            // DO NOT close sidebar or do anything that might affect dropdown state
            if (isSubmenuLink) {
                // Completely skip this handler for submenu links
                // Let the global prevention handler and navigation handle everything
                return;
            }
            
            // Only close sidebar for top-level nav links on mobile
            // This should NOT affect dropdown state at all
            if (window.innerWidth <= 768) {
                const sidebar = document.getElementById('sidebar');
                const overlay = document.querySelector('.sidebar-overlay');
                
                if (sidebar && overlay) {
                    // Only close sidebar, don't touch dropdowns
                    sidebar.classList.remove('mobile-open');
                    overlay.classList.remove('active');
                }
            }
        });
    });
});

// Load and display walk-in orders log
async function loadWalkInOrdersLog() {
    const logContent = document.getElementById('posOrdersLogContent');
    if (!logContent) return;
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firestore is not ready yet.');
        }
        
        // Query orders collection for walk-in orders
        // Filter by walkin: true and order by createdAt descending (newest first)
        const ordersRef = fns.collection(window.db, 'orders');
        let ordersSnapshot;
        
        try {
            // Try to query with orderBy first
            ordersSnapshot = await fns.getDocs(fns.query(
                ordersRef,
                fns.where('walkin', '==', true),
                fns.orderBy('createdAt', 'desc')
            ));
        } catch (orderError) {
            // If orderBy fails (index missing), get all walk-in orders and sort manually
            console.warn('Could not order by createdAt (index may be missing), fetching all walk-in orders:', orderError);
            ordersSnapshot = await fns.getDocs(fns.query(
                ordersRef,
                fns.where('walkin', '==', true)
            ));
        }
        
        const orders = [];
        ordersSnapshot.forEach(doc => {
            const data = doc.data();
            orders.push({
                id: doc.id,
                orderId: data.orderId || doc.id,
                ...data
            });
        });
        
        // Sort by createdAt if not already sorted
        orders.sort((a, b) => {
            const aTime = a.createdAt?.toDate?.() || (a.createdAt ? new Date(a.createdAt) : new Date(0));
            const bTime = b.createdAt?.toDate?.() || (b.createdAt ? new Date(b.createdAt) : new Date(0));
            return bTime - aTime; // Most recent first
        });
        
        // Cache and render first page
        walkInOrdersState = orders;
        walkInOrdersPage = 1;
        renderWalkInOrdersLogPage();
        
    } catch (error) {
        console.error('Error loading walk-in orders log:', error);
        logContent.innerHTML = `
            <div class="pos-loading" style="grid-column: 1 / -1;">
                <i class="fas fa-exclamation-circle"></i>
                <p>Error loading orders. Please try again.</p>
            </div>
        `;
    }
}

function renderWalkInOrdersLogPage() {
    const totalOrders = walkInOrdersState.length;
    const totalPages = Math.max(1, Math.ceil(totalOrders / WALK_IN_ORDERS_PER_PAGE));
    if (walkInOrdersPage > totalPages) {
        walkInOrdersPage = totalPages;
    }
    const startIndex = (walkInOrdersPage - 1) * WALK_IN_ORDERS_PER_PAGE;
    const pageOrders = walkInOrdersState.slice(startIndex, startIndex + WALK_IN_ORDERS_PER_PAGE);
    renderWalkInOrdersLog(pageOrders, totalOrders, totalPages);
}

function changeWalkInOrdersPage(direction) {
    const totalPages = Math.max(1, Math.ceil(walkInOrdersState.length / WALK_IN_ORDERS_PER_PAGE));
    const nextPage = walkInOrdersPage + direction;
    if (nextPage < 1 || nextPage > totalPages) return;
    walkInOrdersPage = nextPage;
    renderWalkInOrdersLogPage();
}

// Render walk-in orders log
function renderWalkInOrdersLog(orders, totalOrders = 0, totalPages = 1) {
    const logContent = document.getElementById('posOrdersLogContent');
    if (!logContent) return;
    
    if (!orders || orders.length === 0) {
        logContent.innerHTML = `
            <div class="pos-empty-cart" style="padding: 60px 20px;">
                <i class="fas fa-receipt" style="font-size: 3em; margin-bottom: 15px; opacity: 0.3;"></i>
                <p style="font-size: 16px; color: #6c757d;">No walk-in orders yet</p>
            </div>
        `;
        return;
    }
    
    const ordersHtml = orders.map(order => {
        // Format timestamp
        const createdAt = order.createdAt?.toDate?.() || (order.createdAt ? new Date(order.createdAt) : new Date());
        const timeStr = createdAt.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        // Format service type
        const serviceType = order.serviceType || order.deliveryInfo?.serviceType || '';
        const serviceTypeDisplay = serviceType === 'take-out' ? 'Take Out' : 
                                   serviceType === 'dine-in' ? 'Dine In' : 
                                   serviceType || '—';
        
        // Format customer name
        const customerName = order.customerName || order.deliveryInfo?.customerName || 'Walk-in Customer';
        
        // Format table number (if dine-in)
        const tableNumber = order.tableNumber || order.deliveryInfo?.tableNumber || '';
        const tableDisplay = tableNumber ? `Table ${tableNumber}` : '';
        
        // Format payment method
        const paymentMethod = order.paymentMode || 'Cash';
        
        // Format total
        const total = order.total || 0;
        const totalDisplay = `₱${total.toFixed(2)}`;
        
        // Format items summary
        const items = order.items || [];
        const itemsCount = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
        const itemsSummary = items.length > 0 
            ? items.slice(0, 2).map(item => `${item.quantity}x ${item.name}`).join(', ') + 
              (items.length > 2 ? ` +${items.length - 2} more` : '')
            : 'No items';
        
        // Format cashier name
        const cashierName = order.processedByName || 'Staff';
        
        const orderKey = (order.orderId || order.id || '').replace(/'/g, "\\'");
        
        return `
            <div class="pos-order-log-item">
                <div class="pos-order-log-header">
                    <div class="pos-order-log-id">${escapeHtml(order.orderId || order.id)}</div>
                    <div class="pos-order-log-time">${escapeHtml(timeStr)}</div>
                </div>
                <div class="pos-order-log-details">
                    <div class="pos-order-log-row">
                        <span class="pos-order-log-label">Customer:</span>
                        <span class="pos-order-log-value">${escapeHtml(customerName)}</span>
                    </div>
                    <div class="pos-order-log-row">
                        <span class="pos-order-log-label">Service:</span>
                        <span class="pos-order-log-value">${escapeHtml(serviceTypeDisplay)} ${tableDisplay ? `(${escapeHtml(tableDisplay)})` : ''}</span>
                    </div>
                    <div class="pos-order-log-row">
                        <span class="pos-order-log-label">Items:</span>
                        <span class="pos-order-log-value">${escapeHtml(itemsSummary)}</span>
                    </div>
                    <div class="pos-order-log-row">
                        <span class="pos-order-log-label">Payment:</span>
                        <span class="pos-order-log-value">${escapeHtml(paymentMethod)}</span>
                    </div>
                    <div class="pos-order-log-row">
                        <span class="pos-order-log-label">Cashier:</span>
                        <span class="pos-order-log-value">${escapeHtml(cashierName)}</span>
                    </div>
                </div>
                <div class="pos-order-log-footer">
                    <span class="pos-order-log-total">${totalDisplay}</span>
                    <button class="btn btn-sm btn-outline-primary" onclick="viewWalkInOrderReceipt('${orderKey}')">
                        <i class="fas fa-receipt"></i> Receipt
                    </button>
                </div>
            </div>
        `;
    }).join('');
    
    const paginationNeeded = totalOrders > WALK_IN_ORDERS_PER_PAGE;
    const paginationHtml = paginationNeeded ? `
        <div class="pos-orders-log-pagination">
            <button class="btn btn-sm btn-secondary" onclick="changeWalkInOrdersPage(-1)" ${walkInOrdersPage === 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left"></i> Previous
            </button>
            <span class="pagination-info">Page ${walkInOrdersPage} of ${totalPages}</span>
            <button class="btn btn-sm btn-secondary" onclick="changeWalkInOrdersPage(1)" ${walkInOrdersPage === totalPages ? 'disabled' : ''}>
                Next <i class="fas fa-chevron-right"></i>
            </button>
        </div>
    ` : '';
    
    logContent.innerHTML = `
        ${ordersHtml}
        ${paginationHtml}
    `;
}

function viewWalkInOrderReceipt(orderId) {
    if (!orderId) {
        alert('Unable to open receipt for this order.');
        return;
    }
    const order = walkInOrdersState.find(o => o.orderId === orderId || o.id === orderId);
    if (!order) {
        alert('Order not found in the current log.');
        return;
    }
    // Ensure receipt modal appears above the log modal
    const receiptModal = document.getElementById('posReceiptModal');
    if (receiptModal) {
        receiptModal.style.zIndex = '10010';
    }
    const paymentAmount = typeof order.paymentAmount === 'number' ? order.paymentAmount : order.total || 0;
    const change = typeof order.change === 'number' ? order.change : 0;
    const customerName = order.customerName || order.deliveryInfo?.customerName || '';
    const tableNumber = order.tableNumber || order.deliveryInfo?.tableNumber || '';
    showReceipt(order.orderId || order.id, order, paymentAmount, change, customerName, tableNumber);
}

// Open walk-in orders log modal
async function openWalkInOrdersLog() {
    const modal = document.getElementById('posOrdersLogModal');
    if (!modal) return;
    
    modal.style.display = 'block';
    
    // Load orders when modal opens
    await loadWalkInOrdersLog();
}

// Close walk-in orders log modal
function closeWalkInOrdersLog() {
    const modal = document.getElementById('posOrdersLogModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Refresh walk-in orders log
async function refreshWalkInOrdersLog() {
    const logContent = document.getElementById('posOrdersLogContent');
    if (!logContent) return;
    
    // Show loading state
    logContent.innerHTML = `
        <div class="pos-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Refreshing...</p>
        </div>
    `;
    
    await loadWalkInOrdersLog();
}

// Helper function to escape HTML
function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
