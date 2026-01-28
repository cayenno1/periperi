

(function() {
    'use strict';

    // Global state
    let products = [];                    // All products from Firebase
    let cart = [];                        // Cart items array
    let pendingLinkedItems = null;        // { product, quantity } when modal open
    let selectedLinkedItems = [];         // Array of selected sauce IDs
    const GUEST_CART_KEY = 'ppp_customer_cart_v1'; // Guest cart localStorage key
    let firestoreDocIds = new Map();      // Map lineId -> Firestore docId for updates
    
    // Abuse prevention and performance
    const MAX_CART_SIZE = 50;             // Maximum items in cart
    const MAX_CART_TOTAL_QTY = 200;      // Maximum total quantity across all items
    const ADD_TO_CART_RATE_LIMIT_MS = 500; // Minimum time between add to cart actions
    const QUANTITY_UPDATE_DEBOUNCE_MS = 300; // Debounce for quantity updates
    let lastAddToCartTime = 0;            // Track last add to cart time
    let quantityUpdateTimeouts = new Map(); // Debounce quantity updates
    let isProcessing = false;             // Prevent concurrent operations

    // ============================================
    // 1. FIREBASE DATA FETCHING
    // ============================================

    /**
     * Fetch menu items from Firestore and process variations
     * Collection: menu
     * Query: availability !== false AND isActive !== false
     */
    async function fetchMenuItemsFromFirebase() {
        try {
            await window.utils?.waitForFirebaseReady();

            if (!window.firebaseDb || !window.collection || !window.getDocs) {
                console.warn('Firebase not ready for menu fetch');
                return [];
            }

            const colRef = window.collection(window.firebaseDb, 'menu');
            const snap = await window.getDocs(colRef);
            const processedProducts = [];

            snap.forEach((docSnap) => {
                const data = docSnap.data();
                
                // Skip if availability === false or isActive === false
                if (data.availability === false || data.isActive === false) {
                    return;
                }

                const variations = Array.isArray(data.variations) ? data.variations : [];
                const includedSauces = Array.isArray(data.includedSauces) ? data.includedSauces : null;

                // Products WITH variations
                if (variations.length > 0) {
                    variations.forEach((variation, index) => {
                        if (!variation) return;

                        const variationId = variation.variationId || variation.id || `${docSnap.id}_var_${index}`;
                        const variationName = variation.name || variation.size || `Variation ${index + 1}`;
                        const baseName = data.foodName || data.name || data.displayName || 'Menu item';
                        const productName = `${baseName} - ${variationName}`;
                        const price = typeof variation.price === 'number' ? variation.price : 
                                      (typeof variation.price === 'string' ? parseFloat(variation.price) : (data.price || 0));
                        const quantity = (variation.quantity != null) ? (typeof variation.quantity === 'number' ? variation.quantity : parseFloat(variation.quantity) || 0) : null;

                        processedProducts.push({
                            id: variationId,
                            menuId: docSnap.id,
                            name: productName,
                            price: price,
                            quantity: quantity,
                            image: data.image || data.imageUrl || data.imageDataUrl || '',
                            category: data.category || '',
                            isVariation: true,
                            variationIndex: index,
                            parentId: docSnap.id,
                            includedSauces: includedSauces
                        });
                    });
                } else {
                    // Products WITHOUT variations
                    const productName = data.foodName || data.name || data.displayName || 'Menu item';
                    const price = typeof data.price === 'number' ? data.price : 
                                  (typeof data.price === 'string' ? parseFloat(data.price) : 0);
                    const quantity = (data.quantity != null) ? (typeof data.quantity === 'number' ? data.quantity : parseFloat(data.quantity) || 0) : null;

                    processedProducts.push({
                        id: docSnap.id,
                        menuId: docSnap.id,
                        name: productName,
                        price: price,
                        quantity: quantity,
                        image: data.image || data.imageUrl || data.imageDataUrl || '',
                        category: data.category || '',
                        isVariation: false,
                        variationIndex: -1,
                        parentId: docSnap.id,
                        includedSauces: includedSauces
                    });
                }
            });

            products = processedProducts;
            return products;
        } catch (error) {
            console.error('Error fetching menu items from Firebase:', error);
            return [];
        }
    }

    /**
     * Check if product is available
     * Product is available if quantity > 0 and quantity != null
     */
    function isProductAvailable(product) {
        if (!product) return false;
        const qty = product.quantity;
        return qty != null && qty > 0;
    }

    // ============================================
    // 2. FIREBASE PERSISTENCE
    // ============================================

    /**
     * Save cart item to Firestore
     * @param {Object} cartItem - Cart item to save
     */
    async function saveCartItemToFirestore(cartItem) {
        try {
            await window.utils?.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.collection || !window.setDoc) {
                console.warn('Firebase not fully initialized for cart save');
                return null;
            }

            const user = auth.currentUser;
            if (!user) {
                // Guest: save to localStorage
                saveGuestCart();
                return null;
            }

            const customerRef = window.doc(db, 'customers', user.uid);
            const cartItemsCol = window.collection(customerRef, 'cartItems');

            // Check if item already exists by lineId
            let existingDocId = firestoreDocIds.get(cartItem.lineId);
            
            if (existingDocId) {
                // Update existing document
                const docRef = window.doc(cartItemsCol, existingDocId);
                await window.updateDoc(docRef, {
                    itemId: cartItem.id,
                    menuId: cartItem.menuId,
                    name: cartItem.name,
                    imageUrl: cartItem.image,
                    price: cartItem.price * cartItem.quantity, // Total price
                    quantity: cartItem.quantity,
                    isVariation: cartItem.isVariation || false,
                    variationIndex: cartItem.variationIndex || -1,
                    parentId: cartItem.parentId || cartItem.menuId,
                    freeWithPeriRibs: cartItem.freeWithPeriRibs || false,
                    linkedToMainItem: cartItem.linkedToMainItem || null,
                    lineId: cartItem.lineId,
                    updatedAt: new Date()
                });
                return existingDocId;
            } else {
                // Create new document
                const cartItemRef = window.doc(cartItemsCol);
                const docId = cartItemRef.id;
                
                await window.setDoc(cartItemRef, {
                    itemId: cartItem.id,
                    menuId: cartItem.menuId,
                    name: cartItem.name,
                    imageUrl: cartItem.image,
                    price: cartItem.price * cartItem.quantity, // Total price
                    quantity: cartItem.quantity,
                    isVariation: cartItem.isVariation || false,
                    variationIndex: cartItem.variationIndex || -1,
                    parentId: cartItem.parentId || cartItem.menuId,
                    freeWithPeriRibs: cartItem.freeWithPeriRibs || false,
                    linkedToMainItem: cartItem.linkedToMainItem || null,
                    lineId: cartItem.lineId,
                    createdAt: new Date()
                });
                
                // Store mapping
                firestoreDocIds.set(cartItem.lineId, docId);
                return docId;
            }
        } catch (error) {
            console.error('Error saving cart item to Firestore:', error);
            return null;
        }
    }

    /**
     * Delete cart item from Firestore
     * @param {string} lineId - Line ID of item to delete
     */
    async function deleteCartItemFromFirestore(lineId) {
        try {
            await window.utils?.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.collection || !window.deleteDoc) {
                console.warn('Firebase not fully initialized for cart delete');
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                // Guest: save to localStorage
                saveGuestCart();
                return;
            }

            const docId = firestoreDocIds.get(lineId);
            if (!docId) {
                console.warn('No Firestore doc ID found for lineId:', lineId);
                return;
            }

            const customerRef = window.doc(db, 'customers', user.uid);
            const cartItemsCol = window.collection(customerRef, 'cartItems');
            const docRef = window.doc(cartItemsCol, docId);
            
            await window.deleteDoc(docRef);
            firestoreDocIds.delete(lineId);
        } catch (error) {
            console.error('Error deleting cart item from Firestore:', error);
        }
    }

    /**
     * Load cart items from Firestore - this is the source of truth
     * Returns exactly what's in Firestore cartItems subcollection
     */
    async function loadCartFromFirestore() {
        try {
            await window.utils?.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.collection || !window.getDocs) {
                console.warn('Firebase not fully initialized for cart load');
                return [];
            }

            const user = auth.currentUser;
            if (!user) {
                // Guest: load from localStorage
                return loadGuestCart();
            }

            const customerRef = window.doc(db, 'customers', user.uid);
            const cartItemsCol = window.collection(customerRef, 'cartItems');
            const snap = await window.getDocs(cartItemsCol);
            
            const items = [];
            firestoreDocIds.clear();
            
            // Load exactly what's in Firestore - this is the source of truth
            snap.forEach((docSnap) => {
                const data = docSnap.data();
                const lineId = data.lineId || `line_${docSnap.id}`;
                
                // Calculate unit price from total price
                const totalPrice = typeof data.price === 'number' ? data.price : Number(data.price) || 0;
                const qty = typeof data.quantity === 'number' ? data.quantity : Number(data.quantity) || 1;
                const unitPrice = qty > 0 ? totalPrice / qty : 0;
                
                items.push({
                    lineId: lineId,
                    id: data.itemId || data.id || '',
                    menuId: data.menuId || '',
                    name: data.name || '',
                    price: unitPrice,
                    quantity: qty,
                    image: data.imageUrl || data.image || '',
                    isVariation: data.isVariation || false,
                    variationIndex: data.variationIndex || -1,
                    parentId: data.parentId || data.menuId || '',
                    freeWithPeriRibs: data.freeWithPeriRibs || false,
                    linkedToMainItem: data.linkedToMainItem || null
                });
                
                // Store mapping: lineId -> Firestore document ID
                firestoreDocIds.set(lineId, docSnap.id);
            });
            
            // Return exactly what's in Firestore - no filtering or removal
            return items;
        } catch (error) {
            console.error('Error loading cart from Firestore:', error);
            return [];
        }
    }
    

    /**
     * Save guest cart to localStorage
     */
    function saveGuestCart() {
        try {
            window.localStorage?.setItem(GUEST_CART_KEY, JSON.stringify(cart));
        } catch (e) {
            console.warn('Failed to save guest cart:', e);
        }
    }

    /**
     * Load guest cart from localStorage
     * For guests, localStorage is the source of truth
     */
    function loadGuestCart() {
        try {
            const raw = window.localStorage?.getItem(GUEST_CART_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            const items = Array.isArray(parsed) ? parsed : [];
            // Return exactly what's in localStorage
            return items;
        } catch (e) {
            console.warn('Failed to load guest cart:', e);
            return [];
        }
    }

    /**
     * Sync entire cart to Firestore
     * Note: This function is kept for backward compatibility but is no longer the primary sync method.
     * The primary sync method is to reload from Firestore after operations.
     */
    async function syncCartToFirestore() {
        const user = window.firebaseAuth?.currentUser;
        
        if (user) {
            // Save all items to Firestore
            await Promise.all(cart.map(item => saveCartItemToFirestore(item)));
            
            // Delete items from Firestore that are no longer in cart
            const currentLineIds = new Set(cart.map(item => item.lineId));
            const firestoreLineIds = Array.from(firestoreDocIds.keys());
            
            for (const lineId of firestoreLineIds) {
                if (!currentLineIds.has(lineId)) {
                    await deleteCartItemFromFirestore(lineId);
                }
            }
            
            // Reload from Firestore to ensure sync
            cart = await loadCartFromFirestore();
        } else {
            // Guest: save to localStorage
            saveGuestCart();
        }
    }

    // ============================================
    // 3. ADD TO CART FUNCTIONALITY
    // ============================================

    /**
     * Generate unique line ID for cart item
     */
    function generateLineId() {
        return 'line_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Internal function to add product to cart (no sauce modal)
     */
    async function addToCartInternal(product, quantity = 1) {
        if (!product) return false;
        
        // Prevent concurrent operations
        if (isProcessing) {
            console.warn('Cart operation already in progress');
            return false;
        }
        
        // Validate quantity
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
            if (window.utils?.showToast) {
                window.utils.showToast('Invalid quantity. Please enter a number between 1 and 99.', 'error', 2000);
            }
            return false;
        }

        // Check availability
        if (!isProductAvailable(product)) {
            if (window.utils?.showToast) {
                window.utils.showToast('This item is currently unavailable.', 'error', 2000);
            }
            return false;
        }

        // Check cart size limits
        const currentCartSize = cart.filter(item => !item.freeWithPeriRibs).length;
        if (currentCartSize >= MAX_CART_SIZE) {
            if (window.utils?.showToast) {
                window.utils.showToast(`Cart limit reached. Maximum ${MAX_CART_SIZE} different items allowed.`, 'error', 2500);
            }
            return false;
        }
        
        // Check total quantity limit
        const currentTotalQty = cart.reduce((sum, item) => sum + (item.quantity || 0), 0);
        if (currentTotalQty + quantity > MAX_CART_TOTAL_QTY) {
            if (window.utils?.showToast) {
                window.utils.showToast(`Cart quantity limit reached. Maximum ${MAX_CART_TOTAL_QTY} total items allowed.`, 'error', 2500);
            }
            return false;
        }

        // Find existing cart item (same product, not free sauce)
        const existingItem = cart.find(item => 
            item.id === product.id && !item.freeWithPeriRibs
        );

        const newQuantity = existingItem ? existingItem.quantity + quantity : quantity;

        // Check stock availability
        if (product.quantity != null && newQuantity > product.quantity) {
            if (window.utils?.showToast) {
                window.utils.showToast(`Only ${product.quantity} available in stock.`, 'error', 2000);
            }
            return false;
        }

        isProcessing = true;
        try {
            if (existingItem) {
                // Update existing item
                existingItem.quantity = newQuantity;
                // Save to Firestore
                await saveCartItemToFirestore(existingItem);
            } else {
                // Add new item
                const newItem = {
                    lineId: generateLineId(),
                    id: product.id,
                    menuId: product.menuId,
                    name: product.name,
                    price: product.price,
                    quantity: quantity,
                    image: product.image,
                    isVariation: product.isVariation,
                    variationIndex: product.variationIndex,
                    parentId: product.parentId,
                    freeWithPeriRibs: false
                };
                cart.push(newItem);
                // Save to Firestore
                await saveCartItemToFirestore(newItem);
            }

            // Reload cart from Firestore to ensure sync - Firestore is source of truth
            cart = await loadCartFromFirestore();
            updateCart();
            updatePaymentButton();
            return true;
        } catch (error) {
            console.error('Error adding to cart:', error);
            if (window.utils?.showToast) {
                window.utils.showToast('Failed to add item. Please try again.', 'error', 2000);
            }
            return false;
        } finally {
            isProcessing = false;
        }
    }

    /**
     * Main add to cart function
     * @param {string|Event} productIdOrEvent - Product ID to add, or event from button click
     * @param {number} quantity - Quantity to add (default: 1)
     */
    function addToCart(productIdOrEvent, quantity = 1) {
        // Rate limiting: prevent rapid clicks
        const now = Date.now();
        if (now - lastAddToCartTime < ADD_TO_CART_RATE_LIMIT_MS) {
            console.warn('Add to cart rate limited');
            return;
        }
        lastAddToCartTime = now;
        
        let productId = productIdOrEvent;
        let btn = null;
        
        // Handle event-based calls (from menu.js buttons)
        if (productIdOrEvent && typeof productIdOrEvent === 'object' && productIdOrEvent.stopPropagation) {
            const event = productIdOrEvent;
            event.stopPropagation();
            
            btn = event.target.closest('.add-to-cart-btn') || event.target.closest('.add-plus-btn');
            if (!btn) return;
            
            // Prevent double-clicks: disable button temporarily
            if (btn.disabled || btn.dataset.processing === 'true') {
                return;
            }
            btn.disabled = true;
            btn.dataset.processing = 'true';
            
            // Get product ID from button data attributes
            productId = btn.dataset.itemId || btn.dataset.variationId || '';
            
            // If variation ID is present, use that; otherwise use item ID
            const variationId = btn.dataset.variationId;
            if (variationId) {
                productId = variationId;
            }
            
            if (!productId) {
                console.warn('No product ID found in button data attributes');
                btn.disabled = false;
                delete btn.dataset.processing;
                return;
            }
            
            // Update button UI optimistically
            const originalContent = btn.innerHTML;
            // Store original content for restoration
            if (!btn.getAttribute('data-original-content')) {
                btn.setAttribute('data-original-content', originalContent);
            }
            btn.innerHTML = '<i class="fas fa-check"></i>';
            btn.setAttribute('aria-pressed', 'true');
        }
        
        // Validate quantity
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
            if (btn) {
                btn.disabled = false;
                delete btn.dataset.processing;
                if (btn.innerHTML.includes('fa-check')) {
                    btn.innerHTML = originalContent;
                }
            }
            if (window.utils?.showToast) {
                window.utils.showToast('Invalid quantity. Please enter a number between 1 and 99.', 'error', 2000);
            }
            return;
        }
        
        // Ensure products are loaded (async, but don't block)
        if (products.length === 0) {
            fetchMenuItemsFromFirebase().then(() => {
                // Retry after products are loaded
                addToCart(productId, quantity);
            });
            if (btn) {
                btn.disabled = false;
                delete btn.dataset.processing;
            }
            return;
        }
        
        // Find product
        console.log('Looking for product with ID:', productId, 'Total products:', products.length);
        const product = products.find(p => p.id === productId);
        if (!product) {
            console.warn('Product not found by id:', productId);
            // Try to find by menuId if productId is a menuId
            const productByMenuId = products.find(p => p.menuId === productId);
            if (productByMenuId) {
                console.log('Found product by menuId:', productByMenuId.name);
                // Use the first variation or the product itself
                if (btn) {
                    btn.disabled = false;
                    delete btn.dataset.processing;
                }
                return addToCart(productByMenuId.id, quantity);
            }
            console.warn('Product not found by menuId either:', productId);
            if (btn) {
                btn.disabled = false;
                delete btn.dataset.processing;
                if (btn.innerHTML.includes('fa-check')) {
                    const originalContent = btn.innerHTML.replace('<i class="fas fa-check"></i>', '');
                    btn.innerHTML = originalContent || '<i class="fas fa-plus"></i>';
                }
            }
            return;
        }
        
        console.log('Found product:', product.name, 'has includedSauces:', !!product.includedSauces);

        // Check for linked sauces
        if (product.includedSauces && Array.isArray(product.includedSauces) && product.includedSauces.length > 0) {
            console.log('Product has includedSauces:', product.name, product.includedSauces);
            // Check product availability first
            if (!isProductAvailable(product)) {
                if (window.utils?.showToast) {
                    window.utils.showToast('This item is currently unavailable.', 'error', 2000);
                }
                if (btn) {
                    btn.disabled = false;
                    delete btn.dataset.processing;
                    if (btn.innerHTML.includes('fa-check')) {
                        const originalContent = btn.innerHTML.replace('<i class="fas fa-check"></i>', '');
                        btn.innerHTML = originalContent || '<i class="fas fa-plus"></i>';
                    }
                }
                return;
            }

            // Open linked sauce selection modal
            console.log('Opening linked items modal for:', product.name);
            if (btn) {
                btn.disabled = false;
                delete btn.dataset.processing;
            }
            openLinkedItemsModal(product, quantity);
            return;
        }
        
        console.log('Product has no includedSauces:', product.name, 'includedSauces:', product.includedSauces);

        // No linked sauces - add directly
        addToCartInternal(product, quantity).then(success => {
            if (btn) {
                if (success) {
                    // Keep checkmark for a bit longer
                    setTimeout(() => {
                        if (btn.isConnected) {
                            const originalContent = btn.getAttribute('data-original-content') || btn.innerHTML.replace('<i class="fas fa-check"></i>', '') || '<i class="fas fa-plus"></i>';
                            btn.innerHTML = originalContent;
                            btn.setAttribute('aria-pressed', 'false');
                            btn.disabled = false;
                            delete btn.dataset.processing;
                        }
                    }, 1500);
                } else {
                    // Revert on failure
                    const originalContent = btn.getAttribute('data-original-content') || btn.innerHTML.replace('<i class="fas fa-check"></i>', '') || '<i class="fas fa-plus"></i>';
                    btn.innerHTML = originalContent;
                    btn.setAttribute('aria-pressed', 'false');
                    btn.disabled = false;
                    delete btn.dataset.processing;
                }
            }
        });
    }

    // ============================================
    // 3. QUANTITY DECREASE/INCREASE FUNCTIONALITY
    // ============================================

    /**
     * Update cart item quantity by change amount
     * @param {string} lineId - Cart line item ID
     * @param {number} change - -1 for decrease, +1 for increase
     */
    async function updateCartItemQuantity(lineId, change) {
        // Prevent free items from being modified
        const item = cart.find(i => i.lineId === lineId);
        if (!item) return;
        
        if (item.freeWithPeriRibs === true) {
            if (window.utils?.showToast) {
                window.utils.showToast('Free items cannot be modified. Remove the main item to change quantity.', 'info', 2000);
            }
            return;
        }
        
        // Prevent concurrent operations
        if (isProcessing) {
            console.warn('Cart operation already in progress');
            return;
        }
        
        // Debounce rapid quantity changes
        const existingTimeout = quantityUpdateTimeouts.get(lineId);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }
        
        const debouncedUpdate = async () => {
            quantityUpdateTimeouts.delete(lineId);
            
            const currentItem = cart.find(i => i.lineId === lineId);
            if (!currentItem) return;
            
            const newQty = currentItem.quantity + change;

            // Validation
            if (newQty <= 0) {
                await removeFromCart(lineId);
                return;
            }

            if (newQty > 99) {
                if (window.utils?.showToast) {
                    window.utils.showToast('Maximum quantity is 99', 'error', 2000);
                }
                updateCart(); // Refresh to show correct quantity
                return;
            }
            
            // Check total cart quantity limit
            const currentTotalQty = cart.reduce((sum, i) => sum + (i.quantity || 0), 0);
            const qtyChange = newQty - currentItem.quantity;
            if (currentTotalQty + qtyChange > MAX_CART_TOTAL_QTY) {
                if (window.utils?.showToast) {
                    window.utils.showToast(`Cart quantity limit reached. Maximum ${MAX_CART_TOTAL_QTY} total items allowed.`, 'error', 2500);
                }
                updateCart(); // Refresh to show correct quantity
                return;
            }

            // Check stock availability
            const product = products.find(p => p.id === currentItem.id);
            if (product && product.quantity != null) {
                if (newQty > product.quantity) {
                    if (window.utils?.showToast) {
                        window.utils.showToast(`Only ${product.quantity} available in stock.`, 'error', 2000);
                    }
                    updateCart(); // Refresh to show correct quantity
                    return;
                }
            }

            isProcessing = true;
            try {
                // Update quantity
                currentItem.quantity = newQty;
                
                // Save to Firestore
                await saveCartItemToFirestore(currentItem);
                
                // Reload cart from Firestore to ensure sync - Firestore is source of truth
                cart = await loadCartFromFirestore();
                updateCart();
                updatePaymentButton();
            } catch (error) {
                console.error('Error updating quantity:', error);
                // Reload from Firestore on error to get correct state
                cart = await loadCartFromFirestore();
                updateCart();
                updatePaymentButton();
                if (window.utils?.showToast) {
                    window.utils.showToast('Failed to update quantity. Please try again.', 'error', 2000);
                }
            } finally {
                isProcessing = false;
            }
        };
        
        const timeout = setTimeout(debouncedUpdate, QUANTITY_UPDATE_DEBOUNCE_MS);
        quantityUpdateTimeouts.set(lineId, timeout);
    }

    /**
     * Update cart item quantity directly from input field
     * @param {string} lineId - Cart line item ID
     * @param {string} newQtyStr - New quantity as string
     */
    async function updateCartItemQuantityDirect(lineId, newQtyStr) {
        const item = cart.find(i => i.lineId === lineId);
        if (!item) return;
        
        // Prevent free items from being modified
        if (item.freeWithPeriRibs === true) {
            if (window.utils?.showToast) {
                window.utils.showToast('Free items cannot be modified. Remove the main item to change quantity.', 'info', 2000);
            }
            updateCart(); // Refresh to show correct quantity
            return;
        }
        
        // Prevent concurrent operations
        if (isProcessing) {
            console.warn('Cart operation already in progress');
            updateCart(); // Refresh to show current state
            return;
        }

        const newQty = parseInt(newQtyStr, 10);

        // Validation
        if (isNaN(newQty) || newQty < 1) {
            // Reset to current quantity
            updateCart();
            return;
        }

        if (newQty > 99) {
            if (window.utils?.showToast) {
                window.utils.showToast('Maximum quantity is 99', 'error', 2000);
            }
            updateCart();
            return;
        }
        
        // Check total cart quantity limit
        const currentTotalQty = cart.reduce((sum, i) => sum + (i.quantity || 0), 0);
        const qtyChange = newQty - item.quantity;
        if (currentTotalQty + qtyChange > MAX_CART_TOTAL_QTY) {
            if (window.utils?.showToast) {
                window.utils.showToast(`Cart quantity limit reached. Maximum ${MAX_CART_TOTAL_QTY} total items allowed.`, 'error', 2500);
            }
            updateCart();
            return;
        }

        if (newQty <= 0) {
            await removeFromCart(lineId);
            return;
        }

        // Check stock availability
        const product = products.find(p => p.id === item.id);
        if (product && product.quantity != null) {
            if (newQty > product.quantity) {
                if (window.utils?.showToast) {
                    window.utils.showToast(`Only ${product.quantity} available in stock.`, 'error', 2000);
                }
                updateCart();
                return;
            }
        }

        isProcessing = true;
        try {
            // Update quantity
            item.quantity = newQty;
            
            // Save to Firestore
            await saveCartItemToFirestore(item);
            
            // Reload cart from Firestore to ensure sync - Firestore is source of truth
            cart = await loadCartFromFirestore();
            updateCart();
            updatePaymentButton();
        } catch (error) {
            console.error('Error updating quantity:', error);
            // Reload from Firestore on error to get correct state
            cart = await loadCartFromFirestore();
            updateCart();
            updatePaymentButton();
            if (window.utils?.showToast) {
                window.utils.showToast('Failed to update quantity. Please try again.', 'error', 2000);
            }
        } finally {
            isProcessing = false;
        }
    }

    /**
     * Remove item from cart
     * @param {string} lineId - Cart line item ID
     */
    async function removeFromCart(lineId) {
        // Find the item being removed
        const itemToRemove = cart.find(item => item.lineId === lineId);
        if (!itemToRemove) {
            // Item not found in local cart, reload from Firestore to check
            cart = await loadCartFromFirestore();
            return;
        }

        // Check if this is a main item (not a free sauce)
        const isMainItem = !itemToRemove.freeWithPeriRibs;
        
        // If it's a main item, find and remove all linked free sauces
        if (isMainItem) {
            const mainItemMenuId = itemToRemove.menuId || itemToRemove.id;
            
            // Find all free sauces linked to this main item
            // Match by linkedToMainItem field or parentId matching main item's menuId/id
            const linkedFreeSauces = cart.filter(item => 
                item.freeWithPeriRibs === true && 
                (item.linkedToMainItem === mainItemMenuId ||
                 item.parentId === mainItemMenuId ||
                 item.menuId === mainItemMenuId)
            );
            
            // Delete all linked free sauces from Firestore
            for (const freeSauce of linkedFreeSauces) {
                await deleteCartItemFromFirestore(freeSauce.lineId);
            }
        }

        // Delete main item from Firestore
        await deleteCartItemFromFirestore(lineId);
        
        // Reload cart from Firestore to ensure sync - Firestore is source of truth
        cart = await loadCartFromFirestore();
        updateCart();
        updatePaymentButton();
    }

    // ============================================
    // 4. LINKED SAUCE SELECTION MODAL
    // ============================================

    /**
     * Open linked items modal
     * @param {Object} product - Product with includedSauces
     * @param {number} quantity - Quantity to add
     */
    function openLinkedItemsModal(product, quantity) {
        if (!product) return;

        // Store pending item
        pendingLinkedItems = { product, quantity };

        // Update modal title
        const modalTitle = document.getElementById('linkedItemsModalTitle');
        if (modalTitle) {
            modalTitle.textContent = `Choose your sauce for ${product.name}`;
        }

        // Extract linked sauce IDs
        const linkedSauceIds = product.includedSauces
            .map(s => s.sauceId || s.menuId || s.id)
            .filter(Boolean);

        if (linkedSauceIds.length === 0) {
            if (window.utils?.showToast) {
                window.utils.showToast('No linked sauces found for this item.', 'info', 2000);
            }
            return;
        }

        // Find sauce products
        const sauceProducts = products.filter(p => 
            linkedSauceIds.includes(p.id) || linkedSauceIds.includes(p.menuId)
        );

        // Calculate available quantities for each sauce
        const sauceList = sauceProducts.map(sauce => {
            const baseAvailable = sauce.quantity != null ? sauce.quantity : null;
            
            // Calculate quantity already in cart (free sauces only)
            const inCartQty = cart
                .filter(i => i.freeWithPeriRibs && (i.id === sauce.id || i.menuId === sauce.id))
                .reduce((sum, item) => sum + item.quantity, 0);

            // Effective available quantity
            const effectiveAvailable = baseAvailable != null ? Math.max(0, baseAvailable - inCartQty) : null;
            const isUnavailable = effectiveAvailable !== null && effectiveAvailable <= 0;

            // Get sauce name from includedSauces if available
            const sauceRef = product.includedSauces.find(s => 
                (s.sauceId || s.menuId || s.id) === sauce.id || 
                (s.sauceId || s.menuId || s.id) === sauce.menuId
            );
            const sauceName = sauceRef?.sauceName || sauce.name;

            return {
                ...sauce,
                sauceName: sauceName,
                effectiveAvailable: effectiveAvailable,
                isUnavailable: isUnavailable
            };
        });

        // Render sauce list
        renderSauceList(sauceList);

        // Show modal
        const modal = document.getElementById('linkedItemsModal');
        if (modal) {
            modal.style.display = 'flex'; // Use flex to center the modal
        }

        // Reset selected items
        selectedLinkedItems = [];
        updateAddButtonState();
    }

    /**
     * Render sauce list in modal
     */
    function renderSauceList(sauceList) {
        const listContainer = document.getElementById('linkedItemsList');
        if (!listContainer) return;

        if (sauceList.length === 0) {
            listContainer.innerHTML = '<p>No linked sauces available.</p>';
            return;
        }

        listContainer.innerHTML = sauceList.map(sauce => {
            const availableText = sauce.effectiveAvailable != null 
                ? `Qty: ${sauce.effectiveAvailable}` 
                : '—';
            const unavailableClass = sauce.isUnavailable ? 'unavailable' : '';
            const disabledAttr = sauce.isUnavailable ? 'disabled' : '';

            return `
                <div class="pos-sauce-item ${unavailableClass}" data-sauce-id="${sauce.id}">
                    <div class="sauce-info">
                        <span class="sauce-name">${sauce.sauceName || sauce.name}</span>
                        <span class="sauce-qty">${availableText}</span>
                    </div>
                    <button 
                        class="btn btn-outline-primary btn-sm" 
                        onclick="window.customerCart.selectLinkedItem('${sauce.id}')"
                        ${disabledAttr}
                    >
                        Select
                    </button>
                </div>
            `;
        }).join('');
    }

    /**
     * Toggle selection of linked item
     * @param {string} sauceId - Sauce ID to toggle
     */
    function selectLinkedItem(sauceId) {
        const sauceItem = document.querySelector(`.pos-sauce-item[data-sauce-id="${sauceId}"]`);
        if (!sauceItem) return;

        if (sauceItem.classList.contains('unavailable')) {
            return;
        }

        const button = sauceItem.querySelector('button');
        if (!button) return;

        const isSelected = selectedLinkedItems.includes(sauceId);

        if (isSelected) {
            // Deselect
            selectedLinkedItems = selectedLinkedItems.filter(id => id !== sauceId);
            sauceItem.classList.remove('selected');
            button.textContent = 'Select';
            button.className = 'btn btn-outline-primary btn-sm';
        } else {
            // Select
            selectedLinkedItems.push(sauceId);
            sauceItem.classList.add('selected');
            button.innerHTML = '<i class="fas fa-check"></i> Selected';
            button.className = 'btn btn-primary btn-sm';
        }

        updateAddButtonState();
    }

    /**
     * Update "Add" button state based on selections
     */
    function updateAddButtonState() {
        const addBtn = document.getElementById('addSelectedBtn');
        if (addBtn) {
            addBtn.disabled = selectedLinkedItems.length === 0;
        }
    }

    /**
     * Confirm linked items selection
     * @param {Array|null} selectedIds - null = add all, [] = skip (no sauces), array = selected items
     */
    async function confirmLinkedItems(selectedIds) {
        if (!pendingLinkedItems) return;
        
        // Prevent concurrent execution (but don't block if we're already processing from addToCartInternal)
        // We need to allow addToCartInternal to run even if isProcessing is true from a previous operation
        const wasProcessing = isProcessing;
        
        const { product, quantity } = pendingLinkedItems;
        pendingLinkedItems = null;

        // Close modal
        closeLinkedItemsModal();

        // Always add main product first
        // Temporarily clear isProcessing to allow addToCartInternal to run
        isProcessing = false;
        const mainItemAdded = await addToCartInternal(product, quantity);
        
        // If main item failed to add, don't proceed with sauces
        if (!mainItemAdded) {
            if (window.utils?.showToast) {
                window.utils.showToast('Failed to add main item to cart.', 'error', 2000);
            }
            // Restore previous processing state
            isProcessing = wasProcessing;
            return;
        }
        
        // Set isProcessing for the sauce addition phase
        isProcessing = true;
        
        // Get the main item's ID for linking free sauces
        // Find the main item that was just added (not a free sauce, matches product ID)
        const addedMainItem = cart.find(item => 
            item.id === product.id && 
            !item.freeWithPeriRibs
        );
        const mainItemId = addedMainItem ? (addedMainItem.menuId || addedMainItem.id) : (product.menuId || product.id);

        // Determine sauces to add based on selection
        const linkedSauceIds = product.includedSauces
            .map(s => s.sauceId || s.menuId || s.id)
            .filter(Boolean);

        let itemsToAdd = [];
        if (selectedIds === null) {
            // Add all linked sauces
            itemsToAdd = linkedSauceIds;
        } else if (Array.isArray(selectedIds) && selectedIds.length > 0) {
            // Add only selected sauces
            itemsToAdd = selectedIds;
        }
        // If selectedIds === [] (Skip button), itemsToAdd remains empty - no sauces will be added

        // Add selected sauces (only if itemsToAdd is not empty)
        // When Skip is clicked, itemsToAdd is empty, so this loop won't execute
        for (const sauceId of itemsToAdd) {
            const sauce = products.find(p => p.id === sauceId || p.menuId === sauceId);
            if (!sauce) continue;

            // CRITICAL: Check if this free sauce already exists for this main item
            // We need to check by sauce ID AND linkedToMainItem to prevent duplicates
            // Also check by parentId as fallback
            const existingFreeSauce = cart.find(item => 
                item.freeWithPeriRibs === true &&
                (item.id === sauce.id || item.menuId === sauce.id) &&
                (item.linkedToMainItem === mainItemId || item.parentId === mainItemId)
            );
            
            // If free sauce already exists for this main item, skip adding duplicate
            if (existingFreeSauce) {
                console.warn(`Free sauce ${sauce.name} already exists for main item ${mainItemId} (found with lineId: ${existingFreeSauce.lineId}). Skipping duplicate.`);
                continue;
            }

            // Calculate available quantity (only count free sauces linked to THIS main item)
            const baseAvailable = sauce.quantity != null ? sauce.quantity : null;
            const inCartQty = cart
                .filter(i => 
                    i.freeWithPeriRibs === true && 
                    (i.id === sauce.id || i.menuId === sauce.id) &&
                    i.linkedToMainItem === mainItemId
                )
                .reduce((sum, item) => sum + item.quantity, 0);
            const effectiveAvailable = baseAvailable != null ? Math.max(0, baseAvailable - inCartQty) : null;

            // Check availability
            if (effectiveAvailable !== null && effectiveAvailable < quantity) {
                console.warn(`Sauce ${sauce.name} has limited availability: ${effectiveAvailable}`);
                // Still add, but with available quantity
                const addQty = Math.min(quantity, effectiveAvailable);
                if (addQty > 0) {
                    const sauceItem = {
                        lineId: generateLineId(),
                        id: sauce.id,
                        menuId: sauce.menuId,
                        name: sauce.name,
                        price: 0, // Free
                        quantity: addQty,
                        image: sauce.image,
                        isVariation: sauce.isVariation,
                        variationIndex: sauce.variationIndex,
                        parentId: mainItemId, // Store main item's ID for linking
                        linkedToMainItem: mainItemId, // Additional field to track main item
                        freeWithPeriRibs: true
                    };
                    
                // Final check before adding - ensure no duplicate exists
                const duplicateCheck = cart.find(item => 
                    item.freeWithPeriRibs === true &&
                    (item.id === sauce.id || item.menuId === sauce.id) &&
                    (item.linkedToMainItem === mainItemId || item.parentId === mainItemId)
                );
                
                if (duplicateCheck) {
                    console.warn(`Duplicate detected before adding (limited qty), skipping: ${sauce.name} for main item ${mainItemId}`);
                    continue;
                }
                    
                    cart.push(sauceItem);
                    // Save to Firestore
                    await saveCartItemToFirestore(sauceItem);
                }
            } else {
                // Add with full quantity
                const sauceItem = {
                    lineId: generateLineId(),
                    id: sauce.id,
                    menuId: sauce.menuId,
                    name: sauce.name,
                    price: 0, // Free
                    quantity: quantity,
                    image: sauce.image,
                    isVariation: sauce.isVariation,
                    variationIndex: sauce.variationIndex,
                    parentId: mainItemId, // Store main item's ID for linking
                    linkedToMainItem: mainItemId, // Additional field to track main item
                    freeWithPeriRibs: true
                };
                
                // Final check before adding - ensure no duplicate exists
                const duplicateCheck = cart.find(item => 
                    item.freeWithPeriRibs === true &&
                    (item.id === sauce.id || item.menuId === sauce.id) &&
                    (item.linkedToMainItem === mainItemId || item.parentId === mainItemId)
                );
                
                if (duplicateCheck) {
                    console.warn(`Duplicate detected before adding (full qty), skipping: ${sauce.name} for main item ${mainItemId}`);
                    continue;
                }
                
                cart.push(sauceItem);
                // Save to Firestore
                await saveCartItemToFirestore(sauceItem);
            }
        }

        // Clear selected items
        selectedLinkedItems = [];
        
        // Reload cart from Firestore to ensure sync - Firestore is source of truth
        // This ensures we display exactly what's in Firestore
        cart = await loadCartFromFirestore();
        updateCart();
        updatePaymentButton();
        
        isProcessing = false;
    }

    /**
     * Close linked items modal
     */
    function closeLinkedItemsModal() {
        const modal = document.getElementById('linkedItemsModal');
        if (modal) {
            modal.style.display = 'none';
        }
        pendingLinkedItems = null;
        selectedLinkedItems = [];
    }
    
    // Make closeLinkedItemsModal available globally for onclick handlers
    window.closeLinkedItemsModal = closeLinkedItemsModal;

    /**
     * Setup modal close on outside click
     */
    function setupModalCloseOnOutsideClick() {
        const modal = document.getElementById('linkedItemsModal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    closeLinkedItemsModal();
                }
            });
        }
    }

    // ============================================
    // 5. CART DISPLAY
    // ============================================

    /**
     * Update cart display
     */
    function updateCart() {
        // This function should render the cart UI
        // The actual rendering depends on where the cart is displayed
        // For now, we'll trigger a custom event that other parts of the app can listen to
        const event = new CustomEvent('customerCart:updated', { 
            detail: { cart: [...cart] } 
        });
        document.dispatchEvent(event);

        // Update cart count
        const totalQty = cart.reduce((sum, item) => sum + item.quantity, 0);
        if (window.setCartCount) {
            window.setCartCount(totalQty);
        } else if (window.incrementCartCount) {
            // Reset and set
            const currentCount = parseInt(window.localStorage?.getItem('ppp_cart_count') || '0', 10);
            const diff = totalQty - currentCount;
            if (diff !== 0) {
                window.incrementCartCount(diff);
            }
        } else {
            window.localStorage?.setItem('ppp_cart_count', String(totalQty));
        }

        // Update cart badges
        const cartBadges = document.querySelectorAll('.cart-badge, .cart-count');
        cartBadges.forEach(badge => {
            badge.textContent = totalQty;
        });
    }

    /**
     * Update payment/checkout button state
     */
    function updatePaymentButton() {
        const hasItems = cart.length > 0;
        // Enable/disable checkout buttons if they exist
        const checkoutBtns = document.querySelectorAll('.proceed-btn, .checkout-btn');
        checkoutBtns.forEach(btn => {
            btn.disabled = !hasItems;
        });
    }

    /**
     * Get current cart
     * Returns the cart array which should always reflect Firestore state
     */
    function getCart() {
        // Return cart copy - this should always match Firestore
        return [...cart];
    }
    
    /**
     * Refresh cart from Firestore
     * Call this to ensure cart is in sync with Firestore
     */
    async function refreshCartFromFirestore() {
        cart = await loadCartFromFirestore();
        updateCart();
        updatePaymentButton();
    }
    
    /**
     * Refresh cart from Firestore - this ensures cart matches Firestore exactly
     */
    async function cleanCart() {
        // Simply reload from Firestore - Firestore is the source of truth
        cart = await loadCartFromFirestore();
        updateCart();
        updatePaymentButton();
    }

    /**
     * Get products array
     */
    function getProducts() {
        return [...products];
    }

    /**
     * Render cart items to a container
     * @param {HTMLElement} container - Container element to render cart items
     */
    function renderCartItems(container) {
        if (!container) return;

        if (cart.length === 0) {
            container.innerHTML = `
                <div class="empty-cart">
                    <i class="fas fa-shopping-cart"></i>
                    <h4>Your cart is empty</h4>
                    <p>Add items from the menu to get started.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = cart.map(item => {
            const price = item.freeWithPeriRibs ? 0 : item.price;
            const total = price * item.quantity;
            const priceDisplay = item.freeWithPeriRibs ? 'Free' : `₱${price.toFixed(2)} each`;
            const totalDisplay = item.freeWithPeriRibs ? 'Free' : `₱${total.toFixed(2)}`;

            return `
                <div class="cart-item" data-line-id="${item.lineId}">
                    <div class="item-image-container">
                        <img src="${item.image || ''}" alt="${item.name}" class="item-image" onerror="this.style.display='none'">
                    </div>
                    <div class="cart-item-details">
                        <div class="item-info">
                            <h3 class="cart-item-title">${item.name}</h3>
                            ${item.freeWithPeriRibs ? '<span class="free-badge">Free</span>' : ''}
                        </div>
                        <div class="item-price-section">
                            <div class="cart-item-price">${priceDisplay}</div>
                            <div class="price-per-unit">Total: ${totalDisplay}</div>
                        </div>
                    </div>
                    <div class="cart-item-controls">
                        <button class="qty-btn minus-btn" onclick="window.customerCart.updateCartItemQuantity('${item.lineId}', -1)">
                            <i class="fas fa-minus"></i>
                        </button>
                        <input
                            class="qty-display qty-input"
                            type="text"
                            inputmode="numeric"
                            pattern="\\d{1,2}"
                            maxlength="2"
                            aria-label="Quantity"
                            value="${item.quantity}"
                            onchange="window.customerCart.updateCartItemQuantityDirect('${item.lineId}', this.value)"
                        />
                        <button class="qty-btn plus-btn" onclick="window.customerCart.updateCartItemQuantity('${item.lineId}', 1)">
                            <i class="fas fa-plus"></i>
                        </button>
                    </div>
                    <button class="remove-btn" onclick="window.customerCart.removeFromCart('${item.lineId}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;
        }).join('');
    }

    /**
     * Initialize customer cart system
     */
    async function initialize() {
        // Fetch menu items
        await fetchMenuItemsFromFirebase();
        
        // Load existing cart from Firestore/localStorage - this is the source of truth
        cart = await loadCartFromFirestore();
        
        // Setup modal close on outside click
        setupModalCloseOnOutsideClick();
        
        // Update cart display
        updateCart();
        updatePaymentButton();
        
        // Listen for cart display requests
        document.addEventListener('customerCart:render', (e) => {
            const container = e.detail?.container;
            if (container) {
                renderCartItems(container);
            }
        });

        // Listen for auth state changes to sync cart
        if (window.onAuthStateChanged && window.firebaseAuth) {
            window.onAuthStateChanged(window.firebaseAuth, async (user) => {
                if (user) {
                    // User signed in: load from Firestore and sync
                    const firestoreCart = await loadCartFromFirestore();
                    cart = firestoreCart; // Load cart without aggressive cleaning
                    updateCart();
                    updatePaymentButton();
                } else {
                    // User signed out: save to localStorage
                    saveGuestCart();
                }
            });
        }
    }

    // Expose to window
    window.customerCart = {
        // Data fetching
        fetchMenuItemsFromFirebase,
        getProducts,
        
        // Cart operations
        addToCart,
        addToCartInternal,
        updateCartItemQuantity,
        updateCartItemQuantityDirect,
        removeFromCart,
        getCart,
        cleanCart,
        refreshCartFromFirestore,
        
        // Firebase persistence
        saveCartItemToFirestore,
        deleteCartItemFromFirestore,
        loadCartFromFirestore,
        syncCartToFirestore,
        
        // Linked items modal
        openLinkedItemsModal,
        selectLinkedItem,
        confirmLinkedItems,
        closeLinkedItemsModal,
        
        // Cart display
        updateCart,
        updatePaymentButton,
        renderCartItems,
        
        // Initialization
        initialize,
        
        // Expose selectedLinkedItems for onclick handlers
        get selectedLinkedItems() {
            return [...selectedLinkedItems];
        }
    };

    // Expose addToCart globally for menu.js and other pages
    window.addToCart = addToCart;

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        // Clear all pending timeouts
        quantityUpdateTimeouts.forEach(timeout => clearTimeout(timeout));
        quantityUpdateTimeouts.clear();
    });
    
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
