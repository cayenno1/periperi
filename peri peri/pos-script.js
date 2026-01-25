// POS (Point of Sale) System Script

let posProducts = [];
let posCart = [];
let posFilteredProducts = [];
let posDailyServings = {}; // Cache for today's serving counts
let posSelectedCategory = 'all'; // Currently selected category filter
let posPaymentMethod = 'cash'; // Current payment method: 'cash' or 'gcash'
let posServiceType = 'dine-in'; // Current service type: 'dine-in' or 'take-out'

// Categories that trigger the sauce selection popup (free sauce)
const PERI_CHICKEN_AND_RIBS_CATEGORIES = ['Peri Chicken', 'Ribs'];
let posPendingPeriRibs = null; // { product, quantity } when sauce modal is open

function generateCartLineId() {
    return 'line_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

// Initialize POS when page loads
document.addEventListener('DOMContentLoaded', async function() {
    await waitForFirebaseReady();
    await loadPOSProducts();
    await loadDailyServings();
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
                    // Add each variation as a separate product
                    data.variations.forEach((variation, index) => {
                        const variationName = variation.name || `${data.foodName || data.name || 'Product'} ${variation.size || ''}`.trim();
                        const variationPrice = variation.price || data.price || 0;
                        const variationQty = variation.quantity || 0;
                        const variationId = variation.variationId || variation.id || `${doc.id}_var_${index}`;
                        
                        // Get variation's maxServingsPerDay (if set), otherwise use parent's
                        const varMaxServings = variation.maxServingsPerDay !== undefined && variation.maxServingsPerDay !== null
                            ? Number(variation.maxServingsPerDay)
                            : maxServingsPerDay;
                        
                        posProducts.push({
                            id: variationId,
                            menuId: doc.id,
                            name: variationName,
                            price: Number(variationPrice),
                            quantity: Number(variationQty),
                            maxServingsPerDay: varMaxServings,
                            image: data.image || data.imageUrl || data.imageDataUrl || '',
                            category: data.category || '',
                            isVariation: true,
                            variationIndex: index,
                            parentId: doc.id
                        });
                    });
                } else {
                    // Add main product
                    posProducts.push({
                        id: doc.id,
                        menuId: doc.id,
                        name: data.foodName || data.name || data.displayName || 'Product',
                        price: Number(data.price || 0),
                        quantity: Number(data.quantity || 0),
                        maxServingsPerDay: maxServingsPerDay,
                        image: data.image || data.imageUrl || data.imageDataUrl || '',
                        category: data.category || '',
                        isVariation: false
                    });
                }
            }
        });
        
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

// Get available quantity for a sauce (for modal display and availability)
// Uses maxServingsPerDay + dailyServings, or quantity. Returns null if unavailable.
function getSauceAvailable(sauce) {
    if (sauce.maxServingsPerDay != null && sauce.maxServingsPerDay > 0) {
        const r = getRemainingServings(sauce);
        return r;
    }
    if (sauce.quantity !== undefined && sauce.quantity !== null) {
        return Number(sauce.quantity);
    }
    return null;
}

// Get sauces from posProducts (category Sauce or similar) for the modal
function getSaucesForModal() {
    const cat = (c) => (c || '').toLowerCase();
    return posProducts.filter(p => 
        cat(p.category) === 'sauce' || cat(p.category).includes('sauce')
    );
}

// Check if product is available (considering daily servings)
// Products are ONLY disabled when maxServingsPerDay === 0
// Even if remaining servings is 0, product is still clickable (will show warning)
function isProductAvailable(product, requestedQty = 1) {
    // ONLY disable if maxServingsPerDay is explicitly set to 0
    // This is the ONLY condition that makes a product unclickable
    if (product.maxServingsPerDay === 0) {
        return false;
    }
    
    // If maxServingsPerDay is null or undefined, it's unlimited - always available
    if (product.maxServingsPerDay === null || product.maxServingsPerDay === undefined) {
        // Check legacy quantity field only if no maxServingsPerDay is set
        if (product.quantity !== undefined && product.quantity !== null && product.quantity === 0) {
            return false; // Legacy mode: disable if quantity is 0
        }
        return true;
    }
    
    // If maxServingsPerDay > 0, product is ALWAYS clickable
    // We don't check remaining servings here - that's done in addToCart()
    // This allows cashiers to see products even when remaining is 0
    // They'll get a warning message when trying to add, but the button works
    
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
        const remainingServings = getRemainingServings(product);
        const isAvailable = isProductAvailable(product);
        
        let stockClass = '';
        let stockText = '';
        
        // Only show "Out of Stock" and disable if maxServingsPerDay is 0
        if (product.maxServingsPerDay === 0) {
            stockClass = 'out';
            stockText = 'Out of Stock';
        } else if (product.maxServingsPerDay && product.maxServingsPerDay > 0) {
            // Using daily servings system - show remaining
            if (remainingServings === 0) {
                stockClass = 'low';
                stockText = `Remaining: 0 (Limit: ${product.maxServingsPerDay})`;
            } else if (remainingServings < 5) {
                stockClass = 'low';
                stockText = `Remaining: ${remainingServings}`;
            } else {
                stockText = `Remaining: ${remainingServings}`;
            }
        } else {
            // Unlimited or using quantity field (legacy)
            if (product.quantity === 0) {
                stockClass = 'out';
                stockText = 'Out of Stock';
            } else if (product.quantity !== undefined && product.quantity !== null && product.quantity < 5) {
                stockClass = 'low';
                stockText = `Stock: ${product.quantity}`;
            } else if (product.quantity !== undefined && product.quantity !== null) {
                stockText = `Stock: ${product.quantity}`;
            } else {
                stockText = 'Available';
            }
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
    
    // Peri Chicken & Ribs: show sauce selection popup (sauce is free)
    if (PERI_CHICKEN_AND_RIBS_CATEGORIES.includes(product.category || '')) {
        if (!isProductAvailable(product, quantity)) {
            if (product.maxServingsPerDay === 0) {
                alert('This product is currently unavailable.');
            } else {
                const remaining = getRemainingServings(product);
                if (remaining !== null && remaining === 0) {
                    alert('This product has reached its daily limit for today.');
                } else if (remaining !== null) {
                    alert(`Only ${remaining} serving(s) remaining for today.`);
                } else {
                    alert('This product is out of stock.');
                }
            }
            return;
        }
        openSauceSelectionModal(product, quantity);
        return;
    }
    
    // Check availability - only disable if maxServingsPerDay is 0
    if (!isProductAvailable(product, quantity)) {
        if (product.maxServingsPerDay === 0) {
            alert('This product is currently unavailable.');
        } else {
            const remaining = getRemainingServings(product);
            if (remaining !== null && remaining === 0) {
                alert('This product has reached its daily limit for today.');
            } else if (remaining !== null) {
                alert(`Only ${remaining} serving(s) remaining for today.`);
            } else {
                alert('This product is out of stock.');
            }
        }
        return;
    }
    
    // Check if product already in cart (never stack paid with free sauce — extra sauce is a separate line)
    const existingItem = posCart.find(item => item.id === productId && !item.freeWithPeriRibs);
    const newQty = existingItem ? existingItem.quantity + quantity : quantity;
    
    // Check if adding more would exceed daily serving limit (only if maxServingsPerDay > 0)
    if (product.maxServingsPerDay && product.maxServingsPerDay > 0) {
        const remaining = getRemainingServings(product);
        if (remaining !== null && newQty > remaining) {
            alert(`Only ${remaining} serving(s) remaining for today.`);
            return;
        }
    } else if (product.maxServingsPerDay === 0) {
        // Product is disabled (maxServingsPerDay = 0)
        alert('This product is currently unavailable.');
        return;
    } else if (product.quantity !== undefined && product.quantity !== null && product.quantity > 0) {
        // Legacy quantity check
        if (newQty > product.quantity) {
            alert('Not enough stock available.');
            return;
        }
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

// --- Sauce selection for Peri Chicken & Ribs ---

function openSauceSelectionModal(product, quantity) {
    posPendingPeriRibs = { product, quantity };
    const titleEl = document.getElementById('posSauceModalTitle');
    if (titleEl) titleEl.textContent = `Choose sauce for ${product.name}`;
    
    const sauces = getSaucesForModal();
    const listEl = document.getElementById('posSauceList');
    if (!listEl) return;
    
    const inCartQty = (sauceId) => 
        posCart.filter(i => i.freeWithPeriRibs && i.id === sauceId).reduce((s, c) => s + c.quantity, 0);
    
    if (sauces.length === 0) {
        listEl.innerHTML = '<p class="pos-sauce-none">No sauces in the database. You can still add without sauce.</p>';
    } else {
        listEl.innerHTML = sauces.map(sauce => {
            const base = getSauceAvailable(sauce);
            const inCart = inCartQty(sauce.id);
            const avail = (base != null ? base : 0) - inCart;
            const isUnavailable = avail <= 0;
            const qtyLabel = avail != null ? `Qty: ${avail}` : '—';
            return `
                <div class="pos-sauce-item ${isUnavailable ? 'unavailable' : ''}" data-sauce-id="${sauce.id}">
                    <div class="pos-sauce-info">
                        <span class="pos-sauce-name">${escapeHtml(sauce.name)}</span>
                        <span class="pos-sauce-qty">${qtyLabel}</span>
                    </div>
                    <button type="button" class="btn btn-primary btn-sm pos-sauce-select" 
                            ${isUnavailable ? 'disabled' : ''} 
                            onclick="confirmPeriRibsWithSauce('${sauce.id}')">
                        Select
                    </button>
                </div>
            `;
        }).join('');
    }
    
    document.getElementById('posSauceModal').style.display = 'block';
}

function closeSauceSelectionModal() {
    posPendingPeriRibs = null;
    const m = document.getElementById('posSauceModal');
    if (m) m.style.display = 'none';
}

function confirmPeriRibsWithSauce(sauceIdOrNull) {
    if (!posPendingPeriRibs) return;
    const { product, quantity } = posPendingPeriRibs;
    posPendingPeriRibs = null;
    closeSauceSelectionModal();
    
    // Add main item (reuse existing add logic but skip the Peri/Ribs check to avoid recursion)
    addToCartInternal(product, quantity);
    
    if (sauceIdOrNull) {
        const sauce = posProducts.find(p => p.id === sauceIdOrNull);
        if (sauce) {
            const avail = getSauceAvailable(sauce);
            const inCart = posCart.filter(i => i.freeWithPeriRibs && i.id === sauce.id).reduce((s, c) => s + c.quantity, 0);
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
    }
    
    updateCart();
    updatePaymentButton();
}

// Internal add (no sauce popup) — used by confirmPeriRibsWithSauce
function addToCartInternal(product, quantity) {
    const existingItem = posCart.find(item => item.id === product.id && !item.freeWithPeriRibs);
    const newQty = existingItem ? existingItem.quantity + quantity : quantity;
    
    if (product.maxServingsPerDay && product.maxServingsPerDay > 0) {
        const remaining = getRemainingServings(product);
        if (remaining !== null && newQty > remaining) {
            alert(`Only ${remaining} serving(s) remaining for today.`);
            return;
        }
    } else if (product.quantity !== undefined && product.quantity !== null && product.quantity > 0) {
        if (newQty > product.quantity) {
            alert('Not enough stock available.');
            return;
        }
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
    if (item.freeWithPeriRibs) return; // Free sauce qty is fixed, no +/-
    
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
    
    // Check availability (daily servings or quantity)
    const product = posProducts.find(p => p.id === item.id);
    if (product) {
        // Only disable if maxServingsPerDay is 0
        if (product.maxServingsPerDay === 0) {
            alert('This product is currently unavailable.');
            return;
        } else if (product.maxServingsPerDay && product.maxServingsPerDay > 0) {
            const remaining = getRemainingServings(product);
            if (remaining !== null && newQty > remaining) {
                alert(`Only ${remaining} serving(s) remaining for today.`);
                return;
            }
        } else if (product.quantity !== undefined && product.quantity !== null && product.quantity > 0) {
            // Legacy quantity check
            if (newQty > product.quantity) {
                alert('Not enough stock available.');
                return;
            }
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
    if (item.freeWithPeriRibs) return; // Free sauce qty is fixed, not editable
    
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
    
    // Check availability (daily servings or quantity)
    const product = posProducts.find(p => p.id === item.id);
    if (product) {
        // Only disable if maxServingsPerDay is 0
        if (product.maxServingsPerDay === 0) {
            alert('This product is currently unavailable.');
            updateCart(); // Reset to current quantity
            return;
        } else if (product.maxServingsPerDay && product.maxServingsPerDay > 0) {
            const remaining = getRemainingServings(product);
            if (remaining !== null && newQty > remaining) {
                newQty = remaining;
                alert(`Only ${remaining} serving(s) remaining for today.`);
            }
        } else if (product.quantity !== undefined && product.quantity !== null && product.quantity > 0) {
            // Legacy quantity check
            if (newQty > product.quantity) {
                newQty = product.quantity;
                alert('Not enough stock available.');
            }
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
                            ${isFree
                                ? `<span class="pos-cart-item-qty-static" title="Quantity is fixed for free sauce">${item.quantity}</span>`
                                : `<button onclick="updateCartItemQuantity('${lineId}', -1)">-</button>
                                   <input type="number" 
                                          class="pos-cart-qty-input" 
                                          value="${item.quantity}" 
                                          min="1" 
                                          max="99" 
                                          onchange="updateCartItemQuantityDirect('${lineId}', this.value)"
                                          onkeydown="return event.key !== 'Enter' || (event.preventDefault(), updateCartItemQuantityDirect('${lineId}', this.value), false)"
                                          onclick="this.select()">
                                   <button onclick="updateCartItemQuantity('${lineId}', 1)">+</button>`
                            }
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
        
        // Reload daily servings to update product availability
        await loadDailyServings();
        renderPOSProducts();
        
        // Refresh walk-in orders log to show the new order
        await loadWalkInOrdersLog();
        
    } catch (error) {
        console.error('Error processing payment:', error);
        alert('Error processing payment: ' + (error.message || 'Please try again.'));
    }
}

// Deduct daily servings for order items
async function deductStockForOrder(orderItems) {
    try {
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            console.error('Firestore not ready for deducting servings');
            return;
        }
        
        const today = getTodayDateString();
        
        for (const orderItem of orderItems) {
            const orderQty = Number(orderItem.quantity) || 1;
            const product = posProducts.find(p => p.id === orderItem.id);
            
            if (!product) {
                console.warn('Product not found for order item:', orderItem.id);
                continue;
            }
            
            // Get maxServingsPerDay
            let maxServings = product.maxServingsPerDay;
            if (maxServings === null || maxServings === 0) {
                // Sauce (free with Peri Chicken & Ribs) or Sauce-category: decrement quantity in menu if present
                const isSauce = orderItem.freeWithPeriRibs || ((product.category || '').toLowerCase().includes('sauce'));
                if (isSauce && !product.isVariation && product.quantity !== undefined && product.quantity !== null && fns.increment) {
                    const menuId = product.menuId || product.id;
                    const menuRef = fns.doc(window.db, 'menu', menuId);
                    await fns.updateDoc(menuRef, { quantity: fns.increment(-orderQty) });
                    console.log(`Decremented sauce ${product.name} quantity by ${orderQty}`);
                } else {
                    console.log(`Skipping daily serving increment for ${product.name} (no limit set)`);
                }
                continue;
            }
            
            // Use the product's ID for daily servings tracking (variation ID or main product ID)
            const menuItemId = orderItem.id; // This is the variation ID or main product ID
            const menuItemName = orderItem.name;
            
            // Increment daily serving count in Firebase
            const docId = `${today}_${menuItemId}`;
            const docRef = fns.doc(window.db, 'dailyServings', docId);
            
            try {
                await fns.runTransaction(window.db, async (transaction) => {
                    const docSnapshot = await transaction.get(docRef);
                    
                    if (docSnapshot.exists) {
                        const current = docSnapshot.data();
                        if (!current) {
                            // Document exists but data is null/undefined - treat as new document
                            transaction.set(docRef, {
                                menuItemId: menuItemId,
                                menuItemName: menuItemName,
                                date: today,
                                count: orderQty,
                                maxServings: maxServings || null,
                                createdAt: fns.serverTimestamp(),
                                updatedAt: fns.serverTimestamp()
                            });
                            console.log(`Created daily serving document for ${menuItemName} (was empty): ${orderQty}`);
                        } else {
                            const currentCount = current.count || 0;
                            const newCount = currentCount + orderQty;
                            transaction.update(docRef, {
                                count: newCount,
                                updatedAt: fns.serverTimestamp()
                            });
                            console.log(`Updated daily serving for ${menuItemName}: ${currentCount} -> ${newCount}`);
                        }
                    } else {
                        // First serving of the day - initialize document in Firebase
                        transaction.set(docRef, {
                            menuItemId: menuItemId,
                            menuItemName: menuItemName,
                            date: today,
                            count: orderQty,
                            maxServings: maxServings || null,
                            createdAt: fns.serverTimestamp(),
                            updatedAt: fns.serverTimestamp()
                        });
                        console.log(`Created daily serving document for ${menuItemName}: ${orderQty}`);
                    }
                });
            } catch (error) {
                console.error(`Error incrementing serving for ${menuItemId}:`, error);
                throw error; // Re-throw to handle in outer catch
            }
        }
        
        console.log('Daily servings updated in Firebase for all items');
        
        // Reload daily servings and products to update display
        await loadDailyServings();
        await loadPOSProducts();
    } catch (error) {
        console.error('Error deducting daily servings:', error);
        throw error; // Re-throw so processPayment can handle it
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
    
    const receiptHTML = `
        <div class="pos-receipt-content">
            <div class="pos-receipt-header">
                <h3>PABLO'S PERI PERI</h3>
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
                        <div class="pos-receipt-item-name">${item.name}${item.freeWithPeriRibs ? ' (Free with Peri Chicken & Ribs)' : ''}</div>
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
    
    receiptContent.innerHTML = receiptHTML;
    document.getElementById('posReceiptModal').style.display = 'block';
}

// Close receipt modal
function closeReceiptModal() {
    document.getElementById('posReceiptModal').style.display = 'none';
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
    const sauceModal = document.getElementById('posSauceModal');
    
    if (event.target === receiptModal) {
        closeReceiptModal();
    }
    
    if (event.target === ordersLogModal) {
        closeWalkInOrdersLog();
    }
    
    if (event.target === sauceModal) {
        closeSauceSelectionModal();
    }
}

// Mobile menu toggle
function toggleMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.classList.toggle('mobile-open');
    }
}

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
        
        // Limit to last 50 orders for performance
        const displayOrders = orders.slice(0, 50);
        
        renderWalkInOrdersLog(displayOrders);
        
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

// Render walk-in orders log
function renderWalkInOrdersLog(orders) {
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
    
    logContent.innerHTML = orders.map(order => {
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
                </div>
            </div>
        `;
    }).join('');
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
