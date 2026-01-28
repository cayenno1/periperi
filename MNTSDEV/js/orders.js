// ============================================
// ORDERS PAGE FUNCTIONALITY
// ============================================

(function() {
    'use strict';

    let orders = [];
    let currentFilter = 'all';
    const GUEST_CART_KEY = 'ppp_guest_cart';
    const itemAvailability = {};
    const missingItemsCache = new Set();
    let isLoadingMore = false;
    function safeNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function toBoolAvailability(value) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const v = value.toLowerCase();
            if (v === 'available' || v === 'yes' || v === 'true') return true;
            if (v === 'unavailable' || v === 'no' || v === 'false') return false;
        }
        return true; // default to available when unknown
    }

    function checkMasServingPerDayAvailability(item) {
        if (!item) return false;
        
        // Check maxServingsPerDay to determine availability
        const maxServingsPerDay = typeof item.maxServingsPerDay === 'number' 
            ? item.maxServingsPerDay 
            : (typeof item.maxServingsPerDay === 'string' 
                ? parseFloat(item.maxServingsPerDay) 
                : null);

        // If maxServingsPerDay is 0, null, undefined, or negative, item is unavailable
        return maxServingsPerDay !== null && maxServingsPerDay !== undefined && maxServingsPerDay > 0;
    }

  function getReorderState(order) {
    if (!order || order.status !== 'completed') {
      return { allowed: false, reason: 'Order not completed yet.' };
    }
    const itemsArr = Array.isArray(order.raw?.items) ? order.raw.items : [];
    if (!itemsArr.length) {
      return { allowed: false, reason: 'Order has no items.' };
    }

    for (const it of itemsArr) {
      const id = it?.itemId;
      if (!id) {
        return { allowed: false, reason: 'Missing menu link for an item.' };
      }
      if (missingItemsCache.has(id)) {
        return { allowed: false, reason: 'Item is no longer on the menu.' };
      }
      // If availability is unknown yet, allow the button; it will be re-checked on click.
      if (Object.prototype.hasOwnProperty.call(itemAvailability, id) && itemAvailability[id] === false) {
        return { allowed: false, reason: 'Item is unavailable.' };
      }
    }
    return { allowed: true, reason: '' };
    }

    function formatOrderDate(raw) {
        if (!raw) return '';
        try {
            const d = new Date(raw);
            if (!Number.isNaN(d.getTime())) {
                return d.toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                });
            }
        } catch (e) {}
        return String(raw);
    }

    function getStatusDisplayLabel(rawStatus) {
        if (!rawStatus) return 'Pending';
        const status = rawStatus.toLowerCase().trim();
        
        const statusMap = {
            'pending': 'Pending',
            'confirmed': 'Preparing', // Map confirmed to preparing
            'preparing': 'Preparing',
            'ready': 'Preparing', // Map ready to preparing
            'out_for_delivery': 'Out for Delivery',
            'out for delivery': 'Out for Delivery',
            'delivered': 'Completed',
            'completed': 'Completed',
            'cancelled': 'Cancelled',
            'canceled': 'Cancelled',
            'declined': 'Declined'
        };
        
        return statusMap[status] || status.charAt(0).toUpperCase() + status.slice(1);
    }

    function renderOrders() {
        const container = document.getElementById('ordersList');
        if (!container) return;

        const filtered = orders.filter(o => {
            if (currentFilter === 'all') {
                return true; // Show all orders including declined
            }
            return o.status === currentFilter;
        });

        if (!filtered.length) {
            container.innerHTML = `
                <div class="address-empty-state" style="text-align:center;padding:32px;color:#999;">
                    No orders yet.
                </div>
            `;
            return;
        }

        const ordersHtml = filtered.map(order => {
            const totalDisplay = (typeof order.total === 'number' ? order.total : Number(order.total) || 0).toFixed(2);
            const itemsHtml = order.items
                .map(i => `<span style='display:inline-block; margin-right:8px;'>• ${i}</span>`)
                .join('');
            const { allowed: reorderAllowed, reason: reorderReason } = getReorderState(order);
            const reorderButton = order.status === 'completed'
                ? `<button class="filter-btn ${reorderAllowed ? '' : 'disabled'}" ${reorderAllowed ? `onclick="window.orders.reorder('${order.id}')"` : 'disabled style="opacity:0.5;cursor:not-allowed;pointer-events:none;"'} title="${reorderAllowed ? '' : (reorderReason || 'Unavailable to reorder')}"><span>${reorderAllowed ? 'Reorder' : 'Unavailable'}</span></button>`
                : '';

            // Get display label for status
            const statusLabel = getStatusDisplayLabel(order.raw?.status || order.status);
            
            return `
            <div class="review-item" data-order-id="${order.id}" data-status="${order.status}">
                <div class="review-header">
                    <div class="reviewer-info">
                        <div class="reviewer-avatar"><i class="fas fa-receipt"></i></div>
                        <div class="reviewer-details">
                            <div class="reviewer-name">Order ${order.displayId}</div>
                            <div class="review-date">${order.date} • ${order.items.length} item(s)</div>
                        </div>
                    </div>
                    <span class="popular-tag" style="text-transform:capitalize;">${statusLabel}</span>
                </div>
                <div class="review-text" style="font-style:normal;">
                    ${itemsHtml} 
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <div class="card-price">₱${totalDisplay}</div>
                    <div style="display:flex; gap:8px;">
                        <button class="filter-btn" onclick="window.orders.viewDetails('${order.id}')"><span>View details</span></button>
                        ${reorderButton}
                    </div>
                </div>
            </div>
            `;
        }).join('');

        container.innerHTML = ordersHtml;
    }

    function processOrderData(docSnap) {
        const data = docSnap.data() || {};
        const rawTimestamp = data.timestamp || data.createdAt || null;
        const dateDisplay = formatOrderDate(rawTimestamp);
        const itemsArr = Array.isArray(data.items) ? data.items : [];
        const itemLabels = itemsArr.map((it) => {
            const name = it.name || 'Item';
            const qty = typeof it.quantity === 'number' ? it.quantity : Number(it.quantity) || 1;
            return `${name} x ${qty}`;
        });

        let total = 0;
        if (typeof data.total === 'number') {
            total = data.total;
        } else {
            const parsed = Number(data.total);
            total = Number.isFinite(parsed) ? parsed : 0;
        }

        const rawStatus = (data.status || 'pending').toLowerCase();
        // Map statuses to filter categories (pending vs completed vs declined)
        let status = 'pending';
        if (rawStatus === 'completed' || rawStatus === 'delivered') {
            status = 'completed';
        } else if (rawStatus === 'cancelled' || rawStatus === 'canceled' || rawStatus === 'declined') {
            status = 'declined';
        } else {
            // All other statuses (pending, confirmed, preparing, ready, out_for_delivery, etc.) are pending
            status = 'pending';
        }

        // Use orderNumber if available, otherwise use document ID
        const orderNumber = data.orderNumber || docSnap.id;
        const displayId = orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;

        return {
            id: docSnap.id,
            displayId: displayId,
            date: dateDisplay,
            total,
            status,
            items: itemLabels,
            raw: data
        };
    }

    async function loadOrdersForUser(user, loadMore = false) {
        if (!user || !window.firebaseDb || !window.collection || !window.query || !window.where || !window.getDocs) {
            orders = [];
            renderOrders();
            return;
        }


        try {
            const ordersCol = window.collection(window.firebaseDb, 'orders');
            const userEmail = user.email ? user.email.toLowerCase().trim() : null;
            const allOrders = [];

            // Fetch authenticated orders (userId matches)
            try {
                let authQuery = window.query(
                    ordersCol,
                    window.where('userId', '==', user.uid)
                );
                const authSnap = await window.getDocs(authQuery);
                authSnap.forEach((docSnap) => {
                    allOrders.push(processOrderData(docSnap));
                });
            } catch (authError) {
                console.warn('Error loading authenticated orders:', authError);
            }

            // Fetch guest orders matching user's email
            if (userEmail) {
                try {
                    let guestQuery = window.query(
                        ordersCol,
                        window.where('isGuest', '==', true)
                    );
                    const guestSnap = await window.getDocs(guestQuery);
                    guestSnap.forEach((docSnap) => {
                        const data = docSnap.data() || {};
                        const orderEmail = data.customerInfo?.email ? data.customerInfo.email.toLowerCase().trim() : null;
                        
                        // Only include guest orders that match user's email and aren't already added
                        if (orderEmail === userEmail && !allOrders.find(o => o.id === docSnap.id)) {
                            allOrders.push(processOrderData(docSnap));
                        }
                    });
                } catch (guestError) {
                    console.warn('Error loading guest orders:', guestError);
                }
            }

            // Sort all orders by timestamp/createdAt (newest first)
            allOrders.sort((a, b) => {
                const ta = a.raw?.timestamp || a.raw?.createdAt || '';
                const tb = b.raw?.timestamp || b.raw?.createdAt || '';
                if (!ta && !tb) return 0;
                if (!ta) return 1;
                if (!tb) return -1;
                const dateA = ta.toDate ? ta.toDate() : new Date(ta);
                const dateB = tb.toDate ? tb.toDate() : new Date(tb);
                return dateB.getTime() - dateA.getTime();
            });

            if (loadMore) {
                // For load more, append to existing orders
                orders = [...orders, ...allOrders];
            } else {
                // Initial load - replace orders
                orders = allOrders;
            }

            // Fetch availability for all unique itemIds referenced in orders
            const uniqueIds = new Set();
            allOrders.forEach((o) => {
                const itemsArr = Array.isArray(o.raw?.items) ? o.raw.items : [];
                itemsArr.forEach((it) => {
                    if (it && it.itemId) uniqueIds.add(it.itemId);
                });
            });
            refreshAvailability([...uniqueIds]);

            renderOrders();
        } catch (error) {
            console.error('Error loading orders from Firestore:', error);
            if (!loadMore) {
                orders = [];
            }
            renderOrders();
        }
    }

    async function loadMore() {
        if (isLoadingMore) return;
        
        isLoadingMore = true;
        const btn = document.getElementById('loadMoreOrders');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span>Loading...</span>';
        }

        const user = window.firebaseAuth?.currentUser;
        if (user) {
            await loadOrdersForUser(user, true);
        }

        isLoadingMore = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<span>Load More Orders</span>';
        }
    }

    async function refreshAvailability(ids) {
        if (!ids || !ids.length) {
            renderOrders();
            return;
        }

        try {
            await window.utils?.waitForFirebaseReady?.();
            if (!window.firestore?.fetchMenuItemById) {
                renderOrders();
                return;
            }

            // Fetch sequentially to avoid flooding; small list per order history.
            for (const id of ids) {
                // Skip if already known
                if (Object.prototype.hasOwnProperty.call(itemAvailability, id)) continue;
                // pessimistically block reorder until verification completes
                itemAvailability[id] = false;
                const item = await window.firestore.fetchMenuItemById(id);
                const exists = !!item && item.active !== false;
                if (!exists) missingItemsCache.add(id);
                // Use masServingPerDay to check availability
                itemAvailability[id] = exists && checkMasServingPerDayAvailability(item);
            }
        } catch (error) {
            console.warn('Failed to refresh item availability for orders:', error);
        }

        renderOrders();
    }

    async function ensureItemsExist(items) {
        const ids = Array.from(
            new Set(
                (Array.isArray(items) ? items : [])
                    .map(it => it?.itemId)
                    .filter(Boolean)
            )
        );

        if (!ids.length) {
            return { ok: false, message: 'Order items are missing menu references.' };
        }

        try {
            await window.utils?.waitForFirebaseReady?.();
            if (!window.firestore?.fetchMenuItemById) {
                return { ok: false, message: 'Menu is not available right now. Please try again later.' };
            }

            for (const id of ids) {
                const item = await window.firestore.fetchMenuItemById(id);
                const exists = !!item && item.active !== false;
                // Use masServingPerDay to check availability
                itemAvailability[id] = exists && checkMasServingPerDayAvailability(item);
                if (!exists || missingItemsCache.has(id) || !itemAvailability[id]) {
                    missingItemsCache.add(id);
                    return { ok: false, message: 'One or more items are no longer on the menu.' };
                }
            }

            return { ok: true };
        } catch (error) {
            console.error('Failed to verify menu items before reorder:', error);
            return { ok: false, message: 'Could not verify menu items. Please try again later.' };
        }
    }

    function viewDetails(id) {
        const order = orders.find(o => o.id === id);
        if (order) {
            try {
                localStorage.setItem('selectedOrder', JSON.stringify(order.raw || order));
                localStorage.setItem('selectedOrderId', id);
            } catch (e) {}
            window.location.href = `order_details.html?orderId=${encodeURIComponent(id)}`;
        } else {
            if (window.showAlert) {
                window.showAlert('Order not found', 'error');
            } else {
                alert('Order not found');
            }
        }
    }

    async function reorder(id) {
        const order = orders.find(o => o.id === id);
        const raw = order?.raw;
        const items = Array.isArray(raw?.items) ? raw.items : [];

        if (!order || !items.length) {
            if (window.showAlert) {
                window.showAlert('Order not found or has no items.', 'error');
            } else {
                alert('Order not found or has no items.');
            }
            return;
        }

        const { ok, message } = await ensureItemsExist(items);
        if (!ok) {
            console.warn(message || 'Items are not available to reorder.');
            refreshAvailability(items.map(it => it.itemId).filter(Boolean));
            return;
        }

        // Normalize items for cart reuse
        const cartItems = items.map((it, idx) => {
            const qty = safeNumber(it.quantity, 1) || 1;
            const unit = safeNumber(it.unitPrice, safeNumber(it.price, 0));
            const lineTotal = safeNumber(it.lineTotal, unit * qty);

            return {
                id: it.itemId || `reorder-${Date.now()}-${idx}`,
                itemId: it.itemId || null,
                name: it.name || 'Item',
                imageUrl: it.imageUrl || null,
                price: lineTotal, // stored as line total in cart
                quantity: qty,
                variation: it.variation || null,
                sauce: it.sauce || null
            };
        });

        const totalQty = cartItems.reduce((sum, item) => sum + safeNumber(item.quantity, 0), 0);

        try {
            await window.utils?.waitForFirebaseReady?.();
            const db = window.firebaseDb;
            const auth = window.firebaseAuth;
            const user = auth?.currentUser;

            if (user && db && window.doc && window.collection && window.getDocs && window.deleteDoc && window.setDoc) {
                // Clear existing Firestore cart
                const customerRef = window.doc(db, 'customers', user.uid);
                const cartCol = window.collection(customerRef, 'cartItems');
                const snap = await window.getDocs(cartCol);
                for (const docSnap of snap.docs) {
                    await window.deleteDoc(docSnap.ref);
                }

                // Seed cart with reordered items
                for (const item of cartItems) {
                    const cartDoc = window.doc(cartCol);
                    await window.setDoc(cartDoc, {
                        itemId: item.itemId,
                        name: item.name,
                        imageUrl: item.imageUrl,
                        price: item.price,
                        quantity: item.quantity,
                        variation: item.variation || null,
                        sauce: item.sauce || null,
                        createdAt: new Date()
                    });
                }
            } else {
                // Guest cart fallback
                window.localStorage?.setItem(GUEST_CART_KEY, JSON.stringify(cartItems));
            }

            if (typeof window.setCartCount === 'function') {
                window.setCartCount(totalQty);
            } else {
                window.localStorage?.setItem('ppp_cart_count', String(totalQty));
            }

            // Go to cart review
            if (typeof window.goToCart === 'function') {
                window.goToCart();
            } else {
                window.location.href = 'cart_review.html';
            }
        } catch (error) {
            console.error('Error while reordering:', error);
            if (window.showAlert) {
                window.showAlert('Could not reorder right now. Please try again.', 'error');
            } else {
                alert('Could not reorder right now. Please try again.');
            }
        }
    }

    // Initialize filter buttons
    function initFilters() {
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                currentFilter = this.dataset.status || 'all';
                renderOrders();
            });
        });
    }

    // Initialize auth listener
    function initAuthListener() {
        function waitForAuth() {
            if (!window.firebaseAuth || !window.onAuthStateChanged) {
                setTimeout(waitForAuth, 100);
                return;
            }

            window.onAuthStateChanged(window.firebaseAuth, (user) => {
                if (user) {
                    loadOrdersForUser(user);
                } else {
                    orders = [];
                    renderOrders();
                }
            });
        }

        waitForAuth();
    }


    // Expose to window
    window.orders = {
        viewDetails,
        reorder,
        loadMore
    };

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', function() {
        initFilters();
        initAuthListener();
    });
})();

