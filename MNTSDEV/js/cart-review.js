

(function() {
    'use strict';

    const GUEST_CART_KEY = 'ppp_guest_cart';
    const MAX_QTY = 99;

    function setCartReviewLoading(isLoading) {
        const container = document.querySelector('.cart-review-container');
        if (!container) return;

        if (isLoading) {
            container.classList.add('is-loading');
            container.setAttribute('aria-busy', 'true');
        } else {
            container.classList.remove('is-loading');
            container.setAttribute('aria-busy', 'false');
        }
    }

    // Get variations for an item
    async function getItemVariations(itemId) {
        if (!itemId) return [];
        
        try {
            await window.utils.waitForFirebaseReady();
            if (!window.firestore || !window.firestore.fetchMenuItemById) return [];
            
            const item = await window.firestore.fetchMenuItemById(itemId);
            if (!item) return [];
            
            const variations = Array.isArray(item.variations) ? item.variations : [];
            // Only return if there are 2 or more variations
            return variations.length >= 2 ? variations : [];
        } catch (error) {
            console.error('Error getting item variations:', error);
            return [];
        }
    }

    // Render variation dropdown
    async function renderVariationDropdown(menuId, currentVariation, cartItemEl, source) {
        if (!menuId) return;
        
        // Don't show variation dropdown for free sauces
        const isFree = cartItemEl.dataset.freeWithPeriRibs === 'true';
        if (isFree) return;
        
        const variations = await getItemVariations(menuId);
        if (!variations || variations.length < 2) return;
        
        const itemOptions = cartItemEl.querySelector('.item-options');
        if (!itemOptions) return;
        
        // Determine current variation index
        let currentVariationIndex = -1;
        if (currentVariation) {
            if (currentVariation.index !== undefined) {
                currentVariationIndex = currentVariation.index;
            } else if (currentVariation.name) {
                currentVariationIndex = variations.findIndex(v => 
                    (v.name || v.title) === currentVariation.name
                );
            } else if (currentVariation.id) {
                // Match by variation ID
                currentVariationIndex = variations.findIndex(v => 
                    (v.variationId || v.id) === currentVariation.id
                );
            }
        }
        
        // If still not found, try to get from data attributes (customer-cart.js structure)
        if (currentVariationIndex === -1) {
            const storedIndex = cartItemEl.dataset.variationIndex;
            if (storedIndex !== undefined && storedIndex !== '-1' && storedIndex !== '') {
                currentVariationIndex = parseInt(storedIndex, 10);
            } else {
                // Try to match by itemId (variation ID)
                const itemId = cartItemEl.dataset.itemId;
                if (itemId) {
                    currentVariationIndex = variations.findIndex(v => 
                        (v.variationId || v.id) === itemId
                    );
                }
                
                // If still not found, try to extract from item name (e.g., "Classic Ribs - Medium")
                if (currentVariationIndex === -1) {
                    const titleEl = cartItemEl.querySelector('.cart-item-title');
                    if (titleEl) {
                        const itemName = titleEl.textContent.trim();
                        const parts = itemName.split(' - ');
                        if (parts.length > 1) {
                            const variationNameFromTitle = parts[parts.length - 1];
                            currentVariationIndex = variations.findIndex(v => 
                                (v.name || v.title) === variationNameFromTitle
                            );
                        }
                    }
                }
            }
        }
        
        const variationOptions = variations.map((variation, index) => {
            const variationName = variation.name || variation.title || `Variation ${index + 1}`;
            const variationPrice = typeof variation.price === 'number' ? variation.price : 
                (typeof variation.price === 'string' ? parseFloat(variation.price) : 0);
            const vq = (variation.quantity ?? 0) || 0;
            const isUnavailable = vq <= 0;
            const selected = (currentVariationIndex === index) ? 'selected' : '';
            const disabled = isUnavailable ? ' disabled' : '';
            const unavLabel = isUnavailable ? ' (Unavailable)' : '';
            return `<option value="${index}" ${selected}${disabled}>${variationName} (₱${variationPrice.toFixed(2)})${unavLabel}</option>`;
        }).join('');
        
        const selectId = `variation-select-${menuId}-${Date.now()}`;
        const variationHtml = `
            <div class="variation-select-container">
                <label for="${selectId}" class="variation-select-label">Variation:</label>
                <select 
                    id="${selectId}" 
                    class="variation-select"
                    data-item-id="${menuId}"
                    data-source="${source}"
                    onchange="cartReview.changeVariation(this)"
                >
                    ${variationOptions}
                </select>
            </div>
        `;
        
        // Set variation dropdown in item-options
        itemOptions.innerHTML = variationHtml;
    }

    // Change variation for cart item
    async function changeVariation(selectEl) {
        const menuId = selectEl.dataset.itemId; // This is actually menuId (parent menu item)
        const source = selectEl.dataset.source;
        const variationIndex = selectEl.value !== '' ? parseInt(selectEl.value, 10) : null;
        const cartItem = selectEl.closest('.cart-item');
        
        if (!cartItem) return;
        
        // Prevent changing variation for free sauces
        const isFree = cartItem.dataset.freeWithPeriRibs === 'true';
        if (isFree) {
            if (window.utils?.showToast) {
                window.utils.showToast('Cannot change variation for free items.', 'info', 2000);
            }
            // Reset dropdown to current value
            const currentVariationIndex = parseInt(cartItem.dataset.variationIndex || '-1', 10);
            if (currentVariationIndex >= 0) {
                selectEl.value = currentVariationIndex;
            }
            return;
        }
        
        let variationData = null;
        let selectedVariation = null;
        let newVariationId = null;
        let newVariationName = null;
        let newUnitPrice = 0;
        
        if (variationIndex !== null && !isNaN(variationIndex)) {
            const variations = await getItemVariations(menuId);
            selectedVariation = variations[variationIndex];
            if (selectedVariation) {
                const variationPrice = typeof selectedVariation.price === 'number' ? selectedVariation.price :
                    (typeof selectedVariation.price === 'string' ? parseFloat(selectedVariation.price) : 0);
                
                newVariationId = selectedVariation.variationId || selectedVariation.id || null;
                newVariationName = selectedVariation.name || selectedVariation.title || null;
                newUnitPrice = variationPrice;
                
                variationData = {
                    index: variationIndex,
                    name: newVariationName,
                    price: variationPrice,
                    id: newVariationId
                };
                
                // Update cart item price based on variation
                const qtyDisplay = cartItem.querySelector('.qty-display');
                const quantity = qtyDisplay ? clampQty(qtyDisplay.value) : 1;
                const newLineTotal = variationPrice * quantity;
                
                // Update price display
                const priceEl = cartItem.querySelector('.cart-item-price');
                const pricePerUnitEl = cartItem.querySelector('.price-per-unit');
                if (priceEl) priceEl.textContent = `₱${variationPrice.toFixed(2)}`;
                if (pricePerUnitEl) pricePerUnitEl.textContent = `₱${variationPrice.toFixed(2)} each`;
                
                cartItem.dataset.unitPrice = String(variationPrice);
                
                // Update item name to include variation
                const titleEl = cartItem.querySelector('.cart-item-title');
                if (titleEl && newVariationName) {
                    // Get base name (remove old variation name if present)
                    const currentName = titleEl.textContent.trim();
                    const baseName = currentName.split(' - ')[0]; // Remove existing variation suffix
                    titleEl.textContent = `${baseName} - ${newVariationName}`;
                }
            }
        }
        
        if (source === 'guest') {
            const guestId = cartItem.dataset.guestId;
            const cart = getGuestCart();
            const item = cart.find(i => i.id === guestId);
            if (item) {
                item.variation = variationData;
                if (variationData && variationData.price) {
                    const qty = item.quantity || 1;
                    item.price = variationData.price * qty;
                }
                setGuestCart(cart);
            }
        } else {
            const docId = cartItem.dataset.cartDocId;
            const lineId = cartItem.dataset.lineId;
            if (!docId && !lineId) return;
            
            try {
                await window.utils.waitForFirebaseReady();
                const db = window.firebaseDb;
                const auth = window.firebaseAuth;
                
                if (!db || !auth || !window.doc || !window.updateDoc) return;
                
                const user = auth.currentUser;
                if (!user) return;
                
                // Direct Firestore update (preferred method to preserve cart structure)
                const customerRef = window.doc(db, 'customers', user.uid);
                const cartItemRef = window.doc(customerRef, 'cartItems', docId);
                
                const qtyDisplay = cartItem.querySelector('.qty-display');
                const quantity = qtyDisplay ? clampQty(qtyDisplay.value) : 1;
                
                const updateData = {
                    updatedAt: new Date()
                };
                
                // Update customer-cart.js structure fields
                if (newVariationId && variationData) {
                    updateData.itemId = newVariationId; // Update to new variation ID
                    updateData.isVariation = true;
                    updateData.variationIndex = variationIndex;
                    
                    // Update name to include variation name
                    if (newVariationName) {
                        const titleEl = cartItem.querySelector('.cart-item-title');
                        if (titleEl) {
                            const currentName = titleEl.textContent.trim();
                            // Remove old variation suffix if present
                            const baseName = currentName.split(' - ')[0];
                            updateData.name = `${baseName} - ${newVariationName}`;
                        }
                    }
                    
                    // Update price
                    if (variationData.price) {
                        updateData.price = variationData.price * quantity;
                    }
                } else {
                    // Fallback: use old variation object structure
                    updateData.variation = variationData;
                    if (variationData && variationData.price) {
                        updateData.price = variationData.price * quantity;
                    }
                }
                
                await window.updateDoc(cartItemRef, updateData);
                
                // Update local data attributes
                if (newVariationId) {
                    cartItem.dataset.itemId = newVariationId;
                    cartItem.dataset.isVariation = 'true';
                    cartItem.dataset.variationIndex = String(variationIndex);
                    cartItem.dataset.unitPrice = String(newUnitPrice);
                }
                
                // Update UI immediately
                const priceEl = cartItem.querySelector('.cart-item-price');
                const pricePerUnitEl = cartItem.querySelector('.price-per-unit');
                if (priceEl && newUnitPrice > 0) {
                    priceEl.textContent = `₱${newUnitPrice.toFixed(2)}`;
                }
                if (pricePerUnitEl && newUnitPrice > 0) {
                    pricePerUnitEl.textContent = `₱${newUnitPrice.toFixed(2)} each`;
                }
                
                // Update item name if changed
                if (newVariationName) {
                    const titleEl = cartItem.querySelector('.cart-item-title');
                    if (titleEl) {
                        const currentName = titleEl.textContent.trim();
                        const baseName = currentName.split(' - ')[0];
                        titleEl.textContent = `${baseName} - ${newVariationName}`;
                    }
                }
                
                // Update cart summary after variation change
                updateCartSummary();
            } catch (error) {
                console.error('Error updating variation:', error);
                if (window.utils?.showToast) {
                    window.utils.showToast('Failed to update variation. Please try again.', 'error', 2000);
                }
            }
        }
        
        // Update cart summary
        updateCartSummary();
    }

    // Sauce functionality removed - sauces are now handled via linked items modal when adding to cart

    function getGuestCart() {
        try {
            const raw = window.localStorage?.getItem(GUEST_CART_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.warn('Failed to read guest cart:', e);
            return [];
        }
    }

    function setGuestCart(cart) {
        try {
            window.localStorage?.setItem(GUEST_CART_KEY, JSON.stringify(cart || []));
        } catch (e) {
            console.warn('Failed to save guest cart:', e);
        }
    }

    function updateGuestCartItemQuantity(guestId, newQty, unitPrice) {
        if (!guestId) return;
        const cart = getGuestCart();
        const idx = cart.findIndex((item) => item.id === guestId);
        if (idx === -1) return;

        const item = cart[idx] || {};
        const safeQty = clampQty(newQty);
        const numericUnit = typeof unitPrice === 'number' ? unitPrice : Number(unitPrice) || 0;

        item.quantity = safeQty;
        item.price = numericUnit * safeQty;
        cart[idx] = item;
        setGuestCart(cart);
    }

    function clampQty(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 1;
        return Math.max(1, Math.min(MAX_QTY, Math.floor(n)));
    }

    function sanitizeQtyInput(raw) {
        const digits = String(raw ?? '').replace(/[^\d]/g, '').slice(0, 2);
        return digits;
    }

    async function commitQuantityForCartItem(cartItem, newQty) {
        if (!cartItem) return;

        // Check if this is a free sauce - prevent independent quantity changes
        const isFreeSauce = cartItem.dataset.freeWithPeriRibs === 'true';
        if (isFreeSauce) {
            // Free sauces should not be changed independently
            // Find the main item and sync quantities
            const allCartItems = document.querySelectorAll('.cart-item');
            const sauceMenuId = cartItem.dataset.menuId || cartItem.dataset.itemId;
            const sauceParentId = cartItem.dataset.parentId;
            
            for (const item of allCartItems) {
                if (item === cartItem) continue;
                const itemMenuId = item.dataset.menuId || item.dataset.itemId;
                const itemParentId = item.dataset.parentId;
                const itemIsFree = item.dataset.freeWithPeriRibs === 'true';
                
                // Main item should have same menuId/parentId but not be free
                if (!itemIsFree && ((itemMenuId === sauceMenuId) || (itemParentId && itemParentId === sauceParentId))) {
                    const mainQtyInput = item.querySelector('.qty-display');
                    const mainQty = mainQtyInput ? clampQty(mainQtyInput.value) : 1;
                    // Reset free sauce to match main item
                    const qtyInput = cartItem.querySelector('.qty-display');
                    if (qtyInput) qtyInput.value = String(mainQty);
                    return;
                }
            }
            return;
        }

        const safeQty = clampQty(newQty);
        const qtyInput = cartItem.querySelector('.qty-display');
        if (qtyInput) qtyInput.value = String(safeQty);


        updateCartSummary();

        const docId = cartItem.dataset.cartDocId;
        const guestId = cartItem.dataset.guestId;
        const unitPrice = parseFloat(cartItem.dataset.unitPrice || '0') || 0;
        const source = cartItem.dataset.source || (guestId ? 'guest' : 'user');

        // Guest cart: update localStorage only
        if (source === 'guest') {
            updateGuestCartItemQuantity(guestId, safeQty, unitPrice);
            
            // Sync free sauces in guest cart
            const cart = getGuestCart();
            const mainItem = cart.find(i => i.id === guestId);
            if (mainItem) {
                const mainItemId = mainItem.menuId || mainItem.itemId || mainItem.id;
                
                // Update all linked free sauces to match main item quantity
                cart.forEach(item => {
                    if (item.freeWithPeriRibs === true) {
                        const linkedToMainItem = item.linkedToMainItem || item.parentId || item.menuId || item.itemId;
                        if (linkedToMainItem === mainItemId) {
                            item.quantity = safeQty;
                        }
                    }
                });
                setGuestCart(cart);
            }
            return;
        }

        if (!docId || !unitPrice) return;

        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.updateDoc || !window.collection || !window.getDocs) {
                console.warn('Firebase not fully initialized for cart update');
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                console.warn('No authenticated user; skipping Firestore cart update');
                return;
            }

            const customerRef = window.doc(db, 'customers', user.uid);
            const cartItemRef = window.doc(customerRef, 'cartItems', docId);
            const newTotalPrice = unitPrice * safeQty;

            await window.updateDoc(cartItemRef, {
                quantity: safeQty,
                price: newTotalPrice,
                updatedAt: new Date()
            });
            
            // Sync free sauces in Firestore
            const cartItemsCol = window.collection(customerRef, 'cartItems');
            const snap = await window.getDocs(cartItemsCol);
            const mainItemId = cartItem.dataset.menuId || cartItem.dataset.itemId;
            
            // Update all linked free sauces to match main item quantity
            const updatePromises = [];
            snap.forEach((docSnap) => {
                const data = docSnap.data();
                if (data.freeWithPeriRibs === true) {
                    const linkedToMainItem = data.linkedToMainItem || data.parentId || data.menuId || data.itemId;
                    if (linkedToMainItem === mainItemId) {
                        updatePromises.push(
                            window.updateDoc(docSnap.ref, {
                                quantity: safeQty,
                                updatedAt: new Date()
                            })
                        );
                    }
                }
            });
            
            // Wait for all free sauce updates to complete
            if (updatePromises.length > 0) {
                await Promise.all(updatePromises);
            }
            
            // Reload cart to reflect free sauce quantity changes in UI
            await loadCartFromFirestore(user);
        } catch (error) {
            console.error('Error updating cart item quantity:', error);
        }
    }

    function removeGuestCartItem(guestId, cartItemData) {
        if (!guestId) return;
        const cart = getGuestCart();
        
        // Check if this is a main item (not a free sauce)
        const isMainItem = cartItemData && !cartItemData.freeWithPeriRibs;
        
        // If it's a main item, find and remove all linked free sauces
        if (isMainItem && cartItemData) {
            const mainItemMenuId = cartItemData.menuId || cartItemData.itemId;
            
            // Find the main item in cart to get its menuId/itemId
            const mainItem = cart.find(item => item.id === guestId);
            const mainItemId = mainItem ? (mainItem.menuId || mainItem.itemId || mainItem.id) : mainItemMenuId;
            
            // Remove all free sauces linked to this main item
            const filteredCart = cart.filter((item) => {
                // Remove the main item being deleted
                if (item.id === guestId) return false;
                
                // Remove free sauces linked to this main item
                if (item.freeWithPeriRibs === true) {
                    const linkedToMainItem = item.linkedToMainItem || item.parentId || item.menuId || item.itemId;
                    if (linkedToMainItem === mainItemId) {
                        return false; // Remove this free sauce
                    }
                }
                
                return true; // Keep other items
            });
            
            setGuestCart(filteredCart);
        } else {
            // Just remove the single item (either a free sauce or if we don't have cart item data)
            const filteredCart = cart.filter((item) => item.id !== guestId);
            setGuestCart(filteredCart);
        }
    }

    async function loadCartFromFirestore(authUser) {
        const cartItemsList = document.querySelector('.cart-items-list');
        if (!cartItemsList) return;

        cartItemsList.innerHTML = '';

        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.collection || !window.getDocs) {
                console.warn('Firebase not fully initialized for cart load');
                updateCartSummary();
                return;
            }

            const user = authUser || auth.currentUser;
            if (!user) {
                console.warn('No authenticated user; cart will appear empty');
                updateCartSummary();
                return;
            }

            const customerRef = window.doc(db, 'customers', user.uid);
            const cartItemsCol = window.collection(customerRef, 'cartItems');
            const snap = await window.getDocs(cartItemsCol);

            for (const docSnap of snap.docs) {
                const data = docSnap.data() || {};
                const docId = docSnap.id;

                const name = data.name || 'Item';
                const quantity =
                    typeof data.quantity === 'number'
                        ? data.quantity
                        : Number(data.quantity) || 1;
                const totalPrice =
                    typeof data.price === 'number'
                        ? data.price
                        : Number(data.price) || 0;
                const unitPrice =
                    quantity > 0 ? totalPrice / quantity : totalPrice;

                const imageUrl = data.imageUrl || 'food_img.png';
                // Support both old variation object and new isVariation/variationIndex structure
                // For customer-cart.js items: if isVariation is true, create variation object from variationIndex
                let variation = null;
                if (data.variation) {
                    variation = data.variation;
                } else if (data.isVariation === true && data.variationIndex !== undefined && data.variationIndex >= 0) {
                    // Create variation object from customer-cart.js structure
                    variation = {
                        index: data.variationIndex,
                        id: data.itemId || null
                    };
                }
                const itemId = data.itemId || null;
                // For variations, menuId is the parent menu item ID (used to fetch all variations)
                // For non-variations, menuId equals itemId
                const menuId = data.menuId || (data.isVariation ? data.parentId : itemId) || itemId;

                const itemEl = document.createElement('div');
                itemEl.className = 'cart-item';
                itemEl.dataset.cartDocId = docId;
                itemEl.dataset.unitPrice = String(unitPrice);
                itemEl.dataset.source = 'user';
                itemEl.dataset.itemId = itemId || '';
                itemEl.dataset.menuId = menuId || '';
                itemEl.dataset.parentId = data.parentId || menuId || '';
                itemEl.dataset.lineId = data.lineId || '';
                itemEl.dataset.freeWithPeriRibs = String(data.freeWithPeriRibs || false);
                itemEl.dataset.isVariation = String(data.isVariation || false);
                itemEl.dataset.variationIndex = String(data.variationIndex !== undefined ? data.variationIndex : -1);

                const isFree = data.freeWithPeriRibs || false;
                const priceDisplay = isFree ? 'Free' : `₱${unitPrice.toFixed(2)}`;
                const pricePerUnitDisplay = isFree ? 'Free' : `₱${unitPrice.toFixed(2)} each`;

                itemEl.innerHTML = `
                    <div class="item-image-container">
                        <img src="${imageUrl}" alt="${name}" class="item-image">
                    </div>
                    <div class="cart-item-details">
                        <div class="item-info">
                            <h3 class="cart-item-title">${name}</h3>
                            ${isFree ? '<span class="free-badge" style="display:inline-block;padding:4px 8px;background:#4caf50;color:#fff;border-radius:4px;font-size:0.75em;font-weight:600;margin-left:8px;">Free</span>' : ''}
                        </div>
                        <div class="item-options"></div>
                        <div class="item-price-section">
                            <div class="cart-item-price">${priceDisplay}</div>
                            <div class="price-per-unit">${pricePerUnitDisplay}</div>
                        </div>
                    </div>
                    <div class="cart-item-controls">
                        <button class="qty-btn minus-btn ${isFree ? 'disabled-input' : ''}" onclick="cartReview.updateQuantity(this, -1)" ${isFree ? 'disabled' : ''}>
                            <i class="fas fa-minus"></i>
                        </button>
                        <input
                            class="qty-display qty-input ${isFree ? 'disabled-input' : ''}"
                            type="text"
                            inputmode="numeric"
                            pattern="\\d{1,2}"
                            maxlength="2"
                            aria-label="Quantity"
                            value="${quantity}"
                            ${isFree ? 'readonly disabled' : 'oninput="cartReview.onQtyInput(this)" onblur="cartReview.onQtyBlur(this)"'}
                            style="${isFree ? 'background:#f5f5f5;color:#999;cursor:not-allowed;' : ''}"
                        />
                        <button class="qty-btn plus-btn ${isFree ? 'disabled-input' : ''}" onclick="cartReview.updateQuantity(this, 1)" ${isFree ? 'disabled' : ''}>
                            <i class="fas fa-plus"></i>
                        </button>
                    </div>
                    <button class="remove-btn" onclick="cartReview.removeItem(this)">
                        <i class="fas fa-trash"></i>
                    </button>
                `;

                cartItemsList.appendChild(itemEl);
                
                // Render variation dropdown if applicable (2+ variations)
                // Use menuId (parent menu item) to get all variations, not the variation ID
                // Only show variation dropdown for main items (not free sauces)
                if (menuId && !isFree) {
                    await renderVariationDropdown(menuId, variation, itemEl, 'user');
                }
            }
        } catch (error) {
            console.error('Error loading cart from Firestore:', error);
        }

        updateCartSummary();
    }

    async function loadCartFromGuestCart() {
        const cartItemsList = document.querySelector('.cart-items-list');
        if (!cartItemsList) return;

        cartItemsList.innerHTML = '';

        const cart = getGuestCart();
        if (!cart.length) {
            updateCartSummary();
            return;
        }

        for (const data of cart) {
            const name = data.name || 'Item';
            const quantity =
                typeof data.quantity === 'number'
                    ? data.quantity
                    : Number(data.quantity) || 1;
            const lineTotal =
                typeof data.price === 'number'
                    ? data.price
                    : Number(data.price) || 0;
            const unitPrice = quantity > 0 ? lineTotal / quantity : lineTotal;
            const imageUrl = data.imageUrl || 'food_img.png';
            const guestId = data.id || data.itemId || `guest-${name}`;
            const variation = data.variation || null;
            const itemId = data.itemId || null;
            const menuId = data.menuId || itemId || null;
            const isFree = data.freeWithPeriRibs || false;

            const itemEl = document.createElement('div');
            itemEl.className = 'cart-item';
            itemEl.dataset.guestId = guestId;
            itemEl.dataset.unitPrice = String(unitPrice);
            itemEl.dataset.source = 'guest';
            itemEl.dataset.itemId = itemId || '';
            itemEl.dataset.menuId = menuId || '';
            itemEl.dataset.parentId = data.parentId || menuId || '';
            itemEl.dataset.freeWithPeriRibs = String(isFree);

            itemEl.innerHTML = `
                <div class="item-image-container">
                    <img src="${imageUrl}" alt="${name}" class="item-image">
                </div>
                <div class="cart-item-details">
                    <div class="item-info">
                        <h3 class="cart-item-title">${name}</h3>
                    </div>
                    <div class="item-options"></div>
                    <div class="item-price-section">
                        <div class="cart-item-price">₱${unitPrice.toFixed(2)}</div>
                        <div class="price-per-unit">₱${unitPrice.toFixed(2)} each</div>
                    </div>
                </div>
                <div class="cart-item-controls">
                    <button class="qty-btn minus-btn" onclick="cartReview.updateQuantity(this, -1)">
                        <i class="fas fa-minus"></i>
                    </button>
                    <input
                        class="qty-display qty-input"
                        type="text"
                        inputmode="numeric"
                        pattern="\\d{1,2}"
                        maxlength="2"
                        aria-label="Quantity"
                        value="${quantity}"
                        oninput="cartReview.onQtyInput(this)"
                        onblur="cartReview.onQtyBlur(this)"
                    />
                    <button class="qty-btn plus-btn" onclick="cartReview.updateQuantity(this, 1)">
                        <i class="fas fa-plus"></i>
                    </button>
                </div>
                <button class="remove-btn" onclick="cartReview.removeItem(this)">
                    <i class="fas fa-trash"></i>
                </button>
            `;

            cartItemsList.appendChild(itemEl);
            
            // Render variation dropdown if applicable (2+ variations)
            if (itemId) {
                await renderVariationDropdown(itemId, variation, itemEl, 'guest');
            }
        }

        updateCartSummary();
    }

    function getBasePriceFromMenuItem(item, fallback = 150) {
        const variations = Array.isArray(item?.variations) ? item.variations : [];
        if (variations.length > 0) {
            const v = variations[0];
            const p = typeof v?.price === 'number' ? v.price : (typeof v?.price === 'string' ? parseFloat(v.price) : NaN);
            if (Number.isFinite(p)) return p;
        }
        const p = typeof item?.price === 'number' ? item.price : (typeof item?.price === 'string' ? parseFloat(item.price) : NaN);
        if (Number.isFinite(p)) return p;
        return fallback;
    }

    function pickImageFromMenuItem(item) {
        return item?.img || item?.image || item?.imageDataUrl || 'food_img.png';
    }

    async function quickAddItem(menuItem) {
        if (!menuItem) return;
        // Products with variations: must open item to choose; quick-add has no variationId
        if (Array.isArray(menuItem.variations) && menuItem.variations.length > 0) {
            if (window.utils?.showToast) window.utils.showToast('Open the item to choose a variation.', 'info');
            return;
        }
        // Quantity-based: do not add when quantity is 0 or null
        if (((menuItem.quantity ?? 0) || 0) <= 0) {
            if (window.utils?.showToast) window.utils.showToast('This item is currently unavailable.', 'error');
            return;
        }
        const itemId = menuItem.id || null;
        const name = menuItem.displayName || menuItem.name || menuItem.title || 'Item';
        const unitPrice = getBasePriceFromMenuItem(menuItem, 50);
        const imageUrl = pickImageFromMenuItem(menuItem);

        try {
            // Update visible badge count quickly
            if (typeof window.incrementCartCount === 'function') {
                window.incrementCartCount(1);
            }
        } catch (e) {}

        const user = window.firebaseAuth?.currentUser || null;
        try {
            if (user) {
                await window.cart.saveCartItemToFirestore({
                    itemId,
                    name,
                    imageUrl,
                    price: unitPrice,
                    quantity: 1
                });
                await loadCartFromFirestore(user);
            } else {
                window.cart.addGuestCartItem({
                    itemId,
                    name,
                    imageUrl,
                    price: unitPrice,
                    quantity: 1
                });
                await loadCartFromGuestCart();
            }
            if (window.utils?.showToast) {
                window.utils.showToast(`Added ${name}`, 'success', 2200);
            }
        } catch (e) {
            console.error('Quick add failed:', e);
            if (window.utils?.showToast) {
                window.utils.showToast('Could not add item. Please try again.', 'error');
            }
        }
    }

    function renderAddOnsSection(items) {
        const mount = document.getElementById('pppAddOns');
        if (!mount) return;
        if (!Array.isArray(items) || items.length === 0) {
            mount.hidden = true;
            mount.innerHTML = '';
            return;
        }

        const top = items.slice(0, 4);
        mount.hidden = false;
        mount.innerHTML = `
            <div class="ppp-addons-title">
                <h3>Add something extra?</h3>
                <span style="font-size:.85rem; opacity:.75;">Sides & drinks</span>
            </div>
            <div class="ppp-addons-grid">
                ${top.map((it) => {
                    const name = it.displayName || it.name || it.title || 'Item';
                    const price = getBasePriceFromMenuItem(it, 50);
                    const img = pickImageFromMenuItem(it);
                    const hasV = Array.isArray(it.variations) && it.variations.length > 0;
                    const q = (it.quantity ?? 0) || 0;
                    const isUnav = hasV || q <= 0;
                    return `
                        <div class="ppp-addon-card">
                            <img src="${String(img).replace(/"/g, '&quot;')}" alt="${String(name).replace(/"/g, '&quot;')}">
                            <div class="ppp-addon-name">${name}</div>
                            <div class="ppp-addon-meta">
                                <div class="ppp-addon-price">₱${price.toFixed(2)}</div>
                                <button type="button" class="btn btn-outline-danger ppp-addon-addbtn" data-addon-id="${it.id}" ${isUnav ? ' disabled' : ''}>
                                    ${isUnav ? 'Unavailable' : 'Add'}
                                </button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        // Wire buttons
        mount.querySelectorAll('button[data-addon-id]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-addon-id');
                const item = items.find((x) => String(x.id) === String(id));
                if (!item) return;
                btn.disabled = true;
                try {
                    await quickAddItem(item);
                } finally {
                    btn.disabled = false;
                }
            });
        });
    }

    async function loadAndRenderAddOns() {
        const mount = document.getElementById('pppAddOns');
        if (!mount) return;
        try {
            await window.utils.waitForFirebaseReady();
            if (!window.firestore?.fetchMenuItems) return;

            const [sides, beverages] = await Promise.all([
                window.firestore.fetchMenuItems('sides'),
                window.firestore.fetchMenuItems('beverages')
            ]);
            const all = []
                .concat(Array.isArray(sides) ? sides : [])
                .concat(Array.isArray(beverages) ? beverages : []);

            // Light shuffle
            for (let i = all.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [all[i], all[j]] = [all[j], all[i]];
            }

            renderAddOnsSection(all);
        } catch (e) {
            console.warn('Failed to load add-ons:', e);
        }
    }

    async function updateQuantity(btn, change) {
        const cartItem = btn.closest('.cart-item');
        if (!cartItem) return;

        // Check if this is a free sauce - prevent increase, allow decrease
        const isFreeSauce = cartItem.dataset.freeWithPeriRibs === 'true';
        if (isFreeSauce && change > 0) {
            // Cannot increase free sauce quantity
            if (window.utils?.showToast) {
                window.utils.showToast('Free items cannot be increased. Remove the main item to change quantity.', 'info', 2000);
            }
            return;
        }

        const qtyInput = cartItem.querySelector('.qty-display');
        if (qtyInput && qtyInput.disabled) {
            // Input is disabled (free sauce) - only allow decrease
            if (change < 0) {
                const currentQty = clampQty(qtyInput?.value ?? 1);
                const newQty = clampQty(currentQty + change);
                await commitQuantityForCartItem(cartItem, newQty);
            }
            return;
        }

        const currentQty = clampQty(qtyInput?.value ?? 1);
        const newQty = clampQty(currentQty + change);
        await commitQuantityForCartItem(cartItem, newQty);
    }

    function onQtyInput(inputEl) {
        if (!inputEl) return;
        const sanitized = sanitizeQtyInput(inputEl.value);
        inputEl.value = sanitized;
        // Update summary live when there's a usable number; don't force-save yet.
        const cartItem = inputEl.closest('.cart-item');
        if (!cartItem) return;
        const liveQty = sanitized === '' ? 0 : clampQty(sanitized);
        // Temporarily treat empty as 0 for display; blur will commit min 1.
        updateCartSummaryWithOverrides(cartItem, liveQty);
    }

    async function onQtyBlur(inputEl) {
        if (!inputEl) return;
        const cartItem = inputEl.closest('.cart-item');
        if (!cartItem) return;

        const sanitized = sanitizeQtyInput(inputEl.value);
        const committed = sanitized === '' ? 1 : clampQty(sanitized);
        await commitQuantityForCartItem(cartItem, committed);
    }

    function updateCartSummaryWithOverrides(overrideItem, overrideQty) {
        // Lightweight wrapper: set a temporary data attr used by updateCartSummary()
        if (overrideItem) {
            overrideItem.dataset._tempQtyOverride = String(overrideQty ?? '');
        }
        updateCartSummary();
        if (overrideItem) {
            delete overrideItem.dataset._tempQtyOverride;
        }
    }

    async function removeItem(btn) {
        const cartItem = btn.closest('.cart-item');
        if (!cartItem) return;

        const docId = cartItem.dataset.cartDocId;
        const guestId = cartItem.dataset.guestId;
        const source = cartItem.dataset.source || (guestId ? 'guest' : 'user');
        const lineId = cartItem.dataset.lineId;
        
        // Store cart item data before removing from DOM (for guest cart free sauce deletion)
        const cartItemData = {
            guestId: guestId,
            menuId: cartItem.dataset.menuId || '',
            itemId: cartItem.dataset.itemId || '',
            freeWithPeriRibs: cartItem.dataset.freeWithPeriRibs === 'true'
        };

        cartItem.style.animation = 'slideOut 0.3s ease forwards';
        
        setTimeout(async () => {
            cartItem.remove();
            updateCartSummary();

            if (source === 'guest') {
                removeGuestCartItem(guestId, cartItemData);
                return;
            }

            // Use customer-cart.js removeFromCart which handles linked free sauces
            if (lineId && window.customerCart && window.customerCart.removeFromCart) {
                try {
                    await window.customerCart.removeFromCart(lineId);
                    // Reload cart to reflect changes
                    const user = window.firebaseAuth?.currentUser;
                    if (user) {
                        await loadCartFromFirestore(user);
                    }
                } catch (error) {
                    console.error('Error removing item via customer-cart:', error);
                }
                return;
            }

            // Fallback to direct Firestore delete if customer-cart not available
            if (!docId) return;

            try {
                await window.utils.waitForFirebaseReady();

                const db = window.firebaseDb;
                const auth = window.firebaseAuth;

                if (!db || !auth || !window.doc || !window.deleteDoc || !window.collection || !window.getDocs) {
                    console.warn('Firebase not fully initialized for cart delete');
                    return;
                }

                const user = auth.currentUser;
                if (!user) {
                    console.warn('No authenticated user; skipping Firestore cart delete');
                    return;
                }

                const customerRef = window.doc(db, 'customers', user.uid);
                const cartItemRef = window.doc(customerRef, 'cartItems', docId);

                // Check if this is a main item (not a free sauce)
                const isMainItem = cartItem.dataset.freeWithPeriRibs !== 'true';
                
                // If it's a main item, find and delete all linked free sauces
                if (isMainItem) {
                    const mainItemMenuId = cartItem.dataset.menuId || cartItem.dataset.itemId;
                    
                    // Get all cart items to find linked free sauces
                    const cartItemsCol = window.collection(customerRef, 'cartItems');
                    const cartItemsSnapshot = await window.getDocs(cartItemsCol);
                    
                    // Find all free sauces linked to this main item
                    const linkedFreeSauceDocs = [];
                    cartItemsSnapshot.forEach((docSnap) => {
                        const data = docSnap.data();
                        if (data.freeWithPeriRibs === true) {
                            const linkedToMainItem = data.linkedToMainItem || data.parentId || data.menuId;
                            if (linkedToMainItem === mainItemMenuId) {
                                linkedFreeSauceDocs.push(docSnap.ref);
                            }
                        }
                    });
                    
                    // Delete all linked free sauces
                    for (const freeSauceRef of linkedFreeSauceDocs) {
                        try {
                            await window.deleteDoc(freeSauceRef);
                        } catch (error) {
                            console.error('Error deleting linked free sauce:', error);
                        }
                    }
                }

                // Delete the main item
                await window.deleteDoc(cartItemRef);
                
                // Reload cart to reflect changes
                await loadCartFromFirestore(user);
            } catch (error) {
                console.error('Error deleting cart item from Firestore:', error);
            }
        }, 300);
    }

    function updateCartSummary() {
        const summaryItemsEl = document.getElementById('summaryItems');
        const cartItemsList = document.querySelector('.cart-items-list');
        const cartSummary = document.querySelector('.cart-summary');
        const cartBadges = document.querySelectorAll('.cart-badge');
        const proceedBtn = document.querySelector('.proceed-btn');
        if (!summaryItemsEl || !cartItemsList || !cartSummary) return;

        // Read from DOM
        let cartItems = [];
        const items = document.querySelectorAll('.cart-item');
        items.forEach((item) => {
            const titleEl = item.querySelector('.cart-item-title');
            const priceEl = item.querySelector('.cart-item-price');
            const qtyEl = item.querySelector('.qty-display');
            const docId = item.dataset.cartDocId;
            const guestId = item.dataset.guestId;
            
            if (!docId && !guestId) return;
            
            const title = titleEl ? titleEl.textContent.trim() : 'Item';
            const priceText = priceEl ? priceEl.textContent : '₱0';
            const overrideRaw = item.dataset._tempQtyOverride;
            const qtyRaw = overrideRaw !== undefined ? overrideRaw : (qtyEl ? qtyEl.value : '1');
            const qty = Number(qtyRaw) > 0 ? clampQty(qtyRaw) : 0;
            const numericPrice = parseFloat(priceText.replace(/[^\d.]/g, '')) || 0;
            
            cartItems.push({
                name: title,
                price: numericPrice,
                quantity: qty,
                freeWithPeriRibs: item.dataset.freeWithPeriRibs === 'true'
            });
        });

        // If empty, reset badges and show empty state
        if (cartItems.length === 0) {
            summaryItemsEl.innerHTML = '';
            cartSummary.style.display = 'none';
            cartItemsList.classList.add('empty-state');

            // Hide proceed button when there are no items
            if (proceedBtn) {
                proceedBtn.style.display = 'none';
            }

            let emptyMessage = cartItemsList.querySelector('.empty-cart-message');
            if (!emptyMessage) {
                emptyMessage = document.createElement('div');
                emptyMessage.className = 'empty-cart-message';
                emptyMessage.textContent = 'Your cart is empty';
                cartItemsList.appendChild(emptyMessage);
            }

            // Badge should be 0 when there are no items
            cartBadges.forEach(badge => {
                badge.textContent = '0';
            });

            // Also sync localStorage-based cart count used on other pages
            try {
                window.localStorage?.setItem('ppp_cart_count', '0');
                document.dispatchEvent(new CustomEvent('cart:count-changed', {
                    detail: { count: 0 }
                }));
            } catch (e) {
                console.warn('Failed to sync empty cart count to localStorage:', e);
            }
            return;
        } else {
            cartSummary.style.display = '';
            cartItemsList.classList.remove('empty-state');
            const existingEmpty = cartItemsList.querySelector('.empty-cart-message');
            if (existingEmpty) existingEmpty.remove();

            // Show proceed button when there are items
            if (proceedBtn) {
                proceedBtn.style.display = '';
            }
        }

        let subtotal = 0;
        let rowsHtml = '';
        let totalCount = 0;

        cartItems.forEach((item) => {
            const title = item.name || 'Item';
            const qty = item.quantity || 1;
            const price = item.freeWithPeriRibs ? 0 : (item.price || 0);
            const lineTotal = price * qty;
            
            // Only add to subtotal if not free
            if (!item.freeWithPeriRibs) {
                subtotal += lineTotal;
            }
            totalCount += qty;

            const priceDisplay = item.freeWithPeriRibs ? '₱0.00' : `₱${lineTotal.toFixed(2)}`;
            
            rowsHtml += `
                <div class="summary-row">
                    <span class="summary-label">${title} x ${qty}</span>
                    <span class="summary-value">${priceDisplay}</span>
                </div>
            `;
        });

        const subtotalDisplay = `₱${subtotal.toFixed(2)}`;

        rowsHtml += `
            <div class="summary-row subtotal">
                <span class="summary-label">Sub-Total</span>
                <span class="summary-value" id="summarySubtotal">${subtotalDisplay}</span>
            </div>
            <div class="summary-row total">
                <span class="summary-label">Estimated total</span>
                <span class="summary-value" id="summaryTotal">${subtotalDisplay}</span>
            </div>
            <div class="summary-row" style="opacity:.75;">
                <span class="summary-label">Final total is calculated at checkout</span>
                <span class="summary-value"></span>
            </div>
        `;

        summaryItemsEl.innerHTML = rowsHtml;

        // Sync cart badge with total quantity from this page
        cartBadges.forEach(badge => {
            badge.textContent = String(totalCount);
        });

        // Also sync localStorage-based cart count used on other pages
        try {
            window.localStorage?.setItem('ppp_cart_count', String(totalCount));
            document.dispatchEvent(new CustomEvent('cart:count-changed', {
                detail: { count: totalCount }
            }));
        } catch (e) {
            console.warn('Failed to sync cart count to localStorage:', e);
        }
    }

    function addMoreItems() {
        window.location.href = 'menu.html';
    }

    function proceedToCheckout() {
        const user = window.firebaseAuth?.currentUser || null;
        if (!user) {
            if (typeof window.showAuthGate === 'function') {
                window.showAuthGate('You need to be logged in to proceed to checkout.', 'checkout.html');
            } else if (window.showAlert) {
                window.showAlert('You need to be logged in to proceed to checkout.', 'info');
            } else {
                alert('You need to be logged in to proceed to checkout.');
            }
            return;
        }

        // Go to unified checkout; service type will be chosen there
        window.location.href = 'checkout.html';
    }

    // Expose functions to window
    window.cartReview = {
        updateQuantity,
        removeItem,
        addMoreItems,
        proceedToCheckout,
        changeVariation,
        onQtyInput,
        onQtyBlur
    };

    // Global functions for onclick handlers
    window.updateQuantity = updateQuantity;
    window.removeItem = removeItem;
    window.addMoreItems = addMoreItems;
    window.proceedToCheckout = proceedToCheckout;

    // Add slideOut animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideOut {
            to {
                opacity: 0;
                transform: translateX(-100%);
            }
        }
    `;
    document.head.appendChild(style);


    document.addEventListener('DOMContentLoaded', () => {
        setCartReviewLoading(true);
        const clearGuestCartIfReload = () => {
            // Requirement: guest can view cart temporarily, but if they refresh the cart page,
            // the guest cart should be cleared.
            try {
                let isReload = false;
                const navEntries = performance && performance.getEntriesByType ? performance.getEntriesByType('navigation') : [];
                if (navEntries && navEntries.length && navEntries[0] && navEntries[0].type) {
                    isReload = navEntries[0].type === 'reload';
                } else if (performance && performance.navigation) {
                    // Legacy fallback: 1 = TYPE_RELOAD
                    isReload = performance.navigation.type === 1;
                }

                if (!isReload) return;

                window.localStorage?.removeItem(GUEST_CART_KEY);
                window.localStorage?.setItem('ppp_cart_count', '0');
                document.dispatchEvent(new CustomEvent('cart:count-changed', {
                    detail: { count: 0 }
                }));
            } catch (e) {
                console.warn('Failed to clear guest cart on reload:', e);
            }
        };

        // Wait for customer cart system to initialize, then load cart
        const initializeCart = async () => {
            // Wait for Firebase and customer cart to be available
            try {
                await window.utils?.waitForFirebaseReady?.();
            } catch (e) {
                console.warn('Firebase not ready:', e);
            }


            try {
                if (window.firebaseAuth && window.onAuthStateChanged) {
                    window.onAuthStateChanged(window.firebaseAuth, async (user) => {
                        try {
                            if (user) {
                                await loadCartFromFirestore(user);
                            } else {
                                clearGuestCartIfReload();
                                await loadCartFromGuestCart();
                            }
                        } finally {
                            setCartReviewLoading(false);
                        }
                    });
                } else {
                    clearGuestCartIfReload();
                    await loadCartFromGuestCart();
                    setCartReviewLoading(false);
                }
                await loadAndRenderAddOns();
            } catch (error) {
                console.error('Error loading cart:', error);
                setCartReviewLoading(false);
            }
        };

        initializeCart();
    });
})();


