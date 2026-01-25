// ============================================
// CART REVIEW PAGE FUNCTIONALITY
// Handles cart display, item management, and navigation to checkout
// ============================================

(function() {
    'use strict';

    const GUEST_CART_KEY = 'ppp_guest_cart';
    let availableSauces = []; // Cache for sauces
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

    // Load available sauces
    async function loadSauces() {
        if (availableSauces.length > 0) return availableSauces;
        
        try {
            await window.utils.waitForFirebaseReady();
            if (window.firestore && window.firestore.fetchMenuItems) {
                availableSauces = await window.firestore.fetchMenuItems('sauce');
            }
        } catch (error) {
            console.error('Error loading sauces:', error);
        }
        return availableSauces;
    }

    // Check if item is ribs or Peri chicken
    async function isRibsOrPeriChicken(itemId) {
        if (!itemId) return false;
        
        try {
            await window.utils.waitForFirebaseReady();
            if (!window.firestore || !window.firestore.fetchMenuItemById) return false;
            
            const item = await window.firestore.fetchMenuItemById(itemId);
            if (!item) return false;
            
            const category = (item.category || item.type || '').toLowerCase();
            return category.includes('ribs') || 
                   category.includes('peri chicken') ||
                   category.includes('perichicken') ||
                   category === 'ribs' ||
                   category === 'peri chicken';
        } catch (error) {
            console.error('Error checking item category:', error);
            return false;
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
    async function renderVariationDropdown(itemId, currentVariation, cartItemEl, source) {
        if (!itemId) return;
        
        const variations = await getItemVariations(itemId);
        if (!variations || variations.length < 2) return;
        
        const itemOptions = cartItemEl.querySelector('.item-options');
        if (!itemOptions) return;
        
        const currentVariationName = currentVariation?.name || currentVariation?.title || 'Select Variation';
        const currentVariationIndex = currentVariation?.index !== undefined ? currentVariation.index : 
            (currentVariation?.name ? variations.findIndex(v => (v.name || v.title) === currentVariation.name) : -1);
        
        const variationOptions = variations.map((variation, index) => {
            const variationName = variation.name || variation.title || `Variation ${index + 1}`;
            const variationPrice = typeof variation.price === 'number' ? variation.price : 
                (typeof variation.price === 'string' ? parseFloat(variation.price) : 0);
            const selected = (currentVariationIndex === index) ? 'selected' : '';
            return `<option value="${index}" ${selected}>${variationName} (₱${variationPrice.toFixed(2)})</option>`;
        }).join('');
        
        const selectId = `variation-select-${itemId}-${Date.now()}`;
        const variationHtml = `
            <div class="variation-select-container">
                <label for="${selectId}" class="variation-select-label">Variation:</label>
                <select 
                    id="${selectId}" 
                    class="variation-select"
                    data-item-id="${itemId}"
                    data-source="${source}"
                    onchange="cartReview.changeVariation(this)"
                >
                    ${variationOptions}
                </select>
            </div>
        `;
        
        // Append variation dropdown to item-options (don't replace, add alongside sauce)
        const existingContent = itemOptions.innerHTML;
        itemOptions.innerHTML = existingContent + variationHtml;
    }

    // Enrich sauces with availability (maxServingsPerDay, remaining, isUnavailable)
    async function enrichSaucesWithAvailability(sauces) {
        if (!sauces || sauces.length === 0) return sauces;
        for (const sauce of sauces) {
            const max = typeof sauce.maxServingsPerDay === 'number'
                ? sauce.maxServingsPerDay
                : (typeof sauce.maxServingsPerDay === 'string' ? parseFloat(sauce.maxServingsPerDay) : null);
            if (max == null || max === undefined || isNaN(max) || max <= 0) {
                sauce._isUnavailable = true;
                sauce._remaining = 0;
            } else {
                const served = await window.firestore.fetchDailyServedCount(sauce.id);
                sauce._remaining = Math.max(0, max - served);
                sauce._isUnavailable = sauce._remaining <= 0;
            }
        }
        return sauces;
    }

    // Render sauce dropdown
    async function renderSauceDropdown(itemId, currentSauce, cartItemEl, source) {
        const itemOptions = cartItemEl.querySelector('.item-options');
        if (!itemOptions || !itemId) {
            // Clear options if no itemId
            if (itemOptions) itemOptions.innerHTML = '';
            return;
        }
        
        const isRibsOrChicken = await isRibsOrPeriChicken(itemId);
        if (!isRibsOrChicken) {
            // Don't clear if variations might be present - just don't render sauce
            return;
        }
        
        let sauces = await loadSauces();
        if (!sauces || sauces.length === 0) {
            // Don't clear if variations might be present - just don't render sauce
            return;
        }

        sauces = await enrichSaucesWithAvailability(sauces);
        
        const currentSauceId = currentSauce?.id || null;
        
        const sauceOptions = sauces.map(sauce => {
            const sauceName = sauce.displayName || sauce.name || sauce.title;
            const selected = sauce.id === currentSauceId ? 'selected' : '';
            const statusText = sauce._isUnavailable ? ' (Unavailable)' : ` (${sauce._remaining} left)`;
            const disabled = sauce._isUnavailable ? ' disabled' : '';
            return `<option value="${sauce.id}" ${selected}${disabled}>${sauceName}${statusText}</option>`;
        }).join('');
        
        const selectId = `sauce-select-${itemId}-${Date.now()}`;
        const sauceHtml = `
            <div class="sauce-select-container">
                <label for="${selectId}" class="sauce-select-label">Sauce:</label>
                <select 
                    id="${selectId}" 
                    class="sauce-select"
                    data-item-id="${itemId}"
                    data-source="${source}"
                    onchange="cartReview.changeSauce(this)"
                >
                    ${sauceOptions}
                </select>
            </div>
        `;
        
        // Append sauce dropdown to item-options (don't replace, add alongside variation)
        const existingContent = itemOptions.innerHTML;
        itemOptions.innerHTML = existingContent + sauceHtml;
    }

    // Change variation for cart item
    async function changeVariation(selectEl) {
        const itemId = selectEl.dataset.itemId;
        const source = selectEl.dataset.source;
        const variationIndex = selectEl.value !== '' ? parseInt(selectEl.value, 10) : null;
        const cartItem = selectEl.closest('.cart-item');
        
        if (!cartItem) return;
        
        // If no variation selected, set to null
        let variationData = null;
        if (variationIndex !== null && !isNaN(variationIndex)) {
            const variations = await getItemVariations(itemId);
            const selectedVariation = variations[variationIndex];
            if (selectedVariation) {
                const variationPrice = typeof selectedVariation.price === 'number' ? selectedVariation.price :
                    (typeof selectedVariation.price === 'string' ? parseFloat(selectedVariation.price) : 0);
                
                variationData = {
                    index: variationIndex,
                    name: selectedVariation.name || selectedVariation.title || null,
                    price: variationPrice
                };
                
                // Update cart item price based on variation
                const unitPrice = variationPrice;
                const qtyDisplay = cartItem.querySelector('.qty-display');
                const quantity = qtyDisplay ? clampQty(qtyDisplay.value) : 1;
                const newLineTotal = unitPrice * quantity;
                
                // Update price display
                const priceEl = cartItem.querySelector('.cart-item-price');
                const pricePerUnitEl = cartItem.querySelector('.price-per-unit');
                if (priceEl) priceEl.textContent = `₱${unitPrice.toFixed(2)}`;
                if (pricePerUnitEl) pricePerUnitEl.textContent = `₱${unitPrice.toFixed(2)} each`;
                
                cartItem.dataset.unitPrice = String(unitPrice);
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
            if (!docId) return;
            
            try {
                await window.utils.waitForFirebaseReady();
                const db = window.firebaseDb;
                const auth = window.firebaseAuth;
                
                if (!db || !auth || !window.doc || !window.updateDoc) return;
                
                const user = auth.currentUser;
                if (!user) return;
                
                const customerRef = window.doc(db, 'customers', user.uid);
                const cartItemRef = window.doc(customerRef, 'cartItems', docId);
                
                const updateData = {
                    variation: variationData,
                    updatedAt: new Date()
                };
                
                // Update price if variation changed
                if (variationData && variationData.price) {
                    const qtyDisplay = cartItem.querySelector('.qty-display');
                    const quantity = qtyDisplay ? clampQty(qtyDisplay.value) : 1;
                    updateData.price = variationData.price * quantity;
                }
                
                await window.updateDoc(cartItemRef, updateData);
                
                // Update cart summary after variation change
                updateCartSummary();
            } catch (error) {
                console.error('Error updating variation:', error);
            }
        }
        
        // Update cart summary
        updateCartSummary();
    }

    // Change sauce for cart item
    async function changeSauce(selectEl) {
        const itemId = selectEl.dataset.itemId;
        const source = selectEl.dataset.source;
        const newSauceId = selectEl.value;
        const cartItem = selectEl.closest('.cart-item');
        
        if (!cartItem) return;
        
        // If no sauce selected, set to null
        let sauceData = null;
        if (newSauceId) {
            const sauces = await loadSauces();
            const selectedSauce = sauces.find(s => s.id === newSauceId);
            if (selectedSauce) {
                sauceData = {
                    id: selectedSauce.id,
                    name: selectedSauce.displayName || selectedSauce.name || selectedSauce.title,
                    price: 0
                };
            }
        }
        
        if (source === 'guest') {
            const guestId = cartItem.dataset.guestId;
            const cart = getGuestCart();
            const item = cart.find(i => i.id === guestId);
            if (item) {
                item.sauce = sauceData;
                setGuestCart(cart);
            }
        } else {
            const docId = cartItem.dataset.cartDocId;
            if (!docId) return;
            
            try {
                await window.utils.waitForFirebaseReady();
                const db = window.firebaseDb;
                const auth = window.firebaseAuth;
                
                if (!db || !auth || !window.doc || !window.updateDoc) return;
                
                const user = auth.currentUser;
                if (!user) return;
                
                const customerRef = window.doc(db, 'customers', user.uid);
                const cartItemRef = window.doc(customerRef, 'cartItems', docId);
                
                await window.updateDoc(cartItemRef, {
                    sauce: sauceData,
                    updatedAt: new Date()
                });
            } catch (error) {
                console.error('Error updating sauce:', error);
            }
        }
    }

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
            return;
        }

        if (!docId || !unitPrice) return;

        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.updateDoc) {
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
        } catch (error) {
            console.error('Error updating cart item quantity:', error);
        }
    }

    function removeGuestCartItem(guestId) {
        if (!guestId) return;
        const cart = getGuestCart().filter((item) => item.id !== guestId);
        setGuestCart(cart);
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
                const sauce = data.sauce || null;
                const variation = data.variation || null;
                const itemId = data.itemId || null;

                const itemEl = document.createElement('div');
                itemEl.className = 'cart-item';
                itemEl.dataset.cartDocId = docId;
                itemEl.dataset.unitPrice = String(unitPrice);
                itemEl.dataset.source = 'user';
                itemEl.dataset.itemId = itemId || '';

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
                // Render sauce dropdown if applicable (ribs or peri chicken)
                // Both can appear together
                if (itemId) {
                    await renderVariationDropdown(itemId, variation, itemEl, 'user');
                    await renderSauceDropdown(itemId, sauce, itemEl, 'user');
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
            const sauce = data.sauce || null;
            const variation = data.variation || null;
            const itemId = data.itemId || null;

            const itemEl = document.createElement('div');
            itemEl.className = 'cart-item';
            itemEl.dataset.guestId = guestId;
            itemEl.dataset.unitPrice = String(unitPrice);
            itemEl.dataset.source = 'guest';
            itemEl.dataset.itemId = itemId || '';

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
            // Render sauce dropdown if applicable (ribs or peri chicken)
            // Both can appear together
            if (itemId) {
                await renderVariationDropdown(itemId, variation, itemEl, 'guest');
                await renderSauceDropdown(itemId, sauce, itemEl, 'guest');
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
                    return `
                        <div class="ppp-addon-card">
                            <img src="${String(img).replace(/"/g, '&quot;')}" alt="${String(name).replace(/"/g, '&quot;')}">
                            <div class="ppp-addon-name">${name}</div>
                            <div class="ppp-addon-meta">
                                <div class="ppp-addon-price">₱${price.toFixed(2)}</div>
                                <button type="button" class="btn btn-outline-danger ppp-addon-addbtn" data-addon-id="${it.id}">
                                    Add
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

        const qtyInput = cartItem.querySelector('.qty-display');
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

        cartItem.style.animation = 'slideOut 0.3s ease forwards';
        
        setTimeout(async () => {
            cartItem.remove();
            updateCartSummary();

            if (source === 'guest') {
                removeGuestCartItem(guestId);
                return;
            }

            if (!docId) return;

            try {
                await window.utils.waitForFirebaseReady();

                const db = window.firebaseDb;
                const auth = window.firebaseAuth;

                if (!db || !auth || !window.doc || !window.deleteDoc) {
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

                await window.deleteDoc(cartItemRef);
            } catch (error) {
                console.error('Error deleting cart item from Firestore:', error);
            }
        }, 300);
    }

    function updateCartSummary() {
        const items = document.querySelectorAll('.cart-item');
        const summaryItemsEl = document.getElementById('summaryItems');
        const cartItemsList = document.querySelector('.cart-items-list');
        const cartSummary = document.querySelector('.cart-summary');
        const cartBadges = document.querySelectorAll('.cart-badge');
        const proceedBtn = document.querySelector('.proceed-btn');
        if (!summaryItemsEl || !cartItemsList || !cartSummary) return;

        // If empty, reset badges and show empty state
        if (items.length === 0) {
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

        items.forEach((item) => {
            const titleEl = item.querySelector('.cart-item-title');
            const priceEl = item.querySelector('.cart-item-price');
            const qtyEl = item.querySelector('.qty-display');

            const title = titleEl ? titleEl.textContent.trim() : 'Item';
            const priceText = priceEl ? priceEl.textContent : '₱0';
            const overrideRaw = item.dataset._tempQtyOverride;
            const qtyRaw =
                overrideRaw !== undefined
                    ? overrideRaw
                    : (qtyEl ? qtyEl.value : '1');
            const qty = Number(qtyRaw) > 0 ? clampQty(qtyRaw) : 0;

            const numericPrice = parseFloat(priceText.replace(/[^\d.]/g, '')) || 0;
            const lineTotal = numericPrice * qty;
            subtotal += lineTotal;
            totalCount += qty;

            rowsHtml += `
                <div class="summary-row">
                    <span class="summary-label">${title} x ${qty}</span>
                    <span class="summary-value">₱${lineTotal.toFixed(2)}</span>
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
        changeSauce,
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

    // Initialize on DOM ready
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

        // Wait for auth state so we get the correct current user before reading cart
        if (window.firebaseAuth && window.onAuthStateChanged) {
            window.onAuthStateChanged(window.firebaseAuth, async (user) => {
                try {
                    if (user) {
                        await loadCartFromFirestore(user);
                        await loadAndRenderAddOns();
                    } else {
                        clearGuestCartIfReload();
                        await loadCartFromGuestCart();
                        await loadAndRenderAddOns();
                    }
                } finally {
                    setCartReviewLoading(false);
                }
            });
        } else {
            // Fallback if auth isn't available – treat as guest
            (async () => {
                try {
                    clearGuestCartIfReload();
                    await loadCartFromGuestCart();
                    await loadAndRenderAddOns();
                } finally {
                    setCartReviewLoading(false);
                }
            })();
        }
    });
})();


