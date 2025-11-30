// Global variables
let activeDropdown = null;
let inventoryState = [];
let menuState = [];
let currentMenuEditItem = null;
let currentMenuDetailIndex = 0;
let menuDetailVisible = false;
let menuDetailEditing = false;
let uploadedFoodImageDataUrl = null; // Stores Firebase Storage URL after upload
let uploadedFoodImageFile = null; // Stores the File object before upload
let menuDetailNewImageFile = null; // Stores the new image file for product detail replacement
let ordersState = [];
let ordersUnsubscribe = null;
const customerDetailsCache = new Map();
const customerFetchInProgress = new Set();
let orderFilters = {
    filter: 'old-to-new', // Combined filter: 'old-to-new', 'status:xxx', 'type:xxx', or 'type:xxx|status:xxx'
    searchTerm: ''
};
let ordersCurrentPage = 1;
const ordersPerPage = 10;
let driversState = [];
let driverFilter = 'available';
let driverSearchTerm = '';
let currentViewingDriverId = null;
let customersState = [];
let selectedCustomerId = null;
let customerSearchTerm = '';

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
            displayName: item.displayName || item.name || '',
            category: item.category || 'Uncategorized',
            price: Number(item.price) || 0,
            quantity: Number(item.quantity) || 0,
            deliveryCharge: Number(item.deliveryCharge) || 0,
            description: item.description || '',
            imageDataUrl: item.imageDataUrl || null,
            isActive: item.isActive !== false,
            isDeleted: item.isDeleted === true,
            deletedAt: item.deletedAt || null,
            variations: Array.isArray(item.variations)
                ? item.variations.map(variation => ({
                    name: variation.name || '',
                    price: Number(variation.price) || 0,
                    description: variation.description || '',
                    ingredientId: variation.ingredientId || null,
                    ingredientName: variation.ingredientName || null,
                    kgUsage: variation.kgUsage !== null && variation.kgUsage !== undefined ? Number(variation.kgUsage) : null // Keep for backward compatibility
                }))
                : [],
            allergens: item.allergens || null,
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

    async function generateUniqueFoodId() {
        const fns = assertFirestoreReady();
        const maxAttempts = 100; // Prevent infinite loops
        let attempts = 0;
        
        // Get all existing menu items to check for duplicates
        const snapshot = await fns.getDocs(fns.collection(window.db, COLLECTION));
        const existingDocIds = new Set();
        const existingMenuIds = new Set();
        
        snapshot.docs.forEach(docSnap => {
            existingDocIds.add(docSnap.id);
            const data = docSnap.data();
            if (data.menuId) {
                existingMenuIds.add(data.menuId.toString());
            }
        });
        
        while (attempts < maxAttempts) {
            // Generate an 8-digit ID (10000000 to 99999999)
            const randomId = Math.floor(10000000 + Math.random() * 90000000).toString();
            
            // Check if this ID is not used as document ID or menuId
            if (!existingDocIds.has(randomId) && !existingMenuIds.has(randomId)) {
                return randomId;
            }
            
            attempts++;
        }
        
        // Fallback: use timestamp-based ID if random generation fails
        const timestampId = Date.now().toString().slice(-8);
        let fallbackId = timestampId.padStart(8, '0');
        
        // Ensure fallback is also unique
        let fallbackAttempts = 0;
        while ((existingDocIds.has(fallbackId) || existingMenuIds.has(fallbackId)) && fallbackAttempts < 100) {
            fallbackId = (Date.now() + fallbackAttempts).toString().slice(-8).padStart(8, '0');
            fallbackAttempts++;
        }
        
        return fallbackId;
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
            isActive: true,
            createdAt: fns.serverTimestamp(),
            updatedAt: fns.serverTimestamp()
        });
        return await getItems();
    }

    async function updateItem(id, data) {
        if (!id) {
            throw new Error('Menu item id is required.');
        }
        const fns = assertFirestoreReady();
        const docRef = fns.doc(window.db, COLLECTION, id);
        
        // Check if item exists and get current state
        const currentDoc = await fns.getDoc(docRef);
        if (!currentDoc.exists()) {
            throw new Error('Menu item not found.');
        }
        
        const currentData = currentDoc.data();
        // Check if currently active (isActive is true, undefined, or not explicitly false)
        const wasActive = currentData.isActive !== false && currentData.isActive !== 'false';
        // Check if will be inactive (isActive is explicitly false)
        const willBeInactive = data.isActive === false || data.isActive === 'false';
        
        // If status is changing from active to inactive, archive the item
        if (wasActive && willBeInactive) {
            try {
                const archiveRef = fns.doc(window.db, 'menu_archive', id);
                // Create a clean copy of the data
                const archiveData = {
                    ...currentData,
                    archivedAt: fns.serverTimestamp(),
                    archivedFrom: COLLECTION
                };
                // Remove any undefined values
                Object.keys(archiveData).forEach(key => {
                    if (archiveData[key] === undefined) {
                        delete archiveData[key];
                    }
                });
                
                await fns.setDoc(archiveRef, archiveData);
            } catch (archiveError) {
                console.error('Failed to archive menu item:', archiveError);
                // Don't throw - continue with the update even if archiving fails
                // This ensures the status change still happens
            }
        }
        
        // Update the original document
        await fns.updateDoc(docRef, {
            ...data,
            updatedAt: fns.serverTimestamp()
        });
        
        return await getItems();
    }

    async function deleteItem(id) {
        if (!id) {
            throw new Error('Menu item id is required.');
        }
        const fns = assertFirestoreReady();
        const docRef = fns.doc(window.db, COLLECTION, id);
        
        // Get the current item data before deleting
        const currentDoc = await fns.getDoc(docRef);
        if (!currentDoc.exists()) {
            throw new Error('Menu item not found.');
        }
        
        const currentData = currentDoc.data();
        
        // Archive the item to menu_archive with deletedAt timestamp
        const archiveRef = fns.doc(window.db, 'menu_archive', id);
        const archiveData = {
            ...currentData,
            deletedAt: fns.serverTimestamp(),
            archivedAt: fns.serverTimestamp(),
            archivedFrom: COLLECTION,
            deletedByUser: true // Flag to indicate this was deleted (not just deactivated)
        };
        
        // Remove any undefined values
        Object.keys(archiveData).forEach(key => {
            if (archiveData[key] === undefined) {
                delete archiveData[key];
            }
        });
        
        // Archive the item
        await fns.setDoc(archiveRef, archiveData);
        
        // Mark as deleted in the main menu collection instead of deleting
        await fns.updateDoc(docRef, {
            isDeleted: true,
            deletedAt: fns.serverTimestamp(),
            isActive: false, // Also set inactive
            updatedAt: fns.serverTimestamp()
        });
        
        return await getItems();
    }
    
    // Clean up expired archived items (older than 30 days)
    async function cleanupExpiredArchivedItems() {
        const fns = assertFirestoreReady();
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
        
        const deletePromises = [];
        
        // Clean up from menu_archive collection
        const archiveCollection = fns.collection(window.db, 'menu_archive');
        const archiveSnapshot = await fns.getDocs(archiveCollection);
        
        archiveSnapshot.docs.forEach(doc => {
            const data = doc.data();
            // Check if item has deletedAt timestamp and was deleted by user (not just deactivated)
            if (data.deletedAt && data.deletedByUser === true) {
                let deletedAt;
                // Handle Firestore Timestamp object
                if (data.deletedAt.toDate) {
                    deletedAt = data.deletedAt.toDate();
                } else if (data.deletedAt.seconds) {
                    deletedAt = new Date(data.deletedAt.seconds * 1000);
                } else if (data.deletedAt instanceof Date) {
                    deletedAt = data.deletedAt;
                } else {
                    deletedAt = new Date(data.deletedAt);
                }
                
                // Check if older than 30 days
                if (deletedAt && deletedAt < thirtyDaysAgo) {
                    deletePromises.push(fns.deleteDoc(fns.doc(window.db, 'menu_archive', doc.id)));
                }
            }
        });
        
        // Clean up from menu collection (items marked as deleted)
        const menuCollection = fns.collection(window.db, COLLECTION);
        const menuSnapshot = await fns.getDocs(menuCollection);
        
        menuSnapshot.docs.forEach(doc => {
            const data = doc.data();
            // Check if item is marked as deleted and has deletedAt timestamp
            if (data.isDeleted === true && data.deletedAt) {
                let deletedAt;
                // Handle Firestore Timestamp object
                if (data.deletedAt.toDate) {
                    deletedAt = data.deletedAt.toDate();
                } else if (data.deletedAt.seconds) {
                    deletedAt = new Date(data.deletedAt.seconds * 1000);
                } else if (data.deletedAt instanceof Date) {
                    deletedAt = data.deletedAt;
                } else {
                    deletedAt = new Date(data.deletedAt);
                }
                
                // Check if older than 30 days
                if (deletedAt && deletedAt < thirtyDaysAgo) {
                    deletePromises.push(fns.deleteDoc(fns.doc(window.db, COLLECTION, doc.id)));
                }
            }
        });
        
        if (deletePromises.length > 0) {
            await Promise.all(deletePromises);
            console.log(`Cleaned up ${deletePromises.length} expired deleted menu items.`);
        }
        
        return deletePromises.length;
    }

    async function setItemActiveState(id, isActive) {
        return await updateItem(id, { isActive });
    }
    
    async function restoreItem(id) {
        if (!id) {
            throw new Error('Menu item id is required.');
        }
        const fns = assertFirestoreReady();
        const docRef = fns.doc(window.db, COLLECTION, id);
        
        // Get the current item data
        const currentDoc = await fns.getDoc(docRef);
        if (!currentDoc.exists()) {
            throw new Error('Menu item not found.');
        }
        
        // Delete from menu_archive if it exists
        const archiveRef = fns.doc(window.db, 'menu_archive', id);
        try {
            const archiveDoc = await fns.getDoc(archiveRef);
            if (archiveDoc.exists()) {
                await fns.deleteDoc(archiveRef);
            }
        } catch (archiveError) {
            console.warn('Failed to delete from menu_archive (may not exist):', archiveError);
            // Continue with restore even if archive deletion fails
        }
        
        // Restore the item by removing isDeleted flag and setting it back to active
        await fns.updateDoc(docRef, {
            isDeleted: false,
            isActive: true,
            deletedAt: fns.deleteField ? fns.deleteField() : null,
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
        updateItem,
        deleteItem,
        setItemActiveState,
        restoreItem,
        cleanupExpiredArchivedItems,
        generateUniqueFoodId,
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
        updateOrdersPagination(0);
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

    // Calculate pagination
    const totalPages = Math.ceil(sortedOrders.length / ordersPerPage);
    if (ordersCurrentPage > totalPages && totalPages > 0) {
        ordersCurrentPage = totalPages;
    }
    const startIndex = (ordersCurrentPage - 1) * ordersPerPage;
    const endIndex = startIndex + ordersPerPage;
    const paginatedOrders = sortedOrders.slice(startIndex, endIndex);

    // Update pagination controls
    updateOrdersPagination(sortedOrders.length);

    paginatedOrders.forEach(order => {
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
        // Reset icon for closed dropdown
        const closedButton = currentDropdown.closest('.user-profile')?.querySelector('.profile-btn');
        if (closedButton) {
            const closedIcon = closedButton.querySelector('.fa-chevron-down, .fa-chevron-right');
            if (closedIcon) {
                closedIcon.classList.remove('fa-chevron-right');
                closedIcon.classList.add('fa-chevron-down');
            }
        }
    }
    
    // Toggle the clicked dropdown
    const dropdown = document.getElementById(dropdownId);
    if (dropdown) {
        const isOpening = !dropdown.classList.contains('show');
        dropdown.classList.toggle('show');
        activeDropdown = dropdown.classList.contains('show') ? dropdownId : null;
        
        // Update chevron icon for user profile dropdown
        if (dropdownId === 'adminDropdown') {
            const profileButton = dropdown.closest('.user-profile')?.querySelector('.profile-btn');
            if (profileButton) {
                const chevronIcon = profileButton.querySelector('.fa-chevron-down, .fa-chevron-right');
                if (chevronIcon) {
                    if (isOpening) {
                        // Opening: change from down to right
                        chevronIcon.classList.remove('fa-chevron-down');
                        chevronIcon.classList.add('fa-chevron-right');
                    } else {
                        // Closing: change from right to down
                        chevronIcon.classList.remove('fa-chevron-right');
                        chevronIcon.classList.add('fa-chevron-down');
                    }
                }
            }
        }
    }
}

// Sidebar Menu tab dropdown (Menu Catalogue / List / Add Product / Product Detail)
function toggleMenuTabDropdown() {
    const submenu = document.getElementById('menuTabDropdown');
    const icon = document.querySelector('.menu-toggle-icon');
    if (!submenu || !icon) return;

    const willShow = !submenu.classList.contains('show');
    submenu.classList.toggle('show', willShow);

    // Update icon: right when closed, down when open
    icon.classList.toggle('fa-chevron-right', !willShow);
    icon.classList.toggle('fa-chevron-down', willShow);
}

function toggleCustomerTabDropdown() {
    const submenu = document.getElementById('customerTabDropdown');
    const navItem = submenu ? submenu.closest('.menu-nav-dropdown') : null;
    const icon = navItem ? navItem.querySelector('.menu-toggle-icon') : null;
    if (!submenu || !icon) return;

    const willShow = !submenu.classList.contains('show');
    submenu.classList.toggle('show', willShow);

    // Update icon: right when closed, down when open
    icon.classList.toggle('fa-chevron-right', !willShow);
    icon.classList.toggle('fa-chevron-down', willShow);
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(event) {
    if (activeDropdown) {
        const dropdown = document.getElementById(activeDropdown);
        const button = event.target.closest('[onclick*="toggleDropdown"]');
        
        if (!dropdown.contains(event.target) && !button) {
            dropdown.classList.remove('show');
            
            // Reset icon for user profile dropdown
            if (activeDropdown === 'adminDropdown') {
                const profileButton = dropdown.closest('.user-profile')?.querySelector('.profile-btn');
                if (profileButton) {
                    const chevronIcon = profileButton.querySelector('.fa-chevron-down, .fa-chevron-right');
                    if (chevronIcon) {
                        chevronIcon.classList.remove('fa-chevron-right');
                        chevronIcon.classList.add('fa-chevron-down');
                    }
                }
            }
            
            activeDropdown = null;
        }
    }
    
    // Close menu/customer tab dropdowns when clicking outside
    const menuDropdown = document.getElementById('menuTabDropdown');
    const customerDropdown = document.getElementById('customerTabDropdown');
    const menuToggle = event.target.closest('[onclick*="toggleMenuTabDropdown"]');
    const customerToggle = event.target.closest('[onclick*="toggleCustomerTabDropdown"]');
    
    if (menuDropdown && !menuToggle && !menuDropdown.contains(event.target)) {
        menuDropdown.classList.remove('show');
        const menuNavItem = menuDropdown.closest('.menu-nav-dropdown');
        if (menuNavItem) {
            menuNavItem.classList.remove('active');
            const icon = menuNavItem.querySelector('.menu-toggle-icon');
            if (icon) {
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-right');
            }
        }
    }
    
    if (customerDropdown && !customerToggle && !customerDropdown.contains(event.target)) {
        customerDropdown.classList.remove('show');
        const customerNavItem = customerDropdown.closest('.menu-nav-dropdown');
        if (customerNavItem) {
            customerNavItem.classList.remove('active');
            const icon = customerNavItem.querySelector('.menu-toggle-icon');
            if (icon) {
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-right');
            }
        }
    }
});

// Filter functions
function applyOrderStatusFilter() {
    const filterSelect = document.getElementById('orderFilter');
    if (filterSelect) {
        orderFilters.filter = filterSelect.value || 'old-to-new';
    }
    ordersCurrentPage = 1; // Reset to first page when filter changes
    renderOrdersTable(ordersState);
}

function filterOrders() {
    const searchInput = document.getElementById('orderSearch');
    if (searchInput) {
        orderFilters.searchTerm = searchInput.value.trim();
        ordersCurrentPage = 1; // Reset to first page when search changes
        renderOrdersTable(ordersState);
    }
}

function changeOrdersPage(direction) {
    const filteredOrders = filterOrdersByCriteria(ordersState);
    const totalPages = Math.ceil(filteredOrders.length / ordersPerPage);
    
    ordersCurrentPage += direction;
    if (ordersCurrentPage < 1) {
        ordersCurrentPage = 1;
    } else if (ordersCurrentPage > totalPages) {
        ordersCurrentPage = totalPages;
    }
    
    renderOrdersTable(ordersState);
}

function updateOrdersPagination(totalOrders) {
    const paginationContainer = document.getElementById('ordersPagination');
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    const paginationInfo = document.getElementById('paginationInfo');
    
    if (!paginationContainer || !prevBtn || !nextBtn || !paginationInfo) return;
    
    const totalPages = Math.ceil(totalOrders / ordersPerPage);
    
    if (totalPages <= 1) {
        paginationContainer.style.display = 'none';
        return;
    }
    
    paginationContainer.style.display = 'flex';
    prevBtn.disabled = ordersCurrentPage <= 1;
    nextBtn.disabled = ordersCurrentPage >= totalPages;
    
    paginationInfo.textContent = `Page ${ordersCurrentPage} of ${totalPages}`;
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
    
    // Clean up expired archived items (older than 30 days) before loading menu
    try {
        await MenuStore.cleanupExpiredArchivedItems();
    } catch (error) {
        console.error('Failed to cleanup expired archived items:', error);
        // Don't block menu loading if cleanup fails
    }
    
    menuState = await MenuStore.getItems();
    renderMenuState();
    return menuState;
}

function renderMenuState() {
    renderMenuItemsTable(menuState);
    renderMenuListTable();
    renderSalesMenuAlerts();
    renderMenuDetailsCarousel();
    updateLinkedMealDropdown();
    
    // If we have a product detail hash and menuState is now loaded, show product detail
    const hash = window.location.hash;
    if ((hash === '#menu-product-detail' || hash === '#product-detail') && menuState && menuState.length && !menuDetailVisible) {
        showMenuProductDetail();
    }
}

function renderMenuListTable() {
    const tableBody = document.getElementById('menuListTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '';

    if (!menuState || !menuState.length) {
        tableBody.innerHTML = '<tr><td colspan="5" class="empty-table">No active menu items found.</td></tr>';
        return;
    }

    // Filter to only active items
    const activeItems = menuState.filter(item => item.isActive !== false);
    
    if (!activeItems.length) {
        tableBody.innerHTML = '<tr><td colspan="5" class="empty-table">No active menu items found.</td></tr>';
        return;
    }

    // Sort by name
    const sortedItems = [...activeItems].sort((a, b) => a.name.localeCompare(b.name));
    
    sortedItems.forEach(item => {
        const row = document.createElement('tr');
        const quantity = Number(item.quantity || 0);
        const stockStatus = quantity > 0 ? { label: 'In Stock', className: 'active' } : { label: 'Out of Stock', className: 'no-stock' };
        const price = Number(item.price || 0).toFixed(2);
        const menuId = item.menuId || item.id || '—';

        const displayName = item.displayName || item.name;
        row.innerHTML = `
            <td>${menuId}</td>
            <td>${displayName}</td>
            <td>${quantity}</td>
            <td><span class="status ${stockStatus.className}">${stockStatus.label}</span></td>
            <td>PHP ${price}</td>
        `;

        tableBody.appendChild(row);
    });
}

function updateLinkedMealDropdown() {
    const linkedMealSelect = document.getElementById('linkedMeal');
    if (!linkedMealSelect) return;
    
    // Clear existing options except "None"
    linkedMealSelect.innerHTML = '<option value="">None</option>';
    
    // Add menu items
    if (menuState && menuState.length) {
        menuState.forEach(item => {
            if (item && item.name) {
                const option = document.createElement('option');
                option.value = item.id;
                const displayName = item.displayName || item.name;
                option.textContent = displayName;
                linkedMealSelect.appendChild(option);
            }
        });
    }
}

let currentMenuFilter = { status: 'all', category: 'all' };

function applyMenuFilter(items) {
    if (!items || !items.length) return [];
    
    let filtered = [...items];
    
    // Filter by status
    if (currentMenuFilter.status === 'active') {
        filtered = filtered.filter(item => item.isActive !== false && item.isDeleted !== true);
    } else if (currentMenuFilter.status === 'inactive') {
        filtered = filtered.filter(item => item.isActive === false && item.isDeleted !== true);
    } else if (currentMenuFilter.status === 'for-deleted') {
        filtered = filtered.filter(item => item.isDeleted === true);
    }
    
    // Filter by category
    if (currentMenuFilter.category !== 'all') {
        const categoryLower = currentMenuFilter.category.toLowerCase();
        filtered = filtered.filter(item => {
            const itemCategory = (item.category || '').toLowerCase();
            // Check for exact match or if category contains the filter value
            return itemCategory === categoryLower || itemCategory.includes(categoryLower);
        });
    }
    
    return filtered;
}

function getFilterDisplayName(filterType, filterValue) {
    if (filterValue === 'all') {
        return filterType === 'status' ? 'all statuses' : 'all categories';
    }
    if (filterType === 'status' && filterValue === 'for-deleted') {
        return 'for deletion';
    }
    return filterValue;
}

function renderMenuItemsTable(items) {
    const container = document.getElementById('menuTableBody');
    if (!container) return;

    container.innerHTML = '';

    if (!items || !items.length) {
        container.innerHTML = '<div class="empty-catalogue">Menu items will appear after you add dishes.</div>';
        return;
    }

    // Apply filters
    const filteredItems = applyMenuFilter(items);
    
    if (!filteredItems.length) {
        let message = 'Nothing has been added in ';
        if (currentMenuFilter.status !== 'all' && currentMenuFilter.category !== 'all') {
            message += `${getFilterDisplayName('category', currentMenuFilter.category)} (${getFilterDisplayName('status', currentMenuFilter.status)}) yet`;
        } else if (currentMenuFilter.status !== 'all') {
            message += `${getFilterDisplayName('status', currentMenuFilter.status)} yet`;
        } else if (currentMenuFilter.category !== 'all') {
            message += `${getFilterDisplayName('category', currentMenuFilter.category)} yet`;
        } else {
            message = 'Menu items will appear after you add dishes.';
        }
        container.innerHTML = `<div class="empty-catalogue">${message}</div>`;
        return;
    }

    const sortedItems = [...filteredItems].sort((a, b) => a.name.localeCompare(b.name));
    sortedItems.forEach(item => {
        const card = document.createElement('div');
        card.className = 'menu-catalogue-card';
        
        const status = getMenuItemStatus(item);
        const ordersCount = getMenuItemOrderCount(item);
        const price = Number(item.price || 0).toFixed(2);
        
        const displayName = item.displayName || item.name;
        const imageContent = item.imageDataUrl
            ? `<img src="${item.imageDataUrl}" alt="${displayName}">`
            : `<div class="menu-card-image-placeholder">${displayName.charAt(0).toUpperCase()}</div>`;

        const isDeleted = item.isDeleted === true;
        const buttonsSection = `
            <div class="menu-card-buttons">
                <button class="menu-card-button" type="button" onclick="showMenuDetailForItem('${item.id}')">View Details</button>
            </div>
        `;
        
        card.style.position = 'relative';
        const titleRow = isDeleted 
            ? `
                <div class="menu-card-title-row">
                    <h4 class="menu-card-title">${displayName}</h4>
                    <div class="menu-card-meatball-menu">
                        <button class="meatball-menu-btn" type="button" onclick="toggleMeatballMenu('${item.id}')" aria-label="Menu options">
                            <i class="fas fa-ellipsis-v"></i>
                        </button>
                        <div class="meatball-menu-dropdown" id="meatballMenu_${item.id}" style="display: none;">
                            <button class="meatball-menu-item" onclick="restoreMenuItem('${item.id}')">
                                <i class="fas fa-undo"></i> Restore Menu
                            </button>
                        </div>
                    </div>
                </div>
            `
            : `
                <h4 class="menu-card-title">${displayName}</h4>
            `;
        
        card.innerHTML = `
            <div class="menu-card-image-wrapper">
                ${imageContent}
            </div>
            <div class="menu-card-content">
                ${titleRow}
                <div class="menu-card-price-row">
                    <span class="menu-card-price-label">PHP</span>
                    <span class="menu-card-price-value">${price}</span>
                </div>
                <div class="menu-card-stats">
                    <div class="menu-card-stat">
                        <span class="stat-label">Total Order:</span>
                        <span class="stat-value">${ordersCount}</span>
                    </div>
                    <div class="menu-card-stat">
                        <span class="stat-label">Availability:</span>
                        <span class="stat-value status ${status.className}">${status.label}</span>
                    </div>
                </div>
                ${buttonsSection}
            </div>
        `;

        container.appendChild(card);
    });
}

function getMenuItemStatus(menuItem) {
    // Check for deleted status first
    if (menuItem && menuItem.isDeleted === true) {
        return { label: 'For Deletion', className: 'for-deleted' };
    }
    if (menuItem && menuItem.isActive === false) {
        return { label: 'Inactive', className: 'inactive' };
    }
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

function getMenuItemOrderCount(menuItem) {
    if (!menuItem || !Array.isArray(ordersState) || !ordersState.length) {
        return 0;
    }
    const idCandidates = [
        (menuItem.menuId || '').toLowerCase(),
        (menuItem.id || '').toLowerCase(),
        (menuItem.name || '').toLowerCase()
    ].filter(Boolean);
    if (!idCandidates.length) return 0;

    let count = 0;
    ordersState.forEach(order => {
        if (!Array.isArray(order.items)) return;
        order.items.forEach(item => {
            if (!item) return;
            const itemName = (item.name || item.itemName || '').toLowerCase();
            const itemId = (item.itemId || item.id || '').toLowerCase();
            const quantity = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
            const matchesId = idCandidates.includes(itemId);
            const matchesName = idCandidates.includes(itemName);
            if (matchesId || matchesName) {
                count += quantity;
            }
        });
    });
    return count;
}

function renderMenuDetailsCarousel() {
    const section = document.getElementById('menu-product-detail');
    const imageEl = document.getElementById('menuDetailImage');
    const captionEl = document.getElementById('menuDetailName');
    const slideIndicatorEl = document.getElementById('menuDetailSlideIndicator');
    const priceEl = document.getElementById('menuDetailPrice');
    const availabilityEl = document.getElementById('menuDetailAvailability');
    const categoryEl = document.getElementById('menuDetailCategory');
    const menuIdEl = document.getElementById('menuDetailMenuId');
    const ordersCountEl = document.getElementById('menuDetailOrdersCount');
    const descriptionEl = document.getElementById('menuDetailDescription');
    const ingredientsListEl = document.getElementById('menuDetailIngredients');
    const priceInput = document.getElementById('menuDetailPriceInput');
    const availabilityInput = document.getElementById('menuDetailAvailabilityInput');
    const categoryInput = document.getElementById('menuDetailCategoryInput');
    const descriptionInput = document.getElementById('menuDetailDescriptionInput');

    if (!section) return;

    if (!menuState || !menuState.length || !menuDetailVisible) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';
    
    // Reset new image file when rendering (user navigated to different item)
    menuDetailNewImageFile = null;

    if (currentMenuDetailIndex < 0 || currentMenuDetailIndex >= menuState.length) {
        currentMenuDetailIndex = 0;
    }

    const item = menuState[currentMenuDetailIndex];
    const statusInfo = getMenuItemStatus(item);
    const ordersCount = getMenuItemOrderCount(item);

    if (slideIndicatorEl) {
        slideIndicatorEl.textContent = `${currentMenuDetailIndex + 1} / ${menuState.length}`;
    }

    // Handle image display - use same approach as catalogue (innerHTML)
    const imageContainer = document.getElementById('menuDetailImageContainer');
    if (imageContainer) {
        // Force container to have dimensions - the padding-top: 40% aspect ratio needs a width
        // Get the wrapper to ensure it has width
        const imageWrapper = imageContainer.closest('.menu-detail-image-wrapper');
        if (imageWrapper) {
            // Force wrapper to have width
            const wrapperStyle = window.getComputedStyle(imageWrapper);
            if (parseInt(wrapperStyle.width) === 0) {
                imageWrapper.style.width = '100%';
                imageWrapper.style.maxWidth = '800px';
                imageWrapper.style.display = 'block';
            }
        }
        
        // Force container dimensions
        imageContainer.style.width = '100%';
        imageContainer.style.position = 'relative';
        imageContainer.style.display = 'block';
        
        // Clear container and rebuild - same approach as catalogue
        // No longer include change image button in image container - it's now under Product Info
        const displayName = item.displayName || item.name;
        if (item.imageDataUrl && item.imageDataUrl.trim() !== '') {
            // Set image and caption directly via innerHTML like catalogue does
            imageContainer.innerHTML = `
                <img id="menuDetailImage" src="${item.imageDataUrl}" alt="${displayName || 'Menu item image'}" style="position: absolute; top: 0; left: 0; width: 100% !important; height: 100% !important; object-fit: cover; display: block !important; visibility: visible !important; opacity: 1 !important; z-index: 0;">
                <div class="menu-detail-image-caption" id="menuDetailName" style="z-index: 2;">${displayName || 'Menu item'}</div>
            `;
            
            // Get the new image element and add handlers
            const newImageEl = document.getElementById('menuDetailImage');
            if (newImageEl) {
                newImageEl.onerror = function() {
                    console.warn('Product Detail - Failed to load image:', item.imageDataUrl);
                    imageContainer.innerHTML = `
                        <div class="menu-detail-image-placeholder">${(displayName || '?').charAt(0).toUpperCase()}</div>
                        <div class="menu-detail-image-caption" id="menuDetailName">${displayName || 'Menu item'}</div>
                    `;
                };
                newImageEl.onload = function() {
                    // Ensure it's visible
                    this.style.display = 'block';
                    this.style.visibility = 'visible';
                    this.style.opacity = '1';
                };
            }
        } else {
            // No image URL - show placeholder
            console.log('Product Detail - No imageDataUrl for:', item.name);
            imageContainer.innerHTML = `
                <div class="menu-detail-image-placeholder">${(displayName || '?').charAt(0).toUpperCase()}</div>
                <div class="menu-detail-image-caption" id="menuDetailName">${displayName || 'Menu item'}</div>
            `;
        }
    }

    if (captionEl) captionEl.textContent = item.name || 'Menu item';
    if (priceEl) priceEl.textContent = `PHP ${Number(item.price || 0).toFixed(2)}`;
    if (availabilityEl) availabilityEl.textContent = statusInfo.label || '—';
    if (categoryEl) categoryEl.textContent = item.category || 'Uncategorized';
    if (menuIdEl) menuIdEl.textContent = item.menuId || item.id || '—';
    if (ordersCountEl) ordersCountEl.textContent = String(ordersCount || 0);
    if (descriptionEl) descriptionEl.textContent = item.description || '—';
    
    const allergensEl = document.getElementById('menuDetailAllergens');
    const allergensInput = document.getElementById('menuDetailAllergensInput');
    if (allergensEl) allergensEl.textContent = item.allergens || '—';
    if (allergensInput) allergensInput.value = item.allergens || '';

    if (priceInput) priceInput.value = Number(item.price || 0).toFixed(2);
    if (availabilityInput) availabilityInput.value = String(item.isActive !== false);
    if (categoryInput) {
        const categoryValue = item.category || 'Popular';
        categoryInput.value = categoryValue;
        // Check if category exists in options, if not, show custom input
        const categoryCustom = document.getElementById('menuDetailCategoryCustom');
        const optionExists = Array.from(categoryInput.options).some(opt => opt.value === categoryValue);
        if (categoryCustom) {
            if (!optionExists && categoryValue) {
                categoryCustom.value = categoryValue;
                categoryCustom.style.display = 'block';
                categoryInput.value = '';
            } else {
                categoryCustom.value = '';
                categoryCustom.style.display = 'none';
            }
        }
    }
    if (descriptionInput) descriptionInput.value = item.description || '';
    if (allergensInput) allergensInput.value = item.allergens || '';

    if (ingredientsListEl) {
        if (!item.ingredients || !item.ingredients.length) {
            ingredientsListEl.innerHTML = '<li class="empty-state">No ingredients linked yet.</li>';
        } else {
            ingredientsListEl.innerHTML = item.ingredients.map(ing => `
                <li>
                    <span>${ing.ingredientName || ing.ingredientId}</span>
                    <small>${ing.displayAmount || ''}</small>
                </li>
            `).join('');
        }
    }

    // Render variations
    const variationsListEl = document.getElementById('menuDetailVariations');
    if (variationsListEl) {
        if (menuDetailEditing) {
            // Edit mode - show editable variations
            if (!item.variations || !item.variations.length) {
                variationsListEl.innerHTML = '<div class="empty-state">No variations added yet. Click "Add Variation" to add one.</div>';
            } else {
                variationsListEl.innerHTML = item.variations.map((variation, index) => {
                    const variationId = `menuDetailVariation_${index}`;
                    
                    // Get already used ingredients from previous variations
                    const usedIngredientIds = new Set();
                    item.variations.forEach((v, idx) => {
                        if (idx < index && v.ingredientId) {
                            usedIngredientIds.add(v.ingredientId);
                        }
                    });
                    
                    // Get available ingredients
                    const availableIngredients = inventoryState.filter(ing => 
                        !usedIngredientIds.has(ing.id) || ing.id === variation.ingredientId
                    );
                    
                    const ingredientOptions = availableIngredients.map(ing => 
                        `<option value="${ing.name}" ${variation.ingredientId === ing.id ? 'selected' : ''}>${ing.name}</option>`
                    ).join('');
                    
                    // Parse displayAmount to extract amount and unit
                    let amountValue = '';
                    let unitValue = '';
                    if (variation.displayAmount) {
                        const match = variation.displayAmount.match(/^([\d.]+)\s+(.+)$/);
                        if (match) {
                            amountValue = match[1];
                            unitValue = match[2].toLowerCase();
                            // Normalize unit values
                            if (unitValue === 'pieces' || unitValue === 'piece') unitValue = 'pcs';
                            if (unitValue === 'grams' || unitValue === 'gram') unitValue = 'g';
                            if (unitValue === 'kilograms' || unitValue === 'kilogram') unitValue = 'kg';
                        }
                    }
                    
                    // Find the ingredient to determine unit type
                    const variationIngredient = inventoryState.find(ing => ing.id === variation.ingredientId);
                    const unitType = variationIngredient?.unitType || 'weight';
                    const defaultUnit = unitType === 'count' ? 'pcs' : 'g';
                    const finalUnit = unitValue || defaultUnit;
                    const unitOptions = unitType === 'count' 
                        ? `<option value="pcs" ${finalUnit === 'pcs' ? 'selected' : ''}>Pieces (pcs)</option>`
                        : `<option value="g" ${finalUnit === 'g' ? 'selected' : ''}>Grams (g)</option>
                           <option value="kg" ${finalUnit === 'kg' ? 'selected' : ''}>Kilograms (kg)</option>`;
                    
                    return `
                    <div class="menu-detail-variation-item menu-detail-variation-item-editable" id="${variationId}">
                        <div class="variation-item-content">
                            <div class="form-group">
                                <input type="text" class="form-control menu-detail-variation-name-input" placeholder="Variation name" value="${variation.name || ''}" required>
                            </div>
                            <div class="form-group">
                                <input type="number" class="form-control menu-detail-variation-price-input" placeholder="Price (PHP)" value="${variation.price || 0}" min="0" step="0.01" required>
                            </div>
                            <div class="form-group">
                                <select class="form-control menu-detail-variation-ingredient" required>
                                    <option value="">Select Ingredient</option>
                                    ${ingredientOptions}
                                </select>
                            </div>
                            <div class="form-group">
                                <input type="number" class="form-control menu-detail-variation-amount-input" placeholder="Amount" min="0" step="${unitType === 'count' ? '1' : '0.01'}" value="${amountValue}">
                            </div>
                            <div class="form-group">
                                <select class="form-control menu-detail-variation-unit-input" ${variationIngredient ? '' : 'disabled'}>
                                    ${variationIngredient ? unitOptions : '<option value="">Select ingredient first</option>'}
                                </select>
                            </div>
                            <button type="button" class="btn btn-danger btn-sm" onclick="removeMenuDetailVariation('${variationId}')" style="flex: 0 0 auto;">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                        <div class="form-group variation-description-group">
                            <textarea class="form-control menu-detail-variation-description-input" placeholder="Short description (optional)" rows="2">${variation.description || ''}</textarea>
                        </div>
                    </div>
                `;
                }).join('');
                
                // Add event handlers for ingredient selection in rendered variations
                variationsListEl.querySelectorAll('.menu-detail-variation-item-editable').forEach(variationItem => {
                    const ingredientSelect = variationItem.querySelector('.menu-detail-variation-ingredient');
                    const amountInput = variationItem.querySelector('.menu-detail-variation-amount-input');
                    const unitSelect = variationItem.querySelector('.menu-detail-variation-unit-input');
                    
                    if (ingredientSelect) {
                        // Remove existing listeners to avoid duplicates
                        const newIngredientSelect = ingredientSelect.cloneNode(true);
                        ingredientSelect.parentNode.replaceChild(newIngredientSelect, ingredientSelect);
                        
                        newIngredientSelect.addEventListener('change', function() {
                            const selectedIngredient = findIngredientInStateByName(this.value);
                            const currentAmountInput = variationItem.querySelector('.menu-detail-variation-amount-input');
                            const currentUnitSelect = variationItem.querySelector('.menu-detail-variation-unit-input');
                            
                            if (selectedIngredient) {
                                variationItem.dataset.ingredientId = selectedIngredient.id;
                                
                                // Update unit options based on ingredient type
                                if (currentUnitSelect) {
                                    if (selectedIngredient.unitType === 'count') {
                                        currentUnitSelect.innerHTML = '<option value="pcs">Pieces (pcs)</option>';
                                        currentUnitSelect.value = 'pcs';
                                    } else {
                                        currentUnitSelect.innerHTML = `
                                            <option value="g">Grams (g)</option>
                                            <option value="kg">Kilograms (kg)</option>
                                        `;
                                        currentUnitSelect.value = 'g';
                                    }
                                    currentUnitSelect.disabled = false;
                                }
                                
                                // Update amount input step and placeholder
                                if (currentAmountInput) {
                                    currentAmountInput.step = selectedIngredient.unitType === 'count' ? '1' : '0.01';
                                    currentAmountInput.placeholder = selectedIngredient.unitType === 'count' ? '0' : '0.00';
                                }
                            } else {
                                variationItem.dataset.ingredientId = '';
                                if (currentUnitSelect) {
                                    currentUnitSelect.innerHTML = '<option value="">Select ingredient first</option>';
                                    currentUnitSelect.disabled = true;
                                }
                            }
                        });
                    }
                });
            }
            // Add "Add Variation" button in edit mode if it doesn't exist
            if (!variationsListEl.querySelector('button[onclick*="addMenuDetailVariation"]')) {
                const addButton = document.createElement('button');
                addButton.type = 'button';
                addButton.className = 'btn btn-secondary btn-sm';
                addButton.style.marginTop = '10px';
                addButton.innerHTML = '<i class="fas fa-plus"></i> Add Variation';
                addButton.onclick = addMenuDetailVariation;
                variationsListEl.appendChild(addButton);
            }
        } else {
            // View mode - show read-only variations
            if (!item.variations || !item.variations.length) {
                variationsListEl.innerHTML = '<div class="empty-state">No variations added yet.</div>';
            } else {
                variationsListEl.innerHTML = item.variations.map(variation => {
                    const ingredientName = variation.ingredientName || (variation.ingredientId ? 'Unknown Ingredient' : '');
                    const amountDisplay = variation.displayAmount ? `Amount: ${variation.displayAmount}` : '';
                    return `
                    <div class="menu-detail-variation-item">
                        <div class="menu-detail-variation-header">
                            <span class="menu-detail-variation-name">${variation.name || 'Unnamed Variation'}</span>
                            <span class="menu-detail-variation-price">PHP ${Number(variation.price || 0).toFixed(2)}</span>
                        </div>
                        ${ingredientName ? `<div class="menu-detail-variation-ingredient">Ingredient: ${ingredientName}</div>` : ''}
                        ${amountDisplay ? `<div class="menu-detail-variation-amount">${amountDisplay}</div>` : ''}
                        ${variation.description ? `<div class="menu-detail-variation-description">${variation.description}</div>` : ''}
                    </div>
                `;
                }).join('');
            }
        }
    }
}

// Extract storage path from Firebase Storage URL
function extractStoragePathFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    
    try {
        // Firebase Storage URLs have format:
        // https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encodedPath}?alt=media&token={token}
        const urlObj = new URL(url);
        const pathMatch = urlObj.pathname.match(/\/o\/(.+)\?/);
        if (pathMatch) {
            // Decode the path (it's URL encoded)
            return decodeURIComponent(pathMatch[1]);
        }
    } catch (error) {
        console.error('Error extracting storage path from URL:', error);
    }
    return null;
}

// Delete image from Firebase Storage
async function deleteImageFromStorage(storagePath) {
    if (!storagePath) return;
    
    try {
        if (!isStorageReady()) {
            await waitForFirebaseReady();
            if (!isStorageReady()) {
                throw new Error('Firebase Storage is not initialized.');
            }
        }
        
        const { ref, deleteObject } = window.storageFunctions;
        const storage = window.storage;
        
        const imageRef = ref(storage, storagePath);
        await deleteObject(imageRef);
        console.log('Successfully deleted image from storage:', storagePath);
    } catch (error) {
        // If file doesn't exist, that's okay - just log it
        if (error.code === 'storage/object-not-found') {
            console.log('Image not found in storage (may have been already deleted):', storagePath);
        } else {
            console.error('Error deleting image from storage:', error);
            throw error;
        }
    }
}

// Handle image file selection in product detail
function handleMenuDetailImageSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
        showNotification('Please select a valid image file.', 'error');
        return;
    }
    
    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB in bytes
    if (file.size > maxSize) {
        showNotification('Image size must be less than 5MB.', 'error');
        return;
    }
    
    // Store the file for upload when saving
    menuDetailNewImageFile = file;
    
    // Show preview immediately using FileReader
    const reader = new FileReader();
    reader.onload = function(e) {
        const imageContainer = document.getElementById('menuDetailImageContainer');
        if (imageContainer) {
            const imageEl = imageContainer.querySelector('#menuDetailImage');
            const captionEl = imageContainer.querySelector('#menuDetailName');
            
            if (imageEl && captionEl) {
                // Update existing image
                imageEl.src = e.target.result;
                imageEl.style.display = 'block';
                imageEl.style.visibility = 'visible';
                imageEl.style.opacity = '1';
            } else {
                // Rebuild if elements don't exist
                const item = menuState[currentMenuDetailIndex];
                const itemName = item ? item.name : 'Menu item';
                imageContainer.innerHTML = `
                    <img id="menuDetailImage" src="${e.target.result}" alt="${itemName}" style="position: absolute; top: 0; left: 0; width: 100% !important; height: 100% !important; object-fit: cover; display: block !important; visibility: visible !important; opacity: 1 !important; z-index: 0;">
                    <div class="menu-detail-image-caption" id="menuDetailName" style="z-index: 2;">${itemName}</div>
                `;
            }
        }
    };
    reader.onerror = function() {
        showNotification('Failed to read image file.', 'error');
        menuDetailNewImageFile = null;
    };
    reader.readAsDataURL(file);
    
    showNotification('Image selected. Click Save to upload the new image.', 'success');
}

async function saveMenuDetailChanges() {
    if (!menuState || !menuState.length) return false;
    const currentItem = menuState[currentMenuDetailIndex];
    if (!currentItem) return false;

    const priceInput = document.getElementById('menuDetailPriceInput');
    const availabilityInput = document.getElementById('menuDetailAvailabilityInput');
    const categoryInput = document.getElementById('menuDetailCategoryInput');
    const categoryCustom = document.getElementById('menuDetailCategoryCustom');
    const descriptionInput = document.getElementById('menuDetailDescriptionInput');
    const allergensInput = document.getElementById('menuDetailAllergensInput');

    const priceValue = parseFloat(priceInput?.value || '0');
    const availabilityValue = availabilityInput?.value === 'true';
    // Get category from custom input if filled, otherwise from select
    const categoryValue = (categoryCustom?.value?.trim() || categoryInput?.value || currentItem.category || 'Popular').trim();
    if (categoryValue && categoryCustom?.value?.trim()) {
        // Add to select if it's a new category
        addCategoryToSelects(categoryValue);
    }
    const descriptionValue = (descriptionInput?.value || '').trim();
    const allergensValue = (allergensInput?.value || '').trim() || null;

    if (!priceValue || priceValue <= 0) {
        showNotification('Enter a price greater than zero.', 'error');
        return false;
    }

    try {
        await waitForFirebaseReady();
        
        let newImageUrl = currentItem.imageDataUrl; // Keep existing image by default
        
        // Handle image replacement if a new image was selected
        if (menuDetailNewImageFile) {
            try {
                // Extract old image path from current imageDataUrl BEFORE uploading new one
                const oldImagePath = extractStoragePathFromUrl(currentItem.imageDataUrl);
                
                // Upload new image
                const { ref, uploadBytes, getDownloadURL } = window.storageFunctions;
                const storage = window.storage;
                
                // Generate unique filename
                const timestamp = Date.now();
                const fileExtension = menuDetailNewImageFile.name.split('.').pop();
                const fileName = `menu_${timestamp}.${fileExtension}`;
                const storagePath = `menuImages/${fileName}`;
                
                // Create storage reference and upload
                const imageRef = ref(storage, storagePath);
                await uploadBytes(imageRef, menuDetailNewImageFile);
                newImageUrl = await getDownloadURL(imageRef);
                
                // Delete old image if it exists and is from Firebase Storage
                // This MUST happen after successful upload to ensure we don't lose the image if upload fails
                if (oldImagePath) {
                    // Check if it's a Firebase Storage URL (starts with menuImages/)
                    if (oldImagePath.startsWith('menuImages/')) {
                        try {
                            await deleteImageFromStorage(oldImagePath);
                            console.log('Successfully deleted old image from storage:', oldImagePath);
                        } catch (deleteError) {
                            // Log but don't fail the save operation if deletion fails
                            console.error('Warning: Failed to delete old image from storage:', deleteError);
                        }
                    } else {
                        // Also try to extract path from URL if it's a full URL
                        console.log('Old image path does not start with menuImages/, skipping deletion:', oldImagePath);
                    }
                }
                
                // Clear the new image file
                menuDetailNewImageFile = null;
                
                showNotification('New image uploaded successfully.', 'success');
            } catch (error) {
                console.error('Error replacing image:', error);
                showNotification('Failed to upload new image. ' + (error.message || ''), 'error');
                return false;
            }
        }
        
        // Gather variations from edit form
        const variations = gatherMenuDetailVariations();
        
        const payload = {
            price: +Number(priceValue).toFixed(2),
            isActive: availabilityValue,
            category: categoryValue,
            deliveryCharge: 0, // Set to 0 since delivery charge field is removed
            description: descriptionValue,
            allergens: allergensValue,
            variations: variations,
            imageDataUrl: newImageUrl
        };
        menuState = await MenuStore.updateItem(currentItem.id, payload);
        renderMenuState();
        showNotification('Menu item updated successfully.', 'success');
        setMenuDetailEditMode(false);
        return true;
    } catch (error) {
        console.error('Inline menu update failed:', error);
        showNotification(error.message || 'Unable to update that menu item.', 'error');
        return false;
    }
}

function showUnsavedChangesDialog() {
    return new Promise((resolve) => {
        const dialog = document.createElement('div');
        dialog.className = 'modal';
        dialog.style.display = 'flex';
        dialog.style.alignItems = 'center';
        dialog.style.justifyContent = 'center';
        dialog.innerHTML = `
            <div class="modal-content" style="max-width: 400px; width: 90%;">
                <div class="modal-header">
                    <h2>Unsaved Changes</h2>
                </div>
                <div class="modal-body">
                    <p>You have unsaved changes. What would you like to do?</p>
                </div>
                <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button class="btn btn-secondary" id="unsavedDialogCancel">Cancel</button>
                    <button class="btn btn-warning" id="unsavedDialogDiscard">Discard</button>
                    <button class="btn btn-primary" id="unsavedDialogSave">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);

        const closeDialog = (action) => {
            document.body.removeChild(dialog);
            resolve(action);
        };

        document.getElementById('unsavedDialogSave').onclick = () => closeDialog('save');
        document.getElementById('unsavedDialogDiscard').onclick = () => closeDialog('discard');
        document.getElementById('unsavedDialogCancel').onclick = () => closeDialog('cancel');
        
        dialog.onclick = (e) => {
            if (e.target === dialog) closeDialog('cancel');
        };
    });
}

async function nextMenuDetail() {
    if (!menuState || !menuState.length) return;
    
    if (menuDetailEditing) {
        const action = await showUnsavedChangesDialog();
        if (action === 'cancel') {
            return;
        }
        if (action === 'save') {
            const saved = await saveMenuDetailChanges();
            if (!saved) return;
        } else if (action === 'discard') {
            setMenuDetailEditMode(false);
        }
    }
    
    currentMenuDetailIndex = (currentMenuDetailIndex + 1) % menuState.length;
    renderMenuDetailsCarousel();
}

async function prevMenuDetail() {
    if (!menuState || !menuState.length) return;
    
    if (menuDetailEditing) {
        const action = await showUnsavedChangesDialog();
        if (action === 'cancel') {
            return;
        }
        if (action === 'save') {
            const saved = await saveMenuDetailChanges();
            if (!saved) return;
        } else if (action === 'discard') {
            setMenuDetailEditMode(false);
        }
    }
    
    currentMenuDetailIndex = (currentMenuDetailIndex - 1 + menuState.length) % menuState.length;
    renderMenuDetailsCarousel();
}

function updatePageTitle(parentSection, subtitle) {
    const pageTitleH2 = document.querySelector('.page-title h2');
    if (pageTitleH2) {
        if (subtitle) {
            pageTitleH2.textContent = `${parentSection} / ${subtitle}`;
        } else {
            pageTitleH2.textContent = parentSection;
        }
    }
}

function showMenuCatalogue() {
    // Show catalogue (cards), hide list table, add product + product detail
    const foodSection = document.getElementById('foodSection');
    const addFoodSection = document.getElementById('addFoodDashboard');
    const productDetailSection = document.getElementById('menu-product-detail');
    const catalogueGrid = document.getElementById('menu-catalogue-grid');
    const menuListTable = document.getElementById('menu-list');
    if (foodSection) foodSection.style.display = 'block';
    if (catalogueGrid) catalogueGrid.style.display = 'block';
    if (menuListTable) menuListTable.style.display = 'none';
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (productDetailSection) productDetailSection.style.display = 'none';
    menuDetailVisible = false;
    menuDetailEditing = false;
    renderMenuDetailsCarousel();
    updatePageTitle('Menu', 'Menu Catalogue');
    // Only update hash if it's not already set to menu-catalogue
    const currentHash = window.location.hash;
    if (currentHash !== '#menu-catalogue') {
        // Use replaceState to avoid triggering hashchange event
        if (history.replaceState) {
            history.replaceState(null, null, '#menu-catalogue');
        } else {
            window.location.hash = '#menu-catalogue';
        }
    }
}

function showMenuList() {
    // Show list table (active items only), hide catalogue cards, add product + product detail
    const foodSection = document.getElementById('foodSection');
    const addFoodSection = document.getElementById('addFoodDashboard');
    const productDetailSection = document.getElementById('menu-product-detail');
    const catalogueGrid = document.getElementById('menu-catalogue-grid');
    const menuListTable = document.getElementById('menu-list');
    if (foodSection) foodSection.style.display = 'block';
    if (catalogueGrid) catalogueGrid.style.display = 'none';
    if (menuListTable) menuListTable.style.display = 'block';
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (productDetailSection) productDetailSection.style.display = 'none';
    menuDetailVisible = false;
    menuDetailEditing = false;
    renderMenuDetailsCarousel();
    renderMenuListTable();
    updatePageTitle('Menu', 'Menu List');
    // Only update hash if it's not already set to menu-list
    const currentHash = window.location.hash;
    if (currentHash !== '#menu-list') {
        // Use replaceState to avoid triggering hashchange event
        if (history.replaceState) {
            history.replaceState(null, null, '#menu-list');
        } else {
            window.location.hash = '#menu-list';
        }
    }
}

function showAddProduct() {
    // Show add product, hide catalogue and product detail
    const foodSection = document.getElementById('foodSection');
    const addFoodSection = document.getElementById('addFoodDashboard');
    const productDetailSection = document.getElementById('menu-product-detail');
    if (foodSection) foodSection.style.display = 'none';
    if (addFoodSection) addFoodSection.style.display = 'block';
    if (productDetailSection) productDetailSection.style.display = 'none';
    menuDetailVisible = false;
    menuDetailEditing = false;
    renderMenuDetailsCarousel();
    updatePageTitle('Menu', 'Add Product');
    // Only update hash if it's not already set to addFoodDashboard
    const currentHash = window.location.hash;
    if (currentHash !== '#addFoodDashboard' && currentHash !== '#add-product') {
        // Use replaceState to avoid triggering hashchange event
        if (history.replaceState) {
            history.replaceState(null, null, '#addFoodDashboard');
        } else {
            window.location.hash = '#addFoodDashboard';
        }
    }
}

function showMenuProductDetail() {
    // Hide catalogue and add product, show product detail carousel
    const foodSection = document.getElementById('foodSection');
    const addFoodSection = document.getElementById('addFoodDashboard');
    const productDetailSection = document.getElementById('menu-product-detail');
    if (foodSection) foodSection.style.display = 'none';
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (productDetailSection) productDetailSection.style.display = 'block';
    if (!menuState || !menuState.length) {
        menuDetailVisible = false;
        renderMenuDetailsCarousel();
        updatePageTitle('Menu', 'Product Detail');
        // Still highlight the dropdown item even if no menu items
        setTimeout(() => {
            if (window.highlightActiveMenuItem) {
                window.highlightActiveMenuItem();
            }
        }, 50);
        return;
    }
    if (currentMenuDetailIndex < 0 || currentMenuDetailIndex >= menuState.length) {
        currentMenuDetailIndex = 0;
    }
    menuDetailVisible = true;
    menuDetailEditing = false;
    renderMenuDetailsCarousel();
    updatePageTitle('Menu', 'Product Detail');
    // Only update hash if it's not already set to menu-product-detail
    const currentHash = window.location.hash;
    if (currentHash !== '#menu-product-detail' && currentHash !== '#product-detail') {
        // Use replaceState to avoid triggering hashchange event
        if (history.replaceState) {
            history.replaceState(null, null, '#menu-product-detail');
        } else {
            window.location.hash = '#menu-product-detail';
        }
    }
    // Highlight the Product Detail dropdown item
    setTimeout(() => {
        if (window.highlightActiveMenuItem) {
            window.highlightActiveMenuItem();
        }
    }, 50);
}

function showMenuDetailForItem(menuItemId) {
    if (!menuState || !menuState.length) return;
    const index = menuState.findIndex(item => item.id === menuItemId);
    if (index === -1) return;
    currentMenuDetailIndex = index;
    showMenuProductDetail();
    // Highlight the Product Detail dropdown item
    setTimeout(() => {
        if (window.highlightActiveMenuItem) {
            window.highlightActiveMenuItem();
        }
    }, 50);
}

function setMenuDetailEditMode(isEditing) {
    menuDetailEditing = isEditing;
    const pairs = [
        ['menuDetailPrice', 'menuDetailPriceInput'],
        ['menuDetailAvailability', 'menuDetailAvailabilityInput'],
        ['menuDetailCategory', 'menuDetailCategoryInputWrapper'],
        ['menuDetailDescription', 'menuDetailDescriptionInput'],
        ['menuDetailAllergens', 'menuDetailAllergensInput']
    ];
    pairs.forEach(([textId, inputId]) => {
        const textEl = document.getElementById(textId);
        const inputEl = document.getElementById(inputId);
        if (textEl && inputEl) {
            textEl.style.display = isEditing ? 'none' : '';
            inputEl.style.display = isEditing ? '' : 'none';
        }
    });
    const editBtn = document.getElementById('menuDetailEditBtn');
    if (editBtn) {
        editBtn.textContent = isEditing ? 'Save' : 'Edit';
    }
    const discardBtn = document.getElementById('menuDetailDiscardBtn');
    if (discardBtn) {
        discardBtn.style.display = isEditing ? 'inline-block' : 'none';
    }
    // Show/hide change image button
    const changeImageRow = document.getElementById('menuDetailChangeImageRow');
    if (changeImageRow) {
        changeImageRow.style.display = isEditing ? 'block' : 'none';
    }
    // Re-render variations to show edit mode
    if (menuState && menuState.length && currentMenuDetailIndex >= 0) {
        renderMenuDetailsCarousel();
    }
}

async function toggleMenuDetailEdit() {
    if (!menuState || !menuState.length) return;
    const currentItem = menuState[currentMenuDetailIndex];
    if (!currentItem) return;

    // Enter edit mode
    if (!menuDetailEditing) {
        setMenuDetailEditMode(true);
        return;
    }

    // Save mode - use the shared save function
    await saveMenuDetailChanges();
}

function openMenuItemEditorFromDetail() {
    if (!menuState || !menuState.length) return;
    const currentItem = menuState[currentMenuDetailIndex];
    if (currentItem) {
        openMenuItemEditor(currentItem.id);
    }
}

function handleMenuItemDeleteFromDetail() {
    if (!menuState || !menuState.length) return;
    const currentItem = menuState[currentMenuDetailIndex];
    if (!currentItem) return;
    currentMenuEditItem = currentItem;
    handleMenuItemDelete();
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
        const amountInputValue = amountInput?.value || '';
        const amountValue = parseFloat(amountInputValue);

        // Skip empty rows (both name and amount are empty/zero)
        if (!ingredientName && (!amountValue || amountValue === 0)) {
            return;
        }

        // If ingredient name is provided, it must be valid
        if (ingredientName) {
            const ingredient = findIngredientInStateByName(ingredientName);
            if (!ingredient) {
                throw new Error(`Ingredient "${ingredientName || 'Unnamed'}" must match a registered inventory item. Please check the ingredient name matches exactly with an item in your inventory.`);
            }

            // Amount must be greater than zero if ingredient is specified
            if (!amountValue || amountValue <= 0) {
                throw new Error(`Amount for ${ingredient.name} must be greater than zero.`);
            }

            const unit = unitSelect?.value || (ingredient.unitType === 'count' ? 'pcs' : 'g');
            const baseAmount = convertToBaseUnits(amountValue, ingredient.unitType, unit);
            const displayAmount = ingredient.unitType === 'count'
                ? `${formatQuantityValue(amountValue, 0)} pcs`
                : `${formatQuantityValue(amountValue, unit === 'kg' ? 2 : 0)} ${unit}`;
            
            collected.push({
                ingredient,
                baseAmount,
                displayAmount
            });
        }
    });
    
        return collected;
}

async function handleMenuFormSubmit(event) {
    if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
    }

    const form = document.getElementById('menuItemForm');
    if (!form) return;

    // Get category from custom input if filled, otherwise from select
    const categorySelect = form.querySelector('#category');
    const categoryCustom = form.querySelector('#categoryCustom');
    const category = (categoryCustom?.value?.trim() || categorySelect?.value || 'Popular').trim();
    if (category && categoryCustom?.value?.trim()) {
        // Add to select if it's a new category
        addCategoryToSelects(category);
    }
    // Generate unique 8-digit food ID if not already set
    let foodId = (form.querySelector('#foodId')?.value || '').trim();
    if (!foodId) {
        try {
            if (!isFirestoreReady()) {
                await waitForFirebaseReady();
            }
            foodId = await MenuStore.generateUniqueFoodId();
            const foodIdInput = form.querySelector('#foodId');
            if (foodIdInput) {
                foodIdInput.value = foodId;
            }
        } catch (error) {
            console.error('Failed to generate food ID:', error);
            showNotification('Failed to generate food ID. Please try again.', 'error');
            return;
        }
    }
    
    const foodName = (form.querySelector('#foodName')?.value || '').trim();
    const displayName = (form.querySelector('#displayName')?.value || '').trim();
    const priceValue = parseFloat(form.querySelector('#price')?.value || '0');
    const quantityRaw = form.querySelector('#quantity')?.value || '';
    const quantityValue = quantityRaw === '' ? 0 : parseInt(quantityRaw, 10);
    const description = (form.querySelector('#description')?.value || '').trim();

    if (!foodName) {
        showNotification('Please enter a food name.', 'error');
        return;
    }

    if (!priceValue || priceValue <= 0) {
        showNotification('Please enter a price greater than zero.', 'error');
        return;
    }

    if (Number.isNaN(quantityValue) || quantityValue < 0) {
        showNotification('Quantity must be zero or a positive whole number.', 'error');
        return;
    }

    if (!description) {
        showNotification('Please enter a description.', 'error');
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

        const linkedMealId = (form.querySelector('#linkedMeal')?.value || '').trim();
        const limitedStartDate = form.querySelector('#limitedStartDate')?.value || null;
        const limitedEndDate = form.querySelector('#limitedEndDate')?.value || null;
        
        // Upload image to Firebase Storage if a file was selected
        let imageUrl = uploadedFoodImageDataUrl; // Use existing URL if from gallery
        if (uploadedFoodImageFile && !imageUrl) {
            try {
                imageUrl = await uploadImageToStorage(uploadedFoodImageFile);
                uploadedFoodImageDataUrl = imageUrl; // Store for potential reuse
            } catch (uploadError) {
                showNotification(`Failed to upload image: ${uploadError.message}`, 'error');
                return; // Don't create menu item if image upload fails
            }
        }
        
        // Gather additional variations (excluding the first one which comes from form inputs)
        const additionalVariations = gatherVariations();
        
        // Get the first ingredient for the first variation
        // The first variation represents the default product details
        const firstIngredient = selectedIngredients.length > 0 ? selectedIngredients[0] : null;
        if (!firstIngredient) {
            showNotification('Add at least one ingredient from the inventory.', 'error');
            return;
        }
        
        // Create first variation from initial product details (form inputs)
        // This first variation IS the default product details
        const firstVariation = {
            name: formattedName, // Use the food name as variation name
            price: +Number(priceValue).toFixed(2),
            description: description || '',
            ingredientId: firstIngredient.ingredient.id,
            ingredientName: firstIngredient.ingredient.name,
            amount: firstIngredient.baseAmount,
            displayAmount: firstIngredient.displayAmount
        };
        
        // Combine first variation with additional variations
        const variations = [firstVariation, ...additionalVariations];
        
        // ALL ingredients from the form should appear in the main ingredients list
        // The first variation's ingredient should also be in the ingredients list
        // This way, when viewing the product, the default details (first variation) match the main ingredients
        const allIngredients = selectedIngredients;
        
        const menuPayload = {
            slug,
            data: {
                menuId: foodId || slug.toUpperCase(),
                name: formattedName, // Internal name
                displayName: displayName ? formatIngredientLabel(displayName) : formattedName, // Customer-facing name
                category,
                price: +Number(priceValue).toFixed(2), // Keep price for backward compatibility
                quantity: quantityValue,
                deliveryCharge: 0, // Set to 0 since delivery charge field is removed
                description,
                allergens: (document.getElementById('allergens')?.value || '').trim() || null,
                imageDataUrl: imageUrl,
                isActive: true,
                linkedMealId: linkedMealId || null,
                limitedStartDate: limitedStartDate || null,
                limitedEndDate: limitedEndDate || null,
                variations: variations,
                ingredients: allIngredients.map(entry => ({
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

// Variation management functions
let variationCounter = 0;

function addVariation() {
    const variationsList = document.getElementById('variationsList');
    if (!variationsList) return;
    
    // Get already used ingredients from existing variations
    const existingVariations = variationsList.querySelectorAll('.variation-item');
    const usedIngredientIds = new Set();
    
    existingVariations.forEach(variation => {
        const ingredientSelect = variation.querySelector('.variation-ingredient');
        if (ingredientSelect && ingredientSelect.value) {
            const ingredient = findIngredientInStateByName(ingredientSelect.value);
            if (ingredient) {
                usedIngredientIds.add(ingredient.id);
            }
        }
    });
    
    // Get available ingredients (excluding already used ones in variations)
    // Note: The first ingredient from main ingredients can still be used in variations
    const availableIngredients = inventoryState.filter(ing => !usedIngredientIds.has(ing.id));
    
    if (availableIngredients.length === 0) {
        showNotification('No more ingredients available. Each variation must use a different ingredient.', 'error');
        return;
    }
    
    const variationId = `variation_${variationCounter++}`;
    const variationItem = document.createElement('div');
    variationItem.className = 'variation-item';
    variationItem.id = variationId;
    
    // Build ingredient options HTML
    const ingredientOptions = availableIngredients.map(ing => 
        `<option value="${ing.name}">${ing.name}</option>`
    ).join('');
    
    variationItem.innerHTML = `
        <div class="variation-item-content">
            <div class="form-group">
                <input type="text" class="form-control variation-name" placeholder="Variation name (e.g., Medium, Large)" required>
            </div>
            <div class="form-group">
                <input type="number" class="form-control variation-price" placeholder="Price (PHP)" min="0" step="0.01" required>
            </div>
            <div class="form-group">
                <select class="form-control variation-ingredient" required>
                    <option value="">Select Ingredient</option>
                    ${ingredientOptions}
                </select>
            </div>
            <div class="form-group">
                <input type="number" class="form-control variation-amount" placeholder="Amount" min="0" step="0.01">
            </div>
            <div class="form-group">
                <select class="form-control variation-unit" disabled>
                    <option value="">Select ingredient first</option>
                </select>
            </div>
            <button type="button" class="btn btn-danger btn-sm" onclick="removeVariation('${variationId}')" style="flex: 0 0 auto;">
                <i class="fas fa-trash"></i>
            </button>
        </div>
        <div class="form-group variation-description-group">
            <textarea class="form-control variation-description" placeholder="Short description (optional)" rows="2"></textarea>
        </div>
    `;
    
    // Handle ingredient selection
    const ingredientSelect = variationItem.querySelector('.variation-ingredient');
    const amountInput = variationItem.querySelector('.variation-amount');
    const unitSelect = variationItem.querySelector('.variation-unit');
    
    ingredientSelect.addEventListener('change', function() {
        const selectedIngredient = findIngredientInStateByName(this.value);
        if (selectedIngredient) {
            variationItem.dataset.ingredientId = selectedIngredient.id;
            
            // Update unit options based on ingredient type
            if (unitSelect) {
                if (selectedIngredient.unitType === 'count') {
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
            
            // Update amount input step and placeholder
            if (amountInput) {
                amountInput.step = selectedIngredient.unitType === 'count' ? '1' : '0.01';
                amountInput.placeholder = selectedIngredient.unitType === 'count' ? '0' : '0.00';
            }
        } else {
            variationItem.dataset.ingredientId = '';
            if (unitSelect) {
                unitSelect.innerHTML = '<option value="">Select ingredient first</option>';
                unitSelect.disabled = true;
            }
        }
    });
    
    variationsList.appendChild(variationItem);
}

function removeVariation(variationId) {
    const variationItem = document.getElementById(variationId);
    if (variationItem) {
        variationItem.remove();
    }
}

// Menu Detail Variation Management Functions
function gatherMenuDetailVariations() {
    const variationsListEl = document.getElementById('menuDetailVariations');
    if (!variationsListEl) return [];
    
    const variationItems = variationsListEl.querySelectorAll('.menu-detail-variation-item-editable');
    const variations = [];
    
    variationItems.forEach(item => {
        const nameInput = item.querySelector('.menu-detail-variation-name-input');
        const priceInput = item.querySelector('.menu-detail-variation-price-input');
        const descriptionInput = item.querySelector('.menu-detail-variation-description-input');
        const ingredientSelect = item.querySelector('.menu-detail-variation-ingredient');
        const amountInput = item.querySelector('.menu-detail-variation-amount-input');
        const unitSelect = item.querySelector('.menu-detail-variation-unit-input');
        
        const name = (nameInput?.value || '').trim();
        const price = parseFloat(priceInput?.value || '0');
        const description = (descriptionInput?.value || '').trim();
        const ingredientName = (ingredientSelect?.value || '').trim();
        const amountValue = parseFloat(amountInput?.value || '0');
        const unit = (unitSelect?.value || '').trim();
        
        if (name && !isNaN(price) && price >= 0 && ingredientName) {
            const ingredient = findIngredientInStateByName(ingredientName);
            if (!ingredient) {
                throw new Error(`Ingredient "${ingredientName}" must match a registered inventory item.`);
            }
            
            // Amount is required for variations
            if (!amountInput || !amountInput.value || isNaN(amountValue) || amountValue <= 0) {
                throw new Error(`Amount for variation "${name}" must be greater than zero.`);
            }
            
            // Get unit or use default based on ingredient type
            const finalUnit = unit || (ingredient.unitType === 'count' ? 'pcs' : 'g');
            const baseAmount = convertToBaseUnits(amountValue, ingredient.unitType, finalUnit);
            
            variations.push({
                name: name,
                price: Number(price.toFixed(2)),
                description: description || '',
                ingredientId: ingredient.id,
                ingredientName: ingredient.name,
                amount: baseAmount,
                displayAmount: ingredient.unitType === 'count'
                    ? `${formatQuantityValue(amountValue, 0)} pcs`
                    : `${formatQuantityValue(amountValue, finalUnit === 'kg' ? 2 : 0)} ${finalUnit}`
            });
        }
    });
    
    return variations;
}

function addMenuDetailVariation() {
    const variationsListEl = document.getElementById('menuDetailVariations');
    if (!variationsListEl) return;
    
    // Get already used ingredients from existing variations
    const existingVariations = variationsListEl.querySelectorAll('.menu-detail-variation-item-editable');
    const usedIngredientIds = new Set();
    existingVariations.forEach(variation => {
        const ingredientSelect = variation.querySelector('.menu-detail-variation-ingredient');
        if (ingredientSelect && ingredientSelect.value) {
            const ingredient = findIngredientInStateByName(ingredientSelect.value);
            if (ingredient) {
                usedIngredientIds.add(ingredient.id);
            }
        }
    });
    
    // Get available ingredients (excluding already used ones)
    const availableIngredients = inventoryState.filter(ing => !usedIngredientIds.has(ing.id));
    
    if (availableIngredients.length === 0) {
        showNotification('No more ingredients available. Each variation must use a different ingredient.', 'error');
        return;
    }
    
    // Remove empty state message if present
    const emptyState = variationsListEl.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    // Remove "Add Variation" button temporarily
    const addButton = variationsListEl.querySelector('button[onclick*="addMenuDetailVariation"]');
    if (addButton) {
        addButton.remove();
    }
    
    const variationIndex = variationsListEl.querySelectorAll('.menu-detail-variation-item-editable').length;
    const variationId = `menuDetailVariation_${variationIndex}`;
    const variationItem = document.createElement('div');
    variationItem.className = 'menu-detail-variation-item menu-detail-variation-item-editable';
    variationItem.id = variationId;
    
    // Build ingredient options HTML
    const ingredientOptions = availableIngredients.map(ing => 
        `<option value="${ing.name}">${ing.name}</option>`
    ).join('');
    
    variationItem.innerHTML = `
        <div class="variation-item-content">
            <div class="form-group">
                <input type="text" class="form-control menu-detail-variation-name-input" placeholder="Variation name" required>
            </div>
            <div class="form-group">
                <input type="number" class="form-control menu-detail-variation-price-input" placeholder="Price (PHP)" value="0" min="0" step="0.01" required>
            </div>
            <div class="form-group">
                <select class="form-control menu-detail-variation-ingredient" required>
                    <option value="">Select Ingredient</option>
                    ${ingredientOptions}
                </select>
            </div>
            <div class="form-group">
                <input type="number" class="form-control menu-detail-variation-amount-input" placeholder="Amount" min="0" step="0.01">
            </div>
            <div class="form-group">
                <select class="form-control menu-detail-variation-unit-input" disabled>
                    <option value="">Select ingredient first</option>
                </select>
            </div>
            <button type="button" class="btn btn-danger btn-sm" onclick="removeMenuDetailVariation('${variationId}')" style="flex: 0 0 auto;">
                <i class="fas fa-trash"></i>
            </button>
        </div>
        <div class="form-group variation-description-group">
            <textarea class="form-control menu-detail-variation-description-input" placeholder="Short description (optional)" rows="2"></textarea>
        </div>
    `;
    
    // Handle ingredient selection
    const ingredientSelect = variationItem.querySelector('.menu-detail-variation-ingredient');
    const amountInput = variationItem.querySelector('.menu-detail-variation-amount-input');
    const unitSelect = variationItem.querySelector('.menu-detail-variation-unit-input');
    
    ingredientSelect.addEventListener('change', function() {
        const selectedIngredient = findIngredientInStateByName(this.value);
        if (selectedIngredient) {
            variationItem.dataset.ingredientId = selectedIngredient.id;
            
            // Update unit options based on ingredient type
            if (unitSelect) {
                if (selectedIngredient.unitType === 'count') {
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
            
            // Update amount input step and placeholder
            if (amountInput) {
                amountInput.step = selectedIngredient.unitType === 'count' ? '1' : '0.01';
                amountInput.placeholder = selectedIngredient.unitType === 'count' ? '0' : '0.00';
            }
        } else {
            variationItem.dataset.ingredientId = '';
            if (unitSelect) {
                unitSelect.innerHTML = '<option value="">Select ingredient first</option>';
                unitSelect.disabled = true;
            }
        }
    });
    
    variationsListEl.appendChild(variationItem);
    
    // Re-add "Add Variation" button
    const newAddButton = document.createElement('button');
    newAddButton.type = 'button';
    newAddButton.className = 'btn btn-secondary btn-sm';
    newAddButton.style.marginTop = '10px';
    newAddButton.innerHTML = '<i class="fas fa-plus"></i> Add Variation';
    newAddButton.onclick = addMenuDetailVariation;
    variationsListEl.appendChild(newAddButton);
}

function removeMenuDetailVariation(variationId) {
    const variationItem = document.getElementById(variationId);
    if (variationItem) {
        variationItem.remove();
        
        // Check if no variations left, show empty state
        const variationsListEl = document.getElementById('menuDetailVariations');
        if (variationsListEl) {
            const remainingVariations = variationsListEl.querySelectorAll('.menu-detail-variation-item-editable');
            if (remainingVariations.length === 0) {
                const addButton = variationsListEl.querySelector('button[onclick*="addMenuDetailVariation"]');
                if (addButton) {
                    addButton.remove();
                }
                variationsListEl.innerHTML = '<div class="empty-state">No variations added yet. Click "Add Variation" to add one.</div>';
                const newAddButton = document.createElement('button');
                newAddButton.type = 'button';
                newAddButton.className = 'btn btn-secondary btn-sm';
                newAddButton.style.marginTop = '10px';
                newAddButton.innerHTML = '<i class="fas fa-plus"></i> Add Variation';
                newAddButton.onclick = addMenuDetailVariation;
                variationsListEl.appendChild(newAddButton);
            }
        }
    }
}

function gatherVariations() {
    const variationsList = document.getElementById('variationsList');
    if (!variationsList) return [];
    
    const variationItems = variationsList.querySelectorAll('.variation-item');
    const variations = [];
    
    variationItems.forEach(item => {
        const nameInput = item.querySelector('.variation-name');
        const priceInput = item.querySelector('.variation-price');
        const descriptionInput = item.querySelector('.variation-description');
        const ingredientSelect = item.querySelector('.variation-ingredient');
        const amountInput = item.querySelector('.variation-amount');
        const unitSelect = item.querySelector('.variation-unit');
        
        const name = (nameInput?.value || '').trim();
        const price = parseFloat(priceInput?.value || '0');
        const description = (descriptionInput?.value || '').trim();
        const ingredientName = (ingredientSelect?.value || '').trim();
        const amountValue = parseFloat(amountInput?.value || '0');
        const unit = (unitSelect?.value || '').trim();
        
        if (name && !isNaN(price) && price >= 0 && ingredientName) {
            const ingredient = findIngredientInStateByName(ingredientName);
            if (!ingredient) {
                throw new Error(`Ingredient "${ingredientName}" must match a registered inventory item.`);
            }
            
            // Amount is required for variations
            if (!amountInput || !amountInput.value || isNaN(amountValue) || amountValue <= 0) {
                throw new Error(`Amount for variation "${name}" must be greater than zero.`);
            }
            
            // Get unit or use default based on ingredient type
            const finalUnit = unit || (ingredient.unitType === 'count' ? 'pcs' : 'g');
            const baseAmount = convertToBaseUnits(amountValue, ingredient.unitType, finalUnit);
            
            variations.push({
                name: name,
                price: Number(price.toFixed(2)),
                description: description || '',
                ingredientId: ingredient.id,
                ingredientName: ingredient.name,
                amount: baseAmount,
                displayAmount: ingredient.unitType === 'count'
                    ? `${formatQuantityValue(amountValue, 0)} pcs`
                    : `${formatQuantityValue(amountValue, finalUnit === 'kg' ? 2 : 0)} ${finalUnit}`
            });
        }
    });
    
    return variations;
}

async function resetMenuForm() {
    const form = document.getElementById('menuItemForm');
    const foodIdInput = document.getElementById('foodId');
    
    // Set generating state before form reset
    if (foodIdInput) {
        foodIdInput.value = 'Generating...';
        foodIdInput.placeholder = 'Generating...';
    }
    
    if (form) {
        form.reset();
        // Restore generating state after reset (reset clears the value)
        if (foodIdInput) {
            foodIdInput.value = 'Generating...';
            foodIdInput.placeholder = 'Generating...';
        }
    }
    
    uploadedFoodImageDataUrl = null;
    uploadedFoodImageFile = null;
    removeImage();
    ensureDishIngredientBuilderInitialized();
    
    // Reset timeline visibility
    const timelineGroup = document.getElementById('limitedMealTimelineGroup');
    if (timelineGroup) {
        timelineGroup.style.display = 'none';
    }
    
    // Reset linked meal dropdown
    const linkedMealSelect = document.getElementById('linkedMeal');
    if (linkedMealSelect) {
        linkedMealSelect.value = '';
    }
    
    // Reset variations
    const variationsList = document.getElementById('variationsList');
    if (variationsList) {
        variationsList.innerHTML = '';
    }
    variationCounter = 0;
    
    // Generate and set new unique food ID immediately
    if (foodIdInput) {
        // Generate ID asynchronously without blocking
        (async () => {
            try {
                if (!isFirestoreReady()) {
                    await waitForFirebaseReady();
                }
                const foodId = await MenuStore.generateUniqueFoodId();
                // Update the input with the generated ID
                const currentInput = document.getElementById('foodId');
                if (currentInput) {
                    currentInput.value = foodId;
                    currentInput.placeholder = 'Auto-generated';
                }
            } catch (error) {
                console.error('Failed to generate food ID on form reset:', error);
                const currentInput = document.getElementById('foodId');
                if (currentInput) {
                    // Generate a simple fallback ID
                    const fallbackId = Date.now().toString().slice(-8).padStart(8, '0');
                    currentInput.value = fallbackId;
                    currentInput.placeholder = 'Auto-generated';
                }
            }
        })();
    }
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
        updateLinkedMealDropdown();
    } catch (error) {
        console.error('Unable to initialize menu management:', error);
        showNotification(error.message || 'Menu data could not be loaded.', 'error');
    }

    ensureDishIngredientBuilderInitialized();

    if (!menuForm.dataset.bound) {
        menuForm.addEventListener('submit', handleMenuFormSubmit);
        menuForm.dataset.bound = 'true';
    }
    
    // Handle category change to show/hide timeline
    const categorySelect = document.getElementById('category');
    if (categorySelect && !categorySelect.dataset.bound) {
        categorySelect.addEventListener('change', function() {
            const timelineGroup = document.getElementById('limitedMealTimelineGroup');
            if (timelineGroup) {
                timelineGroup.style.display = this.value === 'Limited Only' ? 'block' : 'none';
            }
        });
        categorySelect.dataset.bound = 'true';
    }
    
    // Populate linked meal dropdown
    updateLinkedMealDropdown();
    
    // Initialize categories from existing menu items
    if (menuState && menuState.length) {
        menuState.forEach(item => {
            if (item.category && !allCategories.includes(item.category)) {
                allCategories.push(item.category);
            }
        });
        updateFilterCategories();
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
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    
    // Try matching by slugified ID first
    const slug = InventoryStore.slugifyName ? InventoryStore.slugifyName(trimmedName) : trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let found = inventoryState.find(item => item.id === slug);
    
    // If not found by ID, try matching by name (case-insensitive)
    if (!found) {
        const lowerName = trimmedName.toLowerCase();
        found = inventoryState.find(item => {
            const itemName = (item.name || '').toLowerCase();
            return itemName === lowerName || itemName.includes(lowerName) || lowerName.includes(itemName);
        });
    }
    
    return found || null;
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
let customerUnsubscribe = null;

async function initCustomerManagement() {
    try {
        await waitForFirebaseReady();
        await loadCustomers();
        setupCustomerSearch();
        handleCustomerHashNavigation();
    } catch (error) {
        console.error('Failed to initialize customer management:', error);
        showNotification('Failed to load customers.', 'error');
    }
}

function showCustomerProfile() {
    const customerProfile = document.getElementById('customer-profile');
    const reviewsSection = document.getElementById('reviews');
    const mostOrderedSection = document.getElementById('most-ordered');
    
    if (!customerProfile) return; // Not on customer page
    
    if (customerProfile) customerProfile.style.display = 'flex';
    if (reviewsSection) reviewsSection.style.display = 'none';
    if (mostOrderedSection) mostOrderedSection.style.display = 'none';
    
    renderCustomersList();
    updatePageTitle('Customer', 'Customer Profile');
    
    const currentHash = window.location.hash;
    if (currentHash !== '#customer-profile') {
        if (history.replaceState) {
            history.replaceState(null, null, '#customer-profile');
        } else {
            window.location.hash = '#customer-profile';
        }
    }
}

function showCustomerReviews() {
    const customerProfile = document.getElementById('customer-profile');
    const reviewsSection = document.getElementById('reviews');
    const mostOrderedSection = document.getElementById('most-ordered');
    
    if (!reviewsSection) return; // Not on customer page
    
    if (customerProfile) customerProfile.style.display = 'none';
    if (reviewsSection) reviewsSection.style.display = 'block';
    if (mostOrderedSection) mostOrderedSection.style.display = 'none';
    
    // Load and display reviews for all customers
    loadAllCustomerReviews();
    updatePageTitle('Customer', 'Reviews');
    
    const currentHash = window.location.hash;
    if (currentHash !== '#reviews') {
        if (history.replaceState) {
            history.replaceState(null, null, '#reviews');
        } else {
            window.location.hash = '#reviews';
        }
    }
}

function showCustomerMostOrdered() {
    const customerProfile = document.getElementById('customer-profile');
    const reviewsSection = document.getElementById('reviews');
    const mostOrderedSection = document.getElementById('most-ordered');
    
    if (!mostOrderedSection) return; // Not on customer page
    
    if (customerProfile) customerProfile.style.display = 'none';
    if (reviewsSection) reviewsSection.style.display = 'none';
    if (mostOrderedSection) mostOrderedSection.style.display = 'block';
    
    // Load and display most ordered items for all customers
    loadAllCustomerMostOrdered();
    updatePageTitle('Customer', 'Most Ordered');
    
    const currentHash = window.location.hash;
    if (currentHash !== '#most-ordered') {
        if (history.replaceState) {
            history.replaceState(null, null, '#most-ordered');
        } else {
            window.location.hash = '#most-ordered';
        }
    }
}

// Expose functions globally for use in onclick handlers
window.showCustomerProfile = showCustomerProfile;
window.showCustomerReviews = showCustomerReviews;
window.showCustomerMostOrdered = showCustomerMostOrdered;

async function loadAllCustomerReviews() {
    const reviewsList = document.getElementById('reviewsList');
    if (!reviewsList) return;
    
    try {
        await loadCustomerOrders(null); // Load all orders
        
        // Get all orders with reviews
        const reviewedOrders = ordersState.filter(order => 
            order.rating || order.review || order.feedback
        ).slice(0, 50); // Show last 50 reviews
        
        if (reviewedOrders.length === 0) {
            reviewsList.innerHTML = '<div class="empty-state">No reviews yet</div>';
            return;
        }
        
        reviewsList.innerHTML = reviewedOrders.map(order => {
            const customer = customersState.find(c => c.id === order.userId);
            const customerName = customer ? customer.displayName : 'Customer';
            
            const orderDate = order.createdAt 
                ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt))
                : new Date();
            const daysAgo = Math.floor((Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24));
            const dateText = daysAgo === 0 ? 'Today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
            
            const rating = order.rating || 0;
            const stars = '★'.repeat(Math.floor(rating)) + '☆'.repeat(5 - Math.floor(rating));
            const reviewText = order.review || order.feedback || 'No review text';
            
            const firstItem = order.items && order.items.length > 0 ? order.items[0] : null;
            const itemImage = firstItem?.image || firstItem?.imageUrl || '';
            const itemName = firstItem?.name || firstItem?.itemName || 'Order Items';
            
            const imageHtml = itemImage 
                ? `<img src="${escapeHtml(itemImage)}" alt="${escapeHtml(itemName)}" onerror="this.style.display='none'">`
                : '<div class="food-image-placeholder">🍽️</div>';
            
            return `
                <div class="review-item">
                    <div class="review-header">
                        <span class="order-id">${escapeHtml(customerName)} - Order #${order.trackingId || order.id}</span>
                        <span class="restaurant">Pablo's Peri Peri</span>
                    </div>
                    <div class="review-content">
                        <div class="food-image">
                            ${imageHtml}
                        </div>
                        <div class="review-details">
                            <h5>${escapeHtml(itemName)}</h5>
                            <p>${escapeHtml(reviewText)}</p>
                            <div class="review-meta">
                                <span class="date">${dateText}</span>
                                <div class="rating">
                                    <span class="stars">${stars}</span>
                                    <span class="rating-text">${rating.toFixed(1)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Error loading reviews:', error);
        reviewsList.innerHTML = '<div class="empty-state">Error loading reviews</div>';
    }
}

async function loadAllCustomerMostOrdered() {
    const mostOrderedList = document.getElementById('mostOrderedList');
    if (!mostOrderedList) return;
    
    try {
        await loadCustomerOrders(null); // Load all orders
        
        // Calculate most ordered items across all customers
        const itemCounts = {};
        
        ordersState.forEach(order => {
            if (order.items && Array.isArray(order.items)) {
                order.items.forEach(item => {
                    const itemName = item.name || item.itemName || 'Unknown';
                    if (!itemCounts[itemName]) {
                        itemCounts[itemName] = {
                            name: itemName,
                            count: 0,
                            totalPrice: 0,
                            image: item.image || item.imageUrl || ''
                        };
                    }
                    itemCounts[itemName].count++;
                    itemCounts[itemName].totalPrice += parseFloat(item.price || item.itemPrice || 0);
                });
            }
        });
        
        const mostOrderedItems = Object.values(itemCounts)
            .sort((a, b) => b.count - a.count)
            .slice(0, 20); // Top 20
        
        if (mostOrderedItems.length === 0) {
            mostOrderedList.innerHTML = '<div class="empty-state">No orders yet</div>';
            return;
        }
        
        mostOrderedList.innerHTML = mostOrderedItems.map(item => {
            const imageHtml = item.image 
                ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" onerror="this.style.display='none'">`
                : '<div class="food-image-placeholder">🍽️</div>';
            
            return `
                <div class="review-item">
                    <div class="review-header">
                        <span class="order-id">${escapeHtml(item.name)}</span>
                        <span class="restaurant">₱${Number(item.totalPrice / item.count).toFixed(2)}</span>
                    </div>
                    <div class="review-content">
                        <div class="food-image">
                            ${imageHtml}
                        </div>
                        <div class="review-details">
                            <h5>Ordered ${item.count}x</h5>
                            <p>Total: ₱${item.totalPrice.toFixed(2)}</p>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Error loading most ordered items:', error);
        mostOrderedList.innerHTML = '<div class="empty-state">Error loading most ordered items</div>';
    }
}

function handleCustomerHashNavigation() {
    // Only handle if we're on the customer page
    if (!document.getElementById('customer-profile')) {
        return;
    }
    
    const hash = window.location.hash;
    
    if (hash === '#customer-profile' || hash === '' || !hash) {
        showCustomerProfile();
    } else if (hash === '#reviews') {
        showCustomerReviews();
    } else if (hash === '#most-ordered') {
        showCustomerMostOrdered();
    } else {
        // Default to customer profile
        showCustomerProfile();
    }
}

async function loadCustomers() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    
    const fns = window.firestoreFunctions;
    if (!fns || !window.db) {
        throw new Error('Firestore not ready');
    }
    
    try {
        const customersCollection = fns.collection(window.db, 'customers');
        const snapshot = await fns.getDocs(customersCollection);
        
        const customersMap = new Map();
        
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const nameParts = [data.firstName, data.lastName].filter(Boolean);
            
            // Better display name fallback
            let displayName;
            if (nameParts.length) {
                displayName = nameParts.join(' ');
            } else if (data.displayName && data.displayName.trim()) {
                displayName = data.displayName.trim();
            } else if (data.fullName && data.fullName.trim()) {
                displayName = data.fullName.trim();
            } else if (data.email) {
                // Extract name from email (e.g., "john.doe@email.com" -> "john doe")
                const emailName = data.email.split('@')[0].replace(/[._]/g, ' ');
                displayName = emailName.split(' ').map(n => n.charAt(0).toUpperCase() + n.slice(1)).join(' ') || 'Customer';
            } else {
                displayName = 'Customer';
            }
            
            // Only add if not already in map (deduplicate)
            if (!customersMap.has(doc.id)) {
                customersMap.set(doc.id, {
                    id: doc.id,
                    userId: doc.id,
                    firstName: data.firstName || '',
                    lastName: data.lastName || '',
                    email: data.email || '',
                    phoneNumber: data.phoneNumber || data.contactNumber || '',
                    displayName: displayName,
                    createdAt: data.createdAt || null,
                    ...data
                });
            }
        });
        
        customersState = Array.from(customersMap.values()).sort((a, b) => {
            const nameA = a.displayName.toLowerCase();
            const nameB = b.displayName.toLowerCase();
            return nameA.localeCompare(nameB);
        });
        
        // Also update customer cache
        customersState.forEach(customer => {
            customerDetailsCache.set(customer.id, {
                name: customer.displayName,
                phone: customer.phoneNumber
            });
        });
        
    } catch (error) {
        console.error('Error loading customers:', error);
        throw error;
    }
}

function renderCustomersList() {
    const customerList = document.getElementById('customerList') || document.querySelector('.customer-list');
    if (!customerList) return;
    
    let filteredCustomers = customersState;
    
    // Apply search filter
    if (customerSearchTerm) {
        const searchLower = customerSearchTerm.toLowerCase();
        filteredCustomers = customersState.filter(customer => {
            return customer.displayName.toLowerCase().includes(searchLower) ||
                   customer.email.toLowerCase().includes(searchLower) ||
                   (customer.phoneNumber && customer.phoneNumber.includes(searchLower));
        });
    }
    
    if (filteredCustomers.length === 0) {
        customerList.innerHTML = '<div class="empty-state">No customers found</div>';
        return;
    }
    
    customerList.innerHTML = filteredCustomers.map(customer => {
        // Better initials generation
        let initials = '👤';
        if (customer.displayName && customer.displayName !== 'Customer') {
            const nameParts = customer.displayName.split(' ').filter(n => n.length > 0);
            if (nameParts.length >= 2) {
                // First letter of first name and first letter of last name
                initials = (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase().substring(0, 2);
            } else if (nameParts.length === 1 && nameParts[0].length >= 2) {
                // First two letters if only one name part
                initials = nameParts[0].substring(0, 2).toUpperCase();
            } else if (customer.email) {
                // Fallback to email initials
                const emailName = customer.email.split('@')[0];
                initials = emailName.substring(0, 2).toUpperCase();
            }
        } else if (customer.email) {
            // Use email if no name
            const emailName = customer.email.split('@')[0];
            initials = emailName.substring(0, 2).toUpperCase();
        }
        
        const isSelected = selectedCustomerId === customer.id ? 'selected' : '';
        
        return `
            <div class="customer-item ${isSelected}" onclick="selectCustomer('${customer.id}')" data-customer-id="${customer.id}">
                <div class="customer-avatar">${initials}</div>
                <span>${escapeHtml(customer.displayName)}</span>
            </div>
        `;
    }).join('');
    
    // If a customer is selected, show their details
    if (selectedCustomerId) {
        showCustomerDetails(selectedCustomerId);
    }
}

function selectCustomer(customerId) {
    selectedCustomerId = customerId;
    
    // Remove selected class from all customer items
    document.querySelectorAll('.customer-item').forEach(item => {
        item.classList.remove('selected');
    });
    
    // Add selected class to clicked customer
    const clickedItem = document.querySelector(`[data-customer-id="${customerId}"]`);
    if (clickedItem) {
        clickedItem.classList.add('selected');
    }
    
    showCustomerDetails(customerId);
}

async function showCustomerDetails(customerId) {
    const customer = customersState.find(c => c.id === customerId);
    if (!customer) return;
    
    // Load customer orders to calculate stats
    await loadCustomerOrders(customerId);
    
    // Calculate loyalty points and most ordered items
    const customerOrders = ordersState.filter(order => order.userId === customerId);
    const stats = calculateCustomerStats(customerOrders);
    
    // Update rewards tab
    updateRewardsTab(customer, stats);
    
    // Update reviews tab
    updateReviewsTab(customer, customerOrders);
}

async function loadCustomerOrders(customerId) {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    
    // Orders are already loaded in ordersState, we just filter them
    // But if ordersState is empty, we might need to load them
    if (ordersState.length === 0) {
        // Try to load orders if not already loaded
        try {
            const fns = window.firestoreFunctions;
            if (fns && window.db) {
                const ordersCollection = fns.collection(window.db, 'orders');
                const snapshot = await fns.getDocs(ordersCollection);
                ordersState = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
            }
        } catch (error) {
            console.error('Error loading orders:', error);
        }
    }
}

function calculateCustomerStats(orders) {
    const stats = {
        totalPoints: 0,
        availablePoints: 0,
        redeemedPoints: 0,
        totalOrders: orders.length,
        totalSpent: 0,
        mostOrderedItems: {}
    };
    
    orders.forEach(order => {
        // Calculate points (1 point per peso spent, example)
        const orderTotal = parseFloat(order.total || 0);
        stats.totalSpent += orderTotal;
        stats.totalPoints += Math.floor(orderTotal);
        
        // Count most ordered items
        if (order.items && Array.isArray(order.items)) {
            order.items.forEach(item => {
                const itemName = item.name || item.itemName || 'Unknown';
                if (!stats.mostOrderedItems[itemName]) {
                    stats.mostOrderedItems[itemName] = {
                        name: itemName,
                        count: 0,
                        totalPrice: 0,
                        image: item.image || item.imageUrl || ''
                    };
                }
                stats.mostOrderedItems[itemName].count++;
                stats.mostOrderedItems[itemName].totalPrice += parseFloat(item.price || item.itemPrice || 0);
            });
        }
    });
    
    // Convert most ordered items to array and sort
    stats.mostOrderedItems = Object.values(stats.mostOrderedItems)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10); // Top 10
    
    // Calculate available points (assuming some redemption logic)
    stats.availablePoints = stats.totalPoints - stats.redeemedPoints;
    
    // Determine loyalty status
    if (stats.totalSpent >= 10000) {
        stats.loyaltyStatus = 'Gold Member';
    } else if (stats.totalSpent >= 5000) {
        stats.loyaltyStatus = 'Silver Member';
    } else if (stats.totalSpent >= 1000) {
        stats.loyaltyStatus = 'Bronze Member';
    } else {
        stats.loyaltyStatus = 'Regular Member';
    }
    
    return stats;
}

function updateRewardsTab(customer, stats) {
    const rewardsTab = document.getElementById('rewardsTab');
    if (!rewardsTab) return;
    
    // Update loyalty points
    const pointsList = rewardsTab.querySelector('.points-list');
    if (pointsList) {
        pointsList.innerHTML = `
            <div class="points-item">
                <span>Total Points</span>
                <span class="points">${stats.totalPoints.toLocaleString()}</span>
            </div>
            <div class="points-item">
                <span>Available Points</span>
                <span class="points">${stats.availablePoints.toLocaleString()}</span>
            </div>
            <div class="points-item">
                <span>Redeemed Points</span>
                <span class="points">${stats.redeemedPoints.toLocaleString()}</span>
            </div>
        `;
    }
    
    // Update most ordered items
    const reviewsList = rewardsTab.querySelector('.reviews-list');
    if (reviewsList && stats.mostOrderedItems.length > 0) {
        reviewsList.innerHTML = stats.mostOrderedItems.map(item => {
            const imageHtml = item.image 
                ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" onerror="this.style.display='none'">`
                : '<div class="food-image-placeholder">🍽️</div>';
            
            return `
                <div class="review-item">
                    <div class="review-header">
                        <span class="order-id">${escapeHtml(item.name)}</span>
                        <span class="restaurant">₱${Number(item.totalPrice / item.count).toFixed(2)}</span>
                    </div>
                    <div class="review-content">
                        <div class="food-image">
                            ${imageHtml}
                        </div>
                        <div class="review-details">
                            <h5>Ordered ${item.count}x</h5>
                            <p>Total: ₱${item.totalPrice.toFixed(2)}</p>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } else if (reviewsList) {
        reviewsList.innerHTML = '<div class="empty-state">No orders yet</div>';
    }
}

function updateReviewsTab(customer, orders) {
    const reviewsTab = document.getElementById('reviewsTab');
    if (!reviewsTab) return;
    
    // Filter orders with reviews/ratings
    const reviewedOrders = orders.filter(order => 
        order.rating || order.review || order.feedback
    ).slice(0, 20); // Show last 20 reviews
    
    const reviewsList = reviewsTab.querySelector('.reviews-list');
    if (reviewsList) {
        if (reviewedOrders.length === 0) {
            reviewsList.innerHTML = '<div class="empty-state">No reviews yet</div>';
            return;
        }
        
        reviewsList.innerHTML = reviewedOrders.map(order => {
            const orderDate = order.createdAt 
                ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt))
                : new Date();
            const daysAgo = Math.floor((Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24));
            const dateText = daysAgo === 0 ? 'Today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
            
            const rating = order.rating || 0;
            const stars = '★'.repeat(Math.floor(rating)) + '☆'.repeat(5 - Math.floor(rating));
            const reviewText = order.review || order.feedback || 'No review text';
            
            const firstItem = order.items && order.items.length > 0 ? order.items[0] : null;
            const itemImage = firstItem?.image || firstItem?.imageUrl || '';
            const itemName = firstItem?.name || firstItem?.itemName || 'Order Items';
            
            const imageHtml = itemImage 
                ? `<img src="${escapeHtml(itemImage)}" alt="${escapeHtml(itemName)}" onerror="this.style.display='none'">`
                : '<div class="food-image-placeholder">🍽️</div>';
            
            return `
                <div class="review-item">
                    <div class="review-header">
                        <span class="order-id">Order #${order.trackingId || order.id}</span>
                        <span class="restaurant">Pablo's Peri Peri</span>
                    </div>
                    <div class="review-content">
                        <div class="food-image">
                            ${imageHtml}
                        </div>
                        <div class="review-details">
                            <h5>${escapeHtml(itemName)}</h5>
                            <p>${escapeHtml(reviewText)}</p>
                            <div class="review-meta">
                                <span class="date">${dateText}</span>
                                <div class="rating">
                                    <span class="stars">${stars}</span>
                                    <span class="rating-text">${rating.toFixed(1)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }
}

function setupCustomerSearch() {
    const searchInputs = document.querySelectorAll('.customer-profile-panel .search-box input, .search-filter-bar .search-box input');
    searchInputs.forEach(input => {
        input.addEventListener('input', (e) => {
            customerSearchTerm = e.target.value.trim();
            renderCustomersList();
        });
    });
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

function openMenuItemEditor(itemId) {
    const modal = document.getElementById('menuItemModal');
    const form = document.getElementById('menuItemEditForm');
    if (!modal || !form) {
        console.warn('Menu edit modal is not available on this page.');
        return;
    }

    const menuItem = menuState.find(item => item.id === itemId);
    if (!menuItem) {
        showNotification('Unable to load that menu item.', 'error');
        return;
    }

    currentMenuEditItem = menuItem;
    populateMenuEditForm(menuItem);

    modal.style.display = 'block';
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
}

function closeMenuItemModal() {
    const modal = document.getElementById('menuItemModal');
    if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('modal-open');
    currentMenuEditItem = null;
}

function populateMenuEditForm(menuItem) {
    const form = document.getElementById('menuItemEditForm');
    if (!form) return;

    const nameInput = form.querySelector('#menuEditName');
    const displayNameInput = form.querySelector('#menuEditDisplayName');
    const idInput = form.querySelector('#menuEditMenuId');
    const categorySelect = form.querySelector('#menuEditCategory');
    const priceInput = form.querySelector('#menuEditPrice');
    const quantityInput = form.querySelector('#menuEditQuantity');
    const descriptionInput = form.querySelector('#menuEditDescription');
    const allergensInput = form.querySelector('#menuEditAllergens');
    const statusBadge = document.getElementById('menuEditStatusBadge');
    const ingredientsList = document.getElementById('menuEditIngredients');
    const imagePreview = document.getElementById('menuEditImage');

    if (nameInput) nameInput.value = menuItem.name || '';
    if (displayNameInput) displayNameInput.value = menuItem.displayName || '';
    if (idInput) idInput.value = menuItem.menuId || menuItem.id || '';
    if (categorySelect) {
        const categoryValue = menuItem.category || 'Popular';
        categorySelect.value = categoryValue;
        // Check if category exists in options, if not, show custom input
        const categoryCustom = form.querySelector('#menuEditCategoryCustom');
        const optionExists = Array.from(categorySelect.options).some(opt => opt.value === categoryValue);
        if (categoryCustom) {
            if (!optionExists && categoryValue) {
                categoryCustom.value = categoryValue;
                categoryCustom.style.display = 'block';
                categorySelect.value = '';
            } else {
                categoryCustom.value = '';
                categoryCustom.style.display = 'none';
            }
        }
    }
    if (priceInput) priceInput.value = Number(menuItem.price || 0).toFixed(2);
    if (allergensInput) allergensInput.value = menuItem.allergens || '';
    if (quantityInput) quantityInput.value = menuItem.quantity != null ? Number(menuItem.quantity) : 0;
    if (descriptionInput) descriptionInput.value = menuItem.description || '';

    if (statusBadge) {
        statusBadge.textContent = menuItem.isActive ? 'Active' : 'Inactive';
        statusBadge.classList.toggle('active', menuItem.isActive);
        statusBadge.classList.toggle('inactive', !menuItem.isActive);
    }

    if (imagePreview) {
        if (menuItem.imageDataUrl) {
            imagePreview.innerHTML = `<img src="${menuItem.imageDataUrl}" alt="${menuItem.name}">`;
        } else {
            imagePreview.innerHTML = `<div class="image-placeholder large">${(menuItem.name || '?').charAt(0).toUpperCase()}</div>`;
        }
    }

    if (ingredientsList) {
        if (!menuItem.ingredients.length) {
            ingredientsList.innerHTML = '<li class="empty-state">No ingredients linked yet.</li>';
        } else {
            ingredientsList.innerHTML = menuItem.ingredients
                .map(ingredient => `
                    <li>
                        <span>${ingredient.ingredientName || ingredient.ingredientId}</span>
                        <small>${ingredient.displayAmount || ingredient.baseAmountPerDish || ''}</small>
                    </li>
                `)
                .join('');
        }
    }

    // Update product summary block
    try {
        const statusInfo = getMenuItemStatus(menuItem);
        const ordersCount = getMenuItemOrderCount(menuItem);
        const summaryMenuId = document.getElementById('summaryMenuId');
        const summaryCategory = document.getElementById('summaryCategory');
        const summaryPrice = document.getElementById('summaryPrice');
        const summaryStatus = document.getElementById('summaryStatus');
        const summaryOrdersCount = document.getElementById('summaryOrdersCount');
        const summaryDescription = document.getElementById('summaryDescription');

        if (summaryMenuId) summaryMenuId.textContent = menuItem.menuId || menuItem.id || '—';
        if (summaryCategory) summaryCategory.textContent = menuItem.category || 'Uncategorized';
        if (summaryPrice) summaryPrice.textContent = `₱${Number(menuItem.price || 0).toFixed(2)}`;
        if (summaryStatus) summaryStatus.textContent = statusInfo.label || '—';
        if (summaryOrdersCount) summaryOrdersCount.textContent = String(ordersCount || 0);
        if (summaryDescription) summaryDescription.textContent = menuItem.description || '—';
    } catch (e) {
        console.warn('Unable to update product summary for menu item:', e);
    }

    updateMenuModalActionButtons(menuItem);
}

async function handleMenuEditSubmit(event) {
    if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
    }
    if (!currentMenuEditItem) {
        showNotification('Select a menu item first.', 'error');
        return;
    }

    const form = event?.target || document.getElementById('menuItemEditForm');
    if (!form) return;

    const nameValue = (form.querySelector('#menuEditName')?.value || '').trim();
    const displayNameValue = (form.querySelector('#menuEditDisplayName')?.value || '').trim();
    const menuIdValue = (form.querySelector('#menuEditMenuId')?.value || '').trim();
    // Get category from custom input if filled, otherwise from select
    const categorySelect = form.querySelector('#menuEditCategory');
    const categoryCustom = form.querySelector('#menuEditCategoryCustom');
    const categoryValue = (categoryCustom?.value?.trim() || categorySelect?.value || 'Popular').trim();
    if (categoryValue && categoryCustom?.value?.trim()) {
        // Add to select if it's a new category
        addCategoryToSelects(categoryValue);
    }
    const priceValue = parseFloat(form.querySelector('#menuEditPrice')?.value || '0');
    const quantityRaw = form.querySelector('#menuEditQuantity')?.value || '';
    const quantityValue = quantityRaw === '' ? 0 : parseInt(quantityRaw, 10);
    const descriptionValue = (form.querySelector('#menuEditDescription')?.value || '').trim();
    const allergensValue = (form.querySelector('#menuEditAllergens')?.value || '').trim() || null;

    if (!nameValue) {
        showNotification('Name is required.', 'error');
        return;
    }
    if (!priceValue || priceValue <= 0) {
        showNotification('Enter a price greater than zero.', 'error');
        return;
    }

    if (Number.isNaN(quantityValue) || quantityValue < 0) {
        showNotification('Quantity must be zero or a positive whole number.', 'error');
        return;
    }

    setMenuModalLoading(true);

    try {
        await waitForFirebaseReady();
        const formattedName = formatIngredientLabel(nameValue);
        const formattedDisplayName = displayNameValue ? formatIngredientLabel(displayNameValue) : formattedName;
        const payload = {
            menuId: menuIdValue || currentMenuEditItem.menuId,
            name: formattedName, // Internal name
            displayName: formattedDisplayName, // Customer-facing name
            category: categoryValue,
            price: +Number(priceValue).toFixed(2),
            quantity: quantityValue,
            deliveryCharge: 0, // Set to 0 since delivery charge field is removed
            description: descriptionValue,
            allergens: allergensValue
        };

        menuState = await MenuStore.updateItem(currentMenuEditItem.id, payload);
        renderMenuState();
        showNotification(`${formattedName} updated successfully.`, 'success');
        closeMenuItemModal();
    } catch (error) {
        console.error('Update menu item failed:', error);
        showNotification(error.message || 'Unable to update that menu item.', 'error');
    } finally {
        setMenuModalLoading(false);
    }
}

function showDeleteConfirmationDialog(itemName) {
    return new Promise((resolve) => {
        const dialog = document.createElement('div');
        dialog.className = 'modal';
        dialog.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 10001;
            animation: fadeIn 0.2s ease-in;
        `;
        
        dialog.innerHTML = `
            <div class="modal-content" style="max-width: 550px; width: 90%; background: white; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); animation: slideDown 0.3s ease-out;">
                <div class="modal-header" style="padding: 20px 24px; border-bottom: 1px solid #e9ecef; display: flex; align-items: center; gap: 8px;">
                    <div style="width: 40px; height: 40px; border-radius: 50%; background: #fee; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                        <i class="fas fa-exclamation-triangle" style="color: #dc3545; font-size: 20px;"></i>
                    </div>
                    <h2 style="margin: 0; color: #212529; font-size: 20px; font-weight: 600;">Delete Menu Item</h2>
                </div>
                <div class="modal-body" style="padding: 24px;">
                    <p style="margin: 0 0 20px 0; color: #495057; font-size: 16px; line-height: 1.5;">
                        Are you sure you want to delete <strong style="color: #212529;">"${itemName}"</strong>?
                    </p>
                    <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 16px; margin-top: 16px;">
                        <div style="display: flex; align-items: flex-start; gap: 12px;">
                            <i class="fas fa-info-circle" style="color: #856404; font-size: 18px; margin-top: 2px; flex-shrink: 0;"></i>
                            <div style="color: #856404; line-height: 1.6; font-size: 14px;">
                                <strong style="display: block; margin-bottom: 4px;">Important Information:</strong>
                                <span>This menu item will be marked as "For Deletion" and moved to the archive. It will be permanently deleted from the system after <strong>30 days</strong>. You can restore it from the archive within this period if needed.</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer" style="padding: 16px 24px; border-top: 1px solid #e9ecef; display: flex; gap: 12px; justify-content: flex-end; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                    <button class="btn btn-secondary" id="deleteDialogCancel" style="min-width: 100px;">Cancel</button>
                    <button class="btn btn-danger" id="deleteDialogConfirm" style="min-width: 100px;">
                        <i class="fas fa-trash" style="margin-right: 6px;"></i>
                        Delete
                    </button>
                </div>
            </div>
        `;
        
        // Add animation styles if not already present
        if (!document.getElementById('deleteDialogStyles')) {
            const style = document.createElement('style');
            style.id = 'deleteDialogStyles';
            style.textContent = `
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes slideDown {
                    from { 
                        opacity: 0;
                        transform: translateY(-20px);
                    }
                    to { 
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
            `;
            document.head.appendChild(style);
        }
        
        document.body.appendChild(dialog);
        document.body.style.overflow = 'hidden'; // Prevent background scrolling

        const closeDialog = (confirmed) => {
            dialog.style.animation = 'fadeOut 0.2s ease-in';
            setTimeout(() => {
                if (dialog.parentNode) {
                    document.body.removeChild(dialog);
                }
                document.body.style.overflow = ''; // Restore scrolling
                resolve(confirmed);
            }, 200);
        };

        const confirmBtn = document.getElementById('deleteDialogConfirm');
        const cancelBtn = document.getElementById('deleteDialogCancel');
        
        if (confirmBtn) {
            confirmBtn.onclick = () => closeDialog(true);
        }
        if (cancelBtn) {
            cancelBtn.onclick = () => closeDialog(false);
        }
        
        dialog.onclick = (e) => {
            if (e.target === dialog) closeDialog(false);
        };
        
        // Close on Escape key
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                closeDialog(false);
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
    });
}

async function handleMenuItemDelete() {
    if (!currentMenuEditItem) {
        showNotification('Select a menu item first.', 'error');
        return;
    }
    
    const confirmed = await showDeleteConfirmationDialog(currentMenuEditItem.name);
    if (!confirmed) {
        return;
    }

    setMenuModalLoading(true);
    try {
        await waitForFirebaseReady();
        menuState = await MenuStore.deleteItem(currentMenuEditItem.id);
        renderMenuState();
        showNotification(`${currentMenuEditItem.name} was moved to archive. It will be permanently deleted after 30 days.`, 'success');
        closeMenuItemModal();
    } catch (error) {
        console.error('Delete menu item failed:', error);
        showNotification(error.message || 'Unable to delete that menu item.', 'error');
    } finally {
        setMenuModalLoading(false);
    }
}

async function handleMenuItemActiveToggle() {
    if (!currentMenuEditItem) {
        showNotification('Select a menu item first.', 'error');
        return;
    }
    setMenuModalLoading(true);
    try {
        const nextState = !currentMenuEditItem.isActive;
        const itemId = currentMenuEditItem.id;
        const previousName = currentMenuEditItem.name;
        await waitForFirebaseReady();
        menuState = await MenuStore.setItemActiveState(itemId, nextState);
        currentMenuEditItem = menuState.find(item => item.id === itemId) || null;
        renderMenuState();
        if (currentMenuEditItem) {
            populateMenuEditForm(currentMenuEditItem);
        } else {
            closeMenuItemModal();
        }
        const label = currentMenuEditItem?.name || previousName || 'Menu item';
        showNotification(`${label} is now ${nextState ? 'active' : 'inactive'}.`, 'success');
    } catch (error) {
        console.error('Toggle menu item active state failed:', error);
        showNotification(error.message || 'Unable to update menu item status.', 'error');
    } finally {
        setMenuModalLoading(false);
    }
}

function setMenuModalLoading(isLoading) {
    const saveBtn = document.getElementById('menuEditSaveBtn');
    const deleteBtn = document.getElementById('menuEditDeleteBtn');
    const toggleBtn = document.getElementById('menuEditDeactivateBtn');
    [saveBtn, deleteBtn, toggleBtn].forEach(button => {
        if (button) {
            button.disabled = !!isLoading;
        }
    });
}

function updateMenuModalActionButtons(menuItem) {
    const toggleBtn = document.getElementById('menuEditDeactivateBtn');
    if (toggleBtn) {
        toggleBtn.textContent = menuItem.isActive ? 'Deactivate' : 'Activate';
        toggleBtn.classList.toggle('btn-success', !menuItem.isActive);
        toggleBtn.classList.toggle('btn-secondary', menuItem.isActive);
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
        initCustomerManagement();
        
        // Handle hash navigation for customer page
        window.addEventListener('hashchange', function() {
            handleCustomerHashNavigation();
        });
        
        // Handle initial hash on page load - wait for DOM and Firebase to be ready
        function initCustomerHashNavigation() {
            if (document.getElementById('customer-profile')) {
                handleCustomerHashNavigation();
            } else {
                // Retry if elements aren't ready yet
                setTimeout(initCustomerHashNavigation, 100);
            }
        }
        
        // Start hash navigation after a short delay to ensure DOM is ready
        setTimeout(initCustomerHashNavigation, 200);
    } else if (currentPage === 'sales.html') {
        // Initialize sales report specific functionality
        initInventoryManagement();
        initSalesPage();
        console.log('Sales report page loaded');
    } else if (currentPage === 'menu.html') {
        // Initialize menu management specific functionality
        initMenuManagement();
        const menuEditForm = document.getElementById('menuItemEditForm');
        if (menuEditForm && !menuEditForm.dataset.bound) {
            menuEditForm.addEventListener('submit', handleMenuEditSubmit);
            menuEditForm.dataset.bound = 'true';
        }
        const deleteBtn = document.getElementById('menuEditDeleteBtn');
        if (deleteBtn && !deleteBtn.dataset.bound) {
            deleteBtn.addEventListener('click', handleMenuItemDelete);
            deleteBtn.dataset.bound = 'true';
        }
        const toggleBtn = document.getElementById('menuEditDeactivateBtn');
        if (toggleBtn && !toggleBtn.dataset.bound) {
            toggleBtn.addEventListener('click', handleMenuItemActiveToggle);
            toggleBtn.dataset.bound = 'true';
        }
        const modal = document.getElementById('menuItemModal');
        if (modal && !modal.dataset.bound) {
            modal.addEventListener('click', event => {
                if (event.target === modal) {
                    closeMenuItemModal();
                }
            });
            modal.dataset.bound = 'true';
        }

        // Function to highlight the active dropdown item based on hash
        function highlightActiveMenuItem() {
            const hash = window.location.hash;
            const menuSubLinks = document.querySelectorAll('.menu-nav-submenu a');
            menuSubLinks.forEach(link => {
                link.classList.remove('active');
                const href = link.getAttribute('href');
                if (href) {
                    const linkHash = '#' + href.split('#')[1];
                    // Check hash match or if product detail section is visible
                    const productDetailSection = document.getElementById('menu-product-detail');
                    const isProductDetailVisible = productDetailSection && productDetailSection.style.display === 'block';
                    
                    if (linkHash === hash || 
                        (hash === '#add-product' && linkHash === '#addFoodDashboard') ||
                        (hash === '#addFoodDashboard' && linkHash === '#add-product') ||
                        (hash === '#product-detail' && linkHash === '#menu-product-detail') ||
                        (hash === '#menu-product-detail' && linkHash === '#product-detail') ||
                        (isProductDetailVisible && linkHash === '#menu-product-detail')) {
                        link.classList.add('active');
                    }
                }
            });
        }
        
        // Make it globally accessible
        window.highlightActiveMenuItem = highlightActiveMenuItem;
        
        // Handle hash navigation on page load and hash change
        async function handleHashNavigation() {
            const hash = window.location.hash;
            // If trying to show product detail, wait for menuState to be loaded
            if ((hash === '#menu-product-detail' || hash === '#product-detail') && (!menuState || !menuState.length)) {
                // Wait for menuState to be loaded
                let attempts = 0;
                while ((!menuState || !menuState.length) && attempts < 50) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    attempts++;
                }
            }
            
            // Prevent any default behavior and ensure we navigate to the correct section
            if (hash === '#menu-catalogue') {
                showMenuCatalogue();
            } else if (hash === '#menu-list') {
                showMenuList();
            } else if (hash === '#addFoodDashboard' || hash === '#add-product') {
                showAddProduct();
            } else if (hash === '#menu-product-detail' || hash === '#product-detail') {
                showMenuProductDetail();
            } else {
                // Check if product detail section is visible (even without hash)
                const productDetailSection = document.getElementById('menu-product-detail');
                if (productDetailSection && productDetailSection.style.display === 'block') {
                    // Product detail is visible, highlight it
                    showMenuProductDetail();
                } else {
                    // Hide all sections if no hash - don't default to menu catalogue
                    const foodSection = document.getElementById('foodSection');
                    const addFoodSection = document.getElementById('addFoodDashboard');
                    if (foodSection) foodSection.style.display = 'none';
                    if (addFoodSection) addFoodSection.style.display = 'none';
                    if (productDetailSection) productDetailSection.style.display = 'none';
                    menuDetailVisible = false;
                    menuDetailEditing = false;
                    // Reset to base title if no section is shown
                    updatePageTitle('Menu', null);
                }
            }
            // Always highlight the active menu item after navigation
            highlightActiveMenuItem();
        }
        
        // Handle initial hash on page load - use a small delay to ensure DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(() => handleHashNavigation(), 0);
            });
        } else {
            setTimeout(() => handleHashNavigation(), 0);
        }
        
        // Handle hash changes
        window.addEventListener('hashchange', handleHashNavigation);
        
        // Setup menu filter functionality
        const filterItems = document.querySelectorAll('#filterDropdown .dropdown-item[data-filter-type]');
        if (filterItems.length) {
            filterItems.forEach(item => {
                if (!item.dataset.bound) {
                    item.addEventListener('click', (e) => {
                        e.preventDefault();
                        const filterType = item.getAttribute('data-filter-type');
                        const filterValue = item.getAttribute('data-filter-value');
                        
                        if (filterType && filterValue) {
                            currentMenuFilter[filterType] = filterValue;
                            renderMenuState();
                            
                            // Update active state for filter items of the same type
                            filterItems.forEach(fi => {
                                if (fi.getAttribute('data-filter-type') === filterType) {
                                    fi.classList.remove('active');
                                }
                            });
                            item.classList.add('active');
                            
                            // Close dropdown
                            const dropdown = document.getElementById('filterDropdown');
                            if (dropdown) {
                                dropdown.classList.remove('show');
                            }
                        }
                    });
                    item.dataset.bound = 'true';
                }
            });
        }
        
        // Handle clicks on dropdown links
        const menuSubLinks = document.querySelectorAll('.menu-nav-submenu a');
        if (menuSubLinks.length) {
            menuSubLinks.forEach(link => {
                if (!link.dataset.bound) {
                    link.addEventListener('click', (e) => {
                        // Get the hash from the href
                        const href = link.getAttribute('href');
                        if (href && href.includes('#')) {
                            const targetHash = '#' + href.split('#')[1];
                            const currentHash = window.location.hash;
                            
                            // If we're already on menu.html and clicking a link
                            if (window.location.pathname.includes('menu.html')) {
                                // If hash is different, let browser handle it (hashchange will fire)
                                // If hash is same, manually trigger navigation
                                if (currentHash === targetHash || 
                                    (targetHash === '#add-product' && currentHash === '#addFoodDashboard') ||
                                    (targetHash === '#addFoodDashboard' && currentHash === '#add-product') ||
                                    (targetHash === '#product-detail' && currentHash === '#menu-product-detail') ||
                                    (targetHash === '#menu-product-detail' && currentHash === '#product-detail')) {
                                    // Same hash, manually trigger
                                    e.preventDefault();
                                    handleHashNavigation();
                                } else {
                                    // Different hash, let browser navigate, then ensure it happens
                                    setTimeout(() => {
                                        handleHashNavigation();
                                    }, 10);
                                }
                            }
                            // If coming from another page, hashchange will handle it
                        }
                    });
                    link.dataset.bound = 'true';
                }
            });
        }

        // Menu management page loaded
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
window.toggleMenuTabDropdown = toggleMenuTabDropdown;
window.toggleCustomerTabDropdown = toggleCustomerTabDropdown;
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
window.changeOrdersPage = changeOrdersPage;
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
window.initCustomerManagement = initCustomerManagement;
window.toggleReviewOptions = toggleReviewOptions;
window.addFood = addFood;
window.openMenuItemEditor = openMenuItemEditor;
window.closeMenuItemModal = closeMenuItemModal;
window.nextMenuDetail = nextMenuDetail;
window.prevMenuDetail = prevMenuDetail;
window.openMenuItemEditorFromDetail = openMenuItemEditorFromDetail;
window.handleMenuItemDeleteFromDetail = handleMenuItemDeleteFromDetail;
window.showMenuCatalogue = showMenuCatalogue;
window.showMenuList = showMenuList;
window.showMenuProductDetail = showMenuProductDetail;
window.showAddProduct = showAddProduct;
window.showMenuDetailForItem = showMenuDetailForItem;
window.toggleMenuDetailEdit = toggleMenuDetailEdit;
window.addUser = addUser;

// Add Food Dashboard Functions
function showAddFood() {
    resetMenuForm();
    showAddProduct();
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

// Handle local file selection (stores file locally, uploads only on form submit)
function handleImageFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
        showNotification('Please select a valid image file.', 'error');
        return;
    }
    
    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB in bytes
    if (file.size > maxSize) {
        showNotification('Image size must be less than 5MB.', 'error');
        return;
    }
    
    const imagePreview = document.getElementById('imagePreview');
    const progressContainer = document.getElementById('imageUploadProgress');
    
    // Store the file object (will be uploaded when form is submitted)
    uploadedFoodImageFile = file;
    uploadedFoodImageDataUrl = null; // Clear any previous URL
    
    // Hide progress container (upload happens on form submit)
    if (progressContainer) {
        progressContainer.style.display = 'none';
    }
    
    // Show preview immediately using FileReader
    const reader = new FileReader();
    reader.onload = function(e) {
        if (imagePreview) {
            imagePreview.innerHTML = `<img src="${e.target.result}" alt="Preview" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px; cursor: pointer;" onclick="document.getElementById('imageFileInput').click()">`;
            imagePreview.setAttribute('onclick', 'document.getElementById("imageFileInput").click()');
            imagePreview.style.cursor = 'pointer';
            imagePreview.setAttribute('title', 'Click to change image');
        }
    };
    reader.onerror = function() {
        showNotification('Failed to read image file.', 'error');
        uploadedFoodImageFile = null;
    };
    reader.readAsDataURL(file);
    
    showNotification('Image selected. It will be uploaded when you click Add.', 'success');
}

// Upload image to Firebase Storage (called from handleMenuFormSubmit)
async function uploadImageToStorage(file) {
    if (!file) {
        return null;
    }
    
    const progressContainer = document.getElementById('imageUploadProgress');
    const progressBar = document.getElementById('imageUploadProgressBar');
    const progressStatus = document.getElementById('imageUploadStatus');
    
    // Show upload progress
    if (progressContainer) {
        progressContainer.style.display = 'block';
        if (progressBar) progressBar.style.width = '0%';
        if (progressStatus) progressStatus.textContent = 'Uploading to Firebase Storage...';
    }
    
    try {
        // Wait for Firebase to be ready
        if (!isStorageReady()) {
            await waitForFirebaseReady();
            if (!isStorageReady()) {
                throw new Error('Firebase Storage is not initialized. Please refresh the page.');
            }
        }
        
        const { ref, uploadBytes, getDownloadURL } = window.storageFunctions;
        const storage = window.storage;
        
        // Generate unique filename
        const timestamp = Date.now();
        const fileExtension = file.name.split('.').pop();
        const fileName = `menu_${timestamp}.${fileExtension}`;
        const storagePath = `menuImages/${fileName}`;
        
        // Create storage reference
        const imageRef = ref(storage, storagePath);
        
        // Upload file to Firebase Storage
        if (progressBar) progressBar.style.width = '50%';
        if (progressStatus) progressStatus.textContent = 'Uploading...';
        
        await uploadBytes(imageRef, file);
        
        if (progressBar) progressBar.style.width = '75%';
        if (progressStatus) progressStatus.textContent = 'Getting download URL...';
        
        // Get download URL
        const downloadURL = await getDownloadURL(imageRef);
        
        // Update progress
        if (progressBar) progressBar.style.width = '100%';
        if (progressStatus) progressStatus.textContent = 'Upload complete!';
        
        // Hide progress after a short delay
        setTimeout(() => {
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
        }, 1000);
        
        return downloadURL;
        
    } catch (error) {
        console.error('Error uploading image:', error);
        
        // Hide progress on error
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
        
        throw error;
    }
}

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
        imagePreview.setAttribute('onclick', 'document.getElementById("imageFileInput").click()');
        imagePreview.style.cursor = 'pointer';
        imagePreview.setAttribute('title', 'Click to select image');
    }
    
    // Reset file input
    const fileInput = document.getElementById('imageFileInput');
    if (fileInput) {
        fileInput.value = '';
    }
    
    // Hide upload progress
    const progressContainer = document.getElementById('imageUploadProgress');
    if (progressContainer) {
        progressContainer.style.display = 'none';
    }
    
    uploadedFoodImageDataUrl = null;
    uploadedFoodImageFile = null;
}

function submitFood(event) {
    return handleMenuFormSubmit(event);
}

// Update the existing addFood function
function addFood() {
    showAddFood();
    
    // Ensure image preview is set up correctly
    const imagePreview = document.getElementById('imagePreview');
    if (imagePreview) {
        imagePreview.setAttribute('onclick', 'document.getElementById("imageFileInput").click()');
        imagePreview.style.cursor = 'pointer';
    }
    
    // Reset file input
    const fileInput = document.getElementById('imageFileInput');
    if (fileInput) {
        fileInput.value = '';
    }
    
    // Hide upload progress
    const progressContainer = document.getElementById('imageUploadProgress');
    if (progressContainer) {
        progressContainer.style.display = 'none';
    }
}

window.showAddFood = showAddFood;
window.hideAddFood = hideAddFood;
window.openImageGallery = openImageGallery;
window.closeImageGallery = closeImageGallery;
window.selectImageFromGallery = selectImageFromGallery;
window.handleImageFileSelect = handleImageFileSelect;
window.removeImage = removeImage;
window.submitFood = submitFood;
window.addVariation = addVariation;
window.removeVariation = removeVariation;
window.addMenuDetailVariation = addMenuDetailVariation;
window.removeMenuDetailVariation = removeMenuDetailVariation;

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

// Category management functions
let allCategories = ['Popular', 'Starter', 'Main Menu', 'Ala Carte', 'Side', 'Beverage'];

function addCategoryToSelects(categoryName) {
    if (!categoryName || !categoryName.trim()) return;
    const trimmedCategory = categoryName.trim();
    
    // Add to global categories list if not already present
    if (!allCategories.includes(trimmedCategory)) {
        allCategories.push(trimmedCategory);
    }
    
    // Add to all category selects
    const selectIds = ['category', 'menuEditCategory', 'menuDetailCategoryInput'];
    selectIds.forEach(selectId => {
        const select = document.getElementById(selectId);
        if (select) {
            const optionExists = Array.from(select.options).some(opt => opt.value === trimmedCategory);
            if (!optionExists) {
                const option = document.createElement('option');
                option.value = trimmedCategory;
                option.textContent = trimmedCategory;
                select.appendChild(option);
            }
        }
    });
    
    // Update filter dropdown categories
    updateFilterCategories();
}

function handleCategorySelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    
    const customInputId = selectId === 'category' ? 'categoryCustom' : 
                         selectId === 'menuEditCategory' ? 'menuEditCategoryCustom' : 
                         'menuDetailCategoryCustom';
    const customInput = document.getElementById(customInputId);
    
    if (customInput) {
        if (select.value === '') {
            // Show custom input if empty option selected
            customInput.style.display = 'block';
            customInput.focus();
        } else {
            // Hide custom input if a category is selected
            customInput.value = '';
            customInput.style.display = 'none';
        }
    }
}

function handleCategoryCustomInput(selectId) {
    const customInputId = selectId === 'category' ? 'categoryCustom' : 
                         selectId === 'menuEditCategory' ? 'menuEditCategoryCustom' : 
                         'menuDetailCategoryCustom';
    const customInput = document.getElementById(customInputId);
    const select = document.getElementById(selectId);
    
    if (customInput && select) {
        const customValue = customInput.value.trim();
        if (customValue) {
            // Add to selects and update filters
            addCategoryToSelects(customValue);
            // Set the select to the new category
            select.value = customValue;
            customInput.style.display = 'none';
        } else {
            customInput.style.display = 'none';
        }
    }
}

function updateFilterCategories() {
    // Update filter dropdown in menu catalogue
    const filterCategorySection = document.querySelector('#filterDropdown .filter-section:last-of-type');
    if (filterCategorySection) {
        const existingItems = filterCategorySection.querySelectorAll('.dropdown-item[data-filter-type="category"]');
        existingItems.forEach(item => {
            if (item.getAttribute('data-filter-value') !== 'all') {
                item.remove();
            }
        });
        
        // Add all categories
        allCategories.forEach(category => {
            const item = document.createElement('a');
            item.href = '#';
            item.className = 'dropdown-item';
            item.setAttribute('data-filter-type', 'category');
            item.setAttribute('data-filter-value', category.toLowerCase());
            item.textContent = category;
            filterCategorySection.appendChild(item);
        });
        
        // Re-bind event listeners
        const filterItems = filterCategorySection.querySelectorAll('.dropdown-item[data-filter-type]');
        filterItems.forEach(item => {
            if (!item.dataset.bound) {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    const filterType = item.getAttribute('data-filter-type');
                    const filterValue = item.getAttribute('data-filter-value');
                    
                    if (filterType && filterValue) {
                        currentMenuFilter[filterType] = filterValue;
                        renderMenuState();
                        
                        // Update active state
                        filterItems.forEach(fi => {
                            if (fi.getAttribute('data-filter-type') === filterType) {
                                fi.classList.remove('active');
                            }
                        });
                        item.classList.add('active');
                        
                        // Close dropdown
                        const dropdown = document.getElementById('filterDropdown');
                        if (dropdown) {
                            dropdown.classList.remove('show');
                        }
                    }
                });
                item.dataset.bound = 'true';
            }
        });
    }
}

// Toggle meatball menu
function toggleMeatballMenu(itemId) {
    const menuId = `meatballMenu_${itemId}`;
    const dropdown = document.getElementById(menuId);
    if (!dropdown) return;
    
    // Close all other meatball menus
    document.querySelectorAll('.meatball-menu-dropdown').forEach(menu => {
        if (menu.id !== menuId) {
            menu.style.display = 'none';
        }
    });
    
    // Toggle current menu
    if (dropdown.style.display === 'none' || !dropdown.style.display) {
        dropdown.style.display = 'block';
        
        // Close on outside click
        const closeOnOutsideClick = (e) => {
            if (!dropdown.contains(e.target) && !e.target.closest('.meatball-menu-btn')) {
                dropdown.style.display = 'none';
                document.removeEventListener('click', closeOnOutsideClick);
            }
        };
        setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 0);
    } else {
        dropdown.style.display = 'none';
    }
}

// Restore menu item function
async function restoreMenuItem(itemId) {
    if (!itemId) return;
    
    const item = menuState.find(m => m.id === itemId);
    if (!item) {
        showNotification('Menu item not found.', 'error');
        return;
    }
    
    try {
        await waitForFirebaseReady();
        menuState = await MenuStore.restoreItem(itemId);
        renderMenuState();
        const displayName = item.displayName || item.name;
        showNotification(`${displayName} has been restored and is now active.`, 'success');
        
        // Close meatball menu
        const menuId = `meatballMenu_${itemId}`;
        const dropdown = document.getElementById(menuId);
        if (dropdown) {
            dropdown.style.display = 'none';
        }
    } catch (error) {
        console.error('Restore menu item failed:', error);
        showNotification(error.message || 'Unable to restore menu item.', 'error');
    }
}

// Hide menu item function
async function hideMenuItem(itemId) {
    if (!itemId) return;
    
    if (!confirm('Are you sure you want to hide this menu item?')) {
        return;
    }
    
    try {
        await waitForFirebaseReady();
        menuState = await MenuStore.setItemActiveState(itemId, false);
        renderMenuState();
        showNotification('Menu item hidden successfully.', 'success');
    } catch (error) {
        console.error('Hide menu item failed:', error);
        showNotification(error.message || 'Unable to hide menu item.', 'error');
    }
}

// Discard edit function
function discardMenuDetailEdit() {
    if (!menuState || !menuState.length) return;
    const currentItem = menuState[currentMenuDetailIndex];
    if (!currentItem) return;
    
    // Reset form to original values
    renderMenuDetailsCarousel();
    setMenuDetailEditMode(false);
    showNotification('Changes discarded.', 'info');
}

// Make functions globally accessible
window.hideMenuItem = hideMenuItem;
window.toggleMeatballMenu = toggleMeatballMenu;
window.restoreMenuItem = restoreMenuItem;
window.discardMenuDetailEdit = discardMenuDetailEdit;
window.handleCategorySelect = handleCategorySelect;
window.handleCategoryCustomInput = handleCategoryCustomInput;

