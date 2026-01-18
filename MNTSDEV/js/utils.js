// ============================================
// UTILITY FUNCTIONS
// Shared utilities across the application
// ============================================

(function() {
    'use strict';

    const CART_COUNT_KEY = 'ppp_cart_count';
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

    async function loadCartItems() {
        try {
            await waitForFirebaseReady();
            const user = window.firebaseAuth?.currentUser;
            
            if (user && window.firebaseDb && window.doc && window.collection && window.getDocs) {
                // Load from Firestore
                const customerRef = window.doc(window.firebaseDb, 'customers', user.uid);
                const cartItemsCol = window.collection(customerRef, 'cartItems');
                const snap = await window.getDocs(cartItemsCol);
                const items = [];
                snap.forEach((docSnap) => {
                    items.push({ id: docSnap.id, ...docSnap.data() });
                });
                return items;
            } else {
                // Load from localStorage
                return window.cart?.getGuestCart() || [];
            }
        } catch (error) {
            console.error('Error loading cart items:', error);
            return [];
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
            const unitPrice = price / qty;
            total += price;
            
            return `
                <div class="cart-preview-item">
                    <img src="${item.imageUrl || ''}" alt="${item.name || 'Item'}" class="cart-preview-item-img" onerror="this.style.display='none'">
                    <div class="cart-preview-item-info">
                        <div class="cart-preview-item-name">${item.name || 'Item'}</div>
                        <div class="cart-preview-item-details">
                            <span class="cart-preview-item-qty">Qty: ${qty}</span>
                            <span class="cart-preview-item-price">${formatPeso(unitPrice)}</span>
                        </div>
                    </div>
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
                    cartPreviewTimeout = setTimeout(hideCartPreview, 200);
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

    // Expose to window
    window.utils = {
        safeNumber,
        getStoredCartCount,
        storeCartCount,
        updateCartBadges,
        broadcastCartCount,
        navigateTo,
        formatPeso,
        waitForFirebaseReady,
        showToast,
        setupCartPreview
    };

    // Global navigation functions
    window.goHome = () => navigateTo('home');
    window.goToMenu = () => navigateTo('menu');
    window.goToHelp = () => navigateTo('help');
    window.goToCart = () => navigateTo('cart');

    // Global cart count functions
    window.getCartCount = getStoredCartCount;

    window.setCartCount = function setCartCount(count) {
        const next = Math.max(0, safeNumber(count, 0));
        storeCartCount(next);
        updateCartBadges(next);
        broadcastCartCount(next);
        return next;
    };

    window.incrementCartCount = function incrementCartCount(delta = 1) {
        const current = getStoredCartCount();
        return window.setCartCount(current + safeNumber(delta, 0));
    };

    window.resetCartCount = function resetCartCount() {
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
            if (onCancel) onCancel();
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
            onCancel: onCancel || (() => {})
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

