// Shared client-side utilities used across pages.
// This file intentionally exposes a small global API for simple HTML pages.

(function() {
    'use strict';

    const ppp = (window.ppp = window.ppp || {});

    const CART_COUNT_KEY = 'ppp_cart_count';
    const LOYALTY_POINTS_KEY = 'ppp_points';
    const ROUTES = {
        home: 'index.html',
        menu: 'menu.html',
        cart: 'cart_review.html',
        help: 'help.html'
    };

    // Safe number parsing
    function safeNumber(value, fallback = 0) {
        const parsed = Number(value);
        if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
            return fallback;
        }
        return parsed;
    }

    // Cart count management
    function getStoredCartCount() {
        try {
            const raw = window.localStorage?.getItem(CART_COUNT_KEY);
            return safeNumber(raw, 0);
        } catch (error) {
            console.warn('Cart count read failed:', error);
            return 0;
        }
    }

    function storeCartCount(count) {
        try {
            window.localStorage?.setItem(CART_COUNT_KEY, String(count));
        } catch (error) {
            console.warn('Cart count save failed:', error);
        }
    }

    function updateCartBadges(count = getStoredCartCount()) {
        const badges = document.querySelectorAll('.cart-badge');
        badges.forEach((badge) => {
            badge.textContent = Math.max(0, safeNumber(count, 0));
        });
    }

    function broadcastCartCount(count) {
        document.dispatchEvent(new CustomEvent('cart:count-changed', {
            detail: { count }
        }));
    }

    // Navigation functions
    function navigateTo(key) {
        const target = ROUTES[key];
        if (target) {
            window.location.href = target;
        }
    }

    // Format peso currency
    function formatPeso(value) {
        const num = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(num)) return '';
        return `₱${num.toFixed(2)}`;
    }

    // Wait for Firebase to be ready
    async function waitForFirebaseReady(maxAttempts = 40, delayMs = 50) {
        let attempts = 0;
        while (!window.firebaseReady && attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            attempts++;
        }
    }

    function normalizePoints(value) {
        const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(n) || Number.isNaN(n)) return 0;
        return Math.max(0, Math.floor(n));
    }

    function writeStoredPoints(points) {
        try {
            window.localStorage?.setItem(LOYALTY_POINTS_KEY, String(normalizePoints(points)));
        } catch (e) {}
    }

    /**
     * Ensure every customer doc has loyalty fields with safe defaults.
     * This prevents "undefined points" across account/checkout/receipt pages.
     *
     * Creates the customer doc if missing (minimal fields + loyalty defaults).
     */
    async function ensureCustomerLoyaltyDefaults(userOrUid) {
        try {
            await waitForFirebaseReady();

            const db = window.firebaseDb;
            if (!db || !window.doc || !window.getDoc || !window.setDoc) return { points: 0, updated: false };

            const uid = typeof userOrUid === 'string' ? userOrUid : userOrUid?.uid;
            if (!uid) return { points: 0, updated: false };

            const customerRef = window.doc(db, 'customers', uid);

            let snap = null;
            let data = {};
            try {
                snap = await window.getDoc(customerRef);
                data = snap.exists() ? (snap.data() || {}) : {};
            } catch (e) {
                snap = null;
                data = {};
            }

            const patch = {};
            const exists = !!(snap && typeof snap.exists === 'function' && snap.exists());

            // Loyalty fields
            const points = normalizePoints(data.points);
            if (!exists || typeof data.points !== 'number' || data.points !== points) {
                patch.points = points;
            }

            const lastEarnedPoints = normalizePoints(data.lastEarnedPoints);
            if (!exists || typeof data.lastEarnedPoints !== 'number' || data.lastEarnedPoints !== lastEarnedPoints) {
                patch.lastEarnedPoints = lastEarnedPoints;
            }

            if (!Array.isArray(data.pointsHistory)) {
                patch.pointsHistory = [];
            }

            // Keep lastEarnedAt if present; otherwise standardize it to null.
            if (typeof data.lastEarnedAt === 'undefined') {
                patch.lastEarnedAt = null;
            }

            // If the doc doesn't exist yet, store minimal identity info (merge-safe).
            if (!exists) {
                patch.uid = uid;
                const email = typeof userOrUid === 'object' ? (userOrUid?.email || null) : null;
                if (email) patch.email = email;
                patch.createdAt = new Date();
            }

            // Timestamp for audits / debugging
            patch.updatedAt = window.serverTimestamp ? window.serverTimestamp() : new Date();

            const needsWrite = Object.keys(patch).length > 1 || (Object.keys(patch).length === 1 && !('updatedAt' in patch));
            if (needsWrite) {
                await window.setDoc(customerRef, patch, { merge: true });
            }

            // Always keep local points cache consistent (checkout uses it).
            writeStoredPoints(points);
            return { points, updated: needsWrite };
        } catch (e) {
            // Never block the page; default to 0.
            writeStoredPoints(0);
            return { points: 0, updated: false };
        }
    }

    // ============================================
    // TOAST NOTIFICATION SYSTEM
    // ============================================
    function createToastContainer() {
        let container = document.getElementById('toastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toastContainer';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        return container;
    }

    function showToast(message, variant = 'info', duration = 3000) {
        const container = createToastContainer();
        const toast = document.createElement('div');
        toast.className = `toast toast-${variant}`;
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'polite');
        
        // Icon based on variant
        let icon = 'fa-info-circle';
        if (variant === 'success') icon = 'fa-check-circle';
        else if (variant === 'error') icon = 'fa-exclamation-circle';
        else if (variant === 'warning') icon = 'fa-exclamation-triangle';
        
        toast.innerHTML = `
            <div class="toast-content">
                <i class="fas ${icon}"></i>
                <span class="toast-message">${message}</span>
            </div>
            <button class="toast-close" aria-label="Close notification">
                <i class="fas fa-times"></i>
            </button>
        `;
        
        container.appendChild(toast);
        
        // Trigger animation
        setTimeout(() => toast.classList.add('show'), 10);
        
        // Close button handler
        const closeBtn = toast.querySelector('.toast-close');
        const closeToast = () => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.remove();
                }
            }, 300);
        };
        
        if (closeBtn) {
            closeBtn.addEventListener('click', closeToast);
        }
        
        // Auto-close after duration
        const timeout = setTimeout(closeToast, duration);
        
        // Pause timeout on hover
        toast.addEventListener('mouseenter', () => clearTimeout(timeout));
        toast.addEventListener('mouseleave', () => {
            setTimeout(closeToast, duration);
        });
    }

    // ============================================
    // CART PREVIEW FUNCTIONALITY
    // ============================================
    let cartPreviewTimeout = null;
    let cartPreviewElement = null;
    let cartPreviewHideDelay = 200;

    async function loadCartItems() {
        try {
            await waitForFirebaseReady();
            const user = window.firebaseAuth?.currentUser;
            
            if (user && window.firebaseDb && window.doc && window.collection && window.getDocs) {
                // Load directly from Firestore - this is the source of truth
                const customerRef = window.doc(window.firebaseDb, 'customers', user.uid);
                const cartItemsCol = window.collection(customerRef, 'cartItems');
                const snap = await window.getDocs(cartItemsCol);
                const items = [];
                snap.forEach((docSnap) => {
                    const data = docSnap.data();
                    const lineId = data.lineId || docSnap.id;
                    // Calculate unit price from total price
                    const totalPrice = typeof data.price === 'number' ? data.price : Number(data.price) || 0;
                    const qty = typeof data.quantity === 'number' ? data.quantity : Number(data.quantity) || 1;
                    const unitPrice = qty > 0 ? totalPrice / qty : 0;
                    
                    items.push({ 
                        id: docSnap.id, // Use Firestore doc ID
                        lineId: lineId,
                        itemId: data.itemId || data.id || '',
                        menuId: data.menuId || '',
                        name: data.name || '',
                        imageUrl: data.imageUrl || data.image || '',
                        price: totalPrice, // Total price for preview
                        unitPrice: unitPrice, // Unit price
                        quantity: qty,
                        variation: data.variation || null,
                        sauce: data.sauce || null,
                        freeWithPeriRibs: data.freeWithPeriRibs || false,
                        linkedToMainItem: data.linkedToMainItem || null,
                        parentId: data.parentId || null
                    });
                });
                return items;
            } else {
                // Guest: load from localStorage
                return window.cart?.getGuestCart?.() || [];
            }
        } catch (error) {
            console.error('Error loading cart items:', error);
            return [];
        }
    }

    function getCartItemCount(items) {
        if (!Array.isArray(items) || items.length === 0) return 0;
        return items.reduce((sum, item) => {
            const qty = typeof item.quantity === 'number' ? item.quantity : Number(item.quantity) || 1;
            return sum + Math.max(0, qty);
        }, 0);
    }

    function syncCartCountFromItems(items) {
        const count = getCartItemCount(items);
        storeCartCount(count);
        updateCartBadges(count);
        broadcastCartCount(count);
        return count;
    }

    async function removeCartItemFromPreview(cartItemId) {
        if (!cartItemId) return;
        try {
            await waitForFirebaseReady();
            const user = window.firebaseAuth?.currentUser;

            if (user && window.firebaseDb && window.doc && window.deleteDoc) {
                // Try to use customer-cart.js removeFromCart first (handles linked free sauces)
                if (window.customerCart && window.customerCart.removeFromCart) {
                    // Find the lineId for this cart item
                    const items = await loadCartItems();
                    const itemToRemove = items.find(item => item.id === cartItemId || item.lineId === cartItemId);
                    
                    if (itemToRemove && itemToRemove.lineId) {
                        await window.customerCart.removeFromCart(itemToRemove.lineId);
                    } else {
                        // Fallback: direct Firestore delete
                        const customerRef = window.doc(window.firebaseDb, 'customers', user.uid);
                        const cartItemRef = window.doc(customerRef, 'cartItems', cartItemId);
                        await window.deleteDoc(cartItemRef);
                    }
                } else {
                    // Fallback: direct Firestore delete with linked free sauce handling
                    const items = await loadCartItems();
                    const itemToRemove = items.find(item => item.id === cartItemId || item.lineId === cartItemId);
                    
                    if (itemToRemove) {
                        const isMainItem = !itemToRemove.freeWithPeriRibs;
                        
                        // If it's a main item, find and delete all linked free sauces
                        if (isMainItem && window.collection && window.getDocs) {
                            const mainItemMenuId = itemToRemove.menuId || itemToRemove.itemId;
                            const customerRef = window.doc(window.firebaseDb, 'customers', user.uid);
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
                        const customerRef = window.doc(window.firebaseDb, 'customers', user.uid);
                        const cartItemRef = window.doc(customerRef, 'cartItems', cartItemId);
                        await window.deleteDoc(cartItemRef);
                    } else {
                        // Item not found, just delete by ID
                        const customerRef = window.doc(window.firebaseDb, 'customers', user.uid);
                        const cartItemRef = window.doc(customerRef, 'cartItems', cartItemId);
                        await window.deleteDoc(cartItemRef);
                    }
                }
            } else {
                // Guest: remove from localStorage cart by id (with linked free sauce handling)
                const cart = window.cart?.getGuestCart?.() || [];
                const itemToRemove = cart.find(item => item.id === cartItemId || item.lineId === cartItemId);
                
                if (itemToRemove) {
                    const isMainItem = !itemToRemove.freeWithPeriRibs;
                    
                    // If it's a main item, find and remove all linked free sauces
                    if (isMainItem) {
                        const mainItemMenuId = itemToRemove.menuId || itemToRemove.itemId;
                        
                        const filteredCart = cart.filter((item) => {
                            // Remove the main item being deleted
                            if (item.id === cartItemId || item.lineId === cartItemId) return false;
                            
                            // Remove free sauces linked to this main item
                            if (item.freeWithPeriRibs === true) {
                                const linkedToMainItem = item.linkedToMainItem || item.parentId || item.menuId || item.itemId;
                                if (linkedToMainItem === mainItemMenuId) {
                                    return false; // Remove this free sauce
                                }
                            }
                            
                            return true; // Keep other items
                        });
                        
                        window.cart?.setGuestCart?.(filteredCart);
                    } else {
                        // Just remove the single item (free sauce)
                        const filteredCart = cart.filter((item) => item?.id !== cartItemId && item?.lineId !== cartItemId);
                        window.cart?.setGuestCart?.(filteredCart);
                    }
                } else {
                    // Item not found, just filter by ID
                    const filteredCart = cart.filter((item) => item?.id !== cartItemId && item?.lineId !== cartItemId);
                    window.cart?.setGuestCart?.(filteredCart);
                }
            }

            // Refresh preview + count
            const items = await loadCartItems();
            syncCartCountFromItems(items);
            if (cartPreviewElement && cartPreviewElement.classList.contains('show')) {
                renderCartPreview(items, cartPreviewElement);
            }
        } catch (error) {
            console.error('Error removing cart item from preview:', error);
            showToast('Could not remove item. Please try again.', 'error');
        }
    }

    function createCartPreview() {
        if (cartPreviewElement) return cartPreviewElement;
        
        const preview = document.createElement('div');
        preview.id = 'cartPreview';
        preview.className = 'cart-preview-dropdown';
        preview.innerHTML = `
            <div class="cart-preview-header">
                <h4>Cart</h4>
                <button class="cart-preview-close" aria-label="Close cart preview">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="cart-preview-content">
                <div class="cart-preview-loading">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>Loading...</span>
                </div>
            </div>
            <div class="cart-preview-footer">
                <div class="cart-preview-total">
                    <span class="cart-preview-total-label">Total:</span>
                    <span class="cart-preview-total-amount" id="cartPreviewTotal">₱0.00</span>
                </div>
                <button class="cart-preview-checkout-btn" onclick="window.goToCart()">
                    View Cart
                </button>
            </div>
        `;
        
        document.body.appendChild(preview);
        cartPreviewElement = preview;
        
        // Keep open while hovered
        preview.addEventListener('mouseenter', () => {
            clearTimeout(cartPreviewTimeout);
        });
        preview.addEventListener('mouseleave', () => {
            clearTimeout(cartPreviewTimeout);
            cartPreviewTimeout = setTimeout(() => {
                hideCartPreview();
            }, cartPreviewHideDelay);
        });

        // Close button handler
        const closeBtn = preview.querySelector('.cart-preview-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', hideCartPreview);
        }
        
        // Close on outside click
        preview.addEventListener('click', (e) => {
            if (e.target === preview) {
                hideCartPreview();
            }
        });
        
        return preview;
    }

    async function showCartPreview(cartIcon) {
        if (!cartIcon) return;
        
        clearTimeout(cartPreviewTimeout);
        
        const preview = createCartPreview();
        const rect = cartIcon.getBoundingClientRect();
        const scrollY = window.scrollY || window.pageYOffset;
        
        // Position preview relative to cart icon
        // Try to position below the icon, but adjust if near bottom of viewport
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        
        if (spaceBelow < 400 && spaceAbove > 400) {
            // Position above if more space above
            preview.style.top = `${rect.top + scrollY - 10}px`;
            preview.style.bottom = 'auto';
            preview.style.transform = 'translateY(-100%)';
        } else {
            // Position below
            preview.style.top = `${rect.bottom + scrollY + 10}px`;
            preview.style.bottom = 'auto';
            preview.style.transform = 'translateY(0)';
        }
        
        // Position horizontally - align to right edge of icon or viewport
        const iconRight = window.innerWidth - rect.right;
        if (iconRight < 200) {
            // If icon is near right edge, align preview to right edge of viewport
            preview.style.right = '20px';
            preview.style.left = 'auto';
        } else {
            // Align to right edge of icon
            preview.style.right = `${iconRight}px`;
            preview.style.left = 'auto';
        }
        
        // Show loading state
        const content = preview.querySelector('.cart-preview-content');
        content.innerHTML = `
            <div class="cart-preview-loading">
                <i class="fas fa-spinner fa-spin"></i>
                <span>Loading...</span>
            </div>
        `;
        
        preview.classList.add('show');
        
        // Load cart items
        const items = await loadCartItems();
        renderCartPreview(items, preview);
    }

    function renderCartPreview(items, preview) {
        const content = preview.querySelector('.cart-preview-content');
        const totalEl = preview.querySelector('#cartPreviewTotal');
        
        if (!items || items.length === 0) {
            content.innerHTML = `
                <div class="cart-preview-empty">
                    <i class="fas fa-shopping-bag"></i>
                    <p>Your cart is empty</p>
                </div>
            `;
            if (totalEl) totalEl.textContent = '₱0.00';
            return;
        }
        
        let total = 0;
        const itemsHtml = items.slice(0, 5).map(item => {
            const price = typeof item.price === 'number' ? item.price : Number(item.price) || 0;
            const qty = typeof item.quantity === 'number' ? item.quantity : Number(item.quantity) || 1;
            const unitPrice = qty > 0 ? price / qty : 0;
            const isFree = item.freeWithPeriRibs === true;
            // Only add to total if not free
            if (!isFree) {
                total += price;
            }
            
            const itemId = item.id || item.lineId || '';
            const lineId = item.lineId || item.id || '';
            const priceDisplay = isFree ? 'Free' : formatPeso(unitPrice);
            
            // For free items, hide quantity controls
            const qtyControls = isFree 
                ? `<span class="cart-preview-qty-display" style="opacity:0.6;">${qty}</span>`
                : `
                    <button class="cart-preview-qty-btn" aria-label="Decrease quantity" onclick="window.utils.changeCartPreviewQty('${lineId}', -1, ${unitPrice})">-</button>
                    <span class="cart-preview-qty-display">${qty}</span>
                    <button class="cart-preview-qty-btn" aria-label="Increase quantity" onclick="window.utils.changeCartPreviewQty('${lineId}', 1, ${unitPrice})">+</button>
                `;
            
            return `
                <div class="cart-preview-item">
                    <img src="${item.imageUrl || ''}" alt="${item.name || 'Item'}" class="cart-preview-item-img" onerror="this.style.display='none'">
                    <div class="cart-preview-item-info">
                        <div class="cart-preview-item-name">${item.name || 'Item'}${isFree ? ' <span style="color:#4caf50;font-size:0.75em;">(Free)</span>' : ''}</div>
                        <div class="cart-preview-item-details">
                            <div class="cart-preview-qty">
                                ${qtyControls}
                            </div>
                            <span class="cart-preview-item-price">${priceDisplay}</span>
                        </div>
                    </div>
                    <button class="cart-preview-remove-btn" aria-label="Remove item" onclick="window.utils.removeCartItemFromPreview('${lineId}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;
        }).join('');
        
        const moreItems = items.length > 5 ? `<div class="cart-preview-more">+${items.length - 5} more items</div>` : '';
        
        content.innerHTML = `
            <div class="cart-preview-items">
                ${itemsHtml}
                ${moreItems}
            </div>
        `;
        
        if (totalEl) totalEl.textContent = formatPeso(total);
    }

    function hideCartPreview() {
        if (cartPreviewElement) {
            cartPreviewElement.classList.remove('show');
        }
        clearTimeout(cartPreviewTimeout);
    }

    function setupCartPreview() {
        const cartIcons = document.querySelectorAll('.cart-icon, .floating-cart');
        
        cartIcons.forEach(icon => {
            // Show on hover (desktop) or click (mobile)
            if (window.matchMedia('(hover: hover)').matches) {
                icon.addEventListener('mouseenter', () => {
                    cartPreviewTimeout = setTimeout(() => showCartPreview(icon), 300);
                });
                icon.addEventListener('mouseleave', () => {
                    clearTimeout(cartPreviewTimeout);
                    cartPreviewTimeout = setTimeout(() => {
                        if (cartPreviewElement && cartPreviewElement.matches(':hover')) return;
                        hideCartPreview();
                    }, cartPreviewHideDelay);
                });
            } else {
                icon.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (cartPreviewElement?.classList.contains('show')) {
                        hideCartPreview();
                    } else {
                        showCartPreview(icon);
                    }
                });
            }
        });
        
        // Hide on outside click
        document.addEventListener('click', (e) => {
            if (cartPreviewElement && !cartPreviewElement.contains(e.target) && 
                !e.target.closest('.cart-icon') && !e.target.closest('.floating-cart')) {
                hideCartPreview();
            }
        });
    }

    async function changeCartPreviewQty(cartItemId, delta, unitPrice) {
        if (!cartItemId || !delta) return;
        try {
            
            await waitForFirebaseReady();
            const user = window.firebaseAuth?.currentUser;

            if (user && window.firebaseDb && window.doc && window.updateDoc) {
                const customerRef = window.doc(window.firebaseDb, 'customers', user.uid);
                
                // Find the cart item by lineId or document ID
                let cartItemRef = null;
                let data = null;
                
                if (window.collection && window.getDocs) {
                    const cartItemsCol = window.collection(customerRef, 'cartItems');
                    const snap = await window.getDocs(cartItemsCol);
                    
                    // Try to find by lineId first, then by document ID
                    snap.forEach((docSnap) => {
                        const docData = docSnap.data();
                        const docLineId = docData.lineId || docSnap.id;
                        if (docLineId === cartItemId || docSnap.id === cartItemId) {
                            cartItemRef = docSnap.ref;
                            data = docData;
                        }
                    });
                } else {
                    // Fallback: try direct document ID lookup
                    cartItemRef = window.doc(customerRef, 'cartItems', cartItemId);
                    if (window.getDoc) {
                        const snap = await window.getDoc(cartItemRef);
                        if (snap.exists()) {
                            data = snap.data() || {};
                        }
                    }
                }
                
                if (!cartItemRef || !data) {
                    console.warn('Cart item not found:', cartItemId);
                    return;
                }
                
                // Check if item is free - prevent quantity changes
                if (data.freeWithPeriRibs === true) {
                    showToast('Free items cannot be modified. Remove the main item to change quantity.', 'info');
                    return;
                }
                
                const currentQty = typeof data.quantity === 'number' ? data.quantity : Number(data.quantity) || 1;
                const numericUnit = typeof unitPrice === 'number' ? unitPrice : Number(unitPrice) || 0;
                const newQty = Math.max(1, currentQty + delta);
                const mainItemId = data.menuId || data.itemId || data.lineId;
                
                // Update main item quantity
                await window.updateDoc(cartItemRef, {
                    quantity: newQty,
                    price: numericUnit * newQty,
                    updatedAt: new Date()
                });
                
                // Sync free sauces linked to this main item
                if (window.collection && window.getDocs) {
                    const cartItemsCol = window.collection(customerRef, 'cartItems');
                    const snap = await window.getDocs(cartItemsCol);
                    
                    const updatePromises = [];
                    snap.forEach((docSnap) => {
                        const sauceData = docSnap.data();
                        if (sauceData.freeWithPeriRibs === true) {
                            const linkedToMainItem = sauceData.linkedToMainItem || sauceData.parentId || sauceData.menuId || sauceData.itemId;
                            if (linkedToMainItem === mainItemId) {
                                updatePromises.push(
                                    window.updateDoc(docSnap.ref, {
                                        quantity: newQty,
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
                }
            } else {
                // Guest cart: update localStorage
                const cart = window.cart?.getGuestCart?.() || [];
                // Find by lineId or id
                const idx = cart.findIndex((item) => 
                    item?.id === cartItemId || 
                    item?.lineId === cartItemId
                );
                if (idx === -1) return;
                
                // Check if item is free - prevent quantity changes
                if (cart[idx].freeWithPeriRibs === true) {
                    showToast('Free items cannot be modified. Remove the main item to change quantity.', 'info');
                    return;
                }
                
                const numericUnit = typeof unitPrice === 'number' ? unitPrice : Number(unitPrice) || 0;
                const currentQty = typeof cart[idx].quantity === 'number' ? cart[idx].quantity : Number(cart[idx].quantity) || 1;
                const newQty = Math.max(1, currentQty + delta);
                const mainItemId = cart[idx].menuId || cart[idx].itemId || cart[idx].lineId || cart[idx].id;
                
                // Update main item quantity
                cart[idx].quantity = newQty;
                cart[idx].price = numericUnit * newQty;
                
                // Sync free sauces linked to this main item
                cart.forEach(item => {
                    if (item.freeWithPeriRibs === true) {
                        const linkedToMainItem = item.linkedToMainItem || item.parentId || item.menuId || item.itemId || item.lineId;
                        if (linkedToMainItem === mainItemId) {
                            item.quantity = newQty;
                        }
                    }
                });
                
                window.cart?.setGuestCart?.(cart);
            }

            const items = await loadCartItems();
            syncCartCountFromItems(items);
            if (cartPreviewElement && cartPreviewElement.classList.contains('show')) {
                renderCartPreview(items, cartPreviewElement);
            }
        } catch (error) {
            console.error('Error updating quantity from preview:', error);
            showToast('Could not update quantity. Please try again.', 'error');
        }
    }

    // Public API (keep legacy globals for compatibility).
    const utilsApi = {
        safeNumber,
        getStoredCartCount,
        storeCartCount,
        updateCartBadges,
        broadcastCartCount,
        navigateTo,
        formatPeso,
        waitForFirebaseReady,
        ensureCustomerLoyaltyDefaults,
        showToast,
        setupCartPreview,
        removeCartItemFromPreview,
        changeCartPreviewQty
    };
    ppp.utils = utilsApi;
    window.utils = utilsApi;

    // Global navigation functions
    ppp.nav = ppp.nav || {};
    ppp.nav.goHome = window.goHome = () => navigateTo('home');
    ppp.nav.goToMenu = window.goToMenu = () => navigateTo('menu');
    ppp.nav.goToHelp = window.goToHelp = () => navigateTo('help');
    ppp.nav.goToCart = window.goToCart = () => navigateTo('cart');

    // Global cart count functions
    ppp.cart = ppp.cart || {};
    ppp.cart.getCount = window.getCartCount = getStoredCartCount;

    ppp.cart.setCount = window.setCartCount = function setCartCount(count) {
        const next = Math.max(0, safeNumber(count, 0));
        storeCartCount(next);
        updateCartBadges(next);
        broadcastCartCount(next);
        return next;
    };

    ppp.cart.incrementCount = window.incrementCartCount = function incrementCartCount(delta = 1) {
        const current = getStoredCartCount();
        return window.setCartCount(current + safeNumber(delta, 0));
    };

    ppp.cart.resetCount = window.resetCartCount = function resetCartCount() {
        return window.setCartCount(0);
    };

    // ============================================
    // CUSTOM MODAL SYSTEM (replaces browser alerts)
    // ============================================
    function createModalContainer() {
        let container = document.getElementById('customModalContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'customModalContainer';
            container.className = 'custom-modal-container';
            container.innerHTML = `
                <div class="custom-modal-overlay" id="customModalOverlay"></div>
                <div class="custom-modal" id="customModal">
                    <div class="custom-modal-content">
                        <button class="custom-modal-close" id="customModalClose" aria-label="Close">
                            <i class="fas fa-times"></i>
                        </button>
                        <div class="custom-modal-icon" id="customModalIcon">
                            <i class="fas fa-info-circle"></i>
                        </div>
                        <div class="custom-modal-title" id="customModalTitle"></div>
                        <div class="custom-modal-message" id="customModalMessage"></div>
                        <div class="custom-modal-actions" id="customModalActions"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(container);
        }
        return container;
    }

    function showModal(message, options = {}) {
        const {
            title = '',
            type = 'info', // 'info', 'success', 'error', 'warning'
            showCancel = false,
            confirmText = 'OK',
            cancelText = 'Cancel',
            onConfirm = null,
            onCancel = null,
            onClose = null,
            closeBehavior = 'cancel', // 'cancel' | 'none'
            autoClose = false,
            duration = 3000
        } = options;

        const container = createModalContainer();
        const modal = document.getElementById('customModal');
        const overlay = document.getElementById('customModalOverlay');
        const iconEl = document.getElementById('customModalIcon');
        const titleEl = document.getElementById('customModalTitle');
        const messageEl = document.getElementById('customModalMessage');
        const actionsEl = document.getElementById('customModalActions');
        const closeBtn = document.getElementById('customModalClose');

        if (!modal || !messageEl) return;

        // Set icon based on type
        const iconMap = {
            success: 'fa-check-circle',
            error: 'fa-exclamation-circle',
            warning: 'fa-exclamation-triangle',
            info: 'fa-info-circle'
        };
        const icon = iconMap[type] || iconMap.info;
        iconEl.innerHTML = `<i class="fas ${icon}"></i>`;
        modal.className = `custom-modal custom-modal-${type}`;

        // Set title and message
        if (title) {
            titleEl.textContent = title;
            titleEl.style.display = 'block';
        } else {
            titleEl.style.display = 'none';
        }
        messageEl.textContent = message;

        // Set up actions
        actionsEl.innerHTML = '';
        if (showCancel) {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'custom-modal-btn custom-modal-btn-secondary';
            cancelBtn.textContent = cancelText;
            cancelBtn.onclick = () => {
                hideModal();
                if (onCancel) onCancel();
            };
            actionsEl.appendChild(cancelBtn);
        }
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'custom-modal-btn custom-modal-btn-primary';
        confirmBtn.textContent = confirmText;
        confirmBtn.onclick = () => {
            hideModal();
            if (onConfirm) onConfirm();
        };
        actionsEl.appendChild(confirmBtn);

        // Close button handler
        const closeHandler = () => {
            hideModal();
            if (typeof onClose === 'function') {
                onClose();
                return;
            }
            if (closeBehavior === 'cancel' && typeof onCancel === 'function') {
                onCancel();
            }
        };
        closeBtn.onclick = closeHandler;
        overlay.onclick = closeHandler;

        // Show modal
        container.style.display = 'flex';
        setTimeout(() => {
            modal.classList.add('show');
            overlay.classList.add('show');
        }, 10);

        // Auto-close if enabled
        if (autoClose && !showCancel) {
            setTimeout(() => {
                hideModal();
                if (onConfirm) onConfirm();
            }, duration);
        }
    }

    function hideModal() {
        const container = document.getElementById('customModalContainer');
        const modal = document.getElementById('customModal');
        const overlay = document.getElementById('customModalOverlay');
        if (container && modal && overlay) {
            modal.classList.remove('show');
            overlay.classList.remove('show');
            setTimeout(() => {
                container.style.display = 'none';
            }, 300);
        }
    }

    // Replace window.alert with custom modal
    window.showAlert = function(message, type = 'info') {
        showModal(message, { type, autoClose: true, duration: 3000 });
    };

    // Replace window.confirm with custom modal
    window.showConfirm = function(message, onConfirm, onCancel) {
        showModal(message, {
            type: 'warning',
            showCancel: true,
            onConfirm: onConfirm || (() => {}),
            onCancel: onCancel || (() => {}),
            closeBehavior: 'cancel'
        });
    };

    // Auth gate modal (Sign in / Register)
    window.showAuthGate = function(message, redirectTarget = 'checkout.html') {
        const safeRedirect = String(redirectTarget || 'checkout.html');
        showModal(message || 'You need to be signed in to proceed to checkout.', {
            type: 'info',
            showCancel: true,
            confirmText: 'Sign In',
            cancelText: 'Register',
            closeBehavior: 'none',
            onConfirm: () => {
                window.location.href = `login.html?reason=checkout&redirect=${encodeURIComponent(safeRedirect)}`;
            },
            onCancel: () => {
                window.location.href = `register.html?redirect=${encodeURIComponent(safeRedirect)}`;
            }
        });
    };

    // Initialize cart badges and cart preview on load
    document.addEventListener('DOMContentLoaded', () => {
        updateCartBadges();
        setupCartPreview();
    });
    
    document.addEventListener('cart:sync', () => updateCartBadges());
    
    // Re-setup cart preview when cart count changes (cart might have been updated)
    document.addEventListener('cart:count-changed', () => {
        // Refresh cart preview if it's currently shown
        if (cartPreviewElement && cartPreviewElement.classList.contains('show')) {
            const cartIcons = document.querySelectorAll('.cart-icon, .floating-cart');
            if (cartIcons.length > 0) {
                loadCartItems().then(items => {
                    renderCartPreview(items, cartPreviewElement);
                });
            }
        }
    });
    
})();

