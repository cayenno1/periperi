// Global variables
let activeDropdown = null;
let inventoryState = [];
let menuState = [];
let uploadedFoodImageDataUrl = null; // Now stores Firebase Storage URL instead of data URL
let ordersState = [];
let ordersUnsubscribe = null;
const customerDetailsCache = new Map();
const customerFetchInProgress = new Set();
let orderFilters = {
    filter: 'all', // Combined filter: 'all', 'old-to-new', 'status:xxx', 'type:xxx', or 'type:xxx|status:xxx'
    searchTerm: ''
};
let driversState = [];
let driverFilter = 'available';
let driverSearchTerm = '';
let currentViewingDriverId = null;

const InventoryStore = (() => {
    const COLLECTION = 'stocks';

    function assertFirestoreReady() {
        if (!isFirestoreReady()) {
            throw new Error('Inventory service is still loading. Please wait a moment and try again.');
        }
        return window.firestoreFunctions;
    }

    function normalizeTimestamp(value) {
        if (!value) return null;
        if (value instanceof Date) {
            return value;
        }
        if (typeof value.toDate === 'function') {
            return value.toDate();
        }
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function normalizeItem(item) {
        if (!item || !item.id) {
            return null;
        }
        const normalizedUnitType = item.unitType === 'count' ? 'count' : 'weight';
        return {
            id: item.id,
            name: item.name || toTitleCase(item.id.replace(/-/g, ' ')),
            unitType: normalizedUnitType,
            baseUnit: item.baseUnit || (normalizedUnitType === 'count' ? 'pcs' : 'g'),
            quantity: Number(item.quantity) || 0,
            reorderLevel: Number(item.reorderLevel) || defaultReorderLevel(normalizedUnitType),
            createdAt: normalizeTimestamp(item.createdAt),
            updatedAt: normalizeTimestamp(item.updatedAt)
        };
    }

    async function getItems() {
        const fns = assertFirestoreReady();
        const snapshot = await fns.getDocs(fns.collection(window.db, COLLECTION));
        return snapshot.docs
            .map(docSnap => normalizeItem({ id: docSnap.id, ...docSnap.data() }))
            .filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async function registerIngredient({ name, unitType, amount, reorderLevel }) {
        const trimmedName = (name || '').trim();
        if (!trimmedName) {
            throw new Error('Ingredient name is required.');
        }

        const normalizedUnitType = unitType === 'count' ? 'count' : 'weight';
        const normalizedAmount = Number(amount) || 0;
        if (normalizedAmount < 0) {
            throw new Error('Initial quantity cannot be negative.');
        }

        const fns = assertFirestoreReady();
        const slug = slugify(trimmedName);
        const docRef = fns.doc(window.db, COLLECTION, slug);
        const existing = await fns.getDoc(docRef);
        if (existing.exists()) {
            throw new Error(`${toTitleCase(trimmedName)} is already registered.`);
        }

        await fns.setDoc(docRef, {
            name: toTitleCase(trimmedName),
            unitType: normalizedUnitType,
            baseUnit: normalizedUnitType === 'count' ? 'pcs' : 'g',
            quantity: +normalizedAmount.toFixed(2),
            reorderLevel: reorderLevel !== undefined && reorderLevel !== null && reorderLevel !== ''
                ? Math.max(0, Number(reorderLevel))
                : defaultReorderLevel(normalizedUnitType),
            createdAt: fns.serverTimestamp(),
            updatedAt: fns.serverTimestamp()
        });

        return await getItems();
    }

    async function restock({ name, amount }) {
        const trimmedName = (name || '').trim();
        if (!trimmedName) {
            throw new Error('Ingredient name is required.');
        }

        const normalizedAmount = Number(amount) || 0;
        if (normalizedAmount <= 0) {
            throw new Error('Quantity must be greater than zero.');
        }

        const fns = assertFirestoreReady();
        const slug = slugify(trimmedName);
        const docRef = fns.doc(window.db, COLLECTION, slug);
        const existing = await fns.getDoc(docRef);

        if (!existing.exists()) {
            throw new Error(`${toTitleCase(trimmedName)} is not registered in the inventory.`);
        }

        await fns.updateDoc(docRef, {
            quantity: fns.increment(+normalizedAmount.toFixed(2)),
            updatedAt: fns.serverTimestamp()
        });

        return await getItems();
    }

    function slugify(value) {
        return value
            .toString()
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function toTitleCase(value) {
        return value
            .toString()
            .trim()
            .toLowerCase()
            .replace(/(^|\s|-)\S/g, letter => letter.toUpperCase());
    }

    function defaultReorderLevel(unitType) {
        return unitType === 'count' ? 100 : 2000;
    }

    return {
        getItems,
        registerIngredient,
        restock,
        slugifyName: slugify
    };
})();

const MenuStore = (() => {
    const COLLECTION = 'menu';

    function assertFirestoreReady() {
        if (!isFirestoreReady()) {
            throw new Error('Menu service is still loading. Please wait a moment and try again.');
        }
        return window.firestoreFunctions;
    }

    function normalizeMenuItem(item) {
        if (!item || !item.id) {
            return null;
        }
        return {
            id: item.id,
            menuId: item.menuId || item.id.toUpperCase(),
            name: item.name || '',
            category: item.category || 'Uncategorized',
            price: Number(item.price) || 0,
            description: item.description || '',
            imageDataUrl: item.imageDataUrl || null,
            ingredients: Array.isArray(item.ingredients)
                ? item.ingredients.map(ingredient => ({
                    ingredientId: ingredient.ingredientId,
                    ingredientName: ingredient.ingredientName,
                    unitType: ingredient.unitType,
                    baseAmountPerDish: Number(ingredient.baseAmountPerDish) || 0,
                    displayAmount: ingredient.displayAmount || '',
                }))
                : [],
            createdAt: item.createdAt || null,
            updatedAt: item.updatedAt || null
        };
    }

    async function getItems() {
        const fns = assertFirestoreReady();
        const snapshot = await fns.getDocs(fns.collection(window.db, COLLECTION));
        return snapshot.docs
            .map(docSnap => normalizeMenuItem({ id: docSnap.id, ...docSnap.data() }))
            .filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async function createItem({ slug, data }) {
        if (!slug) {
            throw new Error('Dish identifier could not be determined.');
        }
        const fns = assertFirestoreReady();
        const docRef = fns.doc(window.db, COLLECTION, slug);
        const existing = await fns.getDoc(docRef);
        if (existing.exists()) {
            throw new Error(`${data.name} is already registered in the menu.`);
        }
        await fns.setDoc(docRef, {
            ...data,
            createdAt: fns.serverTimestamp(),
            updatedAt: fns.serverTimestamp()
        });
        return await getItems();
    }

    function slugify(value) {
        return value
            .toString()
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    return {
        getItems,
        createItem,
        slugifyName: slugify
    };
})();

async function initOrdersDashboard() {
    const tableBody = document.getElementById('ordersTableBody');
    if (!tableBody) {
        return;
    }
    if (tableBody.dataset.initialized === 'true') {
        return;
    }
    tableBody.dataset.initialized = 'true';
    tableBody.innerHTML = '<tr><td colspan="6" class="empty-table">Loading customer orders...</td></tr>';

    try {
        await waitForFirebaseReady();
        await loadOrdersCollectionOnce();
        await subscribeToOrdersCollection();
    } catch (error) {
        console.error('Orders dashboard failed to initialize:', error);
        showNotification(error.message || 'Unable to load customer orders.', 'error');
    }
}

async function subscribeToOrdersCollection() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns || !window.db) {
        throw new Error('Firestore is not ready yet. Please refresh the page.');
    }

    const ordersQuery = fns.collection(window.db, 'orders');

    if (typeof fns.onSnapshot === 'function') {
        if (typeof ordersUnsubscribe === 'function') {
            ordersUnsubscribe();
        }
        ordersUnsubscribe = fns.onSnapshot(
            ordersQuery,
            (snapshot) => {
                ordersState = snapshot.docs
                    .map(docSnap => normalizeOrderDoc(docSnap))
                    .filter(Boolean);
                // Recalculate isNew status for all orders (in case time has passed)
                ordersState.forEach(order => {
                    if (order.createdAt && order.createdAt instanceof Date) {
                        const now = new Date();
                        const timeDiff = now.getTime() - order.createdAt.getTime();
                        const minutesDiff = timeDiff / (1000 * 60);
                        order.isNew = minutesDiff < 8 && (order.status === 'pending' || order.status === 'new');
                    }
                });
                renderOrdersTable(ordersState);
                hydrateOrderCustomers(ordersState);
                // Also update driver statuses when orders change
                if (driversState.length > 0) {
                    // Recalculate driver statuses based on current orders
                    driversState.forEach(driver => {
                        let driverStatus = 'available';
                        if (ordersState && ordersState.length > 0) {
                            const hasActiveDelivery = ordersState.some(order => {
                                const orderDriverId = order.driverId || '';
                                const orderStatus = (order.status || '').toLowerCase().trim();
                                return (orderDriverId === driver.driverId || orderDriverId === driver.id) &&
                                       (orderStatus === 'preparing' ||
                                        orderStatus === 'being-cooked' || orderStatus === 'being_cooked' || orderStatus === 'being cooked' ||
                                        orderStatus === 'cooking' || 
                                        orderStatus === 'ready for delivery' || orderStatus === 'ready_for_delivery' ||
                                        orderStatus === 'for delivery' || orderStatus === 'for_delivery' ||
                                        orderStatus === 'ready' || 
                                        orderStatus === 'accepted' || 
                                        orderStatus === 'out_for_delivery' || orderStatus === 'out-for-delivery' ||
                                        orderStatus === 'in-transit' || orderStatus === 'in_transit' || 
                                        orderStatus === 'on-the-way' || orderStatus === 'on_the_way');
                            });
                            if (hasActiveDelivery) {
                                driverStatus = 'busy';
                            }
                        }
                        driver.availability = driverStatus;
                        driver.status = driverStatus;
                    });
                    renderDriversList();
                }
            },
            (error) => {
                console.error('Orders listener error:', error);
                showNotification('Live order updates failed. Showing last known data.', 'error');
            }
        );
    } else {
        const snapshot = await fns.getDocs(ordersQuery);
        ordersState = snapshot.docs
            .map(docSnap => normalizeOrderDoc(docSnap))
            .filter(Boolean);
        // Recalculate isNew status
        ordersState.forEach(order => {
            if (order.createdAt && order.createdAt instanceof Date) {
                const now = new Date();
                const timeDiff = now.getTime() - order.createdAt.getTime();
                const minutesDiff = timeDiff / (1000 * 60);
                order.isNew = minutesDiff < 8 && (order.status === 'pending' || order.status === 'new');
            }
        });
        renderOrdersTable(ordersState);
        hydrateOrderCustomers(ordersState);
    }
}

async function loadOrdersCollectionOnce() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns?.getDocs || !fns?.collection) {
        throw new Error('Firestore helpers are not available yet.');
    }
    const snapshot = await fns.getDocs(fns.collection(window.db, 'orders'));
    ordersState = snapshot.docs
        .map(docSnap => normalizeOrderDoc(docSnap))
        .filter(Boolean);
    // Recalculate isNew status
    ordersState.forEach(order => {
        if (order.createdAt && order.createdAt instanceof Date) {
            const now = new Date();
            const timeDiff = now.getTime() - order.createdAt.getTime();
            const minutesDiff = timeDiff / (1000 * 60);
            order.isNew = minutesDiff < 8 && (order.status === 'pending' || order.status === 'new');
        }
    });
    renderOrdersTable(ordersState);
    hydrateOrderCustomers(ordersState);
}

function normalizeOrderDoc(docSnap) {
    if (!docSnap) return null;
    const data = docSnap.data() || {};
    const createdAt = normalizeOrderTimestamp(
        data.createdAt ||
        data.created_at ||
        data.timestamp ||
        data.orderDate ||
        data.dateCreated ||
        data.date
    );
    // Normalize status values - map old statuses to new ones
    let statusValue = (data.status || 'pending').toString().toLowerCase().trim();
    // Map old status values to new standardized ones
    if (['being-cooked', 'being_cooked', 'cooking', 'being cooked', 'accepted'].includes(statusValue)) {
        statusValue = 'preparing';
    } else if (['for_delivery', 'ready-for-delivery', 'ready for delivery', 'ready_for_delivery'].includes(statusValue)) {
        statusValue = 'ready for delivery';
    } else if (['out_for_delivery', 'out-for-delivery', 'in-transit', 'in_transit', 'on-the-way', 'on_the_way'].includes(statusValue)) {
        statusValue = 'out for delivery';
    } else if (['completed'].includes(statusValue)) {
        statusValue = 'delivered';
    }
    const deliveryInfo = data.deliveryInfo || {};
    const deliveryMethod = (data.deliveryMethod || data.delivery_method || deliveryInfo.deliveryMethod || deliveryInfo.delivery_method || '').toLowerCase();
    const serviceType = (data.serviceType || data.service_type || deliveryInfo.serviceType || deliveryInfo.service_type || '').toLowerCase();
    const tableNumber = data.tableNumber || data.table_number || deliveryInfo.tableNumber || deliveryInfo.table_number || '';
    const restaurantAddress = data.restaurantAddress || data.restaurant_address || deliveryInfo.restaurantAddress || deliveryInfo.restaurant_address || 'Pablo\'s Peri Peri Restaurant';
    const paymentProofPath = data.paymentProof || data.payment_proof || data.paymentProofPath || data.payment_proof_path || deliveryInfo.paymentProof || deliveryInfo.payment_proof || '';
    const isGuest = data.isGuest === true || !data.userId || data.userId === null;
    
    // Determine if order is "new" (created less than 8 minutes ago and status is pending)
    let isNew = false;
    if (createdAt && createdAt instanceof Date) {
        const now = new Date();
        const timeDiff = now.getTime() - createdAt.getTime();
        const minutesDiff = timeDiff / (1000 * 60); // Convert to minutes
        // Order is "new" if it's less than 8 minutes old and status is pending
        isNew = minutesDiff < 8 && (statusValue === 'pending' || statusValue === 'new');
    }
    
    return {
        id: docSnap.id,
        trackingId: data.trackingId || `#${docSnap.id.slice(-6).toUpperCase()}`,
        userId: data.userId || data.customerId || '',
        driverId: data.driverId || data.driver?.id || '',
        items: Array.isArray(data.items) ? data.items : [],
        total: typeof data.total === 'number' ? data.total : Number(data.total) || 0,
        paymentMode: data.paymentMode || data.payment?.method || data.paymentMethod || 'Unspecified',
        status: statusValue,
        isNew: isNew,
        isGuest: isGuest,
        deliveryInfo: deliveryInfo,
        deliveryMethod: deliveryMethod,
        serviceType: serviceType,
        tableNumber: tableNumber,
        address: deliveryInfo.address || data.address || '',
        restaurantAddress: restaurantAddress,
        paymentProofPath: paymentProofPath,
        paymentVerified: data.paymentVerified || false,
        paymentVerifiedAt: data.paymentVerifiedAt || null,
        createdAt,
        createdLabel: createdAt ? formatDateLabel(createdAt) : (typeof data.timestamp === 'string' ? data.timestamp : '—')
    };
}

function filterOrdersByCriteria(orders) {
    if (!orders || !orders.length) return [];
    
    let filtered = [...orders];
    
    // Filter by search term
    if (orderFilters.searchTerm) {
        const searchLower = orderFilters.searchTerm.toLowerCase();
        filtered = filtered.filter(order => {
            const trackingId = (order.trackingId || order.id || '').toLowerCase();
            const customerName = formatOrderCustomer(order).toLowerCase();
            const orderName = formatOrderNameShort(order.items).toLowerCase();
            const location = formatOrderLocation(order).toLowerCase();
            const paymentMode = (order.paymentMode || '').toLowerCase();
            const status = (order.status || '').toLowerCase();
            return trackingId.includes(searchLower) || 
                   customerName.includes(searchLower) ||
                   orderName.includes(searchLower) ||
                   location.includes(searchLower) ||
                   paymentMode.includes(searchLower) ||
                   status.includes(searchLower);
        });
    }
    
    // Filter by combined filter (status, type, or both)
    if (orderFilters.filter && orderFilters.filter !== 'all' && orderFilters.filter !== 'old-to-new') {
        const filterValue = orderFilters.filter;
        
        // Parse combined filter (e.g., "type:delivery|status:preparing")
        const parts = filterValue.split('|');
        let typeFilter = null;
        let statusFilter = null;
        
        parts.forEach(part => {
            if (part.startsWith('type:')) {
                typeFilter = part.substring(5); // Remove "type:" prefix
            } else if (part.startsWith('status:')) {
                statusFilter = part.substring(7); // Remove "status:" prefix
            }
        });
        
        // Apply service type filter
        if (typeFilter) {
            filtered = filtered.filter(order => {
                const serviceType = (order.serviceType || '').toLowerCase().trim();
                if (typeFilter === 'delivery') {
                    return serviceType === 'delivery' || (!serviceType || (serviceType !== 'dine-in' && serviceType !== 'dinein' && serviceType !== 'pick-up' && serviceType !== 'pickup' && serviceType !== 'pick_up'));
                } else if (typeFilter === 'dine-in') {
                    return serviceType === 'dine-in' || serviceType === 'dinein';
                } else if (typeFilter === 'pick-up') {
                    return serviceType === 'pick-up' || serviceType === 'pickup' || serviceType === 'pick_up';
                }
                return true;
            });
        }
        
        // Apply status filter
        if (statusFilter) {
            filtered = filtered.filter(order => {
                const orderStatus = (order.status || '').toLowerCase().trim();
                if (statusFilter === 'pending') {
                    return orderStatus === 'pending' || orderStatus === 'new';
                } else if (statusFilter === 'preparing') {
                    return orderStatus === 'preparing' || orderStatus === 'being-cooked' || orderStatus === 'being_cooked' || 
                           orderStatus === 'cooking' || orderStatus === 'being cooked';
                } else if (statusFilter === 'ready') {
                    return orderStatus === 'ready';
                } else if (statusFilter === 'ready for delivery' || statusFilter === 'for delivery') {
                    return orderStatus === 'ready for delivery' || orderStatus === 'ready_for_delivery' ||
                           orderStatus === 'for delivery' || orderStatus === 'for_delivery';
                } else if (statusFilter === 'ready for pick-up' || statusFilter === 'ready for pickup') {
                    return orderStatus === 'ready for pick-up' || orderStatus === 'ready_for_pickup' || 
                           orderStatus === 'ready for pickup';
                } else if (statusFilter === 'out-for-delivery') {
                    return orderStatus === 'out_for_delivery' || orderStatus === 'out-for-delivery' || 
                           orderStatus === 'in-transit' || orderStatus === 'in_transit';
                } else if (statusFilter === 'delivered') {
                    return orderStatus === 'delivered' || orderStatus === 'completed';
                }
                return true;
            });
        }
    }
    
    return filtered;
}

function renderOrdersTable(orders) {
    const tableBody = document.getElementById('ordersTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '';

    // Apply filters
    const filteredOrders = filterOrdersByCriteria(orders);

    if (!filteredOrders || !filteredOrders.length) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="8" class="empty-table">No orders found matching the current filters.</td>';
        tableBody.appendChild(emptyRow);
        return;
    }

    // Sort orders based on filter
    let sortedOrders = [...filteredOrders];
    if (orderFilters.filter === 'old-to-new') {
        // Old to new: ascending order by creation time
        sortedOrders.sort((a, b) => {
            const aTime = a?.createdAt instanceof Date ? a.createdAt.getTime() : 0;
            const bTime = b?.createdAt instanceof Date ? b.createdAt.getTime() : 0;
            return aTime - bTime;
        });
    } else {
        // Default: new to old (descending order by creation time)
        sortedOrders.sort((a, b) => {
        const aTime = a?.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const bTime = b?.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return bTime - aTime;
    });
    }

    sortedOrders.forEach(order => {
        const row = document.createElement('tr');
        const orderStatusLower = (order.status || '').toLowerCase().trim();
        const isPending = order.status === 'pending' || order.status === 'new';
        const isPreparing = orderStatusLower === 'preparing' || 
                           orderStatusLower === 'being-cooked' || 
                              orderStatusLower === 'being_cooked' || 
                              orderStatusLower === 'cooking' ||
                              orderStatusLower === 'being cooked';
        const isReadyForDelivery = orderStatusLower === 'ready for delivery' || orderStatusLower === 'ready_for_delivery' ||
                                   orderStatusLower === 'for delivery' || orderStatusLower === 'for_delivery';
        const isReadyForPickup = orderStatusLower === 'ready for pick-up' || orderStatusLower === 'ready_for_pickup' || 
                                 orderStatusLower === 'ready for pickup';
        const isOutForDelivery = orderStatusLower === 'out_for_delivery' || 
                                orderStatusLower === 'out-for-delivery' || 
                                orderStatusLower === 'in-transit' ||
                                orderStatusLower === 'in_transit';
        const isDelivered = orderStatusLower === 'delivered' || orderStatusLower === 'completed';
        const isCancelled = orderStatusLower === 'cancelled' || orderStatusLower === 'canceled' || orderStatusLower === 'failed';
        
        // Check if GCash payment needs verification
        const paymentModeLower = (order.paymentMode || '').toLowerCase();
        const isGCashOrder = paymentModeLower === 'gcash' || paymentModeLower === 'g-cash';
        const isPaymentVerified = order.paymentVerified === true;
        
        // Service type checks
        const orderServiceType = (order.serviceType || '').toLowerCase().trim();
        const isDineIn = orderServiceType === 'dine-in' || orderServiceType === 'dinein';
        const isPickUp = orderServiceType === 'pick-up' || orderServiceType === 'pickup' || orderServiceType === 'pick_up';
        const isDeliveryOrder = !isDineIn && !isPickUp;
        const hasDeliveryAddress = !!(order.address && order.address.trim());
        
        // Determine available next statuses
        const availableStatuses = [];
        if (isPending) {
            // Can move to preparing if payment is verified (for GCash) or not GCash
            if (!isGCashOrder || isPaymentVerified) {
                availableStatuses.push({ value: 'preparing', label: 'Preparing' });
            }
        } else if (isPreparing) {
            // From preparing, can go to:
            // - Out for Delivery (for delivery orders)
            // - Ready for Pick-up (for pick-up orders)
            // - Ready (for dine-in orders)
            if (isDeliveryOrder && hasDeliveryAddress) {
                availableStatuses.push({ value: 'out for delivery', label: 'Out for Delivery' });
            } else if (isPickUp) {
                availableStatuses.push({ value: 'ready for pick-up', label: 'Ready for Pick-up' });
            } else if (isDineIn) {
                // Dine-in goes to Ready status
                availableStatuses.push({ value: 'ready', label: 'Ready' });
            }
        } else if (isReadyForPickup) {
            // From ready for pick-up, can mark as delivered
            if (isPickUp) {
                availableStatuses.push({ value: 'delivered', label: 'Delivered' });
            }
        } else if (orderStatusLower === 'ready') {
            // From ready (dine-in), can mark as delivered
            if (isDineIn) {
                availableStatuses.push({ value: 'delivered', label: 'Delivered' });
            }
        } else if (isReadyForDelivery) {
            // From ready for delivery, can go to out for delivery
            if (isDeliveryOrder) {
                availableStatuses.push({ value: 'out for delivery', label: 'Out for Delivery' });
            }
        } else if (isOutForDelivery) {
            // From out for delivery, can mark as delivered
            if (isDeliveryOrder) {
                availableStatuses.push({ value: 'delivered', label: 'Delivered' });
            }
        }
        
        // Build status display and change button
        const statusDisplay = formatOrderStatusBadge(order.status);
        
        // Status change button - only show if there are available statuses and payment is verified (for GCash)
        let statusChangeButton = '';
        if (availableStatuses.length > 0 && !isDelivered && !isCancelled) {
            // Check if payment verification is blocking status change
            const canChangeStatus = !isPending || !isGCashOrder || isPaymentVerified;
            
            if (canChangeStatus) {
                // Create dropdown for status change
                const options = availableStatuses.map(s => 
                    `<option value="${s.value}">${s.label}</option>`
                ).join('');
                statusChangeButton = `
                    <select class="status-change-select" onchange="if(this.value) updateOrderStatus('${order.id}', this.value); this.value='';" title="Change order status">
                        <option value="">Change Status</option>
                        ${options}
                    </select>
                `;
            } else {
                statusChangeButton = `<span class="status-blocked" title="Payment must be verified first">Payment Verification Required</span>`;
            }
        }
        
        // Get customer name
        const customerName = formatOrderCustomer(order);
        
        // Get order name (short version)
        const orderName = formatOrderNameShort(order.items);
        
        // Get location
        const location = formatOrderLocation(order);
        
        // Get time
        const orderTime = formatOrderTime(order);
        
        // Get price
        const price = formatCurrency(order.total || 0);
        
        // Service type badge for visual distinction
        let serviceTypeBadge = '';
        if (orderServiceType === 'dine-in' || orderServiceType === 'dinein') {
            serviceTypeBadge = '<span class="service-badge dine-in"><i class="fas fa-utensils"></i> Dine In</span>';
        } else if (orderServiceType === 'pick-up' || orderServiceType === 'pickup' || orderServiceType === 'pick_up') {
            serviceTypeBadge = '<span class="service-badge pick-up"><i class="fas fa-shopping-bag"></i> Pick Up</span>';
        } else {
            serviceTypeBadge = '<span class="service-badge delivery"><i class="fas fa-truck"></i> Delivery</span>';
        }
        
        // View Details button with text
        const viewDetailsButton = `<button class="action-btn-text view" onclick="viewOrderDetails('${order.id}')" title="View Details">
            <i class="fas fa-eye"></i> View Details
        </button>`;
        
        // Driver assignment UI - only for delivery orders that are ready for delivery or out for delivery
        let driverAssignmentUI = '';
        if (isDeliveryOrder && (isReadyForDelivery || isOutForDelivery || isPreparing)) {
            const hasDriver = !!(order.driverId && order.driverId.trim());
            
            if (hasDriver) {
                // Find driver name for display
                const assignedDriver = driversState.find(d => 
                    (d.driverId === order.driverId) || 
                    (d.id === order.driverId) || 
                    (d.staffId === order.driverId)
                );
                const driverName = assignedDriver ? assignedDriver.name : 'Driver Assigned';
                driverAssignmentUI = `
                    <div class="driver-assigned-info" style="font-size: 12px; color: #28a745; font-weight: 500; margin-top: 4px;">
                        <i class="fas fa-check-circle"></i> ${escapeHtml(driverName)}
                    </div>
                `;
            } else {
                driverAssignmentUI = `
                    <button class="action-btn-text assign-driver" onclick="openDriverSelectionForOrder('${order.id}')" title="Assign Driver">
                        <i class="fas fa-user-plus"></i> Assign Driver
                    </button>
                `;
            }
        }
        
        row.innerHTML = `
            <td class="order-id-column">
                <div class="order-id-cell">
                    ${escapeHtml(order.trackingId || order.id)}
                    ${serviceTypeBadge}
                </div>
            </td>
            <td class="order-name-column">${escapeHtml(orderName)}</td>
            <td class="customer-name-column">${escapeHtml(customerName)}</td>
            <td class="location-column">${location}</td>
            <td class="status-column">${statusDisplay}</td>
            <td class="time-column">${escapeHtml(orderTime)}</td>
            <td class="price-column">${price}</td>
            <td class="actions-column">
                <div class="action-buttons-group">
                    ${viewDetailsButton}
                    ${statusChangeButton}
                    ${driverAssignmentUI}
                </div>
            </td>
        `;
        tableBody.appendChild(row);
    });
}

function formatOrderItems(items) {
    if (!Array.isArray(items) || !items.length) {
        return '—';
    }
    return items.map(item => {
        if (typeof item === 'string') {
            return escapeHtml(item);
        }
        const name = item.name || item.itemName || item.itemId || 'Item';
        const quantity = typeof item.quantity === 'number' && item.quantity > 1
            ? ` x${item.quantity}`
            : '';
        return `${escapeHtml(name)}${quantity}`;
    }).join(', ');
}

// Format order name for table display (short version)
function formatOrderNameShort(items) {
    if (!Array.isArray(items) || !items.length) {
        return '—';
    }
    const firstItem = items[0];
    const firstName = typeof firstItem === 'string' 
        ? firstItem 
        : (firstItem.name || firstItem.itemName || firstItem.itemId || 'Item');
    
    if (items.length === 1) {
        return escapeHtml(firstName);
    } else {
        return `${escapeHtml(firstName)} + ${items.length - 1} more`;
    }
}

// Format location based on order type
function formatOrderLocation(order) {
    if (!order) return '—';
    
    const serviceType = (order.serviceType || '').toLowerCase().trim();
    const isDineIn = serviceType === 'dine-in' || serviceType === 'dinein';
    const isPickUp = serviceType === 'pick-up' || serviceType === 'pickup' || serviceType === 'pick_up';
    
    if (isDineIn) {
        const tableNum = order.tableNumber ? String(order.tableNumber) : '—';
        return `Table ${tableNum}`;
    } else if (isPickUp) {
        const restaurantAddr = order.restaurantAddress || 'Pablo\'s Peri Peri Restaurant';
        return escapeHtml(restaurantAddr);
    } else {
        // Delivery order
        const address = order.address || order.deliveryInfo?.address || '—';
        return escapeHtml(address);
    }
}

// Format order time (delivered time if delivered, otherwise creation time)
function formatOrderTime(order) {
    if (!order) return '—';
    
    const orderStatus = (order.status || '').toLowerCase().trim();
    const isDelivered = orderStatus === 'delivered' || orderStatus === 'completed';
    
    let timeToFormat = null;
    if (isDelivered && order.deliveredAt) {
        timeToFormat = order.deliveredAt;
    } else if (isDelivered && order.completedAt) {
        timeToFormat = order.completedAt;
    } else if (order.createdAt) {
        timeToFormat = order.createdAt;
    }
    
    if (!timeToFormat) return '—';
    
    // Normalize timestamp
    let date;
    if (timeToFormat instanceof Date) {
        date = timeToFormat;
    } else if (typeof timeToFormat.toDate === 'function') {
        date = timeToFormat.toDate();
    } else {
        date = new Date(timeToFormat);
    }
    
    if (isNaN(date.getTime())) return '—';
    
    // Format as HH:MM
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
}

function formatOrderCustomer(order) {
    if (!order) return '—';
    const userId = order.userId;
    if (order.customerName) {
        return escapeHtml(order.customerName);
    }
    if (userId && customerDetailsCache.has(userId)) {
        const cached = customerDetailsCache.get(userId);
        return escapeHtml(cached?.name || userId);
    }
    if (order.deliveryInfo && order.deliveryInfo.address) {
        return escapeHtml(order.deliveryInfo.address);
    }
    if (userId) {
        return escapeHtml(userId);
    }
    return '—';
}

async function hydrateOrderCustomers(orders) {
    if (!Array.isArray(orders)) return;
    const userIds = orders
        .map(order => order.userId)
        .filter(userId => Boolean(userId));
    const uniqueMissing = [...new Set(userIds)]
        .filter(userId => !customerDetailsCache.has(userId) && !customerFetchInProgress.has(userId));
    if (!uniqueMissing.length) {
        return;
    }

    if (!isFirestoreReady()) {
        try {
            await waitForFirebaseReady();
        } catch (error) {
            console.warn('Cannot hydrate customers yet:', error);
            return;
        }
    }

    const fns = window.firestoreFunctions;
    if (!fns?.doc || !fns?.getDoc) {
        return;
    }

    await Promise.all(uniqueMissing.map(async (userId) => {
        customerFetchInProgress.add(userId);
        try {
            const customerDocRef = fns.doc(window.db, 'customers', userId);
            const snapshot = await fns.getDoc(customerDocRef);
            if (snapshot.exists()) {
                const data = snapshot.data() || {};
                const nameParts = [data.firstName, data.lastName].filter(Boolean);
                const displayName = nameParts.length
                    ? nameParts.join(' ')
                    : (data.displayName || data.fullName || data.email || userId);
                customerDetailsCache.set(userId, {
                    name: displayName,
                    phone: data.phoneNumber || data.contactNumber || ''
                });
            } else {
                customerDetailsCache.set(userId, { name: userId });
            }
        } catch (error) {
            console.warn(`Failed to fetch customer profile for ${userId}:`, error);
            customerDetailsCache.set(userId, { name: userId });
        } finally {
            customerFetchInProgress.delete(userId);
        }
    }));

    renderOrdersTable(ordersState);
}

function isFirestoreReady() {
    return Boolean(window.db && window.firestoreFunctions);
}

function isStorageReady() {
    return Boolean(window.storage && window.storageFunctions);
}

function waitForFirebaseReady(timeout = 10000) {
    if (isFirestoreReady()) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Firebase initialization timed out.'));
        }, timeout);

        const onReady = () => {
            cleanup();
            resolve();
        };

        const onError = (event) => {
            cleanup();
            reject(event?.detail || new Error('Firebase failed to initialize.'));
        };

        function cleanup() {
            window.removeEventListener('firebaseReady', onReady);
            window.removeEventListener('firebaseError', onError);
            clearTimeout(timer);
        }

        window.addEventListener('firebaseReady', onReady);
        window.addEventListener('firebaseError', onError);
    });
}

window.InventoryStore = InventoryStore;

// Dropdown functionality
function toggleDropdown(dropdownId) {
    // Close any currently open dropdown
    if (activeDropdown && activeDropdown !== dropdownId) {
        const currentDropdown = document.getElementById(activeDropdown);
        if (currentDropdown) {
            currentDropdown.classList.remove('show');
        }
    }
    
    // Toggle the clicked dropdown
    const dropdown = document.getElementById(dropdownId);
    if (dropdown) {
        dropdown.classList.toggle('show');
        activeDropdown = dropdown.classList.contains('show') ? dropdownId : null;
    }
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(event) {
    if (activeDropdown) {
        const dropdown = document.getElementById(activeDropdown);
        const button = event.target.closest('[onclick*="toggleDropdown"]');
        
        if (!dropdown.contains(event.target) && !button) {
            dropdown.classList.remove('show');
            activeDropdown = null;
        }
    }
});

// Filter functions
function applyOrderStatusFilter() {
    const filterSelect = document.getElementById('orderFilter');
    if (filterSelect) {
        orderFilters.filter = filterSelect.value || 'all';
    }
        renderOrdersTable(ordersState);
}

function filterOrders() {
    const searchInput = document.getElementById('orderSearch');
    if (searchInput) {
        orderFilters.searchTerm = searchInput.value.trim();
        renderOrdersTable(ordersState);
    }
}

// Order management functions
let currentOrderForAssignment = null;

// New unified function to update order status with payment verification checks
async function updateOrderStatus(orderId, newStatus) {
    if (!orderId || !newStatus) {
        showNotification('Order ID or status is missing.', 'error');
        return;
    }
    
    const order = ordersState.find(o => o.id === orderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    
    const currentStatus = (order.status || '').toLowerCase().trim();
    const normalizedNewStatus = newStatus.toLowerCase().trim();
    
    // Check payment verification for GCash orders (required before any status change from pending)
    const paymentModeLower = (order.paymentMode || '').toLowerCase();
    const isGCashOrder = paymentModeLower === 'gcash' || paymentModeLower === 'g-cash';
    const isPaymentVerified = order.paymentVerified === true;
    const isPending = currentStatus === 'pending' || currentStatus === 'new';
    
    if (isPending && isGCashOrder && !isPaymentVerified && normalizedNewStatus !== 'pending') {
        showNotification('Payment must be verified before changing order status.', 'error');
        return;
    }
    
    // Validate status transitions
    const serviceType = (order.serviceType || '').toLowerCase().trim();
    const isDineIn = serviceType === 'dine-in' || serviceType === 'dinein';
    const isPickUp = serviceType === 'pick-up' || serviceType === 'pickup' || serviceType === 'pick_up';
    const isDeliveryOrder = !isDineIn && !isPickUp;
    const hasDeliveryAddress = !!(order.address && order.address.trim());
    
    // Status transition validation
    let statusValid = false;
    let errorMessage = '';
    
    if (normalizedNewStatus === 'preparing') {
        // Can move to preparing from pending
        statusValid = isPending;
        errorMessage = 'Can only mark pending orders as preparing.';
    } else if (normalizedNewStatus === 'out for delivery' || normalizedNewStatus === 'out_for_delivery') {
        // Can move to "out for delivery" from preparing, only for delivery orders
        const isPreparing = currentStatus === 'preparing' || currentStatus === 'being-cooked' || 
                           currentStatus === 'being_cooked' || currentStatus === 'cooking' || 
                           currentStatus === 'being cooked';
        const isReadyForDelivery = currentStatus === 'ready for delivery' || currentStatus === 'ready_for_delivery' || 
                                   currentStatus === 'for delivery' || currentStatus === 'for_delivery';
        statusValid = (isPreparing || isReadyForDelivery) && isDeliveryOrder && hasDeliveryAddress;
        errorMessage = !isDeliveryOrder ? 'Only delivery orders can be marked as "Out for Delivery".' : 
                      (!hasDeliveryAddress ? 'Delivery address is required.' : 
                      'Order must be preparing first.');
    } else if (normalizedNewStatus === 'ready for pick-up' || normalizedNewStatus === 'ready_for_pickup' || normalizedNewStatus === 'ready for pickup') {
        // Can move to "ready for pick-up" from preparing, only for pick-up orders
        const isPreparing = currentStatus === 'preparing' || currentStatus === 'being-cooked' || 
                           currentStatus === 'being_cooked' || currentStatus === 'cooking' || 
                           currentStatus === 'being cooked';
        statusValid = isPreparing && isPickUp;
        errorMessage = !isPreparing ? 'Order must be preparing first.' : 
                      (!isPickUp ? 'Only pick-up orders can be marked as "Ready for Pick-up".' : '');
    } else if (normalizedNewStatus === 'ready') {
        // Can move to "ready" from preparing, only for dine-in orders
        const isPreparing = currentStatus === 'preparing' || currentStatus === 'being-cooked' || 
                           currentStatus === 'being_cooked' || currentStatus === 'cooking' || 
                           currentStatus === 'being cooked';
        statusValid = isPreparing && isDineIn;
        errorMessage = !isPreparing ? 'Order must be preparing first.' : 
                      (!isDineIn ? 'Only dine-in orders can be marked as "Ready".' : '');
    } else if (normalizedNewStatus === 'delivered') {
        // Can move to delivered from ready (dine-in), ready for pick-up (pick-up), or out for delivery (delivery)
        const isReady = currentStatus === 'ready';
        const isReadyForPickup = currentStatus === 'ready for pick-up' || currentStatus === 'ready_for_pickup' || currentStatus === 'ready for pickup';
        const isOutForDelivery = currentStatus === 'out_for_delivery' || currentStatus === 'out-for-delivery' || 
                                 currentStatus === 'in-transit' || currentStatus === 'in_transit';
        statusValid = isReady || isReadyForPickup || isOutForDelivery;
        errorMessage = 'Order must be "Ready" (dine-in), "Ready for Pick-up" (pick-up), or "Out for Delivery" (delivery) before marking as delivered.';
    } else {
        errorMessage = `Invalid status transition to "${newStatus}".`;
    }
    
    if (!statusValid) {
        showNotification(errorMessage, 'error');
        return;
    }
    
    // Confirm status change
    const statusLabels = {
        'preparing': 'Preparing',
        'ready': 'Ready',
        'ready for delivery': 'Ready for Delivery',
        'ready_for_delivery': 'Ready for Delivery',
        'for delivery': 'Ready for Delivery',
        'for_delivery': 'Ready for Delivery',
        'ready for pick-up': 'Ready for Pick-up',
        'ready_for_pickup': 'Ready for Pick-up',
        'ready for pickup': 'Ready for Pick-up',
        'out for delivery': 'Out for Delivery',
        'out_for_delivery': 'Out for Delivery',
        'delivered': 'Delivered'
    };
    const statusLabel = statusLabels[normalizedNewStatus] || newStatus;
    
    if (!confirm(`Mark order ${order.trackingId || orderId} as "${statusLabel}"?`)) {
        return;
    }
    
        try {
            if (!isFirestoreReady()) {
                await waitForFirebaseReady();
            }
            
            const fns = window.firestoreFunctions;
            const orderRef = fns.doc(window.db, 'orders', orderId);
            
        // Prepare update object
        const updateData = {
            status: normalizedNewStatus,
            updatedAt: fns.serverTimestamp()
        };
        
        // Add timestamp fields based on status
        if (normalizedNewStatus === 'preparing') {
            updateData.cookingStartedAt = fns.serverTimestamp();
            updateData.preparingStartedAt = fns.serverTimestamp();
        } else if (normalizedNewStatus === 'ready') {
            updateData.readyAt = fns.serverTimestamp();
        } else if (normalizedNewStatus === 'ready for pick-up' || normalizedNewStatus === 'ready_for_pickup' || normalizedNewStatus === 'ready for pickup') {
            updateData.readyForPickupAt = fns.serverTimestamp();
            updateData.status = 'ready for pick-up'; // Normalize to standard format
        } else if (normalizedNewStatus === 'out for delivery' || normalizedNewStatus === 'out_for_delivery') {
            updateData.outForDeliveryAt = fns.serverTimestamp();
            // If no driver assigned yet, we'll need to assign one (handled separately if needed)
        } else if (normalizedNewStatus === 'delivered') {
            updateData.deliveredAt = fns.serverTimestamp();
            updateData.completedAt = fns.serverTimestamp();
        }
        
        await fns.updateDoc(orderRef, updateData);
        
        // Handle "out for delivery" - create for_delivery document if needed
        if ((normalizedNewStatus === 'out for delivery' || normalizedNewStatus === 'out_for_delivery') && isDeliveryOrder) {
            try {
                const deliveryId = orderId;
                const deliveryRef = fns.doc(window.db, 'for_delivery', deliveryId);
                const existingDoc = await fns.getDoc(deliveryRef);
                
                if (!existingDoc.exists()) {
                    await fns.setDoc(deliveryRef, {
                        deliveryId: deliveryId,
                        orderId: orderId,
                        driverId: order.driverId || '',
                        timeAssigned: fns.serverTimestamp(),
                        timeDelivered: null,
                        createdAt: fns.serverTimestamp(),
                updatedAt: fns.serverTimestamp()
            });
                } else {
                    await fns.updateDoc(deliveryRef, {
                        timeAssigned: fns.serverTimestamp(),
                        updatedAt: fns.serverTimestamp()
                    });
                }
            } catch (deliveryError) {
                console.error('Error creating/updating for_delivery document:', deliveryError);
                // Don't fail the whole operation
            }
        }
        
        // Update local state
            const orderIndex = ordersState.findIndex(o => o.id === orderId);
            if (orderIndex !== -1) {
            ordersState[orderIndex].status = normalizedNewStatus;
            }
            
            // Refresh the orders table
            renderOrdersTable(ordersState);
            
        showNotification(`Order ${order.trackingId || orderId} marked as "${statusLabel}"!`, 'success');
        } catch (error) {
            console.error('Error updating order status:', error);
            showNotification('Failed to update order status. Please try again.', 'error');
        }
    }

// Keep acceptOrder for backward compatibility, but redirect to new function
async function acceptOrder(orderId) {
    await updateOrderStatus(orderId, 'preparing');
}

async function loadDriversForSelection() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns?.getDocs || !fns?.collection) {
        throw new Error('Firestore helpers are not available yet.');
    }
    
    try {
        // Try to load from 'drivers' collection first
        let snapshot;
        try {
            snapshot = await fns.getDocs(fns.collection(window.db, 'drivers'));
        } catch (error) {
            // If 'drivers' collection doesn't exist, try 'staff' collection with role filter
            const staffSnapshot = await fns.getDocs(fns.collection(window.db, 'staff'));
            const staffDocs = staffSnapshot.docs.filter(doc => {
                const data = doc.data();
                const role = (data.role || '').toLowerCase();
                return role === 'driver' || role === 'delivery';
            });
            driversState = staffDocs.map(docSnap => normalizeDriverDoc(docSnap));
            renderDriversForSelection();
            return;
        }
        
        driversState = snapshot.docs
            .map(docSnap => normalizeDriverDoc(docSnap))
            .filter(Boolean);
        renderDriversForSelection();
    } catch (error) {
        console.error('Error loading drivers:', error);
        throw error;
    }
}

function renderDriversForSelection() {
    const driversList = document.getElementById('driversSelectionList');
    if (!driversList) return;
    
    // Get order info for display
    let orderInfo = '';
    if (currentOrderForAssignment) {
        const order = ordersState.find(o => o.id === currentOrderForAssignment);
        if (order) {
            orderInfo = ` for Order ${order.trackingId || currentOrderForAssignment}`;
        }
    }
    
    // Update modal title if it exists
    const modalTitle = document.querySelector('#driverSelectionModal .modal-header h2, #driverSelectionModal .modal-header h3');
    if (modalTitle) {
        modalTitle.textContent = `Select Driver${orderInfo}`;
    }
    
    // Filter to only show available drivers
    const availableDrivers = driversState.filter(driver => driver.availability === 'available');
    
    driversList.innerHTML = '';
    
    if (!availableDrivers.length) {
        driversList.innerHTML = '<div class="empty-message">No available drivers at the moment.</div>';
        return;
    }
    
    availableDrivers.forEach(driver => {
        const driverItem = document.createElement('div');
        driverItem.className = 'driver-selection-item';
        driverItem.innerHTML = `
            <div class="driver-icon">
                <i class="fas fa-user"></i>
            </div>
            <div class="driver-info">
                <div class="driver-name">${escapeHtml(driver.name)}</div>
                <div class="driver-id">${escapeHtml(driver.driverId)}</div>
                <div class="driver-phone">${escapeHtml(driver.phoneNumber || 'No phone number')}</div>
            </div>
            <button class="btn btn-primary" onclick="assignDriverToOrder('${driver.id}', '${currentOrderForAssignment}')">
                Assign
            </button>
        `;
        driversList.appendChild(driverItem);
    });
}

// Updated markOutForDelivery to use the new unified function
async function markOutForDelivery(orderId) {
    await updateOrderStatus(orderId, 'out for delivery');
}

function openDriverSelectionForOrder(orderId) {
    currentOrderForAssignment = orderId;
    renderDriversForSelection();
    showDriverSelectionModal();
}

function showDriverSelectionModal() {
    const modal = document.getElementById('driverSelectionModal');
    if (modal) {
        modal.style.display = 'block';
    }
}

function closeDriverSelectionModal() {
    const modal = document.getElementById('driverSelectionModal');
    if (modal) {
        modal.style.display = 'none';
        currentOrderForAssignment = null;
    }
}

async function acceptOrderWithoutDriver(orderId) {
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const orderRef = fns.doc(window.db, 'orders', orderId);
        
        await fns.updateDoc(orderRef, {
            status: 'accepted',
            acceptedAt: fns.serverTimestamp(),
            updatedAt: fns.serverTimestamp()
        });
        
        const order = ordersState.find(o => o.id === orderId);
        showNotification(`Order ${order?.trackingId || orderId} accepted successfully!`, 'success');
    } catch (error) {
        console.error('Error accepting order:', error);
        showNotification('Failed to accept order. Please try again.', 'error');
    }
}

function viewOrderDetails(orderId) {
    if (!orderId) {
        showNotification('Order ID is missing.', 'error');
        return;
    }
    
    const order = ordersState.find(o => o.id === orderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    
    const modal = document.getElementById('orderDetailsModal');
    const content = document.getElementById('orderDetailsContent');
    
    if (!modal || !content) {
        showNotification('Order details modal not found.', 'error');
        return;
    }
    
    // Get customer name
    let customerName = '—';
    if (order.customerName) {
        customerName = order.customerName;
    } else if (order.userId && customerDetailsCache.has(order.userId)) {
        const cached = customerDetailsCache.get(order.userId);
        customerName = cached?.name || order.userId;
    } else if (order.userId) {
        customerName = order.userId;
    }
    
    // Format address (only for delivery)
    const address = order.address || order.deliveryInfo?.address || '—';
    
    // Format restaurant address (for pick-up)
    const restaurantAddress = order.restaurantAddress || 'Pablo\'s Peri Peri Restaurant';
    
    // Format items
    const itemsList = formatOrderItemsForDetails(order.items);
    
    // Format service type
    const serviceType = order.serviceType 
        ? order.serviceType.charAt(0).toUpperCase() + order.serviceType.slice(1)
        : '—';
    
    // Format table number (only for dine-in)
    const tableNumber = (order.serviceType === 'dine-in' && order.tableNumber) ? String(order.tableNumber) : null;
    
    // Check if GCash payment needs verification
    const paymentModeLower = (order.paymentMode || '').toLowerCase();
    const isGCashOrder = paymentModeLower === 'gcash' || paymentModeLower === 'g-cash';
    const isPaymentVerified = order.paymentVerified === true;
    
    // Verify Payment button for GCash orders
    const verifyPaymentButtonHtml = isGCashOrder && !isPaymentVerified
        ? `<button class="btn btn-warning verify-payment-btn" onclick="verifyPayment('${order.id}')" style="margin-top: 10px;">
            <i class="fas fa-receipt"></i> Verify Payment
        </button>`
        : isGCashOrder && isPaymentVerified
        ? `<div style="margin-top: 10px; padding: 8px; background-color: #d4edda; color: #155724; border-radius: 4px; display: inline-block;">
            <i class="fas fa-check-circle"></i> Payment Verified
        </div>`
        : '';
    
    content.innerHTML = `
        <div class="order-details-section">
            <h3>Order Information</h3>
            <div class="detail-row">
                <span class="detail-label">Order ID:</span>
                <span class="detail-value">${escapeHtml(order.trackingId || order.id)}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Time:</span>
                <span class="detail-value">${escapeHtml(order.createdLabel || '—')}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Status:</span>
                <span class="detail-value">${formatOrderStatusBadge(order.status)}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Service Type:</span>
                <span class="detail-value">${escapeHtml(serviceType)}</span>
            </div>
            ${tableNumber ? `
            <div class="detail-row">
                <span class="detail-label">Table Number:</span>
                <span class="detail-value">${escapeHtml(tableNumber)}</span>
            </div>
            ` : ''}
        </div>
        
        <div class="order-details-section">
            <h3>Customer Information</h3>
            <div class="detail-row">
                <span class="detail-label">Customer:</span>
                <span class="detail-value">${escapeHtml(customerName)}</span>
            </div>
            ${order.serviceType === 'delivery' ? `
            <div class="detail-row">
                <span class="detail-label">Delivery Address:</span>
                <span class="detail-value">${escapeHtml(address)}</span>
            </div>
            ` : ''}
            ${order.serviceType === 'pick-up' || order.serviceType === 'pickup' ? `
            <div class="detail-row">
                <span class="detail-label">Pick-up Location:</span>
                <span class="detail-value">${escapeHtml(restaurantAddress)}</span>
            </div>
            ` : ''}
        </div>
        
        <div class="order-details-section">
            <h3>Order Items</h3>
            <div class="detail-row">
                <span class="detail-label">Products:</span>
                <span class="detail-value">${itemsList}</span>
            </div>
        </div>
        
        <div class="order-details-section">
            <h3>Payment Information</h3>
            <div class="detail-row">
                <span class="detail-label">Amount:</span>
                <span class="detail-value">${formatCurrency(order.total)}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Payment Mode:</span>
                <span class="detail-value">${escapeHtml(order.paymentMode || 'Unspecified')}</span>
            </div>
            ${verifyPaymentButtonHtml}
        </div>
        
        <div class="order-details-section">
            <h3>Driver Information</h3>
            <div class="detail-row">
                <span class="detail-label">Driver ID:</span>
                <span class="detail-value">${escapeHtml(order.driverId || '—')}</span>
            </div>
        </div>
    `;
    
    modal.style.display = 'block';
}

function closeOrderDetailsModal() {
    const modal = document.getElementById('orderDetailsModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

let currentVerifyingOrderId = null;

async function verifyPayment(orderId) {
    if (!orderId) {
        showNotification('Order ID is missing.', 'error');
        return;
    }
    
    const order = ordersState.find(o => o.id === orderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    
    const paymentModeLower = (order.paymentMode || '').toLowerCase();
    if (paymentModeLower !== 'gcash' && paymentModeLower !== 'g-cash') {
        showNotification('This order is not a GCash payment.', 'error');
        return;
    }
    
    const modal = document.getElementById('paymentReceiptModal');
    const loadingEl = document.getElementById('receiptLoading');
    const errorEl = document.getElementById('receiptError');
    const imageContainer = document.getElementById('receiptImageContainer');
    const receiptImage = document.getElementById('receiptImage');
    const footer = document.getElementById('receiptModalFooter');
    
    if (!modal || !loadingEl || !errorEl || !imageContainer || !receiptImage) {
        showNotification('Payment receipt modal not found.', 'error');
        return;
    }
    
    // Show modal and loading state
    modal.style.display = 'block';
    loadingEl.style.display = 'block';
    errorEl.style.display = 'none';
    imageContainer.style.display = 'none';
    footer.style.display = 'none';
    currentVerifyingOrderId = orderId;
    
    try {
        // Wait for Firebase Storage to be ready
        if (!window.storage || !window.storageFunctions) {
            await waitForFirebaseReady();
            
            // Check if Storage is available
            if (!window.storage || !window.storageFunctions) {
                throw new Error('Firebase Storage is not initialized. Please refresh the page.');
            }
        }
        
        const { ref, getDownloadURL, listAll } = window.storageFunctions;
        const storage = window.storage;
        
        // First, check if the order has a paymentProofPath field
        let imageUrl = null;
        let lastError = null;
        const attemptedPaths = [];
        
        // Determine if this is a guest order
        const isGuestOrder = !order.userId || order.userId === null || order.isGuest === true;
        
        console.log('Looking for payment receipt:', {
            orderId: orderId,
            orderDocumentId: order.id,
            trackingId: order.trackingId,
            userId: order.userId,
            isGuest: isGuestOrder,
            paymentProofPath: order.paymentProofPath
        });
        
        // If paymentProofPath is specified in order data, use it first
        if (order.paymentProofPath) {
            const path = order.paymentProofPath.startsWith('paymentProofs/') 
                ? order.paymentProofPath 
                : `paymentProofs/${order.paymentProofPath}`;
            attemptedPaths.push(path);
            try {
                const imageRef = ref(storage, path);
                imageUrl = await getDownloadURL(imageRef);
                console.log(`✓ Successfully found receipt at: ${path} (from order data)`);
            } catch (error) {
                lastError = error;
                console.log(`✗ Tried path: ${path} - ${error.code || error.message}`);
            }
        }
        
        // If not found, try different possible file names based on user type
        if (!imageUrl) {
            const documentId = order.id; // Order document ID
            const userId = order.userId; // User ID
            const trackingIdClean = (order.trackingId || '').replace('#', '').toUpperCase();
            
            // Build list of possible paths to try
            const possiblePaths = [];
            
            if (isGuestOrder) {
                // For guest orders: paymentProofs/guest/{filename}
                const basePath = 'paymentProofs/guest';
                // Try with order document ID
                possiblePaths.push(
                    `${basePath}/${documentId}`,
                    `${basePath}/${documentId}.webp`,
                    `${basePath}/${documentId}.jpg`,
                    `${basePath}/${documentId}.jpeg`,
                    `${basePath}/${documentId}.png`,
                    `${basePath}/${documentId}.JPG`,
                    `${basePath}/${documentId}.JPEG`,
                    `${basePath}/${documentId}.PNG`
                );
                // Try with tracking ID (without #)
                if (trackingIdClean && trackingIdClean !== documentId) {
                    possiblePaths.push(
                        `${basePath}/${trackingIdClean}`,
                        `${basePath}/${trackingIdClean}.webp`,
                        `${basePath}/${trackingIdClean}.jpg`,
                        `${basePath}/${trackingIdClean}.jpeg`,
                        `${basePath}/${trackingIdClean}.png`,
                        `${basePath}/${trackingIdClean}.JPG`,
                        `${basePath}/${trackingIdClean}.JPEG`,
                        `${basePath}/${trackingIdClean}.PNG`
                    );
                }
            } else {
                // For registered users: paymentProofs/{userId}/{filename}
                const basePath = `paymentProofs/${userId}`;
                // Try with order document ID
                possiblePaths.push(
                    `${basePath}/${documentId}`,
                    `${basePath}/${documentId}.webp`,
                    `${basePath}/${documentId}.jpg`,
                    `${basePath}/${documentId}.jpeg`,
                    `${basePath}/${documentId}.png`,
                    `${basePath}/${documentId}.JPG`,
                    `${basePath}/${documentId}.JPEG`,
                    `${basePath}/${documentId}.PNG`
                );
                // Try with tracking ID (without #)
                if (trackingIdClean && trackingIdClean !== documentId) {
                    possiblePaths.push(
                        `${basePath}/${trackingIdClean}`,
                        `${basePath}/${trackingIdClean}.webp`,
                        `${basePath}/${trackingIdClean}.jpg`,
                        `${basePath}/${trackingIdClean}.jpeg`,
                        `${basePath}/${trackingIdClean}.png`,
                        `${basePath}/${trackingIdClean}.JPG`,
                        `${basePath}/${trackingIdClean}.JPEG`,
                        `${basePath}/${trackingIdClean}.PNG`
                    );
                }
            }
            
            console.log(`Trying ${possiblePaths.length} paths for ${isGuestOrder ? 'guest' : 'registered'} order...`);
            
            // Try each possible path
            for (const path of possiblePaths) {
                if (attemptedPaths.includes(path)) continue; // Skip if already tried
                attemptedPaths.push(path);
                try {
                    const imageRef = ref(storage, path);
                    imageUrl = await getDownloadURL(imageRef);
                    console.log(`✓ Successfully found receipt at: ${path}`);
                    break; // Success, exit loop
                } catch (error) {
                    lastError = error;
                    console.log(`✗ Tried path: ${path} - ${error.code || error.message}`);
                    // Continue to next path
                }
            }
        }
        
        // If still not found, try listing files in the appropriate folder
        if (!imageUrl && listAll) {
            try {
                const documentId = order.id;
                const userId = order.userId;
                const trackingIdClean = (order.trackingId || '').replace('#', '').toUpperCase();
                
                // List files in the appropriate folder
                const folderPath = isGuestOrder ? 'paymentProofs/guest' : `paymentProofs/${userId}`;
                console.log(`Attempting to list files in ${folderPath} folder...`);
                
                try {
                    const folderRef = ref(storage, folderPath);
                    const result = await listAll(folderRef);
                    
                    console.log(`Found ${result.items.length} files in ${folderPath} folder`);
                    
                    // Try to find a file that might match (contains order ID or tracking ID)
                    for (const itemRef of result.items) {
                        const fileName = itemRef.name;
                        const fileNameUpper = fileName.toUpperCase();
                        const documentIdUpper = documentId.toUpperCase();
                        
                        // Check if filename contains order ID or tracking ID (case-insensitive)
                        if (fileNameUpper.includes(documentIdUpper) || 
                            (trackingIdClean && fileNameUpper.includes(trackingIdClean))) {
                            const path = `${folderPath}/${fileName}`;
                            if (!attemptedPaths.includes(path)) {
                                attemptedPaths.push(path);
                                try {
                                    imageUrl = await getDownloadURL(itemRef);
                                    console.log(`✓ Successfully found receipt at: ${path} (from listing)`);
                                    break;
                                } catch (error) {
                                    console.log(`✗ Tried path: ${path} - ${error.code || error.message}`);
                                }
                            }
                        }
                    }
                    
                    // If still not found, try all files in the folder (last resort)
                    if (!imageUrl && result.items.length > 0) {
                        console.log('Trying all files in folder as last resort...');
                        for (const itemRef of result.items) {
                            const fileName = itemRef.name;
                            const path = `${folderPath}/${fileName}`;
                            if (!attemptedPaths.includes(path)) {
                                attemptedPaths.push(path);
                                try {
                                    imageUrl = await getDownloadURL(itemRef);
                                    console.log(`✓ Successfully found receipt at: ${path} (last resort)`);
                                    break;
                                } catch (error) {
                                    console.log(`✗ Tried path: ${path} - ${error.code || error.message}`);
                                }
                            }
                        }
                    }
                } catch (listError) {
                    console.log(`Could not list files in ${folderPath} folder:`, listError);
                }
            } catch (error) {
                console.log('Could not list files in paymentProofs folder:', error);
            }
        }
        
        if (!imageUrl) {
            const errorMessage = `Receipt image not found for order ${order.trackingId || orderId}. Tried ${attemptedPaths.length} paths. Make sure the file exists in paymentProofs folder.`;
            console.error('Payment receipt error:', errorMessage, lastError);
            console.error('Attempted paths:', attemptedPaths);
            throw new Error(errorMessage);
        }
        
        // Display the image
        receiptImage.src = imageUrl;
        receiptImage.onload = () => {
            loadingEl.style.display = 'none';
            imageContainer.style.display = 'block';
            footer.style.display = 'flex';
        };
        receiptImage.onerror = () => {
            loadingEl.style.display = 'none';
            errorEl.style.display = 'block';
        };
        
        // Store order ID for verification
        currentVerifyingOrderId = orderId;
        
    } catch (error) {
        console.error('Error loading payment receipt:', error);
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
        errorEl.querySelector('p').textContent = error.message || 'Unable to load payment receipt. The receipt image may not be available.';
    }
}

function closePaymentReceiptModal() {
    const modal = document.getElementById('paymentReceiptModal');
    if (modal) {
        modal.style.display = 'none';
        currentVerifyingOrderId = null;
        
        // Reset modal state
        const loadingEl = document.getElementById('receiptLoading');
        const errorEl = document.getElementById('receiptError');
        const imageContainer = document.getElementById('receiptImageContainer');
        const receiptImage = document.getElementById('receiptImage');
        const footer = document.getElementById('receiptModalFooter');
        
        if (loadingEl) loadingEl.style.display = 'block';
        if (errorEl) errorEl.style.display = 'none';
        if (imageContainer) imageContainer.style.display = 'none';
        if (receiptImage) receiptImage.src = '';
        if (footer) footer.style.display = 'none';
    }
}

async function verifyPaymentConfirm() {
    if (!currentVerifyingOrderId) {
        showNotification('No order selected for payment verification.', 'error');
        return;
    }
    
    const order = ordersState.find(o => o.id === currentVerifyingOrderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    
    if (confirm(`Verify payment for order ${order.trackingId || currentVerifyingOrderId}?`)) {
        try {
            if (!isFirestoreReady()) {
                showNotification('Database is not ready. Please try again.', 'error');
                return;
            }
            
            const fns = window.firestoreFunctions;
            const orderRef = fns.doc(window.db, 'orders', currentVerifyingOrderId);
            
            await fns.updateDoc(orderRef, {
                paymentVerified: true,
                paymentVerifiedAt: fns.serverTimestamp(),
                updatedAt: fns.serverTimestamp()
            });
            
            // Update local state
            const orderIndex = ordersState.findIndex(o => o.id === currentVerifyingOrderId);
            if (orderIndex !== -1) {
                ordersState[orderIndex].paymentVerified = true;
                ordersState[orderIndex].paymentVerifiedAt = new Date();
            }
            
            // Refresh the orders table
            renderOrdersTable(ordersState);
            
            showNotification(`Payment verified for order ${order.trackingId || currentVerifyingOrderId}!`, 'success');
            closePaymentReceiptModal();
        } catch (error) {
            console.error('Error verifying payment:', error);
            showNotification('Failed to verify payment. Please try again.', 'error');
        }
    }
}


function formatOrderItemsForDetails(items) {
    if (!Array.isArray(items) || !items.length) {
        return '—';
    }
    const itemsList = items.map(item => {
        if (typeof item === 'string') {
            return escapeHtml(item);
        }
        const name = item.name || item.itemName || item.itemId || 'Item';
        const quantity = typeof item.quantity === 'number' && item.quantity > 0
            ? ` x${item.quantity}`
            : '';
        const price = typeof item.price === 'number' && item.price > 0
            ? ` (${formatCurrency(item.price)})`
            : '';
        return `${escapeHtml(name)}${quantity}${price}`;
    });
    return itemsList.length > 0 ? itemsList.join('<br>') : '—';
}

// Close modal when clicking outside of it
window.onclick = function(event) {
    const orderModal = document.getElementById('orderDetailsModal');
    const receiptModal = document.getElementById('paymentReceiptModal');
    const driverSelectionModal = document.getElementById('driverSelectionModal');
    const driverProfileModal = document.getElementById('driverProfileModal');
    
    if (event.target === orderModal) {
        closeOrderDetailsModal();
    }
    if (event.target === receiptModal) {
        closePaymentReceiptModal();
    }
    if (event.target === driverSelectionModal) {
        closeDriverSelectionModal();
    }
    if (event.target === driverProfileModal) {
        closeDriverProfileModal();
    }
}

// Driver management functions
function editDriver(driverId) {
    alert(`Edit driver ${driverId} - This would open an edit form in a real application`);
}

function deleteDriver(driverId) {
    if (confirm(`Are you sure you want to delete driver ${driverId}?`)) {
        alert(`Driver ${driverId} deleted successfully`);
    }
}

function printDriver(driverId) {
    alert(`Printing driver ${driverId} information`);
    // In a real application, this would trigger a print dialog
}

// Inventory management functions
function editItem(itemId) {
    alert(`Edit item ${itemId} - This would open an edit form in a real application`);
}

function deleteItem(itemId) {
    if (confirm(`Are you sure you want to delete item ${itemId}?`)) {
        alert(`Item ${itemId} deleted successfully`);
    }
}

// Sales report functions
function switchReport(reportType) {
    // Remove active class from all sales activity tabs
    document.querySelectorAll('.sales-activity-tabs .tab-btn').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Add active class to clicked tab
    event.target.classList.add('active');
    
    // In a real application, this would load different report data
    console.log(`Switched to ${reportType} report`); // No popup notification
}

function switchTime(timePeriod) {
    // Remove active class from all time tabs
    document.querySelectorAll('.time-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Add active class to clicked tab
    event.target.classList.add('active');
    
    // In a real application, this would filter data by time period
    console.log(`Switched to ${timePeriod} view`); // No popup notification
}

function exportReport() {
    // In a real application, this would generate and download the report
    console.log('Exporting report...'); // No popup notification
}

function changePage(page) {
    if (page === 'prev' || page === 'next') {
        alert(`Navigate to ${page} page`);
    } else {
        // Remove active class from all page buttons
        document.querySelectorAll('.page-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        
        // Add active class to clicked page button
        event.target.classList.add('active');
        
        alert(`Navigate to page ${page}`);
    }
}

function exportReport() {
    alert('Export functionality - In a real application, this would download a report file');
    // Note: Export buttons don't need backend functionality as per requirements
}

async function exportInventoryReport() {
    try {
        await waitForFirebaseReady();
        const items = (inventoryState && inventoryState.length)
            ? inventoryState
            : await InventoryStore.getItems();

        if (!items || !items.length) {
            showNotification('No inventory data available to export yet.', 'info');
            return;
        }

        const header = 'Ingredient,Quantity (base unit),Display Quantity,Unit Type,Last Updated';
        const rows = [...items]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(item => {
                const unitLabel = item.unitType === 'weight' ? 'Weight' : 'Count';
                const displayValue = formatInventoryQuantity(item, true);
                return [
                    `"${item.name}"`,
                    item.quantity,
                    `"${displayValue}"`,
                    unitLabel,
                    item.updatedAt || item.createdAt || ''
                ].join(',');
            });

        const csvContent = [header, ...rows].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'inventory_report_' + new Date().toISOString().split('T')[0] + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);

        showNotification('Inventory report exported successfully!', 'success');
    } catch (error) {
        console.error('Export inventory failed:', error);
        showNotification(error.message || 'Unable to export inventory report.', 'error');
    }
}

// Inventory UI helpers
async function initInventoryManagement() {
    const restockForm = document.getElementById('inventoryForm');
    const registerForm = document.getElementById('ingredientRegisterForm');

    if (!restockForm) {
        return;
    }

    try {
        await waitForFirebaseReady();
        await refreshInventoryState();
    } catch (error) {
        console.error('Unable to initialize inventory management:', error);
        showNotification(error.message || 'Inventory data could not be loaded. Please try again later.', 'error');
        return;
    }

    const ingredientInput = document.getElementById('inventoryIngredientName');
    const unitTypeSelect = document.getElementById('inventoryUnitType');
    const registerUnitTypeSelect = document.getElementById('registerUnitType');
    const registerUnitSelect = document.getElementById('registerUnit');
    const registerQuantityInput = document.getElementById('registerQuantity');

    if (ingredientInput) {
        ingredientInput.addEventListener('input', () => syncIngredientUnitType(ingredientInput, unitTypeSelect));
    }

    if (unitTypeSelect) {
        unitTypeSelect.addEventListener('change', () => updateUnitOptions(unitTypeSelect.value));
        updateUnitOptions(unitTypeSelect.value);
    }

    restockForm.addEventListener('submit', handleInventoryFormSubmit);
    if (registerForm) {
        registerForm.addEventListener('submit', handleIngredientRegisterSubmit);
    }
    if (registerUnitTypeSelect) {
        const updateRegisterUnits = () => updateUnitOptions(registerUnitTypeSelect.value, registerUnitSelect, registerQuantityInput);
        registerUnitTypeSelect.addEventListener('change', updateRegisterUnits);
        updateRegisterUnits();
    }
}

async function refreshInventoryState() {
    inventoryState = await InventoryStore.getItems();
    renderInventoryState();
}

async function handleInventoryFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const nameInput = form.querySelector('#inventoryIngredientName');
    const unitTypeSelect = form.querySelector('#inventoryUnitType');
    const quantityInput = form.querySelector('#inventoryQuantity');
    const unitSelect = form.querySelector('#inventoryUnit');

    const ingredientName = (nameInput?.value || '').trim();
    const selectedUnitType = unitTypeSelect?.value || 'weight';
    const quantityValue = parseFloat(quantityInput?.value || '0');
    const selectedUnit = unitSelect?.value || 'g';

    if (!ingredientName) {
        showNotification('Please enter an ingredient name.', 'error');
        return;
    }

    if (!quantityValue || quantityValue <= 0) {
        showNotification('Quantity must be greater than zero.', 'error');
        return;
    }

    const existingIngredient = findIngredientInStateByName(ingredientName);
    if (!existingIngredient) {
        showNotification(`${formatIngredientLabel(ingredientName)} is not registered. Please select an ingredient from the list.`, 'error');
        return;
    }

    const normalizedUnitType = existingIngredient.unitType;
    const baseAmount = convertToBaseUnits(quantityValue, normalizedUnitType, selectedUnit);

    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }

        inventoryState = await InventoryStore.restock({
            name: existingIngredient.name,
            amount: baseAmount
        });
        renderInventoryState();
        form.reset();
        if (unitTypeSelect) {
            unitTypeSelect.disabled = false;
            unitTypeSelect.value = 'weight';
            updateUnitOptions('weight');
        }
        showNotification(`${existingIngredient.name} updated successfully!`, 'success');
    } catch (error) {
        console.error('Inventory restock failed:', error);
        showNotification(error.message || 'Unable to update inventory.', 'error');
    }
}

function syncIngredientUnitType(ingredientInput, unitTypeSelect) {
    if (!ingredientInput || !unitTypeSelect) return;
    const existingIngredient = findIngredientInStateByName(ingredientInput.value);
    if (existingIngredient) {
        unitTypeSelect.value = existingIngredient.unitType;
        unitTypeSelect.disabled = true;
    } else {
        unitTypeSelect.disabled = false;
    }
    updateUnitOptions(unitTypeSelect.value);
}

function updateUnitOptions(unitType, unitSelectOverride, quantityInputOverride) {
    const unitSelect = unitSelectOverride || document.getElementById('inventoryUnit');
    const quantityInput = quantityInputOverride || document.getElementById('inventoryQuantity');
    if (!unitSelect || !quantityInput) return;

    if (unitType === 'count') {
        unitSelect.innerHTML = '<option value="pcs">Pieces</option>';
        quantityInput.step = '1';
        quantityInput.placeholder = '0';
    } else {
        unitSelect.innerHTML = `
            <option value="g">Grams (g)</option>
            <option value="kg">Kilograms (kg)</option>
        `;
        quantityInput.step = '0.01';
        quantityInput.placeholder = '0.00';
    }
}

function renderInventoryState() {
    renderInventoryTable(inventoryState);
    renderInventoryMetrics(inventoryState);
    updateInventoryDatalist(inventoryState);
    updateInventoryLastUpdated(inventoryState);
    updateMenuIngredientsOptions(inventoryState);
    renderMenuState();
}

function renderInventoryTable(items) {
    const tableBody = document.getElementById('inventoryTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '';

    if (!items.length) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="5" class="empty-table">Inventory data will appear after you add stock.</td>';
        tableBody.appendChild(emptyRow);
        return;
    }

    const sortedItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
    sortedItems.forEach(item => {
        const row = document.createElement('tr');
        const status = getStockStatus(item);
        row.innerHTML = `
            <td>${item.name}</td>
            <td>${formatInventoryQuantity(item)}</td>
            <td>${item.unitType === 'weight' ? 'Weight (grams)' : 'Pieces'}</td>
            <td><span class="status ${status.className}">${status.label}</span></td>
            <td>${formatDateLabel(item.updatedAt || item.createdAt)}</td>
        `;
        tableBody.appendChild(row);
    });
}

function renderInventoryMetrics(items) {
    const totalIngredientsEl = document.getElementById('totalIngredientsMetric');
    const lowStockEl = document.getElementById('lowStockMetric');
    const weightMetricEl = document.getElementById('weightMetric');
    const packagingMetricEl = document.getElementById('packagingMetric');

    const totalItems = items.length;
    const lowStockItems = items.filter(item => getStockStatus(item).level !== 'healthy').length;
    const totalWeight = items
        .filter(item => item.unitType === 'weight')
        .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const totalPackaging = items
        .filter(item => item.unitType === 'count')
        .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

    if (totalIngredientsEl) totalIngredientsEl.textContent = totalItems.toString();
    if (lowStockEl) lowStockEl.textContent = lowStockItems.toString();
    if (weightMetricEl) weightMetricEl.textContent = formatQuantityValue(totalWeight / 1000, 2);
    if (packagingMetricEl) packagingMetricEl.textContent = formatQuantityValue(totalPackaging, 0);
}

function updateInventoryDatalist(items) {
    const datalist = document.getElementById('inventoryIngredientsList');
    if (!datalist) return;

    datalist.innerHTML = '';
    const sortedItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
    sortedItems.forEach(item => {
        const option = document.createElement('option');
        option.value = item.name;
        datalist.appendChild(option);
    });
}

function updateInventoryLastUpdated(items) {
    const label = document.getElementById('inventoryLastUpdated');
    if (!label) return;

    const timestamps = items
        .map(item => item.updatedAt || item.createdAt)
        .filter(Boolean)
        .map(value => {
            if (value instanceof Date) {
                return value.getTime();
            }
            const dateValue = value && typeof value.toDate === 'function' ? value.toDate() : new Date(value);
            return dateValue.getTime();
        })
        .filter(time => !Number.isNaN(time));

    if (!timestamps.length) {
        label.textContent = 'Not updated yet';
        return;
    }

    const latest = new Date(Math.max(...timestamps));
    label.textContent = `Updated ${formatDateLabel(latest)}`;
}

async function refreshMenuState() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    menuState = await MenuStore.getItems();
    renderMenuState();
    return menuState;
}

function renderMenuState() {
    renderMenuItemsTable(menuState);
    renderSalesMenuAlerts();
}

function renderMenuItemsTable(items) {
    const tableBody = document.getElementById('menuTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '';

    if (!items.length) {
        tableBody.innerHTML = '<tr><td colspan="8" class="empty-table">Menu items will appear after you add dishes.</td></tr>';
        return;
    }

    const sortedItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
    sortedItems.forEach(item => {
        const row = document.createElement('tr');
        const status = getMenuItemStatus(item);
        const menuToggleId = `itemMenu${item.id}`;
        const imageContent = item.imageDataUrl
            ? `<img src="${item.imageDataUrl}" alt="${item.name}">`
            : `<span class="image-placeholder">${item.name.charAt(0).toUpperCase()}</span>`;

        row.innerHTML = `
            <td><input type="checkbox" data-menu-id="${item.id}"></td>
            <td>${item.name}</td>
            <td><div class="food-thumbnail">${imageContent}</div></td>
            <td>${item.menuId || item.id}</td>
            <td>${item.category}</td>
            <td>${Number(item.price || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td><span class="status ${status.className}">${status.label}</span></td>
            <td class="actions">
                <button class="action-btn more" onclick="toggleItemMenu('${item.id}')">
                    <i class="fas fa-ellipsis-h"></i>
                </button>
                <div class="item-menu" id="${menuToggleId}">
                    <a href="#" class="menu-item"><i class="fas fa-eye"></i> View</a>
                    <a href="#" class="menu-item"><i class="fas fa-edit"></i> Edit</a>
                    <a href="#" class="menu-item"><i class="fas fa-trash"></i> Delete</a>
                    <a href="#" class="menu-item"><i class="fas fa-toggle-on"></i> Deactivate</a>
                </div>
            </td>
        `;

        tableBody.appendChild(row);
    });
}

function getMenuItemStatus(menuItem) {
    if (!menuItem || !Array.isArray(menuItem.ingredients) || !menuItem.ingredients.length) {
        return { label: 'No Ingredients', className: 'no-stock' };
    }
    const missingIngredients = getMissingIngredientsForDish(menuItem);
    if (missingIngredients.length) {
        return { label: 'Missing Ingredient', className: 'no-stock' };
    }
    const depleted = menuItem.ingredients.some(ingredient => {
        const inventoryItem = inventoryState.find(item => item.id === ingredient.ingredientId);
        return inventoryItem && inventoryItem.quantity <= 0;
    });
    if (depleted) {
        return { label: 'Restock Needed', className: 'low-stock' };
    }
    return { label: 'Active', className: 'active' };
}

function getMissingIngredientsForDish(menuItem) {
    if (!menuItem || !Array.isArray(menuItem.ingredients)) {
        return [];
    }
    return menuItem.ingredients
        .filter(ingredient => !inventoryState.some(item => item.id === ingredient.ingredientId))
        .map(ingredient => ingredient.ingredientName || ingredient.ingredientId);
}

function updateMenuIngredientsOptions(items) {
    const datalist = document.getElementById('menuIngredientsOptions');
    if (!datalist) return;

    datalist.innerHTML = '';
    const sortedItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
    sortedItems.forEach(item => {
        const option = document.createElement('option');
        option.value = item.name;
        datalist.appendChild(option);
    });
}

function ensureDishIngredientBuilderInitialized() {
    const container = document.getElementById('dishIngredientsList');
    if (!container) return;

    container.innerHTML = '';
    addDishIngredientRow();

    const addRowBtn = document.getElementById('addIngredientRowBtn');
    if (addRowBtn && !addRowBtn.dataset.bound) {
        addRowBtn.addEventListener('click', () => addDishIngredientRow());
        addRowBtn.dataset.bound = 'true';
    }
}

function addDishIngredientRow(prefill = {}) {
    const container = document.getElementById('dishIngredientsList');
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'dish-ingredient-row';
    row.innerHTML = `
        <div class="dish-ingredient-field">
            <label>Ingredient</label>
            <input type="text" class="form-control dish-ingredient-name" list="menuIngredientsOptions" placeholder="e.g., Chicken">
        </div>
        <div class="dish-ingredient-field">
            <label>Amount</label>
            <input type="number" class="form-control dish-ingredient-amount" min="0" step="0.01" placeholder="0.00">
        </div>
        <div class="dish-ingredient-field">
            <label>Unit</label>
            <select class="form-control dish-ingredient-unit" disabled>
                <option value="">Select ingredient first</option>
            </select>
        </div>
        <button type="button" class="remove-ingredient-row" title="Remove ingredient">&times;</button>
    `;

    const nameInput = row.querySelector('.dish-ingredient-name');
    const amountInput = row.querySelector('.dish-ingredient-amount');
    const unitSelect = row.querySelector('.dish-ingredient-unit');
    const removeBtn = row.querySelector('.remove-ingredient-row');

    if (prefill.name) {
        nameInput.value = prefill.name;
        handleIngredientSelection(row, prefill.name);
    }

    if (prefill.amount) {
        amountInput.value = prefill.amount;
    }

    if (prefill.unit && unitSelect) {
        unitSelect.value = prefill.unit;
    }

    nameInput.addEventListener('change', () => handleIngredientSelection(row, nameInput.value));
    removeBtn.addEventListener('click', () => removeDishIngredientRow(row));

    container.appendChild(row);
}

function removeDishIngredientRow(row) {
    const container = document.getElementById('dishIngredientsList');
    if (!container) return;
    if (container.children.length <= 1) {
        row.querySelector('.dish-ingredient-name').value = '';
        row.querySelector('.dish-ingredient-amount').value = '';
        row.dataset.ingredientId = '';
        const unitSelect = row.querySelector('.dish-ingredient-unit');
        if (unitSelect) {
            unitSelect.innerHTML = '<option value="">Select ingredient first</option>';
            unitSelect.value = '';
            unitSelect.disabled = true;
        }
        return;
    }
    row.remove();
}

function handleIngredientSelection(row, ingredientName) {
    const ingredient = findIngredientInStateByName(ingredientName);
    const amountInput = row.querySelector('.dish-ingredient-amount');
    const unitSelect = row.querySelector('.dish-ingredient-unit');

    if (ingredient) {
        row.dataset.ingredientId = ingredient.id;
        if (unitSelect) {
            if (ingredient.unitType === 'count') {
                unitSelect.innerHTML = '<option value="pcs">Pieces (pcs)</option>';
                unitSelect.value = 'pcs';
            } else {
                unitSelect.innerHTML = `
                    <option value="g">Grams (g)</option>
                    <option value="kg">Kilograms (kg)</option>
                `;
                unitSelect.value = 'g';
            }
            unitSelect.disabled = false;
        }
        if (amountInput) {
            amountInput.step = ingredient.unitType === 'count' ? '1' : '0.01';
            amountInput.placeholder = ingredient.unitType === 'count' ? '0' : '0.00';
        }
    } else {
        row.dataset.ingredientId = '';
        if (unitSelect) {
            unitSelect.innerHTML = '<option value="">Select ingredient first</option>';
            unitSelect.value = '';
            unitSelect.disabled = true;
        }
    }
}

function gatherDishIngredients() {
    const container = document.getElementById('dishIngredientsList');
    if (!container) return [];

    const rows = Array.from(container.querySelectorAll('.dish-ingredient-row'));
    const collected = [];

    rows.forEach(row => {
        const nameInput = row.querySelector('.dish-ingredient-name');
        const amountInput = row.querySelector('.dish-ingredient-amount');
        const unitSelect = row.querySelector('.dish-ingredient-unit');
        const ingredientName = (nameInput?.value || '').trim();
        const amountValue = parseFloat(amountInput?.value || '0');

        if (!ingredientName && !amountValue) {
            return;
        }

        const ingredient = findIngredientInStateByName(ingredientName);
        if (!ingredient) {
            throw new Error(`Ingredient "${ingredientName || 'Unnamed'}" must match a registered inventory item.`);
        }

        if (!amountValue || amountValue <= 0) {
            throw new Error(`Amount for ${ingredient.name} must be greater than zero.`);
        }

        const unit = unitSelect?.value || (ingredient.unitType === 'count' ? 'pcs' : 'g');
        const baseAmount = convertToBaseUnits(amountValue, ingredient.unitType, unit);
        collected.push({
            ingredient,
            baseAmount,
            displayAmount: ingredient.unitType === 'count'
                ? `${formatQuantityValue(amountValue, 0)} pcs`
                : `${formatQuantityValue(amountValue, unit === 'kg' ? 2 : 0)} ${unit}`
        });
    });

    return collected;
}

async function handleMenuFormSubmit(event) {
    if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
    }

    const form = document.getElementById('menuItemForm');
    if (!form) return;

    const category = form.querySelector('#category')?.value || 'Rice Meal';
    const foodId = (form.querySelector('#foodId')?.value || '').trim();
    const foodName = (form.querySelector('#foodName')?.value || '').trim();
    const priceValue = parseFloat(form.querySelector('#price')?.value || '0');
    const description = (form.querySelector('#description')?.value || '').trim();

    if (!foodName) {
        showNotification('Please enter a food name.', 'error');
        return;
    }

    if (!priceValue || priceValue <= 0) {
        showNotification('Please enter a price greater than zero.', 'error');
        return;
    }

    let selectedIngredients;
    try {
        selectedIngredients = gatherDishIngredients();
    } catch (ingredientError) {
        showNotification(ingredientError.message, 'error');
        return;
    }

    if (!selectedIngredients.length) {
        showNotification('Add at least one ingredient from the inventory.', 'error');
        return;
    }

    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }

        if (!inventoryState.length) {
            await refreshInventoryState();
        }

        const slugSource = foodId || foodName;
        const slugify = MenuStore.slugifyName || InventoryStore.slugifyName;
        const slug = slugify(slugSource);
        const formattedName = formatIngredientLabel(foodName);

        const menuPayload = {
            slug,
            data: {
                menuId: foodId || slug.toUpperCase(),
                name: formattedName,
                category,
                price: +Number(priceValue).toFixed(2),
                description,
                imageDataUrl: uploadedFoodImageDataUrl,
                ingredients: selectedIngredients.map(entry => ({
                    ingredientId: entry.ingredient.id,
                    ingredientName: entry.ingredient.name,
                    unitType: entry.ingredient.unitType,
                    baseAmountPerDish: entry.baseAmount,
                    displayAmount: entry.displayAmount
                }))
            }
        };

        menuState = await MenuStore.createItem(menuPayload);
        renderMenuState();
        showNotification(`${formattedName} added to the menu!`, 'success');
        resetMenuForm();
        hideAddFood();
    } catch (error) {
        console.error('Add menu item failed:', error);
        showNotification(error.message || 'Unable to add menu item.', 'error');
    }
}

function resetMenuForm() {
    const form = document.getElementById('menuItemForm');
    if (form) {
        form.reset();
    }
    uploadedFoodImageDataUrl = null;
    removeImage();
    ensureDishIngredientBuilderInitialized();
}

async function initMenuManagement() {
    const menuForm = document.getElementById('menuItemForm');
    if (!menuForm) return;

    try {
        await waitForFirebaseReady();
        if (!inventoryState.length) {
            await refreshInventoryState();
        } else {
            updateMenuIngredientsOptions(inventoryState);
        }
        await refreshMenuState();
    } catch (error) {
        console.error('Unable to initialize menu management:', error);
        showNotification(error.message || 'Menu data could not be loaded.', 'error');
    }

    ensureDishIngredientBuilderInitialized();

    if (!menuForm.dataset.bound) {
        menuForm.addEventListener('submit', handleMenuFormSubmit);
        menuForm.dataset.bound = 'true';
    }
}

async function initSalesPage() {
    const alertsContainer = document.getElementById('salesInventoryAlerts');
    if (!alertsContainer) return;

    try {
        await waitForFirebaseReady();
        if (!inventoryState.length) {
            await refreshInventoryState();
        }
        await refreshMenuState();
        renderSalesMenuAlerts();
    } catch (error) {
        console.error('Unable to initialize sales overview:', error);
    }
}

function renderSalesMenuAlerts() {
    const container = document.getElementById('salesInventoryAlerts');
    if (!container) return;

    container.innerHTML = '';

    const alerts = [];

    if (!menuState.length) {
        alerts.push({
            type: 'info',
            message: 'No menu dishes are registered yet. Add dishes in the Menu tab to keep sales reporting accurate.'
        });
    } else {
        menuState.forEach(menuItem => {
            const missing = getMissingIngredientsForDish(menuItem);
            if (missing.length) {
                alerts.push({
                    type: 'warning',
                    message: `${menuItem.name} is missing inventory links for: ${missing.join(', ')}. Register the ingredients to keep stock tracking in sync.`
                });
            }
        });
    }

    if (!alerts.length) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';
    alerts.forEach(alert => {
        const alertEl = document.createElement('div');
        alertEl.className = `sales-alert ${alert.type === 'info' ? 'sales-alert-info' : 'sales-alert-warning'}`;
        alertEl.innerHTML = `
            <i class="fas fa-exclamation-circle"></i>
            <span>${alert.message}</span>
        `;
        container.appendChild(alertEl);
    });
}

function convertToBaseUnits(quantity, unitType, unit) {
    const value = Number(quantity) || 0;
    if (unitType === 'count') {
        return value;
    }
    return unit === 'kg' ? value * 1000 : value;
}

function formatInventoryQuantity(item, plainText = false) {
    if (!item) return '0';
    if (item.unitType === 'weight') {
        const grams = Number(item.quantity) || 0;
        if (grams >= 1000) {
            const kilos = grams / 1000;
            const display = `${formatQuantityValue(kilos, 2)} kg (${formatQuantityValue(grams, 0)} g)`;
            return plainText ? display : display;
        }
        const display = `${formatQuantityValue(grams, 0)} g`;
        return plainText ? display : display;
    }
    const pieces = `${formatQuantityValue(item.quantity, 0)} pcs`;
    return plainText ? pieces : pieces;
}

function formatQuantityValue(value, decimals = 2) {
    return Number(value || 0).toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

function formatDateLabel(value) {
    if (!value) return '—';
    let date;
    if (value instanceof Date) {
        date = value;
    } else if (value && typeof value.toDate === 'function') {
        date = value.toDate();
    } else {
        date = new Date(value);
    }
    if (Number.isNaN(date.getTime())) {
        return '—';
    }

    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const timePart = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (isToday) {
        return `Today, ${timePart}`;
    }

    return date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function normalizeOrderTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) {
        return value;
    }
    if (typeof value.toDate === 'function') {
        try {
            return value.toDate();
        } catch (error) {
            console.warn('Unable to convert Firestore timestamp:', error);
        }
    }
    if (typeof value === 'number') {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value === 'string') {
        const direct = new Date(value);
        if (!Number.isNaN(direct.getTime())) {
            return direct;
        }
        const iso = new Date(`${value}T00:00:00`);
        return Number.isNaN(iso.getTime()) ? null : iso;
    }
    return null;
}

function formatCurrency(value) {
    const amount = Number(value) || 0;
    return `PHP ${amount.toLocaleString('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

function formatOrderStatusBadge(status) {
    const normalized = (status || 'pending').toString().toLowerCase().trim();
    let className = 'process';
    let label = 'Pending';
    
    if (['completed', 'delivered'].includes(normalized)) {
        className = 'delivered';
        label = 'Delivered';
    } else if (['cancelled', 'canceled', 'failed'].includes(normalized)) {
        className = 'cancelled';
        label = 'Cancelled';
    } else if (normalized === 'preparing' || ['being-cooked', 'being_cooked', 'cooking', 'being cooked'].includes(normalized)) {
        className = 'process';
        label = 'Preparing';
    } else if (normalized === 'ready for delivery' || normalized === 'ready_for_delivery' || 
               normalized === 'for delivery' || normalized === 'for_delivery') {
        className = 'process';
        label = 'Ready for Delivery';
    } else if (normalized === 'ready for pick-up' || normalized === 'ready_for_pickup' || normalized === 'ready for pickup') {
        className = 'process';
        label = 'Ready for Pick-up';
    } else if (normalized === 'ready') {
        className = 'process';
        label = 'Ready';
    } else if (normalized === 'out for delivery' || normalized === 'out_for_delivery' || normalized === 'out-for-delivery' || 
               normalized === 'in-transit' || normalized === 'in_transit') {
        className = 'process';
        label = 'Out for Delivery';
    } else if (normalized === 'pending' || normalized === 'new') {
        className = 'pending';
        label = 'Pending';
    } else {
        // Format other statuses nicely
        label = normalized
        ? normalized.replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
        : 'Pending';
    }
    
    return `<span class="status ${className}">${label}</span>`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getStockStatus(item) {
    const reorderLevel = Number(item.reorderLevel) || (item.unitType === 'count' ? 100 : 2000);
    if (item.quantity <= 0) {
        return { label: 'Out of Stock', className: 'low-stock', level: 'critical' };
    }
    if (item.quantity <= reorderLevel) {
        return { label: 'Low Stock', className: 'low-stock', level: 'low' };
    }
    return { label: 'In Stock', className: 'high-stock', level: 'healthy' };
}

function findIngredientInStateByName(name) {
    if (!name) return null;
    const slug = InventoryStore.slugifyName ? InventoryStore.slugifyName(name) : name.toLowerCase();
    return inventoryState.find(item => item.id === slug) || null;
}

function formatIngredientLabel(value) {
    return value
        .toString()
        .trim()
        .replace(/(^|\s|-)\S/g, letter => letter.toUpperCase());
}

async function handleIngredientRegisterSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const nameInput = form.querySelector('#registerIngredientName');
    const unitTypeSelect = form.querySelector('#registerUnitType');
    const quantityInput = form.querySelector('#registerQuantity');
    const unitSelect = form.querySelector('#registerUnit');
    const reorderInput = form.querySelector('#registerReorderLevel');

    const ingredientName = (nameInput?.value || '').trim();
    const selectedUnitType = unitTypeSelect?.value || 'weight';
    const quantityValue = parseFloat(quantityInput?.value || '0');
    const selectedUnit = unitSelect?.value || (selectedUnitType === 'count' ? 'pcs' : 'g');
    const reorderLevel = reorderInput && reorderInput.value !== '' ? Number(reorderInput.value) : undefined;

    if (!ingredientName) {
        showNotification('Please enter an ingredient name to register.', 'error');
        return;
    }

    if (quantityValue < 0) {
        showNotification('Initial quantity cannot be negative.', 'error');
        return;
    }

    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }

        const baseAmount = convertToBaseUnits(quantityValue, selectedUnitType, selectedUnit);
        inventoryState = await InventoryStore.registerIngredient({
            name: ingredientName,
            unitType: selectedUnitType,
            amount: baseAmount,
            reorderLevel
        });
        renderInventoryState();
        form.reset();
        if (unitTypeSelect) {
            unitTypeSelect.value = 'weight';
        }
        updateUnitOptions('weight', unitSelect, quantityInput);
        showNotification(`${formatIngredientLabel(ingredientName)} registered successfully!`, 'success');
    } catch (error) {
        console.error('Register ingredient failed:', error);
        showNotification(error.message || 'Unable to register ingredient.', 'error');
    }
}

// Customer management functions
function selectCustomer(customerId) {
    // Remove selected class from all customer items
    document.querySelectorAll('.customer-item').forEach(item => {
        item.classList.remove('selected');
    });
    
    // Add selected class to clicked customer
    event.target.closest('.customer-item').classList.add('selected');
    
    alert(`Selected customer ${customerId}`);
}

function switchTab(tabName) {
    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Add active class to clicked tab
    event.target.classList.add('active');
    
    // Show/hide tab content
    const reviewsTab = document.getElementById('reviewsTab');
    const rewardsTab = document.getElementById('rewardsTab');
    
    if (tabName === 'reviews') {
        if (reviewsTab) reviewsTab.style.display = 'block';
        if (rewardsTab) rewardsTab.style.display = 'none';
    } else if (tabName === 'rewards') {
        if (reviewsTab) reviewsTab.style.display = 'none';
        if (rewardsTab) rewardsTab.style.display = 'block';
    }
}

function toggleReviewOptions(reviewId) {
    alert(`Review options for review ${reviewId}`);
}

// Menu management functions
function addFood() {
    alert('Add Food - This would open a form to add new food items');
}

function toggleItemMenu(itemId) {
    // Close any other open item menus
    document.querySelectorAll('.item-menu').forEach(menu => {
        if (menu.id !== `itemMenu${itemId}`) {
            menu.classList.remove('show');
        }
    });
    
    // Toggle the clicked item menu
    const menu = document.getElementById(`itemMenu${itemId}`);
    if (menu) {
        menu.classList.toggle('show');
    }
}

// Admin profile functions
function addUser() {
    alert('Add User - This would open a form to add new admin users');
}

// Activity logs functions
function toggleReviewOptions(reviewId) {
    alert(`Review options for review ${reviewId}`);
}

// Initialize page-specific functionality
document.addEventListener('DOMContentLoaded', function() {
    // Set active navigation item based on current page
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const navItems = document.querySelectorAll('.nav-item');
    
    navItems.forEach(item => {
        const link = item.querySelector('a');
        if (link && link.getAttribute('href') === currentPage) {
            item.classList.add('active');
        }
    });
    
    const ordersTableBody = document.getElementById('ordersTableBody');
    if (ordersTableBody) {
        initOrdersDashboard();
        console.log('Orders dashboard loaded');
        
        // Backfill for_delivery documents for existing orders with drivers (after orders load)
        setTimeout(() => {
            backfillForDeliveryDocuments();
        }, 5000); // Wait 5 seconds for orders to load
    }

    // Initialize any remaining page-specific functionality
    if (currentPage === 'customer.html') {
        // Initialize customer management specific functionality
        console.log('Customer management page loaded');
    } else if (currentPage === 'sales.html') {
        // Initialize sales report specific functionality
        initInventoryManagement();
        initSalesPage();
        console.log('Sales report page loaded');
    } else if (currentPage === 'menu.html') {
        // Initialize menu management specific functionality
        initMenuManagement();
        console.log('Menu management page loaded');
    } else if (currentPage === 'drivers.html') {
        // Initialize drivers page
        initDriversDashboard();
        console.log('Drivers page loaded');
    } else if (currentPage === 'adminindex.html' || window.location.pathname.includes('adminindex.html')) {
        // Backfill for_delivery documents for existing orders with drivers
        setTimeout(() => {
            backfillForDeliveryDocuments();
        }, 5000); // Wait 5 seconds for orders to load
    }
    
    // Set up periodic check to update order "new" status (every minute)
    setInterval(() => {
        if (ordersState && ordersState.length > 0) {
            let needsUpdate = false;
            ordersState.forEach(order => {
                if (order.createdAt && order.createdAt instanceof Date) {
                    const now = new Date();
                    const timeDiff = now.getTime() - order.createdAt.getTime();
                    const minutesDiff = timeDiff / (1000 * 60);
                    const wasNew = order.isNew;
                    order.isNew = minutesDiff < 8 && (order.status === 'pending' || order.status === 'new');
                    if (wasNew !== order.isNew) {
                        needsUpdate = true;
                    }
                }
            });
            if (needsUpdate) {
                renderOrdersTable(ordersState);
                // Update driver statuses if orders changed
                if (driversState.length > 0) {
                    driversState.forEach(driver => {
                        // Recalculate driver status based on current orders
                        let driverStatus = 'available';
                        if (ordersState && ordersState.length > 0) {
                            const hasActiveDelivery = ordersState.some(order => {
                                const orderDriverId = order.driverId || '';
                                const orderStatus = (order.status || '').toLowerCase().trim();
                                return (orderDriverId === driver.driverId || orderDriverId === driver.id) &&
                                       (orderStatus === 'preparing' ||
                                        orderStatus === 'being-cooked' || orderStatus === 'being_cooked' || orderStatus === 'being cooked' ||
                                        orderStatus === 'cooking' || 
                                        orderStatus === 'ready for delivery' || orderStatus === 'ready_for_delivery' ||
                                        orderStatus === 'for delivery' || orderStatus === 'for_delivery' ||
                                        orderStatus === 'ready' || 
                                        orderStatus === 'accepted' || 
                                        orderStatus === 'out_for_delivery' || orderStatus === 'out-for-delivery' ||
                                        orderStatus === 'in-transit' || orderStatus === 'in_transit' || 
                                        orderStatus === 'on-the-way' || orderStatus === 'on_the_way');
                            });
                            if (hasActiveDelivery) {
                                driverStatus = 'busy';
                            }
                        }
                        driver.availability = driverStatus;
                        driver.status = driverStatus;
                    });
                    renderDriversList();
                }
            }
        }
    }, 60000); // Check every minute
});

// Utility functions
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    // Style the notification
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#d4edda' : type === 'error' ? '#f8d7da' : '#d1ecf1'};
        color: ${type === 'success' ? '#155724' : type === 'error' ? '#721c24' : '#0c5460'};
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 10000;
        max-width: 300px;
        word-wrap: break-word;
    `;
    
    // Add to page
    document.body.appendChild(notification);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// Form validation helper
function validateForm(formData) {
    const errors = [];
    
    // Example validation rules
    if (!formData.name || formData.name.trim() === '') {
        errors.push('Name is required');
    }
    
    if (!formData.email || !isValidEmail(formData.email)) {
        errors.push('Valid email is required');
    }
    
    return errors;
}

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// Search functionality
function performSearch(searchTerm) {
    console.log(`Searching for: ${searchTerm}`);
    // In a real application, this would make an API call to search for data
    showNotification(`Searching for "${searchTerm}"...`, 'info');
}

// Filter functionality
function applyFilter(filterType, filterValue) {
    console.log(`Applying filter: ${filterType} = ${filterValue}`);
    // In a real application, this would filter the displayed data
    showNotification(`Filter applied: ${filterType} = ${filterValue}`, 'info');
}

// Export all functions to global scope for HTML onclick handlers
window.toggleDropdown = toggleDropdown;
window.acceptOrder = acceptOrder;
window.viewOrderDetails = viewOrderDetails;
window.closeOrderDetailsModal = closeOrderDetailsModal;
window.verifyPayment = verifyPayment;
window.closePaymentReceiptModal = closePaymentReceiptModal;
window.verifyPaymentConfirm = verifyPaymentConfirm;
// Backfill function to create for_delivery documents for existing orders with drivers
async function backfillForDeliveryDocuments() {
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            return;
        }
        
        // Get all orders that have a driver assigned and are out for delivery
        const ordersWithDrivers = ordersState.filter(order => {
            const hasDriver = order.driverId && order.driverId.trim() !== '';
            const isOutForDelivery = order.status === 'out_for_delivery' || 
                                    order.status === 'out-for-delivery' || 
                                    order.status === 'in-transit' ||
                                    order.status === 'in_transit' ||
                                    order.status === 'delivered';
            return hasDriver && isOutForDelivery;
        });
        
        if (ordersWithDrivers.length === 0) {
            return;
        }
        
        console.log(`Found ${ordersWithDrivers.length} orders with drivers that may need for_delivery documents`);
        
        let createdCount = 0;
        let updatedCount = 0;
        
        for (const order of ordersWithDrivers) {
            try {
                const deliveryRef = fns.doc(window.db, 'for_delivery', order.id);
                const existingDoc = await fns.getDoc(deliveryRef);
                
                if (!existingDoc.exists()) {
                    // Get the assignedAt time from the order if available
                    const assignedAt = order.assignedAt || order.createdAt || fns.serverTimestamp();
                    
                    await fns.setDoc(deliveryRef, {
                        deliveryId: order.id,
                        orderId: order.id,
                        driverId: order.driverId,
                        timeAssigned: assignedAt,
                        timeDelivered: order.status === 'delivered' ? (order.deliveredAt || fns.serverTimestamp()) : null,
                        createdAt: order.createdAt || fns.serverTimestamp(),
                        updatedAt: fns.serverTimestamp()
                    });
                    createdCount++;
                    console.log(`Created for_delivery document for order ${order.trackingId || order.id}`);
                } else {
                    // Update if driver changed or timeDelivered is missing
                    const existingData = existingDoc.data();
                    const needsUpdate = existingData.driverId !== order.driverId || 
                                       (order.status === 'delivered' && !existingData.timeDelivered);
                    
                    if (needsUpdate) {
                        const updateData = {
                            updatedAt: fns.serverTimestamp()
                        };
                        
                        if (existingData.driverId !== order.driverId) {
                            updateData.driverId = order.driverId;
                        }
                        
                        if (order.status === 'delivered' && !existingData.timeDelivered) {
                            updateData.timeDelivered = order.deliveredAt || fns.serverTimestamp();
                        }
                        
                        await fns.updateDoc(deliveryRef, updateData);
                        updatedCount++;
                        console.log(`Updated for_delivery document for order ${order.trackingId || order.id}`);
                    }
                }
            } catch (error) {
                console.error(`Error processing order ${order.id}:`, error);
            }
        }
        
        if (createdCount > 0 || updatedCount > 0) {
            console.log(`Backfill complete: Created ${createdCount} documents, Updated ${updatedCount} documents`);
        }
    } catch (error) {
        console.error('Error in backfillForDeliveryDocuments:', error);
    }
}

window.updateOrderStatus = updateOrderStatus;
window.applyOrderStatusFilter = applyOrderStatusFilter;
window.filterOrders = filterOrders;
window.markOutForDelivery = markOutForDelivery;
window.backfillForDeliveryDocuments = backfillForDeliveryDocuments;
window.editDriver = editDriver;
window.deleteDriver = deleteDriver;
window.printDriver = printDriver;
window.editItem = editItem;
window.deleteItem = deleteItem;
window.switchReport = switchReport;
window.switchTime = switchTime;
window.changePage = changePage;
window.exportReport = exportReport;
window.exportInventoryReport = exportInventoryReport;
window.selectCustomer = selectCustomer;
window.switchTab = switchTab;
window.toggleReviewOptions = toggleReviewOptions;
window.addFood = addFood;
window.toggleItemMenu = toggleItemMenu;
window.addUser = addUser;

// Add Food Dashboard Functions
function showAddFood() {
    resetMenuForm();
    const formPanel = document.getElementById('addFoodDashboard');
    const tablePanel = document.getElementById('foodSection');
    if (formPanel) formPanel.style.display = 'block';
    if (tablePanel) tablePanel.style.display = 'none';
}

function hideAddFood() {
    document.getElementById('addFoodDashboard').style.display = 'none';
    document.getElementById('foodSection').style.display = 'block';
}

// Helper function to create image gallery modal if it doesn't exist
function createImageGalleryModal() {
    // Check if modal already exists
    let modal = document.getElementById('imageGalleryModal');
    if (modal) return modal;
    
    // Create modal structure
    modal = document.createElement('div');
    modal.id = 'imageGalleryModal';
    modal.className = 'modal';
    modal.style.cssText = 'display: none; position: fixed; z-index: 10000; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0, 0, 0, 0.5);';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 900px; max-height: 80vh; background-color: #fefefe; margin: 5% auto; padding: 0; border: none; border-radius: 10px; width: 90%; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);">
            <div class="modal-header" style="padding: 20px 30px; background-color: #f8f9fa; border-bottom: 1px solid #e9ecef; border-radius: 10px 10px 0 0; display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; color: #495057; font-size: 24px;">Select Food Image</h3>
                <button class="modal-close" onclick="closeImageGallery()" style="background:none; border:none; font-size:1.5em; cursor:pointer; color:#777; padding: 0; line-height: 1;">&times;</button>
            </div>
            <div class="modal-body" style="padding: 30px; max-height: 60vh; overflow-y: auto;">
                <div id="imageGalleryLoading" style="text-align: center; padding: 40px;">
                    <i class="fas fa-spinner fa-spin" style="font-size: 2em; color: #dc3545;"></i>
                    <p>Loading images...</p>
                </div>
                <div id="imageGalleryGrid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; padding: 20px;">
                    <!-- Images will be loaded here -->
                </div>
                <div id="imageGalleryEmpty" style="display: none; text-align: center; padding: 40px; color: #666;">
                    <i class="fas fa-image" style="font-size: 3em; margin-bottom: 16px; opacity: 0.3;"></i>
                    <p>No images found in menuImages folder.</p>
                </div>
            </div>
        </div>
    `;
    
    // Append to body
    document.body.appendChild(modal);
    
    // Set up click outside to close
    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            closeImageGallery();
        }
    });
    
    return modal;
}

// Image Gallery Functions
async function openImageGallery(event) {
    // Prevent any default behavior
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    console.log('openImageGallery called'); // Debug log
    
    // Wait for DOM to be ready if needed
    if (document.readyState === 'loading') {
        await new Promise(resolve => {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', resolve);
            } else {
                resolve();
            }
        });
    }
    
    // Try to find modal - wait a bit if not found immediately
    let modal = document.getElementById('imageGalleryModal');
    if (!modal) {
        // Wait a bit for DOM to be fully parsed
        await new Promise(resolve => setTimeout(resolve, 100));
        modal = document.getElementById('imageGalleryModal');
    }
    
    const loadingEl = document.getElementById('imageGalleryLoading');
    const gridEl = document.getElementById('imageGalleryGrid');
    const emptyEl = document.getElementById('imageGalleryEmpty');
    
    if (!modal) {
        // Try to create the modal dynamically if it doesn't exist
        console.warn('Image gallery modal not found, creating it dynamically...');
        modal = createImageGalleryModal();
    }
    
    if (!modal) {
        console.error('Failed to create image gallery modal. DOM state:', {
            body: document.body,
            readyState: document.readyState,
            allModals: document.querySelectorAll('.modal')
        });
        showNotification('Image gallery modal not found. Please refresh the page.', 'error');
        return;
    }
    
    // Make sure no file input is triggered
    const fileInput = document.getElementById('imageInput');
    if (fileInput) {
        fileInput.remove(); // Remove any leftover file input
    }
    
    modal.style.display = 'block';
    if (loadingEl) loadingEl.style.display = 'block';
    if (gridEl) {
        gridEl.style.display = 'none';
        gridEl.innerHTML = '';
    }
    if (emptyEl) emptyEl.style.display = 'none';
    
    try {
        if (!isStorageReady()) {
            await waitForFirebaseReady();
            
            if (!isStorageReady()) {
                throw new Error('Firebase Storage is not initialized. Please refresh the page.');
            }
        }
        
        const { ref, getDownloadURL, listAll } = window.storageFunctions;
        const storage = window.storage;
        
        // List all images in menuImages folder
        const menuImagesRef = ref(storage, 'menuImages');
        const result = await listAll(menuImagesRef);
        
        if (result.items.length === 0) {
            loadingEl.style.display = 'none';
            emptyEl.style.display = 'block';
            return;
        }
        
        // Get download URLs for all images
        const imagePromises = result.items.map(async (itemRef) => {
            try {
                const url = await getDownloadURL(itemRef);
                const name = itemRef.name;
                return { url, name };
            } catch (error) {
                console.error(`Error getting URL for ${itemRef.name}:`, error);
                return null;
            }
        });
        
        const images = (await Promise.all(imagePromises)).filter(Boolean);
        
        loadingEl.style.display = 'none';
        gridEl.style.display = 'grid';
        
        if (images.length === 0) {
            emptyEl.style.display = 'block';
            return;
        }
        
        // Display images in grid
        gridEl.innerHTML = images.map(img => `
            <div class="gallery-image-item" onclick="selectImageFromGallery('${img.url}', '${img.name}')" style="cursor: pointer; border: 2px solid #e0e0e0; border-radius: 8px; overflow: hidden; transition: all 0.3s ease;">
                <img src="${img.url}" alt="${img.name}" style="width: 100%; height: 150px; object-fit: cover; display: block;">
                <div style="padding: 8px; background: #f5f5f5; font-size: 0.85em; color: #666; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${img.name}</div>
            </div>
        `).join('');
        
    } catch (error) {
        console.error('Error loading images from Firebase Storage:', error);
        loadingEl.style.display = 'none';
        gridEl.innerHTML = `<div style="text-align: center; padding: 40px; color: #dc3545;">
            <i class="fas fa-exclamation-triangle" style="font-size: 2em; margin-bottom: 16px;"></i>
            <p>Error loading images: ${error.message}</p>
        </div>`;
        showNotification('Failed to load images from Firebase Storage.', 'error');
    }
}

function closeImageGallery() {
    const modal = document.getElementById('imageGalleryModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Close modal when clicking outside
document.addEventListener('DOMContentLoaded', function() {
    const modal = document.getElementById('imageGalleryModal');
    if (modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === modal) {
                closeImageGallery();
            }
        });
    }
});

function selectImageFromGallery(imageUrl, imageName) {
    uploadedFoodImageDataUrl = imageUrl;
    
            const imagePreview = document.getElementById('imagePreview');
    if (imagePreview) {
        imagePreview.innerHTML = `<img src="${imageUrl}" alt="${imageName}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px; cursor: pointer;" onclick="openImageGallery(event)">`;
        // Make sure the preview area is still clickable
        imagePreview.setAttribute('onclick', 'openImageGallery(event)');
        imagePreview.style.cursor = 'pointer';
        imagePreview.setAttribute('title', 'Click to change image');
    }
    
    closeImageGallery();
    showNotification(`Image "${imageName}" selected.`, 'success');
}

function removeImage() {
    const imagePreview = document.getElementById('imagePreview');
    if (imagePreview) {
        imagePreview.innerHTML = `
            <div class="upload-placeholder">
                <i class="fas fa-image"></i>
                <span>Click to Select Image</span>
            </div>
        `;
        // Ensure it's still clickable
        imagePreview.setAttribute('onclick', 'openImageGallery(event)');
        imagePreview.style.cursor = 'pointer';
        imagePreview.setAttribute('title', 'Click to select image');
    }
    uploadedFoodImageDataUrl = null;
}

function submitFood(event) {
    return handleMenuFormSubmit(event);
}

// Update the existing addFood function
function addFood() {
    showAddFood();
    
    // Remove any leftover file input elements
    const fileInput = document.getElementById('imageInput');
    if (fileInput) {
        fileInput.remove();
    }
    
    // Ensure image preview is set up correctly
    const imagePreview = document.getElementById('imagePreview');
    if (imagePreview) {
        imagePreview.setAttribute('onclick', 'openImageGallery(event)');
        imagePreview.style.cursor = 'pointer';
    }
}

window.showAddFood = showAddFood;
window.hideAddFood = hideAddFood;
window.openImageGallery = openImageGallery;
window.closeImageGallery = closeImageGallery;
window.selectImageFromGallery = selectImageFromGallery;
window.removeImage = removeImage;
window.submitFood = submitFood;

// User Profile Dashboard Functions
function showUserProfile() {
    document.getElementById('userProfileDashboard').style.display = 'block';
    // Hide other sections if they exist
    const adminProfiles = document.querySelector('.admin-profiles');
    if (adminProfiles) {
        adminProfiles.style.display = 'none';
    }
}

function hideUserProfile() {
    document.getElementById('userProfileDashboard').style.display = 'none';
    // Show other sections if they exist
    const adminProfiles = document.querySelector('.admin-profiles');
    if (adminProfiles) {
        adminProfiles.style.display = 'block';
    }
}

window.showUserProfile = showUserProfile;
window.hideUserProfile = hideUserProfile;

// Driver Dashboard Functions
function logIn() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
    });
    
    // Update the logged in time
    const timeTracking = document.querySelector('.time-tracking');
    if (timeTracking) {
        const loginTime = timeTracking.querySelector('p:first-child');
        if (loginTime) {
            loginTime.innerHTML = `<i class="fas fa-sign-in-alt"></i> Logged in: ${timeString}`;
        }
    }
    
    // Update availability toggle
    const toggle = document.getElementById('availabilityToggle');
    if (toggle) {
        toggle.checked = true;
    }
    
    showNotification('Successfully logged in!', 'success');
}

function logOut() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
    });
    
    // Update the logged out time
    const timeTracking = document.querySelector('.time-tracking');
    if (timeTracking) {
        const logoutTime = timeTracking.querySelector('p:last-child');
        if (logoutTime) {
            logoutTime.innerHTML = `<i class="fas fa-sign-out-alt"></i> Last logout: ${timeString}`;
        }
    }
    
    // Update availability toggle
    const toggle = document.getElementById('availabilityToggle');
    if (toggle) {
        toggle.checked = false;
    }
    
    showNotification('Successfully logged out!', 'success');
}

function markPickedUp(orderId) {
    if (confirm(`Mark order #${orderId} as picked up?`)) {
        // Update the delivery status
        const deliveryCard = document.querySelector(`[onclick*="markPickedUp('${orderId}')"]`).closest('.delivery-card');
        if (deliveryCard) {
            const statusElement = deliveryCard.querySelector('.delivery-status');
            const actionsElement = deliveryCard.querySelector('.delivery-actions');
            
            if (statusElement) {
                statusElement.textContent = 'On the Way';
                statusElement.className = 'delivery-status in-transit';
            }
            
            if (actionsElement) {
                actionsElement.innerHTML = `
                    <button class="btn btn-warning" onclick="markDelivered('${orderId}')">
                        <i class="fas fa-check-circle"></i> Mark as Delivered
                    </button>
                    <button class="btn btn-danger" onclick="reportIssue('${orderId}')">
                        <i class="fas fa-exclamation-triangle"></i> Report Issue
                    </button>
                `;
            }
        }
        
        showNotification(`Order #${orderId} marked as picked up!`, 'success');
    }
}

async function markDelivered(orderId) {
    if (confirm(`Mark order #${orderId} as delivered?`)) {
        try {
            if (!isFirestoreReady()) {
                await waitForFirebaseReady();
            }
            
            const fns = window.firestoreFunctions;
            
            // Update order status to delivered
            const orderRef = fns.doc(window.db, 'orders', orderId);
            await fns.updateDoc(orderRef, {
                status: 'delivered',
                updatedAt: fns.serverTimestamp()
            });
            
            // Update for_delivery document with time delivered
            const deliveryRef = fns.doc(window.db, 'for_delivery', orderId);
            const deliveryDoc = await fns.getDoc(deliveryRef);
            
            if (deliveryDoc.exists()) {
                await fns.updateDoc(deliveryRef, {
                    timeDelivered: fns.serverTimestamp(),
                    updatedAt: fns.serverTimestamp()
                });
            } else {
                // If document doesn't exist, create it (shouldn't happen, but handle it)
                const order = ordersState.find(o => o.id === orderId);
                if (order && order.driverId) {
                    await fns.setDoc(deliveryRef, {
                        deliveryId: orderId,
                        orderId: orderId,
                        driverId: order.driverId,
                        timeAssigned: fns.serverTimestamp(), // Approximate, since we don't have the original time
                        timeDelivered: fns.serverTimestamp(),
                        createdAt: fns.serverTimestamp(),
                        updatedAt: fns.serverTimestamp()
                    });
                }
            }
            
            // Update local state
            const orderIndex = ordersState.findIndex(o => o.id === orderId);
            if (orderIndex !== -1) {
                ordersState[orderIndex].status = 'delivered';
            }
            
            // Refresh the orders table
            renderOrdersTable(ordersState);
            
            // Update the delivery status in UI
            const deliveryCard = document.querySelector(`[onclick*="markDelivered('${orderId}')"]`)?.closest('.delivery-card');
        if (deliveryCard) {
            const statusElement = deliveryCard.querySelector('.delivery-status');
            const actionsElement = deliveryCard.querySelector('.delivery-actions');
            
            if (statusElement) {
                statusElement.textContent = 'Delivered';
                statusElement.className = 'delivery-status delivered';
            }
            
            if (actionsElement) {
                actionsElement.innerHTML = `
                    <button class="btn btn-success" disabled>
                        <i class="fas fa-check-circle"></i> Delivered
                    </button>
                `;
            }
        }
        
        showNotification(`Order #${orderId} marked as delivered!`, 'success');
        } catch (error) {
            console.error('Error marking order as delivered:', error);
            showNotification('Failed to mark order as delivered. Please try again.', 'error');
        }
    }
}

function reportIssue(orderId) {
    const issue = prompt(`Report issue for order #${orderId}:\n\n1. Customer not available\n2. Address problem\n3. Payment issue\n4. Other\n\nPlease describe the issue:`);
    
    if (issue && issue.trim() !== '') {
        showNotification(`Issue reported for order #${orderId}: ${issue}`, 'info');
        
        // In a real application, this would send the issue report to the admin
        console.log(`Issue reported for order ${orderId}:`, issue);
    }
}

// Add driver functions to global scope
window.logIn = logIn;
window.logOut = logOut;
window.markPickedUp = markPickedUp;
window.markDelivered = markDelivered;
window.reportIssue = reportIssue;

// Drivers Management Functions
async function initDriversDashboard() {
    const driversList = document.getElementById('driversList');
    if (!driversList) {
        return;
    }
    if (driversList.dataset.initialized === 'true') {
        return;
    }
    driversList.dataset.initialized = 'true';
    driversList.innerHTML = '<div class="loading-message">Loading drivers...</div>';

    try {
        await waitForFirebaseReady();
        await loadDrivers();
        await subscribeToDrivers();
    } catch (error) {
        console.error('Drivers dashboard failed to initialize:', error);
        showNotification(error.message || 'Unable to load drivers.', 'error');
        driversList.innerHTML = '<div class="error-message">Failed to load drivers. Please refresh the page.</div>';
    }
}

async function loadDrivers() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns?.getDocs || !fns?.collection) {
        throw new Error('Firestore helpers are not available yet.');
    }
    
    try {
        // Try to load from 'drivers' collection first
        let snapshot;
        try {
            snapshot = await fns.getDocs(fns.collection(window.db, 'drivers'));
        } catch (error) {
            // If 'drivers' collection doesn't exist, try 'staff' collection with role filter
            console.log('Drivers collection not found, trying staff collection...');
            const staffSnapshot = await fns.getDocs(fns.collection(window.db, 'staff'));
            const staffDocs = staffSnapshot.docs.filter(doc => {
                const data = doc.data();
                const role = (data.role || '').toLowerCase();
                return role === 'driver' || role === 'delivery';
            });
            driversState = staffDocs.map(docSnap => normalizeDriverDoc(docSnap));
            renderDriversList();
            return;
        }
        
        driversState = snapshot.docs
            .map(docSnap => normalizeDriverDoc(docSnap))
            .filter(Boolean);
        renderDriversList();
    } catch (error) {
        console.error('Error loading drivers:', error);
        throw error;
    }
}

async function subscribeToDrivers() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns || !window.db) {
        return;
    }

    try {
        const driversQuery = fns.collection(window.db, 'drivers');
        if (typeof fns.onSnapshot === 'function') {
            fns.onSnapshot(
                driversQuery,
                (snapshot) => {
                    driversState = snapshot.docs
                        .map(docSnap => normalizeDriverDoc(docSnap))
                        .filter(Boolean);
                    renderDriversList();
                },
                (error) => {
                    console.error('Drivers listener error:', error);
                }
            );
        }
    } catch (error) {
        // If drivers collection doesn't exist, that's okay - we'll use staff collection
        console.log('Could not subscribe to drivers collection:', error);
    }
}

function normalizeDriverDoc(docSnap) {
    if (!docSnap) return null;
    const data = docSnap.data() || {};
    
    // Get driver name - format: "Driver X - FirstName LastName" or just the name
    const firstName = data.firstName || data.first_name || '';
    const lastName = data.lastName || data.last_name || '';
    const nameParts = [firstName, lastName].filter(Boolean);
    const baseName = nameParts.length ? nameParts.join(' ') : (data.name || data.displayName || 'Unknown Driver');
    
    // Get driver ID
    const driverId = data.driverId || data.driver_id || data.staffId || data.id || docSnap.id;
    
    // Format driver name as "Driver X - Name" if we have a numeric ID, otherwise just use the name
    let displayName = baseName;
    const driverIdMatch = driverId.match(/(\d+)/);
    if (driverIdMatch) {
        const driverNumber = driverIdMatch[1];
        displayName = `Driver ${driverNumber} - ${baseName}`;
    } else {
        displayName = baseName;
    }
    
    // Get phone number
    const phoneNumber = data.phoneNumber || data.phone_number || data.contactNumber || data.contact_number || data.phone || '';
    
    // Check Firestore availability status first (set by driver login/logout)
    let driverStatus = data.availability || data.availabilityStatus || 'off';
    
    // If driver is marked as "off" in Firestore, use that
    if (driverStatus === 'off') {
        // Keep as 'off'
    } else {
        // If available in Firestore, check if they have active orders (then they're busy)
    if (ordersState && ordersState.length > 0) {
        const hasActiveDelivery = ordersState.some(order => {
            const orderDriverId = order.driverId || '';
            const orderStatus = (order.status || '').toLowerCase().trim();
                // Driver is busy if assigned to an order that's preparing, ready, out for delivery, or in transit
                // Match by driverId, staffId, or document ID
            const driverStaffId = data.staffId || data.driverId || driverId;
            return (orderDriverId === driverId || orderDriverId === driverStaffId || orderDriverId === docSnap.id) &&
                       (orderStatus === 'preparing' ||
                        orderStatus === 'being-cooked' || orderStatus === 'being_cooked' || orderStatus === 'being cooked' ||
                    orderStatus === 'cooking' || 
                    orderStatus === 'ready' || 
                        orderStatus === 'ready for delivery' || orderStatus === 'ready_for_delivery' ||
                        orderStatus === 'for delivery' || orderStatus === 'for_delivery' ||
                    orderStatus === 'accepted' || 
                    orderStatus === 'out_for_delivery' || orderStatus === 'out-for-delivery' ||
                    orderStatus === 'in-transit' || orderStatus === 'in_transit' || 
                    orderStatus === 'on-the-way' || orderStatus === 'on_the_way');
        });
        if (hasActiveDelivery) {
            driverStatus = 'busy';
            } else if (driverStatus !== 'available' && driverStatus !== 'busy') {
                // If status is not explicitly set, default to available
                driverStatus = 'available';
            }
        } else if (driverStatus !== 'available' && driverStatus !== 'busy' && driverStatus !== 'off') {
            // If no orders and status not explicitly set, default to available
            driverStatus = 'available';
        }
    }
    
    return {
        id: docSnap.id,
        driverId: driverId,
        name: displayName,
        firstName: firstName,
        lastName: lastName,
        phoneNumber: phoneNumber,
        availability: driverStatus,
        status: driverStatus,
        email: data.email || '',
        createdAt: data.createdAt || null
    };
}

function renderDriversList() {
    const driversList = document.getElementById('driversList');
    if (!driversList) return;

    // Filter drivers
    let filteredDrivers = [...driversState];
    
    // Apply search filter
    if (driverSearchTerm) {
        const searchLower = driverSearchTerm.toLowerCase();
        filteredDrivers = filteredDrivers.filter(driver => {
            const name = (driver.name || '').toLowerCase();
            const driverId = (driver.driverId || '').toLowerCase();
            const phone = (driver.phoneNumber || '').toLowerCase();
            return name.includes(searchLower) || 
                   driverId.includes(searchLower) || 
                   phone.includes(searchLower);
        });
    }
    
    // Apply availability filter
    if (driverFilter === 'available') {
        filteredDrivers = filteredDrivers.filter(driver => driver.availability === 'available');
    } else if (driverFilter === 'busy') {
        filteredDrivers = filteredDrivers.filter(driver => driver.availability === 'busy');
    } else if (driverFilter === 'off') {
        filteredDrivers = filteredDrivers.filter(driver => driver.availability === 'off');
    }
    
    driversList.innerHTML = '';

    if (!filteredDrivers.length) {
        driversList.innerHTML = '<div class="empty-message">No drivers found matching the current filters.</div>';
        return;
    }

    filteredDrivers.forEach(driver => {
        const driverCard = document.createElement('div');
        driverCard.className = 'driver-card';
        
        let availabilityClass = 'available';
        let availabilityText = 'AVAILABLE';
        
        if (driver.availability === 'busy') {
            availabilityClass = 'busy';
            availabilityText = 'BUSY';
        } else if (driver.availability === 'off') {
            availabilityClass = 'off';
            availabilityText = 'OFF';
        }
        
        driverCard.innerHTML = `
            <div class="driver-icon">
                <i class="fas fa-user"></i>
            </div>
            <div class="driver-info">
                <div class="driver-name">${escapeHtml(driver.name)}</div>
                <div class="driver-id">${escapeHtml(driver.driverId)} - ${escapeHtml(driver.phoneNumber || '')}</div>
            </div>
            <div class="driver-status">
                <span class="status-badge ${availabilityClass}">${availabilityText}</span>
            </div>
        `;
        
        driversList.appendChild(driverCard);
    });
}

function setDriverFilter(filter) {
    driverFilter = filter;
    
    // Update button states
    document.getElementById('filterAvailable')?.classList.toggle('active', filter === 'available');
    document.getElementById('filterBusy')?.classList.toggle('active', filter === 'busy');
    document.getElementById('filterOff')?.classList.toggle('active', filter === 'off');
    
    renderDriversList();
}

function filterDrivers() {
    const searchInput = document.getElementById('driverSearch');
    if (searchInput) {
        driverSearchTerm = searchInput.value.trim();
        renderDriversList();
    }
}

// Driver functions removed - using original hardcoded structure

async function assignDriverToOrder(driverId, orderId) {
    if (!driverId || !orderId) {
        showNotification('Driver ID or Order ID is missing.', 'error');
        return;
    }
    
    const driver = driversState.find(d => d.id === driverId);
    const order = ordersState.find(o => o.id === orderId);
    
    if (!driver) {
        showNotification('Driver not found.', 'error');
        return;
    }
    
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    
    if (driver.availability !== 'available') {
        showNotification('Selected driver is not available.', 'error');
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const orderRef = fns.doc(window.db, 'orders', orderId);
        
        // Update order with driver assignment
        await fns.updateDoc(orderRef, {
            driverId: driver.driverId || driver.id,
            status: 'out_for_delivery',
            assignedAt: fns.serverTimestamp(),
            updatedAt: fns.serverTimestamp()
        });
        
        // Create document in for_delivery collection
        try {
            const deliveryId = orderId; // Use order ID as delivery ID
            const deliveryRef = fns.doc(window.db, 'for_delivery', deliveryId);
            
            // Check if document already exists
            const existingDoc = await fns.getDoc(deliveryRef);
            if (!existingDoc.exists()) {
                await fns.setDoc(deliveryRef, {
                    deliveryId: deliveryId,
                    orderId: orderId,
                    driverId: driver.driverId || driver.id,
                    timeAssigned: fns.serverTimestamp(),
                    timeDelivered: null,
                    createdAt: fns.serverTimestamp(),
                    updatedAt: fns.serverTimestamp()
                });
                console.log(`Created for_delivery document for order ${orderId}`);
            } else {
                // Update existing document if driver changed
                await fns.updateDoc(deliveryRef, {
                    driverId: driver.driverId || driver.id,
                    timeAssigned: fns.serverTimestamp(),
                    updatedAt: fns.serverTimestamp()
                });
                console.log(`Updated for_delivery document for order ${orderId}`);
            }
        } catch (deliveryError) {
            console.error('Error creating/updating for_delivery document:', deliveryError);
            // Don't fail the whole operation if for_delivery creation fails
            showNotification('Driver assigned, but failed to create delivery record. Please check console.', 'warning');
        }
        
        // Update local state
        const orderIndex = ordersState.findIndex(o => o.id === orderId);
        if (orderIndex !== -1) {
            ordersState[orderIndex].driverId = driver.driverId || driver.id;
            ordersState[orderIndex].status = 'out_for_delivery';
        }
        
        // Update driver status in driversState
        const driverIndex = driversState.findIndex(d => (d.id === driverId || d.driverId === driverId || d.id === driver.id || d.driverId === driver.driverId));
        if (driverIndex !== -1) {
            driversState[driverIndex].availability = 'busy';
            driversState[driverIndex].status = 'busy';
        }
        
        // Refresh the orders table and drivers list
        renderOrdersTable(ordersState);
        renderDriversList();
        
        showNotification(`Driver ${driver.name} assigned to order ${order.trackingId || orderId}!`, 'success');
        closeDriverSelectionModal();
    } catch (error) {
        console.error('Error assigning driver:', error);
        showNotification('Failed to assign driver. Please try again.', 'error');
    }
}

// Driver profile functions removed - using original hardcoded structure

window.assignDriverToOrder = assignDriverToOrder;
window.openDriverSelectionForOrder = openDriverSelectionForOrder;
window.closeDriverSelectionModal = closeDriverSelectionModal;
window.setDriverFilter = setDriverFilter;
window.filterDrivers = filterDrivers;

window.addEventListener('beforeunload', () => {
    if (typeof ordersUnsubscribe === 'function') {
        ordersUnsubscribe();
        ordersUnsubscribe = null;
    }
});

