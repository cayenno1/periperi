// ============================================
// CART FUNCTIONALITY
// Handles both guest cart (localStorage) and Firestore cart
// ============================================

(function() {
    'use strict';

    const GUEST_CART_KEY = 'ppp_guest_cart';

    // Guest cart helpers (temporary cart stored locally)
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

    function clearGuestCart() {
        try {
            window.localStorage?.removeItem(GUEST_CART_KEY);
        } catch (e) {
            console.warn('Failed to clear guest cart:', e);
        }
    }

    function addGuestCartItem({ itemId, name, imageUrl, price, quantity, variation, sauce }) {
        const cart = getGuestCart();
        const numericUnit = typeof price === 'number' ? price : Number(price) || 0;
        const numericQty = typeof quantity === 'number' ? quantity : Number(quantity) || 1;
        const lineTotal = numericUnit * numericQty;

        // Try to match existing item by itemId + variation + sauce
        let existingIndex = -1;
        if (itemId) {
            existingIndex = cart.findIndex((item) => {
                const itemIdMatch = item?.itemId === itemId;
                const variationMatch = JSON.stringify(item?.variation || null) === JSON.stringify(variation || null);
                const sauceMatch = JSON.stringify(item?.sauce || null) === JSON.stringify(sauce || null);
                return itemIdMatch && variationMatch && sauceMatch;
            });
        }

        if (existingIndex !== -1) {
            const existing = cart[existingIndex] || {};
            const currentQty = typeof existing.quantity === 'number' ? existing.quantity : Number(existing.quantity) || 0;
            const currentPrice = typeof existing.price === 'number' ? existing.price : Number(existing.price) || 0;
            existing.quantity = currentQty + numericQty;
            existing.price = currentPrice + lineTotal;
            cart[existingIndex] = existing;
        } else {
            const id = itemId || `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            cart.push({
                id,
                itemId: itemId || null,
                name: name || null,
                imageUrl: imageUrl || null,
                // Store line total
                price: lineTotal,
                quantity: numericQty,
                variation: variation || null,
                sauce: sauce || null
            });
        }

        setGuestCart(cart);
    }

    // Save to Firestore cart
    async function saveCartItemToFirestore({ itemId, name, imageUrl, price, quantity, variation, sauce }) {
        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.collection || !window.setDoc) {
                console.warn('Firebase not fully initialized for cart save');
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                console.warn('No authenticated user; skipping save to Firestore cart');
                return;
            }

            const customerRef = window.doc(db, 'customers', user.uid);
            const cartItemsCol = window.collection(customerRef, 'cartItems');

            const numericPrice = typeof price === 'number' ? price : Number(price) || 0;
            const numericQty = typeof quantity === 'number' ? quantity : Number(quantity) || 1;

            // Check if this item already exists in the cart with same variation and sauce
            let existingSnap = null;
            if (itemId) {
                const q = window.query(cartItemsCol, window.where('itemId', '==', itemId));
                const existingQuerySnap = await window.getDocs(q);
                existingQuerySnap.forEach((docSnap) => {
                    const data = docSnap.data() || {};
                    const variationMatch = JSON.stringify(data.variation || null) === JSON.stringify(variation || null);
                    const sauceMatch = JSON.stringify(data.sauce || null) === JSON.stringify(sauce || null);
                    if (variationMatch && sauceMatch && !existingSnap) {
                        existingSnap = docSnap;
                    }
                });
            }

            if (existingSnap) {
                // Update existing cart item: add to quantity and price (treat price as running total)
                const data = existingSnap.data() || {};
                const currentQty = typeof data.quantity === 'number' ? data.quantity : Number(data.quantity) || 0;
                const currentPrice = typeof data.price === 'number' ? data.price : Number(data.price) || 0;

                const newQty = currentQty + numericQty;
                const newPrice = currentPrice + (numericPrice * numericQty);

                await window.updateDoc(existingSnap.ref, {
                    quantity: newQty,
                    price: newPrice,
                    updatedAt: new Date()
                });
            } else {
                // Create new cart item document
                const cartItemRef = window.doc(cartItemsCol);
                await window.setDoc(cartItemRef, {
                    itemId: itemId || null,
                    name: name || null,
                    imageUrl: imageUrl || null,
                    // For a new item, price is the total for this line (unit price * quantity)
                    price: numericPrice * numericQty,
                    quantity: numericQty,
                    variation: variation || null,
                    sauce: sauce || null,
                    createdAt: new Date()
                });
            }
        } catch (error) {
            console.error('Error saving cart item to Firestore:', error);
        }
    }

    // Add to cart function (works for both guest and authenticated users)
    // NOTE: This function now delegates to customer-cart.js for items with linked sauces
    function addToCart(e) {
        if (!e) return;
        e.stopPropagation();

        const btn = e.target.closest('.add-to-cart-btn') || e.target.closest('.add-plus-btn');
        if (!btn) return;

        // If customer-cart.js is available, use its addToCart which handles linked sauces
        if (window.customerCart && window.customerCart.addToCart) {
            // Delegate to customer-cart.js - it will handle linked sauces modal
            return window.customerCart.addToCart(e);
        }

        // Fallback to old behavior if customer-cart.js not available
        const itemId = btn.dataset.itemId || '';
        let itemName = btn.dataset.itemName || '';
        const imageUrl = btn.dataset.itemImg || '';
        const priceValue = Number(btn.dataset.itemPrice || '0') || 0;
        const quantity = 1;

        // From menu + button: variation can be passed for products-with-variations (first in-stock)
        const variationId = btn.dataset.variationId || null;
        const variationName = btn.dataset.variationName || null;
        const variationPrice = btn.dataset.variationPrice != null ? Number(btn.dataset.variationPrice) : null;
        const variation = (variationId || variationName) ? {
            id: variationId || null,
            name: variationName || null,
            price: (typeof variationPrice === 'number' && !isNaN(variationPrice)) ? variationPrice : 0
        } : null;
        if (variation && variationName) {
            itemName = `${itemName} - ${variationName}`;
        }

        window.incrementCartCount(1);

        btn.innerHTML = '<i class="fas fa-check"></i>';
        btn.setAttribute('aria-pressed', 'true');

        // Revert back to plus icon after 1 second
        setTimeout(() => {
            if (!btn.isConnected) return;
            btn.innerHTML = '<i class="fas fa-plus"></i>';
            btn.setAttribute('aria-pressed', 'false');
        }, 1000);
        
        const user = window.firebaseAuth?.currentUser;
        if (user) {
            saveCartItemToFirestore({
                itemId,
                name: itemName,
                imageUrl,
                price: priceValue,
                quantity,
                variation: variation || undefined
            });
        } else {
            addGuestCartItem({
                itemId,
                name: itemName,
                imageUrl,
                price: priceValue,
                quantity,
                variation: variation || undefined
            });
        }
    }

    // Expose to window
    window.cart = {
        getGuestCart,
        setGuestCart,
        clearGuestCart,
        addGuestCartItem,
        saveCartItemToFirestore,
        addToCart
    };

    // Global function for onclick handlers
    // Set this, but customer-cart.js will overwrite it when it loads
    window.addToCart = addToCart;
})();

