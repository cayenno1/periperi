// Global variables
let activeDropdown = null;

// Generate a unique 8-digit numeric ID that avoids collisions across key collections
async function generateUnique8DigitId() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    const collectionsToCheck = ['menu'];
    const existingIds = new Set();

    for (const col of collectionsToCheck) {
        const snap = await fns.getDocs(fns.collection(window.db, col));
        snap.docs.forEach(docSnap => {
            const data = docSnap.data() || {};
            [
                docSnap.id,
                data.ingredientId,
                data.menuId,
                data.variationId,
                data.foodId,
            ].forEach(val => {
                if (val !== undefined && val !== null && val !== '') {
                    existingIds.add(String(val));
                }
            });
        });
    }

    let attempts = 0;
    while (attempts < 5000) {
        const candidate = Math.floor(10000000 + Math.random() * 90000000).toString();
        if (!existingIds.has(candidate)) {
            return candidate;
        }
        attempts += 1;
    }
    throw new Error('Unable to generate a unique 8-digit ID. Please try again.');
}
let menuState = [];
let menuQuantityMode = 'stored'; // Always 'stored' - ingredients mode removed
let currentMenuEditItem = null;
let currentMenuDetailIndex = 0;
let menuDetailVisible = false;
let menuDetailEditing = false;
let uploadedFoodImageDataUrl = null; // Stores Firebase Storage URL after upload
let uploadedFoodImageFile = null; // Stores the File object before upload
let menuDetailNewImageFile = null; // Stores the new image file for product detail replacement
let ordersState = [];
let ordersUnsubscribe = null;
let ordersSubscriptionInitialized = false;
let menuUnsubscribe = null;
let menuSubscriptionInitialized = false;
const customerDetailsCache = new Map();
const customerFetchInProgress = new Set();
let orderFilters = {
    filter: 'new-to-old', // Combined filter: 'new-to-old', 'old-to-new', 'status:xxx', 'type:xxx', or 'type:xxx|status:xxx'
    searchTerm: ''
};
let ordersCurrentPage = 1;
const ordersPerPage = 10;
let driversState = [];
let driverFilter = 'all';
let driverSearchTerm = '';
let currentViewingDriverId = null;
let customersState = [];
let selectedCustomerId = null;
let customerSearchTerm = '';
// Global alert state for cross-page notifications
let reviewAlertsInitialized = false;
let lastReviewedOrderIds = new Set();
let orderReviewAlertUnsubscribe = null;
let idVerificationAlertInitialized = false;
let lastPendingIdCustomerIds = new Set();
let idVerificationAlertUnsubscribe = null;
let pendingIdCustomerDetails = [];

// InventoryStore removed - system is now recipe-based

// ============================================================================
// DAILY SERVINGS SYSTEM (Replaces Inventory-Based Order Blocking)
// ============================================================================

const DailyServingsStore = (() => {
    const COLLECTION = 'dailyServings';
    
    function assertFirestoreReady() {
        if (!isFirestoreReady()) {
            throw new Error('Database is not ready. Please wait a moment and try again.');
        }
        return window.firestoreFunctions;
    }
    
    // Get today's date string (YYYY-MM-DD) in Asia/Manila timezone
    function getTodayDateString() {
        // Use Asia/Manila timezone for date calculation
        const now = new Date();
        const manilaDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
        const year = manilaDate.getFullYear();
        const month = String(manilaDate.getMonth() + 1).padStart(2, '0');
        const day = String(manilaDate.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    // Get today's serving count for a menu item
    async function getTodayServings(menuItemId) {
        const fns = assertFirestoreReady();
        const today = getTodayDateString();
        const docId = `${today}_${menuItemId}`;
        
        try {
            const docRef = fns.doc(window.db, COLLECTION, docId);
            const docSnap = await fns.getDoc(docRef);
            if (docSnap.exists()) {
                const data = docSnap.data();
                return data.count || 0;
            }
            return 0;
        } catch (error) {
            console.error('Error getting today servings:', error);
            return 0;
        }
    }
    
    // Get today's servings for multiple menu items (batch)
    async function getTodayServingsBatch(menuItemIds) {
        const fns = assertFirestoreReady();
        const today = getTodayDateString();
        const servings = {};
        
        // Initialize all to 0
        menuItemIds.forEach(id => {
            servings[id] = 0;
        });
        
        try {
            // Get all today's servings
            const snapshot = await fns.getDocs(fns.collection(window.db, COLLECTION));
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                if (data.date === today && menuItemIds.includes(data.menuItemId)) {
                    servings[data.menuItemId] = data.count || 0;
                }
            });
        } catch (error) {
            console.error('Error getting batch servings:', error);
        }
        
        return servings;
    }
    
    // Increment serving count for today
    async function incrementServing(menuItemId, menuItemName, maxServings, quantity = 1) {
        const fns = assertFirestoreReady();
        const today = getTodayDateString();
        const docId = `${today}_${menuItemId}`;
        const docRef = fns.doc(window.db, COLLECTION, docId);
        
        try {
            await fns.runTransaction(window.db, async (transaction) => {
                const doc = await transaction.get(docRef);
                
                if (doc.exists) {
                    const current = doc.data();
                    transaction.update(docRef, {
                        count: (current.count || 0) + quantity,
                        updatedAt: fns.serverTimestamp()
                    });
                } else {
                    // First serving of the day - initialize
                    transaction.set(docRef, {
                        menuItemId: menuItemId,
                        menuItemName: menuItemName,
                        date: today,
                        count: quantity,
                        maxServings: maxServings || null,
                        createdAt: fns.serverTimestamp(),
                        updatedAt: fns.serverTimestamp()
                    });
                }
            });
        } catch (error) {
            console.error('Error incrementing serving:', error);
            throw error;
        }
    }
    
    // Initialize dailyServings document for a menu item (if it doesn't exist)
    async function initializeDailyServings(menuItemId, menuItemName, maxServings) {
        const fns = assertFirestoreReady();
        const today = getTodayDateString();
        const docId = `${today}_${menuItemId}`;
        const docRef = fns.doc(window.db, COLLECTION, docId);
        
        try {
            const doc = await fns.getDoc(docRef);
            if (!doc.exists()) {
                // Default to 0 if maxServings is null/undefined
                const effectiveMaxServings = maxServings !== null && maxServings !== undefined && maxServings > 0 ? maxServings : 0;
                
                // Create document with count 0 (remaining = maxServings at start of day)
                // Each day, count resets to 0, so remaining = maxServings
                await fns.setDoc(docRef, {
                    menuItemId: menuItemId,
                    menuItemName: menuItemName,
                    date: today,
                    count: 0, // Count starts at 0 each day, remaining = maxServings
                    maxServings: effectiveMaxServings,
                    createdAt: fns.serverTimestamp(),
                    updatedAt: fns.serverTimestamp()
                });
                console.log(`Initialized dailyServings document for ${menuItemName} (${menuItemId}) - count: 0, maxServings: ${effectiveMaxServings}`);
            }
        } catch (error) {
            console.error('Error initializing dailyServings:', error);
            throw error;
        }
    }
    
    // Check if order can be placed (serving availability)
    async function checkServingAvailability(menuItemId, menuItemName, maxServings, orderQuantity) {
        // If no limit set, always available
        if (!maxServings || maxServings === 0) {
            return { available: true, remaining: null };
        }
        
        const todayCount = await getTodayServings(menuItemId);
        const remaining = maxServings - todayCount;
        
        if (remaining < orderQuantity) {
            return {
                available: false,
                remaining: remaining,
                error: `${menuItemName}: Only ${remaining} serving(s) remaining today (limit: ${maxServings})`
            };
        }
        
        return { available: true, remaining: remaining };
    }
    
    // Get all today's servings (for dashboard/reporting)
    async function getTodayAllServings() {
        const fns = assertFirestoreReady();
        const today = getTodayDateString();
        
        try {
            const snapshot = await fns.getDocs(fns.collection(window.db, COLLECTION));
            return snapshot.docs
                .filter(doc => doc.data().date === today)
                .map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
        } catch (error) {
            console.error('Error getting all today servings:', error);
            return [];
        }
    }
    
    return {
        getTodayServings,
        getTodayServingsBatch,
        incrementServing,
        checkServingAvailability,
        getTodayAllServings,
        getTodayDateString,
        initializeDailyServings
    };
})();

// ============================================================================
// INGREDIENT LOGS SYSTEM (Track ingredient usage and receipts)
// ============================================================================

const IngredientLogStore = (() => {
    const COLLECTION = 'ingredientLogs';
    
    function assertFirestoreReady() {
        if (!isFirestoreReady()) {
            throw new Error('Database is not ready. Please wait a moment and try again.');
        }
        return window.firestoreFunctions;
    }
    
    // Log ingredient usage (when order is prepared)
    async function logIngredientUsage(ingredientId, ingredientName, amount, orderId, menuItemName) {
        const fns = assertFirestoreReady();
        const logsCol = fns.collection(window.db, COLLECTION);
        
        await fns.addDoc(logsCol, {
            ingredientId: ingredientId,
            ingredientName: ingredientName,
            type: 'used',
            amount: Number(amount),
            orderId: orderId || null,
            menuItemName: menuItemName || null,
            timestamp: fns.serverTimestamp(),
            date: new Date().toISOString().split('T')[0] // YYYY-MM-DD
        });
    }
    
    // Log ingredient restock
    async function logIngredientRestock(ingredientId, ingredientName, amount) {
        const fns = assertFirestoreReady();
        const logsCol = fns.collection(window.db, COLLECTION);
        
        await fns.addDoc(logsCol, {
            ingredientId: ingredientId,
            ingredientName: ingredientName,
            type: 'received',
            amount: Number(amount),
            orderId: null,
            menuItemName: null,
            timestamp: fns.serverTimestamp(),
            date: new Date().toISOString().split('T')[0]
        });
    }
    
    // Get logs for an ingredient (or all logs)
    async function getLogs(ingredientId = null, limit = 100) {
        const fns = assertFirestoreReady();
        const logsCol = fns.collection(window.db, COLLECTION);
        
        let query = fns.query(logsCol, fns.orderBy('timestamp', 'desc'), fns.limit(limit));
        
        if (ingredientId) {
            query = fns.query(
                logsCol,
                fns.where('ingredientId', '==', ingredientId),
                fns.orderBy('timestamp', 'desc'),
                fns.limit(limit)
            );
        }
        
        const snapshot = await fns.getDocs(query);
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    }
    
    return {
        logIngredientUsage,
        logIngredientRestock,
        getLogs
    };
})();

// Expose globally
window.IngredientLogStore = IngredientLogStore;

// Cache for today's servings (to avoid repeated queries)
let todayServingsCache = {};
let todayServingsCacheDate = null;
let dailyServingsUnsubscribe = null;

// Get cached serving count or fetch if needed
async function getCachedTodayServings(menuItemId) {
    const today = DailyServingsStore.getTodayDateString();
    
    // Reset cache if new day
    if (todayServingsCacheDate !== today) {
        todayServingsCache = {};
        todayServingsCacheDate = today;
    }
    
    // Return cached if available
    if (todayServingsCache[menuItemId] !== undefined) {
        return todayServingsCache[menuItemId];
    }
    
    // Fetch and cache
    const count = await DailyServingsStore.getTodayServings(menuItemId);
    todayServingsCache[menuItemId] = count;
    return count;
}

// Refresh serving cache for multiple items
async function refreshServingsCache(menuItemIds) {
    const today = DailyServingsStore.getTodayDateString();
    
    if (todayServingsCacheDate !== today) {
        todayServingsCache = {};
        todayServingsCacheDate = today;
    }
    
    const servings = await DailyServingsStore.getTodayServingsBatch(menuItemIds);
    Object.assign(todayServingsCache, servings);
    return servings;
}


function parseMoney(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === 'string') {
        // Strip currency symbols/letters, keep digits, dot, comma, minus
        const cleaned = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
        const parsed = parseFloat(cleaned);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
}

// Generates an 8-digit numeric string (10000000 - 99999999) for variations
function generateVariationId() {
    return Math.floor(10000000 + Math.random() * 90000000).toString();
}

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
            price: parseMoney(item.price || item.basePrice || item.defaultPrice || item.displayPrice),
            quantity: (() => {
                // Handle quantity field - check multiple possible formats
                const qty = item.quantity;
                if (qty === undefined || qty === null) return 0;
                // Firestore numbers might come as Firestore number type, convert to JS number
                const numQty = typeof qty === 'number' ? qty : Number(qty);
                return isNaN(numQty) ? 0 : numQty;
            })(),
            maxServingsPerDay: (() => {
                // NEW: Daily serving limit (null/0 = unlimited)
                const max = item.maxServingsPerDay;
                if (max === undefined || max === null) return null;
                const numMax = typeof max === 'number' ? max : Number(max);
                return isNaN(numMax) || numMax <= 0 ? null : numMax;
            })(),
            deliveryCharge: Number(item.deliveryCharge) || 0,
            description: item.description || '',
            imageDataUrl: item.imageDataUrl || null,
            isActive: item.isActive !== false,
            isDeleted: item.isDeleted === true,
            deletedAt: item.deletedAt || null,
            variations: Array.isArray(item.variations)
                ? item.variations.map(variation => ({
                    variationId: variation.variationId || variation.id || null,
                    id: variation.variationId || variation.id || null,
                    name: variation.name || '',
                    price: parseMoney(
                        variation.price ??
                        variation.sellingPrice ??
                        variation.regularPrice ??
                        variation.displayPrice ??
                        variation.unitPrice ??
                        variation.priceValue ??
                        variation.amount ??
                        variation.cost ??
                        0
                    ),
                    quantity: (variation.quantity !== undefined && variation.quantity !== null)
                        ? Number(variation.quantity)
                        : 0,
                    maxServingsPerDay: (variation.maxServingsPerDay !== undefined && variation.maxServingsPerDay !== null)
                        ? Number(variation.maxServingsPerDay)
                        : null,
                    allergens: variation.allergens || '',
                    description: variation.description || '',
                    ingredientId: variation.ingredientId || null,
                    ingredientName: variation.ingredientName || null,
                    amount: (variation.amount !== null && variation.amount !== undefined) ? Number(variation.amount) : null,
                    displayAmount: variation.displayAmount || '',
                    size: variation.size || null,
                    kgUsage: variation.kgUsage !== null && variation.kgUsage !== undefined ? Number(variation.kgUsage) : null // Keep for backward compatibility
                }))
                : [],
            allergens: item.allergens || null,
            // kcalUnit is stored in Firebase; normalize to calories for app use (fallback to legacy "calories")
            calories: (v => v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : null)(item.kcalUnit ?? item.calories),
            ingredients: Array.isArray(item.ingredients)
                ? item.ingredients.map(ingredient => ({
                    ingredientId: ingredient.ingredientId,
                    ingredientName: ingredient.ingredientName,
                    unitType: ingredient.unitType,
                    baseAmountPerDish: Number(ingredient.baseAmountPerDish) || 0,
                    displayAmount: ingredient.displayAmount || '',
                }))
                : [],
            limitedStartDate: item.limitedStartDate || null,
            limitedEndDate: item.limitedEndDate || null,
            createdAt: item.createdAt || null,
            updatedAt: item.updatedAt || null
        };
    }

    async function getItems() {
        const fns = assertFirestoreReady();
        
        // Get items from main menu collection
        const menuSnapshot = await fns.getDocs(fns.collection(window.db, COLLECTION));
        const menuItems = menuSnapshot.docs
            .map(docSnap => {
                const data = docSnap.data();
                // Debug: log raw data to see what's actually in Firebase
                if (data.quantity !== undefined) {
                    console.log(`[Menu Debug] Item ${docSnap.id}: raw quantity =`, data.quantity, 'type:', typeof data.quantity);
                }
                return normalizeMenuItem({ id: docSnap.id, ...data });
            })
            .filter(Boolean);
        
        // Get items from menuArchives collection (inactive and deleted items)
        let archiveItems = [];
        try {
            const archiveSnapshot = await fns.getDocs(fns.collection(window.db, 'menuArchives'));
            archiveItems = archiveSnapshot.docs
                .map(docSnap => normalizeMenuItem({ id: docSnap.id, ...docSnap.data() }))
                .filter(Boolean);
        } catch (error) {
            // If permission error, log but continue with menu items only
            if (error.code === 'permission-denied' || error.message?.includes('permission')) {
                console.warn('Permission denied for menuArchives. Make sure Firestore rules are deployed. Loading menu items only:', error.message);
            } else {
                // Re-throw other errors
                throw error;
            }
        }
        
        // Combine both collections
        const allItems = [...menuItems, ...archiveItems];
        
        return allItems.sort((a, b) => a.name.localeCompare(b.name));
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
        // Prepare document data with proper date handling
        // Default maxServingsPerDay to 0 (unavailable) if not provided
        const docData = {
            ...data,
            isActive: true,
            maxServingsPerDay: data.maxServingsPerDay !== null && data.maxServingsPerDay !== undefined ? data.maxServingsPerDay : 0,
            createdAt: fns.serverTimestamp(),
            updatedAt: fns.serverTimestamp()
        };
        
        // Debug: log what's being saved
        console.log('[Date Debug] Creating menu item - data being saved:', {
            hasLimitedStartDate: 'limitedStartDate' in docData,
            hasLimitedEndDate: 'limitedEndDate' in docData,
            limitedStartDate: docData.limitedStartDate,
            limitedEndDate: docData.limitedEndDate,
            limitedStartDateType: typeof docData.limitedStartDate,
            limitedEndDateType: typeof docData.limitedEndDate
        });
        
        await fns.setDoc(docRef, docData);
        
        // Initialize dailyServings document for new active menu item
        if (docData.isActive !== false) {
            try {
                await initializeDailyServingsForMenuItem(slug, data.name || 'Unknown', data.maxServingsPerDay || null);
            } catch (error) {
                console.warn('Failed to initialize dailyServings for new menu item:', error);
                // Don't throw - menu item creation should still succeed
            }
        }
        
        return await getItems();
    }

    async function updateItem(id, data) {
        if (!id) {
            throw new Error('Menu item id is required.');
        }
        const fns = assertFirestoreReady();
        const docRef = fns.doc(window.db, COLLECTION, id);
        const archiveRef = fns.doc(window.db, 'menuArchives', id);
        
        // Check if item exists in menu collection or archive
        let currentDoc = await fns.getDoc(docRef);
        let currentData = null;
        let isInArchive = false;
        
        if (currentDoc.exists()) {
            currentData = currentDoc.data();
        } else {
            // Check if item is in archive
            const archiveDoc = await fns.getDoc(archiveRef);
            if (archiveDoc.exists()) {
                currentData = archiveDoc.data();
                isInArchive = true;
            } else {
                throw new Error('Menu item not found.');
            }
        }
        
        // If item is already in archive, check if we need to restore it
        if (isInArchive) {
            // Check if status is changing from inactive to active
            const wasInactive = currentData.isActive === false || currentData.isActive === 'false';
            const willBeActive = data.isActive === true || data.isActive === 'true' || (data.isActive !== false && data.isActive !== 'false');
            const willBeDeleted = data.isDeleted === true || data.isDeleted === 'true';
            const wasDeleted = currentData.isDeleted === true;
            
            // If changing from inactive/deleted to active, restore to menu collection
            if ((wasInactive && willBeActive && !willBeDeleted) || (wasDeleted && !willBeDeleted && willBeActive)) {
                // Prepare data for restoration (remove archive-specific fields)
                const restoreData = { ...currentData, ...data };
                delete restoreData.archivedAt;
                delete restoreData.archivedFrom;
                if (!willBeDeleted) {
                    delete restoreData.deletedAt;
                    delete restoreData.deletedByUser;
                }
                restoreData.isDeleted = willBeDeleted ? true : false;
                restoreData.isActive = willBeActive ? true : false;
                restoreData.updatedAt = fns.serverTimestamp();
                
                // Remove any undefined values
                Object.keys(restoreData).forEach(key => {
                    if (restoreData[key] === undefined) {
                        delete restoreData[key];
                    }
                });
                
                // Move back to menu collection
                await fns.setDoc(docRef, restoreData);
                
                // Delete from archive
                await fns.deleteDoc(archiveRef);
                
                return await getItems();
            } else {
                // Just update in archive
                await fns.updateDoc(archiveRef, {
                    ...data,
                    updatedAt: fns.serverTimestamp()
                });
                return await getItems();
            }
        }
        
        // Check if will be deleted (isDeleted is explicitly true)
        const willBeDeleted = data.isDeleted === true || data.isDeleted === 'true';
        const wasDeleted = currentData.isDeleted === true;
        
        // Check if will be inactive (isActive is explicitly false)
        const willBeInactive = data.isActive === false || data.isActive === 'false';
        const wasActive = currentData.isActive !== false && currentData.isActive !== 'false';
        
        // If status is changing to deleted or inactive, move the item to archive
        if ((!wasDeleted && willBeDeleted) || (wasActive && willBeInactive)) {
            try {
                const archiveRef = fns.doc(window.db, 'menuArchives', id);
                
                // Check if already exists in archive to avoid duplicates
                const archiveDoc = await fns.getDoc(archiveRef);
                if (!archiveDoc.exists()) {
                    // Create a clean copy of the data for archive
                    const archiveData = {
                        ...currentData,
                        ...data, // Include the new data
                        archivedAt: fns.serverTimestamp(),
                        archivedFrom: COLLECTION,
                        deletedByUser: willBeDeleted ? true : false,
                        deletedAt: willBeDeleted ? fns.serverTimestamp() : null
                    };
                    // Remove any undefined values
                    Object.keys(archiveData).forEach(key => {
                        if (archiveData[key] === undefined) {
                            delete archiveData[key];
                        }
                    });
                    
                    // Move to archive: create in archive and delete from menu
                    await fns.setDoc(archiveRef, archiveData);
                    await fns.deleteDoc(docRef);
                    
                    return await getItems(); // Return early since document is moved
                } else {
                    // Already in archive, just update it
                    const archiveData = {
                        ...data,
                        updatedAt: fns.serverTimestamp()
                    };
                    await fns.updateDoc(archiveRef, archiveData);
                    // Delete from menu if it still exists
                    const menuDoc = await fns.getDoc(docRef);
                    if (menuDoc.exists()) {
                        await fns.deleteDoc(docRef);
                    }
                    return await getItems(); // Return early since document is moved
                }
            } catch (archiveError) {
                console.error('Failed to archive menu item:', archiveError);
                throw archiveError; // Throw error to prevent partial state
            }
        }
        
        // Update the original document (only if not moved to archive)
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
        
        // Move the item to menuArchives with deletedAt timestamp
        const archiveRef = fns.doc(window.db, 'menuArchives', id);
        
        // Check if already exists in archive to avoid duplicates
        const archiveDoc = await fns.getDoc(archiveRef);
        
        const archiveData = {
            ...currentData,
            deletedAt: fns.serverTimestamp(),
            archivedAt: fns.serverTimestamp(),
            archivedFrom: COLLECTION,
            deletedByUser: true, // Flag to indicate this was deleted (not just deactivated)
            isDeleted: true,
            isActive: false
        };
        
        // Remove any undefined values
        Object.keys(archiveData).forEach(key => {
            if (archiveData[key] === undefined) {
                delete archiveData[key];
            }
        });
        
        if (archiveDoc.exists()) {
            // Already in archive, just update it with deletion info
            await fns.updateDoc(archiveRef, {
                deletedAt: fns.serverTimestamp(),
                deletedByUser: true,
                isDeleted: true,
                isActive: false,
                updatedAt: fns.serverTimestamp()
            });
        } else {
            // Move to archive: create in archive
            await fns.setDoc(archiveRef, archiveData);
        }
        
        // Delete from menu collection (move, not copy)
        await fns.deleteDoc(docRef);
        
        return await getItems();
    }
    
    // Clean up expired archived items (older than 30 days)
    async function cleanupExpiredArchivedItems() {
        const fns = assertFirestoreReady();
        try {
            const now = new Date();
            const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
            
            const deletePromises = [];
            
            // Clean up from menuArchives collection (only delete documents, not the collection)
            const archiveCollection = fns.collection(window.db, 'menuArchives');
            const archiveSnapshot = await fns.getDocs(archiveCollection);
        
            archiveSnapshot.docs.forEach(doc => {
                const data = doc.data();
                // Check if item has deletedAt timestamp and was deleted by user (marked for deletion)
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
                    
                    // Check if older than 30 days - only delete the document, not the collection
                    if (deletedAt && deletedAt < thirtyDaysAgo) {
                        deletePromises.push(fns.deleteDoc(fns.doc(window.db, 'menuArchives', doc.id)));
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
        } catch (error) {
            // If permission error, log but don't throw - this allows the app to continue
            if (error.code === 'permission-denied' || error.message?.includes('permission')) {
                console.warn('Permission denied for menuArchives cleanup. Make sure Firestore rules are deployed:', error.message);
                return 0;
            }
            // Re-throw other errors
            throw error;
        }
    }

    async function setItemActiveState(id, isActive) {
        const result = await updateItem(id, { isActive });
        
        // If activating, initialize dailyServings document
        if (isActive === true || isActive === 'true') {
            try {
                const item = result.find(i => i.id === id);
                if (item) {
                    await DailyServingsStore.initializeDailyServings(id, item.name || 'Unknown', item.maxServingsPerDay || null);
                }
            } catch (error) {
                console.warn('Failed to initialize dailyServings for activated menu item:', error);
                // Don't throw - activation should still succeed
            }
        }
        
        return result;
    }
    
    async function restoreItem(id) {
        if (!id) {
            throw new Error('Menu item id is required.');
        }
        const fns = assertFirestoreReady();
        const archiveRef = fns.doc(window.db, 'menuArchives', id);
        
        // Get the item from archive
        const archiveDoc = await fns.getDoc(archiveRef);
        if (!archiveDoc.exists()) {
            throw new Error('Menu item not found in archive.');
        }
        
        const archiveData = archiveDoc.data();
        
        // Prepare data for restoration (remove archive-specific fields)
        const restoreData = { ...archiveData };
        delete restoreData.archivedAt;
        delete restoreData.archivedFrom;
        delete restoreData.deletedAt;
        delete restoreData.deletedByUser;
        restoreData.isDeleted = false;
        restoreData.isActive = true;
        restoreData.updatedAt = fns.serverTimestamp();
        
        // Remove any undefined values
        Object.keys(restoreData).forEach(key => {
            if (restoreData[key] === undefined) {
                delete restoreData[key];
            }
        });
        
        // Move back to menu collection
        const docRef = fns.doc(window.db, COLLECTION, id);
        await fns.setDoc(docRef, restoreData);
        
        // Initialize dailyServings document for restored active menu item
        if (restoreData.isActive !== false) {
            try {
                await DailyServingsStore.initializeDailyServings(id, restoreData.name || 'Unknown', restoreData.maxServingsPerDay || null);
            } catch (error) {
                console.warn('Failed to initialize dailyServings for restored menu item:', error);
                // Don't throw - restoration should still succeed
            }
        }
        
        // Delete from archive
        await fns.deleteDoc(archiveRef);
        
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
        
        // Sync dailyServings for existing orders in preparing status (today only)
        // Run this asynchronously so it doesn't block the UI
        syncDailyServingsForExistingOrders().catch(error => {
            console.error('Error syncing dailyServings for existing orders:', error);
        });
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
            async (snapshot) => {
                const previousOrders = [...ordersState]; // Keep copy of previous state
                const previousOrderIds = new Set(previousOrders.map(o => o.id));
                
                // Update ordersState first
                ordersState = snapshot.docs
                    .map(docSnap => normalizeOrderDoc(docSnap))
                    .filter(Boolean);
                
                // Process new orders (added) - deduct servings when order is created with status "new" or "pending"
                // Use docChanges() if available, otherwise compare with previous state
                let newOrdersToProcess = [];
                
                try {
                    if (snapshot.docChanges && typeof snapshot.docChanges === 'function') {
                        const changes = snapshot.docChanges();
                        changes.forEach(change => {
                            if (change.type === 'added') {
                                const order = normalizeOrderDoc(change.doc);
                                if (order && !previousOrderIds.has(order.id)) {
                                    newOrdersToProcess.push(order);
                                }
                            }
                        });
                    }
                } catch (e) {
                    console.warn('docChanges() not available, using fallback method', e);
                }
                
                // Fallback: Check for new orders by comparing with previous state
                if (newOrdersToProcess.length === 0) {
                    newOrdersToProcess = ordersState.filter(newOrder => 
                        !previousOrderIds.has(newOrder.id)
                    );
                }
                
                // Process each new order
                if (newOrdersToProcess.length > 0) {
                    console.log(`Found ${newOrdersToProcess.length} new order(s) to process`);
                    for (const order of newOrdersToProcess) {
                        const orderStatus = (order.status || '').toLowerCase().trim();
                        // Deduct servings when order is created with status "new" or "pending"
                        if (orderStatus === 'new' || orderStatus === 'pending') {
                            console.log(`New order detected: ${order.id} with status ${orderStatus} - deducting servings`);
                            try {
                                await deductDailyServingsForOrder(order);
                                // Refresh serving cache (include variation ids) and menu list
                                if (menuState && menuState.length > 0) {
                                    const menuItemIds = [];
                                    menuState.forEach(function (it) {
                                        if (Array.isArray(it.variations) && it.variations.length > 0) {
                                            it.variations.forEach(function (v) {
                                                const id = v.variationId || v.id;
                                                if (id) menuItemIds.push(id);
                                            });
                                        } else {
                                            if (it.id) menuItemIds.push(it.id);
                                        }
                                    });
                                    await refreshServingsCache(menuItemIds);
                                    const menuListTable = document.getElementById('menuListTableBody');
                                    if (menuListTable) {
                                        await renderMenuListTable();
                                    }
                                }
                            } catch (error) {
                                console.error(`Error deducting servings for new order ${order.id}:`, error);
                            }
                        } else {
                            console.log(`Skipping order ${order.id} - status is ${orderStatus}, not "new" or "pending"`);
                        }
                    }
                }
                // Recalculate isNew status for all orders (in case time has passed)
                ordersState.forEach(order => {
                    if (order.createdAt && order.createdAt instanceof Date) {
                        const now = new Date();
                        const timeDiff = now.getTime() - order.createdAt.getTime();
                        const minutesDiff = timeDiff / (1000 * 60);
                        order.isNew = minutesDiff < 8 && (order.status === 'pending' || order.status === 'new');
                    }
                });
                
                // Process orders for automated payment verification
                // Run this asynchronously so it doesn't block the UI update
                processOrdersForAutoVerification(previousOrders, ordersState).catch(error => {
                    console.error('Error in automated payment verification:', error);
                });
                
                renderOrdersTable(ordersState);
                hydrateOrderCustomers(ordersState);
                await refreshMenuOrderDependentViews();
                // Also update driver statuses when orders change
                if (driversState.length > 0) {
                    updateDriverStatusesWithOrders();
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
        await refreshMenuOrderDependentViews();
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
    await refreshMenuOrderDependentViews();
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
    const updatedAt = normalizeOrderTimestamp(
        data.updatedAt ||
        data.updated_at ||
        data.lastUpdated ||
        data.last_updated ||
        createdAt
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
    
    // Extract payment information from various possible locations
    const paymentInfo = data.payment || {};
    const paymentProofPath = data.paymentProof || data.payment_proof || data.paymentProofPath || data.payment_proof_path || 
                             paymentInfo.gcashProofPath || paymentInfo.gcash_proof_path || 
                             deliveryInfo.paymentProof || deliveryInfo.payment_proof || '';
    const paymentProofUrl = paymentInfo.gcashProofUrl || paymentInfo.gcash_proof_url || 
                            paymentInfo.gcashProofURL || paymentInfo.gcash_proof_URL || '';
    const paymentReferenceNumber = paymentInfo.referenceNumber || paymentInfo.reference_number || 
                                   paymentInfo.gcashReference || paymentInfo.gcash_reference || 
                                   paymentInfo.gcashRefNo || paymentInfo.gcash_ref_no || 
                                   paymentInfo.transactionRef || paymentInfo.transaction_ref || 
                                   data.paymentReference || data.payment_reference || 
                                   data.gcashRefNo || data.gcash_ref_no || '';
    const gcashAccountName = paymentInfo.gcashAccountName || paymentInfo.gcash_account_name || 
                             paymentInfo.accountName || paymentInfo.account_name || 
                             data.gcashAccountName || data.gcash_account_name || '';
    const paymentTimestamp = paymentInfo.paymentTimestamp || paymentInfo.payment_timestamp || 
                            paymentInfo.timestamp || data.paymentTimestamp || data.payment_timestamp || null;
    
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
        paymentProofUrl: paymentProofUrl,
        paymentReferenceNumber: paymentReferenceNumber,
        gcashAccountName: gcashAccountName,
        paymentTimestamp: paymentTimestamp ? (paymentTimestamp instanceof Date ? paymentTimestamp : new Date(paymentTimestamp)) : null,
        paymentVerified: data.paymentVerified || false,
        paymentVerifiedAt: data.paymentVerifiedAt || null,
        paymentAutoVerified: data.paymentAutoVerified || false,
        paymentProofVersion: data.paymentProofVersion || 1,
        paymentProofHistory: Array.isArray(data.paymentProofHistory) ? data.paymentProofHistory : [],
        createdAt,
        updatedAt,
        createdLabel: createdAt ? formatDateLabel(createdAt) : (typeof data.timestamp === 'string' ? data.timestamp : '—')
    };
}

function filterOrdersByCriteria(orders) {
    if (!orders || !orders.length) return [];
    
    let filtered = [...orders];
    
    // For Orders tab (orders.html), only show online orders (delivery), exclude dine-in and pick-up
    const isOrdersPage = window.location.pathname.includes('orders.html') || 
                         document.getElementById('orderServiceTypeFilter') !== null;
    if (isOrdersPage) {
        filtered = filtered.filter(order => {
            const serviceType = (order.serviceType || '').toLowerCase().trim();
            // Only show delivery orders (exclude dine-in and pick-up)
            return serviceType === 'delivery' || 
                   (!serviceType || (serviceType !== 'dine-in' && serviceType !== 'dinein' && 
                                     serviceType !== 'pick-up' && serviceType !== 'pickup' && serviceType !== 'pick_up'));
        });
    }
    
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
    if (orderFilters.filter && orderFilters.filter !== 'all' && orderFilters.filter !== 'old-to-new' && orderFilters.filter !== 'new-to-old') {
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
                } else if (statusFilter === 'declined') {
                    return orderStatus === 'declined';
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
        emptyRow.innerHTML = '<td colspan="9" class="empty-table">No orders found matching the current filters.</td>';
        tableBody.appendChild(emptyRow);
        updateOrdersPagination(0);
        return;
    }

    // Sort orders based on filter
    let sortedOrders = [...filteredOrders];
    if (orderFilters.filter === 'old-to-new') {
        // Old to new: ascending order by creation time
        sortedOrders.sort((a, b) => {
            const aTime = a?.createdAt instanceof Date ? a.createdAt.getTime() : 
                         (a?.createdAt?.toDate ? a.createdAt.toDate().getTime() : 
                         (a?.createdAt ? new Date(a.createdAt).getTime() : 0));
            const bTime = b?.createdAt instanceof Date ? b.createdAt.getTime() : 
                         (b?.createdAt?.toDate ? b.createdAt.toDate().getTime() : 
                         (b?.createdAt ? new Date(b.createdAt).getTime() : 0));
            return aTime - bTime;
        });
    } else if (orderFilters.filter === 'new-to-old') {
        // New to old: descending order by creation time
        sortedOrders.sort((a, b) => {
            const aTime = a?.createdAt instanceof Date ? a.createdAt.getTime() : 
                         (a?.createdAt?.toDate ? a.createdAt.toDate().getTime() : 
                         (a?.createdAt ? new Date(a.createdAt).getTime() : 0));
            const bTime = b?.createdAt instanceof Date ? b.createdAt.getTime() : 
                         (b?.createdAt?.toDate ? b.createdAt.toDate().getTime() : 
                         (b?.createdAt ? new Date(b.createdAt).getTime() : 0));
            return bTime - aTime;
        });
    } else {
        // Default: new to old (descending order by creation time)
        sortedOrders.sort((a, b) => {
            const aTime = a?.createdAt instanceof Date ? a.createdAt.getTime() : 
                         (a?.createdAt?.toDate ? a.createdAt.toDate().getTime() : 
                         (a?.createdAt ? new Date(a.createdAt).getTime() : 0));
            const bTime = b?.createdAt instanceof Date ? b.createdAt.getTime() : 
                         (b?.createdAt?.toDate ? b.createdAt.toDate().getTime() : 
                         (b?.createdAt ? new Date(b.createdAt).getTime() : 0));
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
                                orderStatusLower === 'out for delivery' ||
                                orderStatusLower === 'in-transit' ||
                                orderStatusLower === 'in_transit' ||
                                orderStatusLower === 'on the way' ||
                                orderStatusLower === 'on-the-way';
        const isDelivered = orderStatusLower === 'delivered' || orderStatusLower === 'completed';
        const isCancelled = orderStatusLower === 'cancelled' || orderStatusLower === 'canceled' || orderStatusLower === 'failed';
        const isDeclined = orderStatusLower === 'declined';
        const hasDriver = !!(order.driverId && (typeof order.driverId === 'string' ? order.driverId.trim() : order.driverId));
        
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
                availableStatuses.push({ value: 'preparing', label: 'In Kitchen' });
            }
        } else if (isPreparing) {
            // From preparing, can go to:
            // - Out for Delivery (for delivery orders)
            // - Ready for Pick-up (for pick-up orders)
            // - Ready (for dine-in orders)
            if (isDeliveryOrder && hasDeliveryAddress && hasDriver) {
                availableStatuses.push({ value: 'out for delivery', label: 'On the Way' });
            } else if (isPickUp) {
                availableStatuses.push({ value: 'ready for pick-up', label: 'Ready for Pick-up' });
            } else if (isDineIn) {
                // Dine-in goes to Ready status
                availableStatuses.push({ value: 'ready', label: 'Ready' });
            }
        } else if (isReadyForPickup) {
            // From ready for pick-up, can mark as delivered
            if (isPickUp) {
                availableStatuses.push({ value: 'delivered', label: 'Done' });
            }
        } else if (orderStatusLower === 'ready') {
            // From ready (dine-in), can mark as delivered
            if (isDineIn) {
                availableStatuses.push({ value: 'delivered', label: 'Done' });
            }
        } else if (isReadyForDelivery) {
            // From ready for delivery, can go to out for delivery (only if driver already assigned)
            if (isDeliveryOrder && hasDriver) {
                availableStatuses.push({ value: 'out for delivery', label: 'On the Way' });
            }
        } else if (isOutForDelivery) {
            // From out for delivery, can mark as delivered
            if (isDeliveryOrder) {
                availableStatuses.push({ value: 'delivered', label: 'Done' });
            }
        }
        
        // Build status display - pass order object to check for resubmission and verification status
        const statusDisplay = formatOrderStatusBadge(order.status, order);
        
        // Get customer name
        const customerName = formatOrderCustomer(order);
        
        // Get location
        const location = formatOrderLocation(order);
        
        // Get time
        const orderTime = formatOrderTime(order);
        
        // Service type badge for Order Type column
        let serviceTypeBadge = '';
        if (orderServiceType === 'dine-in' || orderServiceType === 'dinein') {
            serviceTypeBadge = '<span class="service-badge dine-in"><i class="fas fa-utensils"></i> Dine In</span>';
        } else if (orderServiceType === 'pick-up' || orderServiceType === 'pickup' || orderServiceType === 'pick_up') {
            serviceTypeBadge = '<span class="service-badge pick-up"><i class="fas fa-shopping-bag"></i> Pick Up</span>';
        } else {
            serviceTypeBadge = '<span class="service-badge delivery"><i class="fas fa-truck"></i> Delivery</span>';
        }
        
        // Build action buttons
        let actionButtonsHTML = '';
        if (order.id) {
            const escapedOrderId = String(order.id).replace(/'/g, "\\'").replace(/"/g, '\\"');
            const buttons = [];
            
            // Show Reopen Order button for declined orders
            if (isDeclined) {
                buttons.push(`<button class="order-action-btn btn-reopen" onclick="event.stopPropagation(); reopenOrder('${escapedOrderId}')" title="Reopen Order">
                    <i class="fas fa-redo"></i> Reopen Order
                </button>`);
            } else {
                // Show Verify Payment button for unverified GCash orders
                if (isGCashOrder && !isPaymentVerified) {
                    buttons.push(`<button class="order-action-btn btn-accept-payment" onclick="event.stopPropagation(); verifyPayment('${escapedOrderId}')" title="Verify Payment">
                        <i class="fas fa-check-circle"></i> Verify Payment
                    </button>`);
                }
            }
            
            // Show Assign Driver when: delivery order with no driver, and (ready for delivery, or preparing with address, or already on the way)
            const showAssignDriver = isDeliveryOrder && !hasDriver && (
                isReadyForDelivery ||
                (isPreparing && hasDeliveryAddress) ||
                isOutForDelivery
            );
            if (showAssignDriver) {
                buttons.push(`<button class="order-action-btn btn-assign-driver" onclick="event.stopPropagation(); openDriverSelectionForOrder('${escapedOrderId}')" title="Assign Driver">
                    <i class="fas fa-user-tie"></i> Assign Driver
                </button>`);
            }
            
            // Show Change Status button if status can be changed (not for declined orders, not for out for delivery)
            if (availableStatuses.length > 0 && !isDelivered && !isCancelled && !isDeclined && !isOutForDelivery) {
                const canChangeStatus = !isPending || !isGCashOrder || isPaymentVerified;
                if (canChangeStatus) {
                    // Create dropdown for status change
                    const options = availableStatuses.map(s => 
                        `<option value="${s.value}">${s.label}</option>`
                    ).join('');
                    buttons.push(`<div class="order-action-btn-wrapper" onclick="event.stopPropagation();">
                        <select class="order-action-btn btn-change-status" onchange="if(this.value) { event.stopPropagation(); updateOrderStatus('${escapedOrderId}', this.value); this.value=''; }" title="Change Status">
                            <option value="">Change Status</option>
                            ${options}
                        </select>
                    </div>`);
                }
            }
            
            actionButtonsHTML = buttons.length > 0 
                ? `<div class="order-action-buttons">${buttons.join('')}</div>`
                : '<span style="color: #999;">—</span>';
        } else {
            actionButtonsHTML = '<span style="color: #999;">—</span>';
        }
        
        // Use action buttons directly (receipt buttons removed - receipt accessible via row click)
        const allActionsHTML = actionButtonsHTML;
        
        // Make row clickable to show order details (which includes receipt access)
        if (order.id) {
            row.style.cursor = 'pointer';
            row.onclick = function(e) {
                // Don't trigger if clicking on action buttons
                if (!e.target.closest('.order-action-buttons') && 
                    !e.target.closest('.order-action-btn') && 
                    !e.target.closest('select')) {
                    viewOrderDetails(order.id);
                }
            };
        }
        
        row.innerHTML = `
            <td class="order-id-column">
                ${escapeHtml(order.trackingId || order.id)}
            </td>
            <td class="customer-name-column">${escapeHtml(customerName)}</td>
            <td class="order-type-column">${serviceTypeBadge}</td>
            <td class="location-column">${location}</td>
            <td class="status-column">${statusDisplay}</td>
            <td class="time-column">${escapeHtml(orderTime)}</td>
            <td class="actions-column">
                ${allActionsHTML}
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

// Format order time using updatedAt from Firebase
function formatOrderTime(order) {
    if (!order) return '—';
    
    // Use updatedAt if available, otherwise fall back to createdAt
    let timeToFormat = order.updatedAt || order.updated_at || order.createdAt;
    
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
    
    // Format as MM/DD/YYYY HH:MM (proper format)
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month}/${day}/${year} ${hours}:${minutes}`;
}

function formatOrderCustomer(order) {
    if (!order) return '—';
    const userId = order.userId;
    // If no userId, it's a guest order
    if (!userId) {
        return 'Guest';
    }
    // Check if we have customer name in cache
    if (customerDetailsCache.has(userId)) {
        const cached = customerDetailsCache.get(userId);
        return cached?.name || escapeHtml(userId);
    }
    // Check if order has customerName directly
    if (order.customerName) {
        return order.customerName;
    }
    // Fall back to userId if name not available yet
    return escapeHtml(userId);
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

// window.InventoryStore removed - system is now recipe-based

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
                closedIcon.classList.remove('open');
            }
        }
        // Reset filter button icon
        const closedFilterBtn = currentDropdown.closest('.filter-container')?.querySelector('.filter-btn');
        if (closedFilterBtn) {
            closedFilterBtn.classList.remove('open');
        }
    }
    
    // Toggle the clicked dropdown
    const dropdown = document.getElementById(dropdownId);
    if (dropdown) {
        const isOpening = !dropdown.classList.contains('show');
        dropdown.classList.toggle('show');
        activeDropdown = dropdown.classList.contains('show') ? dropdownId : null;
        
        // Update icon for user profile dropdown
        if (dropdownId === 'adminDropdown') {
            const profileButton = dropdown.closest('.user-profile')?.querySelector('.profile-btn');
            if (profileButton) {
                const chevronIcon = profileButton.querySelector('.fa-chevron-down, .fa-chevron-right');
                if (chevronIcon) {
                    if (isOpening) {
                        chevronIcon.classList.add('open');
                    } else {
                        chevronIcon.classList.remove('open');
                    }
                }
            }
        }
        
        // Update icon for filter dropdown
        if (dropdownId === 'filterDropdown') {
            const filterButton = dropdown.closest('.filter-container')?.querySelector('.filter-btn');
            if (filterButton) {
                if (isOpening) {
                    filterButton.classList.add('open');
                } else {
                    filterButton.classList.remove('open');
                }
            }
        }
        
    }
}

// Sidebar Menu tab dropdown (Menu Catalogue / List / Add Product / Product Detail)
function toggleMenuTabDropdown() {
    const submenu = document.getElementById('menuTabDropdown');
    if (!submenu) return;
    
    const navItem = submenu.closest('.menu-nav-dropdown');
    const icon = navItem ? navItem.querySelector('.menu-toggle-icon') : null;
    if (!icon) return;

    const willShow = !submenu.classList.contains('show');
    submenu.classList.toggle('show', willShow);
    navItem.classList.toggle('active', willShow);

    // Update icon: > when closed, v when open
    if (willShow) {
        icon.classList.add('open');
    } else {
        icon.classList.remove('open');
    }
}

function toggleCustomerTabDropdown() {
    const submenu = document.getElementById('customerTabDropdown');
    const navItem = submenu ? submenu.closest('.menu-nav-dropdown') : null;
    const icon = navItem ? navItem.querySelector('.menu-toggle-icon') : null;
    if (!submenu || !icon) return;

    const willShow = !submenu.classList.contains('show');
    submenu.classList.toggle('show', willShow);
    navItem.classList.toggle('active', willShow);

    // Update icon: > when closed, v when open
    if (willShow) {
        icon.classList.add('open');
    } else {
        icon.classList.remove('open');
    }
}

function togglePromotionTabDropdown() {
    const submenu = document.getElementById('promotionTabDropdown');
    const navItem = submenu ? submenu.closest('.menu-nav-dropdown') : null;
    const icon = navItem ? navItem.querySelector('.menu-toggle-icon') : null;
    if (!submenu || !icon) return;

    const willShow = !submenu.classList.contains('show');
    submenu.classList.toggle('show', willShow);
    navItem.classList.toggle('active', willShow);

    // Update icon: > when closed, v when open
    if (willShow) {
        icon.classList.add('open');
    } else {
        icon.classList.remove('open');
    }
}

function toggleAnalyticsTabDropdown() {
    const submenu = document.getElementById('analyticsTabDropdown');
    if (!submenu) return;
    
    const navItem = submenu.closest('.menu-nav-dropdown');
    const icon = navItem ? navItem.querySelector('.menu-toggle-icon') : null;
    if (!icon) return;

    const willShow = !submenu.classList.contains('show');
    submenu.classList.toggle('show', willShow);
    navItem.classList.toggle('active', willShow);

    // Update icon: > when closed, v when open
    if (willShow) {
        icon.classList.add('open');
    } else {
        icon.classList.remove('open');
    }
}

// Close dropdowns when clicking outside or on toggle button again
document.addEventListener('click', function(event) {
    // Check if clicking on a link inside a dropdown - don't close dropdowns in this case
    const clickedLink = event.target.closest('a[href]');
    if (clickedLink && clickedLink.closest('.menu-nav-submenu, .dropdown-menu')) {
        // User clicked a navigation link - don't close dropdowns, let navigation happen
        return;
    }
    
    // Handle profile/filter dropdowns
    if (activeDropdown) {
        const dropdown = document.getElementById(activeDropdown);
        if (!dropdown) {
            activeDropdown = null;
            return;
        }
        
        // Check if clicking inside the dropdown
        const isInsideDropdown = dropdown.contains(event.target);
        
        // Check if clicking on any toggle button (let toggleDropdown handle it)
        const isToggleButton = event.target.closest('[onclick*="toggleDropdown"]');
        
        // Close if clicking outside the dropdown and not on a toggle button
        if (!isInsideDropdown && !isToggleButton) {
            dropdown.classList.remove('show');
            
            // Reset icon for user profile dropdown
            if (activeDropdown === 'adminDropdown') {
                const profileButton = dropdown.closest('.user-profile')?.querySelector('.profile-btn');
                if (profileButton) {
                    const chevronIcon = profileButton.querySelector('.fa-chevron-down, .fa-chevron-right');
                    if (chevronIcon) {
                        chevronIcon.classList.remove('open');
                    }
                }
            }
            
            // Reset filter button icon
            if (activeDropdown === 'filterDropdown') {
                const filterButton = dropdown.closest('.filter-container')?.querySelector('.filter-btn');
                if (filterButton) {
                    filterButton.classList.remove('open');
                }
            }
            
            activeDropdown = null;
        }
    }
    
    // (Menu/Customer dropdowns are controlled by their toggles; do not auto-close here)
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

// Apply filters from orders.html dropdowns
function applyOrderFilters() {
    const sortFilter = document.getElementById('orderSortFilter');
    const statusFilter = document.getElementById('orderStatusFilter');
    const serviceTypeFilter = document.getElementById('orderServiceTypeFilter');
    
    // Get sort value
    let filterValue = 'new-to-old';
    if (sortFilter && sortFilter.value) {
        filterValue = sortFilter.value;
    }
    
    // Combine status and service type filters if they exist
    const parts = [];
    if (serviceTypeFilter && serviceTypeFilter.value) {
        parts.push(`type:${serviceTypeFilter.value}`);
    }
    if (statusFilter && statusFilter.value) {
        parts.push(`status:${statusFilter.value}`);
    }
    
    if (parts.length > 0) {
        orderFilters.filter = parts.join('|');
    } else {
        orderFilters.filter = filterValue;
    }
    
    ordersCurrentPage = 1; // Reset to first page when filter changes
    renderOrdersTable(ordersState);
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
    
    // Normalize status variations to "preparing"
    const preparingStatuses = ['preparing', 'in kitchen', 'being-cooked', 'being_cooked', 'cooking', 'being cooked', 'accepted'];
    let actualNewStatus = normalizedNewStatus;
    if (preparingStatuses.includes(normalizedNewStatus)) {
        actualNewStatus = 'preparing'; // Normalize to "preparing" for database
    }
    
    // Cannot change status from declined (must use reopen function)
    if (currentStatus === 'declined' && actualNewStatus !== 'pending') {
        statusValid = false;
        errorMessage = 'Declined orders must be reopened first. Use the "Reopen Order" button.';
    } else if (preparingStatuses.includes(normalizedNewStatus)) {
        // Can move to preparing (or any variation) from pending
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
        // Can move to delivered from ready (dine-in), ready for pick-up (pickup), or out for delivery (delivery)
        const isReady = currentStatus === 'ready';
        const isReadyForPickup = currentStatus === 'ready for pick-up' || currentStatus === 'ready_for_pickup' || currentStatus === 'ready for pickup';
        const isOutForDelivery = currentStatus === 'out_for_delivery' || currentStatus === 'out-for-delivery' || 
                                 currentStatus === 'in-transit' || currentStatus === 'in_transit';
        
        // Allow delivered status for dine-in (from ready), pickup (from ready for pick-up), or delivery orders (from out for delivery)
        statusValid = (isReady && isDineIn) || (isReadyForPickup && isPickUp) || (isOutForDelivery && isDeliveryOrder);
        
        if (!statusValid) {
            errorMessage = 'Order must be "Ready" (dine-in), "Ready for Pick-up" (pickup), or "Out for Delivery" (delivery) before marking as done.';
        }
    } else {
        errorMessage = `Invalid status transition to "${newStatus}".`;
    }
    
    if (!statusValid) {
        showNotification(errorMessage, 'error');
        return;
    }
    
    // Require a driver before marking delivery orders as "On the Way"
    if ((normalizedNewStatus === 'out for delivery' || normalizedNewStatus === 'out_for_delivery') && isDeliveryOrder) {
        const hasDriver = !!(order.driverId && (typeof order.driverId === 'string' ? order.driverId.trim() : order.driverId));
        if (!hasDriver) {
            showNotification('Please assign a driver before marking the order as On the Way.', 'error');
            openDriverSelectionForOrder(orderId);
            return;
        }
    }
    
    // NOTE: Daily servings are now deducted when orders are created (status: "new" or "pending")
    // This happens in subscribeToOrdersCollection() when detecting new orders
    // We no longer deduct when moving to preparing status

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
        'delivered': 'Done'
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
            
        // Prepare update object (use normalized status for database)
        const updateData = {
            status: actualNewStatus, // Use normalized status
            updatedAt: fns.serverTimestamp()
        };
        
        // Add timestamp fields based on status
        if (actualNewStatus === 'preparing' || preparingStatuses.includes(normalizedNewStatus)) {
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
        
        // Print kitchen receipt when order moves to In Kitchen (cashier gives to kitchen)
        if (actualNewStatus === 'preparing' || preparingStatuses.includes(normalizedNewStatus)) {
            if (typeof printKitchenReceipt === 'function') {
                printKitchenReceipt(order);
            }
        }
        
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
        
        // Print customer copy receipt when order is On The Way or Ready to Pickup
        const isOutForDeliveryStatus = ['out for delivery', 'out_for_delivery', 'out-for-delivery', 'in-transit', 'in_transit', 'on-the-way', 'on_the_way'].includes(normalizedNewStatus);
        const isReadyForPickupStatus = ['ready for pick-up', 'ready_for_pickup', 'ready for pickup'].includes(normalizedNewStatus);
        if (isOutForDeliveryStatus || isReadyForPickupStatus) {
            if (typeof printCustomerReceipt === 'function') {
                printCustomerReceipt(order);
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

async function ensureMenuStateLoaded() {
    if (menuState && menuState.length) return menuState;
    await refreshMenuState();
    return menuState;
}

function findMenuItemByOrderItem(orderItem) {
    if (!orderItem || !menuState || !menuState.length) return null;
    const candidates = [
        (orderItem.itemId || '').toLowerCase(),
        (orderItem.id || '').toLowerCase(),
        (orderItem.menuId || '').toLowerCase(),
        (orderItem.name || '').toLowerCase(),
        (orderItem.itemName || '').toLowerCase(),
    ].filter(Boolean);
    return menuState.find(menuItem => {
        const ids = [
            (menuItem.id || '').toLowerCase(),
            (menuItem.menuId || '').toLowerCase(),
            (menuItem.name || '').toLowerCase(),
            (menuItem.displayName || '').toLowerCase(),
        ];
        return candidates.some(c => ids.includes(c));
    }) || null;
}

function getIngredientsForOrderItem(menuItem, orderItem) {
    // Currently use the menu item's ingredients list (baseAmountPerDish is in base units)
    if (!menuItem || !Array.isArray(menuItem.ingredients)) return [];
    return menuItem.ingredients;
}

async function deductMenuQuantityForOrder(order) {
    if (!order || !Array.isArray(order.items) || !order.items.length) return;
    await ensureMenuStateLoaded();
    
    const fns = window.firestoreFunctions;
    if (!fns || !window.db) return;
    
    for (const orderItem of order.items) {
        const orderQty = Number(orderItem.quantity) > 0 ? Number(orderItem.quantity) : 1;
        const menuItem = findMenuItemByOrderItem(orderItem);
        if (!menuItem) continue;
        
        try {
            const menuRef = fns.doc(window.db, 'menu', menuItem.id);
            const menuDoc = await fns.getDoc(menuRef);
            
            if (!menuDoc.exists()) continue;
            
            const currentData = menuDoc.data();
            const hasVariations = Array.isArray(currentData.variations) && currentData.variations.length > 0;
            
            // Check if order item is for a specific variation
            const orderItemName = (orderItem.name || orderItem.itemName || '').toLowerCase();
            const orderItemId = (orderItem.itemId || orderItem.id || '').toLowerCase();
            
            if (hasVariations) {
                // Find matching variation
                let variationIndex = -1;
                currentData.variations.forEach((v, idx) => {
                    const varName = (v.name || '').toLowerCase();
                    const varId = (v.variationId || v.id || '').toLowerCase();
                    if (orderItemName === varName || orderItemId === varId || 
                        orderItemName.includes(varName) || varName.includes(orderItemName)) {
                        variationIndex = idx;
                    }
                });
                
                if (variationIndex >= 0) {
                    // Update variation quantity
                    const variations = [...currentData.variations];
                    const currentVarQty = variations[variationIndex].quantity || 0;
                    const newVarQty = Math.max(0, currentVarQty - orderQty);
                    variations[variationIndex] = {
                        ...variations[variationIndex],
                        quantity: newVarQty
                    };
                    
                    await fns.updateDoc(menuRef, {
                        variations: variations,
                        updatedAt: fns.serverTimestamp()
                    });
                } else {
                    // No matching variation, decrement parent quantity
                    const currentQty = currentData.quantity || 0;
                    const newQty = Math.max(0, currentQty - orderQty);
                    await fns.updateDoc(menuRef, {
                        quantity: newQty,
                        updatedAt: fns.serverTimestamp()
                    });
                }
            } else {
                // No variations, decrement parent quantity
                const currentQty = currentData.quantity || 0;
                const newQty = Math.max(0, currentQty - orderQty);
                await fns.updateDoc(menuRef, {
                    quantity: newQty,
                    updatedAt: fns.serverTimestamp()
                });
            }
        } catch (e) {
            console.warn('Failed to deduct menu quantity for item', menuItem.id, e);
        }
    }
}

// NEW: Deduct daily servings when order moves to preparing
async function deductDailyServingsForOrder(order) {
    if (!order || !Array.isArray(order.items) || !order.items.length) {
        console.warn('deductDailyServingsForOrder: Order or items missing', { orderId: order?.id, hasItems: !!order?.items });
        return;
    }
    
    await ensureMenuStateLoaded();
    
    console.log(`deductDailyServingsForOrder: Processing order ${order.id} with ${order.items.length} items`);
    
    for (const orderItem of order.items) {
        const qty = Number(orderItem.quantity) > 0 ? Number(orderItem.quantity) : 1;
        const menuItemName = orderItem.name || orderItem.itemName || 'Unknown Item';
        
        const menuItem = findMenuItemByOrderItem(orderItem);
        if (!menuItem) {
            console.warn('deductDailyServingsForOrder: Could not find menu item for order item', orderItem);
            continue;
        }
        
        let menuItemId, maxServings;
        const orderName = (orderItem.name || orderItem.itemName || '').toLowerCase();
        const orderId = (orderItem.itemId || orderItem.id || '').toLowerCase();
        const hasVariations = Array.isArray(menuItem.variations) && menuItem.variations.length > 0;
        
        if (hasVariations) {
            let matched = null;
            for (let i = 0; i < menuItem.variations.length; i++) {
                const v = menuItem.variations[i];
                const vName = (v.name || '').toLowerCase();
                const vId = (v.variationId || v.id || '').toLowerCase();
                if (vName && (orderName === vName || orderName.includes(vName) || vName.includes(orderName)) ||
                    vId && (orderId === vId || orderId.includes(vId) || vId.includes(orderId))) {
                    matched = v;
                    break;
                }
            }
            if (matched) {
                menuItemId = matched.variationId || matched.id;
                maxServings = (matched.quantity !== undefined && matched.quantity !== null) ? Number(matched.quantity) : 0;
            } else {
                menuItemId = menuItem.id;
                maxServings = menuItem.maxServingsPerDay !== null && menuItem.maxServingsPerDay !== undefined ? menuItem.maxServingsPerDay : 0;
            }
        } else {
            menuItemId = menuItem.id;
            maxServings = menuItem.maxServingsPerDay !== null && menuItem.maxServingsPerDay !== undefined ? menuItem.maxServingsPerDay : 0;
        }
        
        console.log(`deductDailyServingsForOrder: Deducting ${qty} servings for ${menuItemName} (menuItemId: ${menuItemId})`);
        
        try {
            await DailyServingsStore.incrementServing(menuItemId, menuItemName, maxServings, qty);
            console.log(`deductDailyServingsForOrder: Successfully incremented serving for ${menuItemName} (${menuItemId})`);
            
            const currentCount = todayServingsCache[menuItemId] || 0;
            todayServingsCache[menuItemId] = currentCount + qty;
            console.log(`deductDailyServingsForOrder: Updated cache for ${menuItemId}: ${currentCount} -> ${todayServingsCache[menuItemId]}`);
            
            // NEW: Log ingredient usage
            if (menuItem && Array.isArray(menuItem.ingredients) && menuItem.ingredients.length > 0) {
                for (const ingredient of menuItem.ingredients) {
                    if (ingredient.ingredientId && ingredient.baseAmountPerDish) {
                        const totalAmount = Number(ingredient.baseAmountPerDish) * qty;
                        try {
                            await IngredientLogStore.logIngredientUsage(
                                ingredient.ingredientId,
                                ingredient.ingredientName || ingredient.ingredientId,
                                totalAmount,
                                order.id || order.trackingId,
                                menuItemName
                            );
                        } catch (error) {
                            console.error(`Error logging ingredient usage for ${ingredient.ingredientId}:`, error);
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Error deducting serving for ${menuItemId}:`, error);
            // Continue with other items even if one fails
        }
    }
    
    console.log(`deductDailyServingsForOrder: Completed processing order ${order.id}`);
}

// Track synced orders to prevent double-processing in the same session
const syncedOrdersToday = new Set();

// Sync dailyServings for existing orders that are already in preparing status (today only)
async function syncDailyServingsForExistingOrders() {
    try {
        // Check if we've already synced today (using session storage key)
        const syncKey = `dailyServings_synced_${DailyServingsStore.getTodayDateString()}`;
        if (sessionStorage.getItem(syncKey) === 'true') {
            console.log('DailyServings already synced for today');
            return;
        }
        
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            console.warn('Firestore not ready for sync');
            return;
        }
        
        const today = DailyServingsStore.getTodayDateString();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        
        // Normalize timestamps for comparison
        const normalizeTimestamp = (ts) => {
            if (!ts) return null;
            if (ts instanceof Date) return ts;
            if (ts.toDate && typeof ts.toDate === 'function') return ts.toDate();
            if (ts._seconds) return new Date(ts._seconds * 1000);
            if (typeof ts === 'number') return new Date(ts);
            return new Date(ts);
        };
        
        // Query orders that are in preparing status (or variations)
        const preparingStatuses = ['preparing', 'in kitchen', 'being-cooked', 'being_cooked', 'cooking', 'being cooked', 'accepted'];
        const ordersCol = fns.collection(window.db, 'orders');
        const ordersSnapshot = await fns.getDocs(ordersCol);
        
        const ordersToProcess = [];
        
        ordersSnapshot.docs.forEach(doc => {
            const orderData = doc.data();
            const orderStatus = (orderData.status || '').toLowerCase().trim();
            
            // Check if order is in preparing status
            if (preparingStatuses.includes(orderStatus)) {
                // Check if order was created or updated today
                const createdAt = normalizeTimestamp(orderData.createdAt);
                const updatedAt = normalizeTimestamp(orderData.updatedAt);
                const cookingStartedAt = normalizeTimestamp(orderData.cookingStartedAt);
                
                const isToday = (createdAt && createdAt >= todayStart && createdAt <= todayEnd) ||
                               (updatedAt && updatedAt >= todayStart && updatedAt <= todayEnd) ||
                               (cookingStartedAt && cookingStartedAt >= todayStart && cookingStartedAt <= todayEnd);
                
                // Only process if order is from today and hasn't been synced yet
                if (isToday && !syncedOrdersToday.has(doc.id)) {
                    ordersToProcess.push({
                        id: doc.id,
                        ...orderData,
                        items: orderData.items || []
                    });
                    syncedOrdersToday.add(doc.id);
                }
            }
        });
        
        if (ordersToProcess.length === 0) {
            console.log('No existing orders in preparing status for today to sync');
            // Mark as synced even if no orders to process
            sessionStorage.setItem(syncKey, 'true');
            return;
        }
        
        console.log(`Syncing dailyServings for ${ordersToProcess.length} existing orders in preparing status (today only)`);
        
        await ensureMenuStateLoaded();
        
        // Process each order
        let syncedCount = 0;
        for (const order of ordersToProcess) {
            try {
                // Process each item in the order (resolve variation so we use variation-specific id and quantity)
                for (const orderItem of order.items) {
                    const qty = Number(orderItem.quantity) > 0 ? Number(orderItem.quantity) : 1;
                    const menuItemName = orderItem.name || orderItem.itemName || 'Unknown Item';
                    
                    const menuItem = findMenuItemByOrderItem(orderItem);
                    if (!menuItem) continue;
                    
                    let menuItemId, maxServings;
                    const orderName = (orderItem.name || orderItem.itemName || '').toLowerCase();
                    const orderId = (orderItem.itemId || orderItem.id || orderItem.menuItemId || '').toLowerCase();
                    const hasVariations = Array.isArray(menuItem.variations) && menuItem.variations.length > 0;
                    
                    if (hasVariations) {
                        let matched = null;
                        for (let i = 0; i < menuItem.variations.length; i++) {
                            const v = menuItem.variations[i];
                            const vName = (v.name || '').toLowerCase();
                            const vId = (v.variationId || v.id || '').toLowerCase();
                            if ((vName && (orderName === vName || orderName.includes(vName) || vName.includes(orderName))) ||
                                (vId && (orderId === vId || orderId.includes(vId) || vId.includes(orderId)))) {
                                matched = v;
                                break;
                            }
                        }
                        if (matched) {
                            menuItemId = matched.variationId || matched.id;
                            maxServings = (matched.quantity !== undefined && matched.quantity !== null) ? Number(matched.quantity) : null;
                        } else {
                            menuItemId = menuItem.id;
                            maxServings = menuItem.maxServingsPerDay != null ? menuItem.maxServingsPerDay : null;
                        }
                    } else {
                        menuItemId = menuItem.id;
                        maxServings = menuItem.maxServingsPerDay != null ? menuItem.maxServingsPerDay : null;
                    }
                    
                    if (!menuItemId) continue;
                    
                    try {
                        await DailyServingsStore.incrementServing(menuItemId, menuItemName, maxServings, qty);
                    } catch (error) {
                        console.warn(`Failed to sync serving for ${menuItemId} in order ${order.id}:`, error);
                    }
                }
                
                syncedCount++;
            } catch (error) {
                console.error(`Error syncing order ${order.id}:`, error);
            }
        }
        
        console.log(`Successfully synced dailyServings for ${syncedCount} orders`);
        
        // Mark as synced for today
        sessionStorage.setItem(syncKey, 'true');
        
        // Refresh serving cache (include variation ids) and menu list
        if (menuState && menuState.length > 0) {
            const menuItemIds = [];
            menuState.forEach(function (item) {
                if (Array.isArray(item.variations) && item.variations.length > 0) {
                    item.variations.forEach(function (v) {
                        const id = v.variationId || v.id;
                        if (id) menuItemIds.push(id);
                    });
                } else {
                    if (item.id) menuItemIds.push(item.id);
                }
            });
            await refreshServingsCache(menuItemIds);
            const menuListTable = document.getElementById('menuListTableBody');
            if (menuListTable) {
                await renderMenuListTable();
            }
        }
        
    } catch (error) {
        console.error('Error syncing dailyServings for existing orders:', error);
    }
}

// DISABLED: Inventory deduction - kept for reference but no longer used
async function deductInventoryForOrder(order) {
    // DISABLED: Inventory tracking removed in favor of daily servings system
    // This function is kept for reference but no longer used
    console.log('Inventory deduction disabled - using daily servings system instead');
    return;
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
                return role === 'driver';
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
    if (!driversList) {
        console.error('renderDriversForSelection: driversSelectionList element not found');
        return;
    }
    
    console.log('renderDriversForSelection: currentOrderForAssignment =', currentOrderForAssignment);
    
    // Get order info for display
    let orderInfo = '';
    let nearbyOrders = [];
    if (currentOrderForAssignment) {
        const order = ordersState.find(o => o.id === currentOrderForAssignment);
        if (order) {
            orderInfo = ` for Order ${order.trackingId || currentOrderForAssignment}`;
            
            // Check for nearby orders
            nearbyOrders = checkForNearbyOrders(currentOrderForAssignment);
        }
    }
    
    // Update modal title if it exists
    const modalTitle = document.querySelector('#driverSelectionModal .modal-header h2, #driverSelectionModal .modal-header h3');
    if (modalTitle) {
        modalTitle.textContent = `Select Driver${orderInfo}`;
    }
    
    // Filter to only show available drivers
    const availableDrivers = driversState.filter(driver => driver.availability === 'available');
    
    console.log('Rendering driver selection - Total drivers:', driversState.length, 'Available:', availableDrivers.length);
    console.log('Available drivers:', availableDrivers.map(d => ({ name: d.name, driverId: d.driverId, availability: d.availability })));
    console.log('Nearby orders found:', nearbyOrders.length);
    
    driversList.innerHTML = '';
    
    // Show batch assignment option if nearby orders found
    if (nearbyOrders.length > 0 && currentOrderForAssignment && availableDrivers.length > 0) {
        const order = ordersState.find(o => o.id === currentOrderForAssignment);
        const primaryAddress = order?.address || order?.deliveryInfo?.address || '';
        const barangay = extractBarangayFromAddress(primaryAddress);
        
        const batchInfo = document.createElement('div');
        batchInfo.className = 'batch-assignment-info';
        batchInfo.style.cssText = 'background: #e3f2fd; border-left: 4px solid #2196f3; padding: 12px; margin-bottom: 16px; border-radius: 4px;';
        batchInfo.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-map-marker-alt" style="color: #2196f3;"></i>
                <strong style="color: #1976d2;">Nearby Orders Found (${nearbyOrders.length})</strong>
            </div>
            <p style="margin: 0 0 8px 0; color: #555; font-size: 0.9rem;">
                Found ${nearbyOrders.length} order(s) in the same barangay (${barangay || 'Unknown'}). 
                You can assign them together to optimize delivery route.
            </p>
            <div style="font-size: 0.85rem; color: #666; margin-bottom: 8px;">
                <strong>Orders:</strong> ${[order?.trackingId || currentOrderForAssignment, ...nearbyOrders.map(o => o.trackingId || o.id)].join(', ')}
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button class="btn btn-primary batch-assign-btn" data-driver-id="${availableDrivers[0]?.id || ''}" data-order-id="${currentOrderForAssignment}" 
                        style="font-size: 0.9rem; padding: 6px 12px;">
                    <i class="fas fa-layer-group"></i> Assign Batch (${nearbyOrders.length + 1} orders)
                </button>
                <button class="btn btn-secondary single-assign-btn" data-order-id="${currentOrderForAssignment}" 
                        style="font-size: 0.9rem; padding: 6px 12px;">
                    <i class="fas fa-shipping-fast"></i> Single Order Only
                </button>
            </div>
        `;
        driversList.appendChild(batchInfo);
        
        // Add event listeners for batch buttons
        const batchAssignBtn = batchInfo.querySelector('.batch-assign-btn');
        if (batchAssignBtn) {
            batchAssignBtn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const driverId = this.getAttribute('data-driver-id');
                const orderId = this.getAttribute('data-order-id');
                console.log('Batch assign button clicked:', { driverId, orderId });
                if (typeof assignBatchToDriver === 'function') {
                    assignBatchToDriver(driverId, orderId);
                } else {
                    console.error('assignBatchToDriver function not found on window');
                    showNotification('Error: Batch assignment function not available. Please refresh the page.', 'error');
                }
            });
        }
        
        const singleAssignBtn = batchInfo.querySelector('.single-assign-btn');
        if (singleAssignBtn) {
            singleAssignBtn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const orderId = this.getAttribute('data-order-id');
                console.log('Single assign button clicked:', { orderId });
                if (typeof assignSingleOrderOnly === 'function') {
                    assignSingleOrderOnly(orderId);
                } else {
                    console.error('assignSingleOrderOnly function not found on window');
                    showNotification('Error: Assignment function not available. Please refresh the page.', 'error');
                }
            });
        }
        
        // Add separator
        const separator = document.createElement('div');
        separator.style.cssText = 'border-top: 1px solid #ddd; margin: 16px 0;';
        driversList.appendChild(separator);
        
        const orText = document.createElement('div');
        orText.style.cssText = 'text-align: center; color: #999; font-size: 0.85rem; margin: 8px 0;';
        orText.textContent = 'OR select driver manually:';
        driversList.appendChild(orText);
    }
    
    if (!availableDrivers.length) {
        driversList.innerHTML = '<div class="empty-message">No available drivers at the moment.</div>';
        return;
    }
    
    // First-come-first-serve: Only the first driver can be assigned
    availableDrivers.forEach((driver, index) => {
        const isFirstInLine = index === 0;
        const driverItem = document.createElement('div');
        driverItem.className = 'driver-selection-item';
        
        // Set opacity to 70% if not first in line
        if (!isFirstInLine) {
            driverItem.style.opacity = '0.7';
        }
        
        driverItem.innerHTML = `
            <div class="driver-icon">
                <i class="fas fa-user"></i>
            </div>
            <div class="driver-info">
                <div class="driver-name">${escapeHtml(driver.name)}</div>
                <div class="driver-id">${escapeHtml(driver.driverId)}</div>
                <div class="driver-phone">${escapeHtml(driver.phoneNumber || 'No phone number')}</div>
            </div>
            <div class="driver-action">
                ${isFirstInLine && currentOrderForAssignment
                    ? `<button class="btn btn-primary assign-driver-btn" data-driver-id="${escapeHtml(driver.id)}" data-order-id="${escapeHtml(currentOrderForAssignment)}">
                           Assign
                       </button>`
                    : `<button class="btn btn-secondary" disabled style="cursor: not-allowed;">
                           Not Available
                       </button>`}
            </div>
        `;
        
        // Add event listener for assign button
        if (isFirstInLine && currentOrderForAssignment) {
            const assignBtn = driverItem.querySelector('.assign-driver-btn');
            if (assignBtn) {
                assignBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const driverId = this.getAttribute('data-driver-id');
                    const orderId = this.getAttribute('data-order-id');
                    console.log('Assign button clicked:', { driverId, orderId });
                    if (typeof assignDriverToOrder === 'function') {
                        assignDriverToOrder(driverId, orderId);
                    } else {
                        console.error('assignDriverToOrder function not found on window');
                        showNotification('Error: Assignment function not available. Please refresh the page.', 'error');
                    }
                });
            }
        }
        
        driversList.appendChild(driverItem);
    });
}

/**
 * Check for nearby orders ready for delivery in the same barangay
 */
function checkForNearbyOrders(orderId) {
    try {
        const order = ordersState.find(o => o.id === orderId);
        if (!order) {
            console.warn('checkForNearbyOrders: Order not found', orderId);
            return [];
        }
        
        // Get all orders ready for delivery
        const readyOrders = ordersState.filter(o => {
            const status = (o.status || '').toLowerCase().trim();
            return (status === 'ready for delivery' || 
                    status === 'ready_for_delivery' ||
                    status === 'for delivery' ||
                    status === 'for_delivery') &&
                   !o.driverId && // Not yet assigned
                   o.id !== orderId; // Not the same order
        });
        
        // Find nearby orders
        return findNearbyOrdersForBatching(order, readyOrders, { maxBatchSize: 3 });
    } catch (error) {
        console.error('Error checking for nearby orders:', error);
        return [];
    }
}

/**
 * Assign batch to driver (called from batch info button)
 */
async function assignBatchToDriver(driverId, primaryOrderId) {
    if (!driverId || !primaryOrderId) {
        showNotification('Invalid parameters for batch assignment.', 'error');
        return;
    }
    
    const primaryOrder = ordersState.find(o => o.id === primaryOrderId);
    if (!primaryOrder) {
        showNotification('Primary order not found.', 'error');
        return;
    }
    
    // Get nearby orders
    const nearbyOrders = checkForNearbyOrders(primaryOrderId);
    
    // Combine primary order with nearby orders
    const batchOrders = [primaryOrder, ...nearbyOrders];
    
    // Assign batch
    await assignDriverToBatch(driverId, batchOrders);
}

/**
 * Assign single order only (skip batching)
 */
async function assignSingleOrderOnly(orderId) {
    const availableDrivers = driversState.filter(d => d.availability === 'available');
    if (availableDrivers.length === 0) {
        showNotification('No available drivers.', 'error');
        return;
    }
    
    // Assign to first available driver
    await assignDriverToOrder(availableDrivers[0].id, orderId);
}

// Updated markOutForDelivery to use the new unified function
async function markOutForDelivery(orderId) {
    await updateOrderStatus(orderId, 'out for delivery');
}

async function openDriverSelectionForOrder(orderId) {
    currentOrderForAssignment = orderId;
    
    // Refresh driver statuses to ensure we have the latest availability
    // This ensures drivers who just started their shift appear as available
    if (driversState.length > 0) {
        await updateDriverStatusesWithOrders();
    } else {
        // If no drivers loaded yet, load them first
        try {
            await loadDrivers();
        } catch (error) {
            console.error('Error loading drivers for selection:', error);
        }
    }
    
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
    
    // Payment verification status indicator for GCash orders (informational only)
    const paymentStatusHtml = isGCashOrder && isPaymentVerified
        ? `<div style="margin-top: 10px; padding: 8px; background-color: #d4edda; color: #155724; border-radius: 4px; display: inline-block;">
            <i class="fas fa-check-circle"></i> Payment Verified
            ${order.paymentAutoVerified ? ' <span style="font-size: 0.85em; color: #28a745; font-weight: 600;">(Auto)</span>' : ''}
        </div>`
        : isGCashOrder && !isPaymentVerified
        ? `<div style="margin-top: 10px; padding: 8px; background-color: #fff3cd; color: #856404; border-radius: 4px; display: inline-block;">
            <i class="fas fa-exclamation-circle"></i> Payment Not Verified
        </div>`
        : '';
    
    const escapedOrderIdForOnclick = String(orderId).replace(/'/g, "\\'").replace(/"/g, '\\"');
    // Customer receipts should be viewable for all orders (better customer service and record keeping)
    // Previously only shown for "out for delivery" or "ready for pick-up", but now available anytime
    const showCustomerReceipt = true; // Always show customer receipt option - orders are saved, so receipts can be generated anytime
    
    content.innerHTML = `
        <!-- Order Header Card -->
        <div class="order-details-header-card">
            <div class="order-header-main">
                <div class="order-id-display">
                    <i class="fas fa-hashtag"></i>
                    <span class="order-id-value">${escapeHtml(order.trackingId || order.id)}</span>
                </div>
                <div class="order-status-display">
                    ${formatOrderStatusBadge(order.status)}
                </div>
            </div>
            <div class="order-header-meta">
                <div class="order-meta-item">
                    <i class="fas fa-clock"></i>
                    <span>${escapeHtml(order.createdLabel || '—')}</span>
                </div>
                <div class="order-meta-item">
                    <i class="fas fa-tag"></i>
                    <span>${escapeHtml(serviceType)}</span>
                </div>
            </div>
        </div>

        <!-- Customer Information Card -->
        <div class="order-details-card">
            <div class="order-card-header">
                <i class="fas fa-user"></i>
                <h3>Customer Information</h3>
            </div>
            <div class="order-card-body">
                <div class="detail-row-enhanced">
                    <div class="detail-label-enhanced">
                        <i class="fas fa-user-circle"></i>
                        <span>Customer Name</span>
                    </div>
                    <div class="detail-value-enhanced">${escapeHtml(customerName)}</div>
                </div>
                ${order.userId ? `
                <div class="detail-row-enhanced">
                    <div class="detail-label-enhanced">
                        <i class="fas fa-id-card"></i>
                        <span>User ID</span>
                    </div>
                    <div class="detail-value-enhanced">${escapeHtml(order.userId)}</div>
                </div>
                ` : ''}
            </div>
        </div>

        <!-- Location Information Card -->
        <div class="order-details-card">
            <div class="order-card-header">
                <i class="fas fa-map-marker-alt"></i>
                <h3>Location Information</h3>
            </div>
            <div class="order-card-body">
                ${order.serviceType === 'delivery' ? `
                <div class="detail-row-enhanced">
                    <div class="detail-label-enhanced">
                        <i class="fas fa-truck"></i>
                        <span>Delivery Address</span>
                    </div>
                    <div class="detail-value-enhanced">${escapeHtml(address)}</div>
                </div>
                ` : ''}
                ${order.serviceType === 'pick-up' || order.serviceType === 'pickup' ? `
                <div class="detail-row-enhanced">
                    <div class="detail-label-enhanced">
                        <i class="fas fa-store"></i>
                        <span>Pick-up Location</span>
                    </div>
                    <div class="detail-value-enhanced">${escapeHtml(restaurantAddress)}</div>
                </div>
                ` : ''}
                ${tableNumber ? `
                <div class="detail-row-enhanced">
                    <div class="detail-label-enhanced">
                        <i class="fas fa-chair"></i>
                        <span>Table Number</span>
                    </div>
                    <div class="detail-value-enhanced">${escapeHtml(tableNumber)}</div>
                </div>
                ` : ''}
                ${!order.serviceType || (order.serviceType !== 'delivery' && order.serviceType !== 'pick-up' && order.serviceType !== 'pickup' && !tableNumber) ? `
                <div class="detail-row-enhanced">
                    <div class="detail-label-enhanced">
                        <i class="fas fa-map-marker-alt"></i>
                        <span>Location</span>
                    </div>
                    <div class="detail-value-enhanced">—</div>
                </div>
                ` : ''}
            </div>
        </div>

        <!-- Order Items Card -->
        <div class="order-details-card order-items-card">
            <div class="order-card-header">
                <i class="fas fa-shopping-basket"></i>
                <h3>Order Items</h3>
            </div>
            <div class="order-card-body">
                <div class="order-items-list">
                    ${itemsList}
                </div>
            </div>
        </div>

        <!-- Payment Information Card -->
        <div class="order-details-card payment-card">
            <div class="order-card-header">
                <i class="fas fa-credit-card"></i>
                <h3>Payment Information</h3>
            </div>
            <div class="order-card-body">
                <div class="payment-amount-display">
                    <div class="payment-amount-label">Total Amount</div>
                    <div class="payment-amount-value">${formatCurrency(order.total)}</div>
                </div>
                <div class="detail-row-enhanced">
                    <div class="detail-label-enhanced">
                        <i class="fas fa-money-bill-wave"></i>
                        <span>Payment Mode</span>
                    </div>
                    <div class="detail-value-enhanced">${escapeHtml(order.paymentMode || 'Unspecified')}</div>
                </div>
                ${paymentStatusHtml ? `<div class="payment-status-wrapper">${paymentStatusHtml}</div>` : ''}
            </div>
        </div>

        ${order.driverId ? `
        <!-- Driver Information Card -->
        <div class="order-details-card">
            <div class="order-card-header">
                <i class="fas fa-car"></i>
                <h3>Driver Information</h3>
            </div>
            <div class="order-card-body">
                <div class="detail-row-enhanced">
                    <div class="detail-label-enhanced">
                        <i class="fas fa-id-badge"></i>
                        <span>Driver ID</span>
                    </div>
                    <div class="detail-value-enhanced">${escapeHtml(order.driverId)}</div>
                </div>
            </div>
        </div>
        ` : ''}

        <!-- Receipts Card -->
        <div class="order-details-card receipt-section-prominent">
            <div class="order-card-header">
                <i class="fas fa-receipt"></i>
                <h3>Receipts</h3>
            </div>
            <div class="order-card-body">
                <div class="receipt-actions-grid">
                    <button type="button" class="btn btn-receipt-kitchen" onclick="event.stopPropagation(); viewKitchenReceipt('${escapedOrderIdForOnclick}');">
                        <i class="fas fa-utensils"></i>
                        <span>View Kitchen Receipt</span>
                    </button>
                    ${showCustomerReceipt ? `
                    <button type="button" class="btn btn-receipt-customer" onclick="event.stopPropagation(); viewCustomerReceipt('${escapedOrderIdForOnclick}');">
                        <i class="fas fa-receipt"></i>
                        <span>View Customer Receipt</span>
                    </button>
                    <button type="button" class="btn btn-receipt-print" onclick="event.stopPropagation(); quickPrintCustomerReceipt('${escapedOrderIdForOnclick}');">
                        <i class="fas fa-print"></i>
                        <span>Quick Print</span>
                    </button>
                    ` : ''}
                </div>
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
    const historyContainer = document.getElementById('paymentHistoryContainer');
    if (historyContainer) {
        historyContainer.innerHTML = '';
        historyContainer.style.display = 'none';
    }
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
        
        // First, check if the order has a paymentProofUrl (direct URL) field
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
            paymentProofPath: order.paymentProofPath,
            paymentProofUrl: order.paymentProofUrl
        });
        
        // First priority: Check if paymentProofUrl (gcashProofUrl) is available - use it directly
        if (order.paymentProofUrl && order.paymentProofUrl.trim() !== '') {
            imageUrl = order.paymentProofUrl;
            console.log(`✓ Using direct payment proof URL: ${imageUrl}`);
        }
        // Second priority: If paymentProofPath is specified in order data, use it
        else if (order.paymentProofPath) {
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
            
            // Display GCash account name and reference number if available
            if ((order.gcashAccountName && order.gcashAccountName.trim() !== '') || 
                (order.paymentReferenceNumber && order.paymentReferenceNumber.trim() !== '')) {
                const paymentInfoContainer = document.createElement('div');
                paymentInfoContainer.setAttribute('data-ref-number-container', 'true');
                paymentInfoContainer.style.cssText = 'margin-bottom: 15px; padding: 12px; background: #f8f9fa; border-radius: 6px; border-left: 4px solid #7E2021;';
                
                let paymentInfoHtml = '';
                
                // Display GCash Account Name if available
                if (order.gcashAccountName && order.gcashAccountName.trim() !== '') {
                    paymentInfoHtml += `
                        <div style="font-size: 12px; color: #666; margin-bottom: 5px; font-weight: 500;">GCash Account Name:</div>
                        <div style="font-size: 16px; color: #333; font-weight: 600; margin-bottom: 12px;">${order.gcashAccountName.trim()}</div>
                    `;
                }
                
                // Display Reference Number if available
                if (order.paymentReferenceNumber && order.paymentReferenceNumber.trim() !== '') {
                    paymentInfoHtml += `
                        <div style="font-size: 12px; color: #666; margin-bottom: 5px; font-weight: 500;">GCash Reference Number:</div>
                        <div style="font-size: 16px; color: #333; font-weight: 600; font-family: monospace; letter-spacing: 1px;">${order.paymentReferenceNumber.trim().toUpperCase()}</div>
                    `;
                }
                
                paymentInfoContainer.innerHTML = paymentInfoHtml;
                // Insert before the image
                imageContainer.insertBefore(paymentInfoContainer, receiptImage);
            }
            
            // Show payment history if available
            if (order.paymentProofHistory && order.paymentProofHistory.length > 0) {
                const historyContainer = document.getElementById('paymentHistoryContainer');
                if (historyContainer) {
                    const currentVersion = order.paymentProofVersion || order.paymentProofHistory.length;
                    const currentProofInHistory = order.paymentProofHistory.find(p => p.version === currentVersion);
                    
                    // Build history HTML with images
                    const historyHtml = `
                        <div style="margin-top: 25px; padding-top: 25px; border-top: 2px solid #ddd;">
                            <h4 style="margin-bottom: 15px; font-size: 16px; font-weight: 600; color: #333; display: flex; align-items: center; gap: 8px;">
                                <i class="fas fa-history"></i> Payment Proof History
                            </h4>
                            
                            <!-- Current Version Indicator -->
                            <div style="font-size: 13px; color: #666; margin-bottom: 15px; padding: 10px; background: #e8f5e9; border-radius: 6px; border-left: 4px solid #4caf50;">
                                <strong style="color: #2e7d32;">📸 Currently Viewing:</strong> Version ${currentVersion} 
                                ${order.paymentProofPath || order.paymentProofUrl ? '(Active - Shown Above)' : '(Pending Resubmission)'}
                            </div>
                            
                            ${order.paymentProofHistory.length > 1 ? `
                                <details style="margin-top: 10px;" open>
                                    <summary style="cursor: pointer; color: #7E2021; font-weight: 600; font-size: 14px; padding: 10px; background: #f5f5f5; border-radius: 6px; user-select: none;">
                                        <i class="fas fa-images"></i> View All Previous Attempts (${order.paymentProofHistory.length - 1})
                                    </summary>
                                    <div style="margin-top: 15px; display: flex; flex-direction: column; gap: 20px; max-height: 600px; overflow-y: auto; padding-right: 5px;">
                                        ${order.paymentProofHistory.slice().reverse().map((proof, index) => {
                                            const isCurrent = proof.version === currentVersion;
                                            const isDeclined = proof.declinedAt;
                                            const proofImageUrl = proof.paymentProofUrl || '';
                                            
                                            return `
                                                <div style="padding: 15px; background: ${isDeclined ? '#fff3cd' : isCurrent ? '#e3f2fd' : '#f8f9fa'}; 
                                                           border-radius: 8px; border-left: 5px solid ${isDeclined ? '#ffc107' : isCurrent ? '#2196f3' : '#6c757d'}; 
                                                           box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                                                    
                                                    <!-- Version Header -->
                                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
                                                        <div style="font-weight: 600; font-size: 14px; color: #333;">
                                                            <i class="fas fa-receipt"></i> Version ${proof.version || (order.paymentProofHistory.length - index)}
                                                            ${isCurrent ? '<span style="background: #4caf50; color: white; padding: 3px 10px; border-radius: 4px; font-size: 11px; margin-left: 8px; font-weight: 600;">CURRENT</span>' : ''}
                                                            ${isDeclined ? '<span style="background: #dc3545; color: white; padding: 3px 10px; border-radius: 4px; font-size: 11px; margin-left: 8px; font-weight: 600;">DECLINED</span>' : ''}
                                                        </div>
                                                    </div>
                                                    
                                                    <!-- Decline Info -->
                                                    ${isDeclined ? `
                                                        <div style="color: #856404; font-size: 12px; margin-bottom: 12px; padding: 8px; background: #fff; border-radius: 4px; border: 1px solid #ffc107;">
                                                            <strong style="color: #dc3545;">❌ Decline Reason:</strong> ${proof.declineReason || 'N/A'}<br>
                                                            ${proof.declinedBy ? `<small style="color: #666;">Declined by: ${proof.declinedBy}</small>` : ''}
                                                            ${proof.declinedAt ? `
                                                                <br><small style="color: #666;">Declined on: ${(() => {
                                                                    if (proof.declinedAt instanceof Date) {
                                                                        return proof.declinedAt.toLocaleString();
                                                                    } else if (proof.declinedAt.seconds) {
                                                                        return new Date(proof.declinedAt.seconds * 1000).toLocaleString();
                                                                    } else if (typeof proof.declinedAt.toDate === 'function') {
                                                                        return proof.declinedAt.toDate().toLocaleString();
                                                                    } else if (typeof proof.declinedAt === 'number') {
                                                                        return new Date(proof.declinedAt).toLocaleString();
                                                                    }
                                                                    return 'N/A';
                                                                })()}</small>
                                                            ` : ''}
                                                        </div>
                                                    ` : ''}
                                                    
                                                    <!-- Upload Info -->
                                                    ${proof.uploadedAt ? `
                                                        <div style="color: #666; font-size: 11px; margin-bottom: 12px;">
                                                            <i class="fas fa-clock"></i> Uploaded: ${(() => {
                                                                if (proof.uploadedAt instanceof Date) {
                                                                    return proof.uploadedAt.toLocaleString();
                                                                } else if (proof.uploadedAt.seconds) {
                                                                    return new Date(proof.uploadedAt.seconds * 1000).toLocaleString();
                                                                } else if (typeof proof.uploadedAt.toDate === 'function') {
                                                                    return proof.uploadedAt.toDate().toLocaleString();
                                                                } else if (typeof proof.uploadedAt === 'number') {
                                                                    return new Date(proof.uploadedAt).toLocaleString();
                                                                }
                                                                return 'N/A';
                                                            })()}
                                                        </div>
                                                    ` : ''}
                                                    
                                                    <!-- Screenshot Image -->
                                                    ${proofImageUrl ? `
                                                        <div style="margin-top: 12px; position: relative;">
                                                            <div style="font-size: 11px; color: #666; margin-bottom: 6px; font-weight: 500;">
                                                                <i class="fas fa-image"></i> Screenshot:
                                                            </div>
                                                            <img src="${proofImageUrl}" 
                                                                 alt="Payment Proof Version ${proof.version}" 
                                                                 style="max-width: 100%; height: auto; border-radius: 6px; border: 2px solid ${isDeclined ? '#ffc107' : isCurrent ? '#2196f3' : '#ddd'}; 
                                                                        cursor: pointer; transition: transform 0.2s; box-shadow: 0 2px 8px rgba(0,0,0,0.15);"
                                                                 onclick="window.open('${proofImageUrl}', '_blank')"
                                                                 onmouseover="this.style.transform='scale(1.02)'"
                                                                 onmouseout="this.style.transform='scale(1)'"
                                                                 title="Click to view full size in new tab">
                                                            <div style="font-size: 10px; color: #999; margin-top: 4px; text-align: center;">
                                                                Click image to view full size
                                                            </div>
                                                        </div>
                                                    ` : proof.paymentProofPath ? `
                                                        <div style="margin-top: 12px; padding: 12px; background: #fff; border-radius: 4px; color: #666; font-size: 12px; border: 1px dashed #ccc;">
                                                            <i class="fas fa-exclamation-triangle"></i> Image path: ${proof.paymentProofPath}<br>
                                                            <small style="color: #999;">(Image may have been deleted or is no longer accessible)</small>
                                                        </div>
                                                    ` : `
                                                        <div style="margin-top: 12px; padding: 12px; background: #fff; border-radius: 4px; color: #999; font-size: 12px; border: 1px dashed #ccc; text-align: center;">
                                                            <i class="fas fa-image"></i> No image available
                                                        </div>
                                                    `}
                                                </div>
                                            `;
                                        }).join('')}
                                    </div>
                                </details>
                            ` : `
                                <div style="padding: 15px; background: #f8f9fa; border-radius: 6px; color: #666; font-size: 13px; text-align: center;">
                                    <i class="fas fa-info-circle"></i> This is the first payment proof submission for this order.
                                </div>
                            `}
                        </div>
                    `;
                    historyContainer.innerHTML = historyHtml;
                    historyContainer.style.display = 'block';
                }
            }
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
    const historyContainer = document.getElementById('paymentHistoryContainer');
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
        if (imageContainer) {
            imageContainer.style.display = 'none';
            // Remove any dynamically added reference number containers
            const refContainers = imageContainer.querySelectorAll('[data-ref-number-container="true"]');
            refContainers.forEach(container => container.remove());
        }
        if (receiptImage) receiptImage.src = '';
        if (footer) footer.style.display = 'none';
    }
    if (historyContainer) {
        historyContainer.innerHTML = '';
        historyContainer.style.display = 'none';
    }
}

// Helper function to get current staff name
function getCurrentStaffName() {
    const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
    if (session) {
        try {
            const staffSession = JSON.parse(session);
            if (staffSession.firstName && staffSession.lastName) {
                let displayName = `${staffSession.firstName} ${staffSession.lastName}`;
                if (staffSession.suffix) {
                    displayName += ` ${staffSession.suffix}`;
                }
                return displayName;
            } else if (staffSession.email) {
                // Prefer user part over full email for receipts
                const email = String(staffSession.email);
                const namePart = email.split('@')[0];
                return namePart ? namePart : email;
            } else if (staffSession.staffId) {
                return staffSession.staffId;
            }
        } catch (e) {
            console.warn('Could not parse staff session:', e);
        }
    }
    return 'Admin';
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

// Initialize payment decline modal event listeners (called once on page load)
function initPaymentDeclineModal() {
    const reasonSelect = document.getElementById('paymentDeclineReasonSelect');
    const reasonText = document.getElementById('paymentDeclineReasonText');
    
    if (reasonSelect && reasonText) {
        reasonSelect.addEventListener('change', function() {
            if (this.value === 'other') {
                reasonText.style.display = 'block';
                reasonText.required = false; // Optional
            } else {
                reasonText.style.display = 'none';
                reasonText.value = '';
            }
        });
    }
}

// Open payment decline modal
function openPaymentDeclineModal() {
    if (!currentVerifyingOrderId) {
        showNotification('No order selected for payment decline.', 'error');
        return;
    }
    
    const order = ordersState.find(o => o.id === currentVerifyingOrderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    
    const modal = document.getElementById('paymentDeclineModal');
    if (!modal) {
        showNotification('Payment decline modal not found.', 'error');
        return;
    }
    
    // Reset form
    const reasonSelect = document.getElementById('paymentDeclineReasonSelect');
    const reasonText = document.getElementById('paymentDeclineReasonText');
    if (reasonSelect) reasonSelect.value = '';
    if (reasonText) {
        reasonText.value = '';
        reasonText.style.display = 'none';
    }
    
    // Show modal
    modal.style.display = 'block';
}

// Close payment decline modal
function closePaymentDeclineModal() {
    const modal = document.getElementById('paymentDeclineModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Close modal when clicking outside (attach once)
(function() {
    let clickHandlerAttached = false;
    if (!clickHandlerAttached) {
        document.addEventListener('click', function(event) {
            const modal = document.getElementById('paymentDeclineModal');
            if (modal && (modal.style.display === 'block' || modal.style.display === 'flex')) {
                const modalContent = modal.querySelector('.modal-content');
                // Close if clicking on the modal backdrop (not on content)
                if (event.target === modal && modalContent && !modalContent.contains(event.target)) {
                    closePaymentDeclineModal();
                }
            }
        });
        clickHandlerAttached = true;
    }
})();

// Confirm payment decline with selected reason
async function confirmPaymentDecline() {
    const reasonSelect = document.getElementById('paymentDeclineReasonSelect');
    const reasonText = document.getElementById('paymentDeclineReasonText');
    
    if (!reasonSelect || !reasonSelect.value) {
        showNotification('Please select a reason for declining', 'error');
        return;
    }
    
    // Map reason values to display text
    let declineReason = '';
    if (reasonSelect.value === 'wrong_screenshot') {
        declineReason = 'Wrong Screenshot';
    } else if (reasonSelect.value === 'credentials_mismatch') {
        declineReason = 'Account Credentials Do not Match';
    } else if (reasonSelect.value === 'other') {
        if (reasonText && reasonText.value.trim()) {
            declineReason = reasonText.value.trim();
        } else {
            showNotification('Please provide additional details for "Other" reason', 'error');
            return;
        }
    } else {
        declineReason = reasonSelect.options[reasonSelect.selectedIndex].text;
    }
    
    if (!declineReason || !declineReason.trim()) {
        showNotification('Please provide a reason for declining', 'error');
        return;
    }
    
    // Close modal
    closePaymentDeclineModal();
    
    // Proceed with decline using the selected reason
    await processPaymentDecline(declineReason.trim());
}

// Process payment decline (extracted from original declinePayment function)
async function processPaymentDecline(declineReason) {
    if (!currentVerifyingOrderId) {
        showNotification('No order selected for payment decline.', 'error');
        return;
    }
    
    const order = ordersState.find(o => o.id === currentVerifyingOrderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            showNotification('Database is not ready. Please try again.', 'error');
            return;
        }
        
        const fns = window.firestoreFunctions;
        const orderRef = fns.doc(window.db, 'orders', currentVerifyingOrderId);
        
        // Get current order data to build history entry
        const orderDoc = await fns.getDoc(orderRef);
        const orderData = orderDoc.exists() ? orderDoc.data() : {};
        
        // Get current payment proof info
        const currentProofPath = order.paymentProofPath || orderData.paymentProofPath || '';
        const currentProofUrl = order.paymentProofUrl || orderData.paymentProofUrl || '';
        const currentVersion = order.paymentProofVersion || orderData.paymentProofVersion || 1;
        
        // Build history entry for the declined proof
        // Note: Cannot use serverTimestamp() inside arrays, so use Timestamp.now() instead
        const now = fns.Timestamp ? fns.Timestamp.now() : new Date();
        const declinedProofEntry = {
            version: currentVersion,
            paymentProofPath: currentProofPath,
            paymentProofUrl: currentProofUrl,
            declinedAt: now,
            declineReason: declineReason.trim(),
            declinedBy: getCurrentStaffName(),
            uploadedAt: orderData.paymentProofUploadedAt || order.createdAt || now
        };
        
        // Get existing history or create new array
        const existingHistory = Array.isArray(orderData.paymentProofHistory) ? orderData.paymentProofHistory : [];
        
        // If current proof is not already in history, add it
        // Otherwise, update the last entry with decline info
        let updatedHistory = [...existingHistory];
        const lastEntry = updatedHistory.length > 0 ? updatedHistory[updatedHistory.length - 1] : null;
        
        if (!lastEntry || lastEntry.version !== currentVersion) {
            // Add new entry to history
            updatedHistory.push(declinedProofEntry);
        } else {
            // Update last entry with decline info
            updatedHistory[updatedHistory.length - 1] = {
                ...lastEntry,
                declinedAt: declinedProofEntry.declinedAt,
                declineReason: declinedProofEntry.declineReason,
                declinedBy: declinedProofEntry.declinedBy
            };
        }
        
        // Update order: mark as declined, clear current proof, increment version for next submission
        const updateData = {
            status: 'declined',
            declineReason: declineReason.trim(),
            declinedAt: fns.serverTimestamp(),
            declinedBy: getCurrentStaffName(),
            // Keep history
            paymentProofHistory: updatedHistory,
            // Clear current proof fields (customer will need to resubmit)
            paymentProofPath: fns.deleteField(),
            paymentProofUrl: fns.deleteField(),
            paymentVerified: false,
            // Increment version for next resubmission
            paymentProofVersion: currentVersion + 1,
            updatedAt: fns.serverTimestamp()
        };
        
        await fns.updateDoc(orderRef, updateData);
        
        // Update local state
        const orderIndex = ordersState.findIndex(o => o.id === currentVerifyingOrderId);
        if (orderIndex !== -1) {
            ordersState[orderIndex].status = 'declined';
            ordersState[orderIndex].declineReason = declineReason.trim();
            ordersState[orderIndex].paymentProofHistory = updatedHistory;
            ordersState[orderIndex].paymentProofVersion = currentVersion + 1;
            ordersState[orderIndex].paymentProofPath = null;
            ordersState[orderIndex].paymentProofUrl = null;
            ordersState[orderIndex].paymentVerified = false;
        }
        
        // Refresh the orders table
        renderOrdersTable(ordersState);
        
        showNotification(`Payment declined for order ${order.trackingId || currentVerifyingOrderId}. Customer can resubmit.`, 'success');
        closePaymentReceiptModal();
    } catch (error) {
        console.error('Error declining payment:', error);
        showNotification('Failed to decline payment. Please try again.', 'error');
    }
}

// Make functions available globally
window.declinePayment = openPaymentDeclineModal;
window.openPaymentDeclineModal = openPaymentDeclineModal;
window.closePaymentDeclineModal = closePaymentDeclineModal;
window.confirmPaymentDecline = confirmPaymentDecline;

/**
 * Automated payment verification function
 * Verifies payments that meet safe criteria, leaves edge cases for manual review
 */
async function attemptAutomatedPaymentVerification(order) {
    // Only process GCash orders
    const paymentModeLower = (order.paymentMode || '').toLowerCase();
    const isGCashOrder = paymentModeLower === 'gcash' || paymentModeLower === 'g-cash';
    if (!isGCashOrder) {
        return { verified: false, reason: 'Not a GCash order' };
    }
    
    // Skip if already verified
    if (order.paymentVerified === true) {
        return { verified: false, reason: 'Already verified' };
    }
    
    // Skip if order is not pending
    const currentStatus = (order.status || '').toLowerCase().trim();
    if (currentStatus !== 'pending' && currentStatus !== 'new') {
        return { verified: false, reason: 'Order not in pending status' };
    }
    
    // Edge case: Multiple payment proof versions (resubmission) - requires manual review
    if (order.paymentProofVersion && order.paymentProofVersion > 1) {
        return { verified: false, reason: 'Requires manual review: Payment resubmission', requiresReview: true };
    }
    
    // TIME/DATE VALIDATION 1: Check order age
    if (order.createdAt && order.createdAt instanceof Date) {
        const now = new Date();
        const hoursDiff = (now.getTime() - order.createdAt.getTime()) / (1000 * 60 * 60);
        
        // Order too old - suspicious
        if (hoursDiff > 24) {
            return { verified: false, reason: 'Requires manual review: Order too old (>24 hours)', requiresReview: true };
        }
        
        // Order too new - might be created before payment (allow 5 minutes grace period)
        if (hoursDiff < 0) {
            return { verified: false, reason: 'Requires manual review: Order timestamp in future', requiresReview: true };
        }
    }
    
    // TIME/DATE VALIDATION 2: Check payment proof upload time from filename
    if (order.paymentProofPath) {
        try {
            // Extract timestamp from path (format: paymentProofs/userId/1234567890-filename.jpg)
            const pathParts = order.paymentProofPath.split('/');
            const fileName = pathParts[pathParts.length - 1];
            const timestampMatch = fileName.match(/^(\d+)-/);
            
            if (timestampMatch) {
                const uploadTimestamp = parseInt(timestampMatch[1], 10);
                const uploadDate = new Date(uploadTimestamp);
                
                if (order.createdAt && order.createdAt instanceof Date) {
                    const timeDiffMs = Math.abs(uploadDate.getTime() - order.createdAt.getTime());
                    const timeDiffMinutes = timeDiffMs / (1000 * 60);
                    
                    // Payment proof should be uploaded within 30 minutes of order creation
                    if (timeDiffMinutes > 30) {
                        return { 
                            verified: false, 
                            reason: `Requires manual review: Payment proof uploaded ${Math.round(timeDiffMinutes)} minutes after order creation (suspicious timing)`, 
                            requiresReview: true 
                        };
                    }
                    
                    // Payment proof uploaded before order creation (shouldn't happen)
                    if (uploadDate < order.createdAt) {
                        const diffBefore = (order.createdAt.getTime() - uploadDate.getTime()) / (1000 * 60);
                        if (diffBefore > 5) { // Allow 5 minute clock skew
                            return { 
                                verified: false, 
                                reason: `Requires manual review: Payment proof uploaded ${Math.round(diffBefore)} minutes before order creation`, 
                                requiresReview: true 
                            };
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Could not extract timestamp from payment proof path:', error);
            // Don't fail verification if we can't parse the timestamp
        }
    }
    
    // TIME/DATE VALIDATION 3: If payment timestamp is collected from customer, validate it
    if (order.paymentTimestamp) {
        try {
            const paymentDate = order.paymentTimestamp instanceof Date ? order.paymentTimestamp : new Date(order.paymentTimestamp);
            
            if (order.createdAt && order.createdAt instanceof Date) {
                const timeDiffMs = Math.abs(paymentDate.getTime() - order.createdAt.getTime());
                const timeDiffMinutes = timeDiffMs / (1000 * 60);
                
                // Payment should be made within 15 minutes of order creation
                if (timeDiffMinutes > 15) {
                    return { 
                        verified: false, 
                        reason: `Requires manual review: Payment timestamp (${paymentDate.toLocaleString()}) is ${Math.round(timeDiffMinutes)} minutes from order creation`, 
                        requiresReview: true 
                    };
                }
                
                // Payment made before order (shouldn't happen)
                if (paymentDate < order.createdAt) {
                    const diffBefore = (order.createdAt.getTime() - paymentDate.getTime()) / (1000 * 60);
                    if (diffBefore > 2) { // Allow 2 minute clock skew
                        return { 
                            verified: false, 
                            reason: `Requires manual review: Payment timestamp is ${Math.round(diffBefore)} minutes before order creation`, 
                            requiresReview: true 
                        };
                    }
                }
            }
        } catch (error) {
            console.warn('Could not parse payment timestamp:', error);
            // If timestamp is invalid format, flag for review
            return { verified: false, reason: 'Requires manual review: Invalid payment timestamp format', requiresReview: true };
        }
    }
    
    // CRITICAL CHECK 1: Verify all three required fields exist
    const hasReferenceNumber = !!(order.paymentReferenceNumber && order.paymentReferenceNumber.trim());
    const hasProofPath = !!(order.paymentProofPath && order.paymentProofPath.trim());
    const hasProofUrl = !!(order.paymentProofUrl && order.paymentProofUrl.trim());
    
    if (!hasReferenceNumber) {
        return { verified: false, reason: 'Requires manual review: Missing reference number', requiresReview: true };
    }
    
    if (!hasProofPath) {
        return { verified: false, reason: 'Requires manual review: Missing payment proof path', requiresReview: true };
    }
    
    if (!hasProofUrl) {
        return { verified: false, reason: 'Requires manual review: Missing payment proof URL', requiresReview: true };
    }
    
    // CRITICAL CHECK 2: Verify reference number is unique (not used in another verified order)
    const referenceNumber = order.paymentReferenceNumber.trim().toUpperCase();
    const duplicateOrder = ordersState.find(o => 
        o.id !== order.id && 
        o.paymentReferenceNumber && 
        o.paymentReferenceNumber.trim().toUpperCase() === referenceNumber &&
        o.paymentVerified === true
    );
    
    if (duplicateOrder) {
        return { 
            verified: false, 
            reason: `Requires manual review: Reference number ${referenceNumber} already used in order ${duplicateOrder.trackingId || duplicateOrder.id}`, 
            requiresReview: true 
        };
    }
    
    // CRITICAL CHECK 3: Verify payment proof image exists and is accessible
    let proofExists = false;
    let proofAccessible = false;
    try {
        if (!window.storage || !window.storageFunctions) {
            await waitForFirebaseReady();
        }
        
        if (window.storage && window.storageFunctions) {
            const { ref, getDownloadURL } = window.storageFunctions;
            const storage = window.storage;
            
            // Try using the path first
            const path = order.paymentProofPath.startsWith('paymentProofs/') 
                ? order.paymentProofPath 
                : `paymentProofs/${order.paymentProofPath}`;
            
            try {
                const imageRef = ref(storage, path);
                const urlFromPath = await getDownloadURL(imageRef);
                proofExists = true;
                // Verify the URL matches (or is accessible)
                if (urlFromPath) {
                    proofAccessible = true;
                    // Optional: Verify URL matches stored URL (within reason - URLs might have tokens)
                    if (order.paymentProofUrl && !order.paymentProofUrl.includes(urlFromPath.split('?')[0])) {
                        console.warn('URL mismatch between stored URL and path-derived URL');
                    }
                }
            } catch (error) {
                // Proof file doesn't exist or is inaccessible via path
                return { verified: false, reason: 'Requires manual review: Payment proof not accessible via path', requiresReview: true };
            }
            
            // Also verify URL is accessible (optional but recommended)
            if (order.paymentProofUrl) {
                try {
                    const response = await fetch(order.paymentProofUrl, { method: 'HEAD' });
                    if (response.ok) {
                        proofAccessible = true;
                    } else {
                        console.warn('Payment proof URL not accessible:', response.status);
                    }
                } catch (error) {
                    console.warn('Could not verify payment proof URL accessibility:', error);
                    // Don't fail verification if URL check fails, path check is primary
                }
            }
        }
    } catch (error) {
        console.error('Error checking payment proof:', error);
        return { verified: false, reason: 'Requires manual review: Error checking payment proof', requiresReview: true };
    }
    
    // CRITICAL CHECK 4: Validate reference number format (GCash refs are typically alphanumeric, 8-15 chars)
    const refFormatValid = /^[A-Z0-9]{8,15}$/i.test(referenceNumber);
    if (!refFormatValid) {
        return { verified: false, reason: 'Requires manual review: Invalid reference number format', requiresReview: true };
    }
    
    // All checks passed - safe to auto-verify
    if (proofExists && proofAccessible) {
        try {
            if (!isFirestoreReady()) {
                return { verified: false, reason: 'Database not ready' };
            }
            
            const fns = window.firestoreFunctions;
            const orderRef = fns.doc(window.db, 'orders', order.id);
            
            await fns.updateDoc(orderRef, {
                paymentVerified: true,
                paymentVerifiedAt: fns.serverTimestamp(),
                paymentAutoVerified: true, // Flag to indicate automated verification
                paymentVerificationMethod: 'automated', // Track verification method
                updatedAt: fns.serverTimestamp()
            });
            
            // Update local state
            const orderIndex = ordersState.findIndex(o => o.id === order.id);
            if (orderIndex !== -1) {
                ordersState[orderIndex].paymentVerified = true;
                ordersState[orderIndex].paymentVerifiedAt = new Date();
                ordersState[orderIndex].paymentAutoVerified = true;
                ordersState[orderIndex].paymentVerificationMethod = 'automated';
            }
            
            console.log(`✓ Auto-verified payment for order ${order.trackingId || order.id} (Ref: ${referenceNumber})`);
            return { verified: true, reason: 'Auto-verified: All checks passed' };
        } catch (error) {
            console.error('Error auto-verifying payment:', error);
            return { verified: false, reason: 'Error during auto-verification' };
        }
    }
    
    return { verified: false, reason: 'Payment proof validation failed' };
}

/**
 * Process new orders for automated payment verification
 * Called when orders are updated via subscription
 */
async function processOrdersForAutoVerification(previousOrders, currentOrders) {
    // Track which orders we've already processed to avoid duplicate processing
    if (!window.processedOrdersForAutoVerification) {
        window.processedOrdersForAutoVerification = new Set();
    }
    
    // Find new or updated GCash orders that need verification
    const ordersToCheck = currentOrders.filter(order => {
        const paymentModeLower = (order.paymentMode || '').toLowerCase();
        const isGCashOrder = paymentModeLower === 'gcash' || paymentModeLower === 'g-cash';
        const isPending = (order.status || '').toLowerCase().trim() === 'pending' || 
                        (order.status || '').toLowerCase().trim() === 'new';
        const notVerified = order.paymentVerified !== true;
        const notProcessed = !window.processedOrdersForAutoVerification.has(order.id);
        
        return isGCashOrder && isPending && notVerified && notProcessed;
    });
    
    // Process each order
    for (const order of ordersToCheck) {
        // Mark as processed immediately to avoid duplicate attempts
        window.processedOrdersForAutoVerification.add(order.id);
        
        // Small delay to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const result = await attemptAutomatedPaymentVerification(order);
        
        if (result.verified) {
            // Successfully auto-verified - refresh the table
            renderOrdersTable(ordersState);
            console.log(`Auto-verified payment for order ${order.trackingId || order.id}`);
        } else if (result.requiresReview) {
            // Edge case detected - flag for manual review
            console.log(`Order ${order.trackingId || order.id} requires manual review: ${result.reason}`);
            // Optional: You could add a flag to highlight these orders in the UI
        }
    }
    
    // Clean up old processed orders (older than 1 hour) to prevent memory buildup
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    // Note: This is a simple cleanup - in production you might want more sophisticated tracking
}

async function reopenOrder(orderId) {
    if (!orderId) {
        showNotification('No order selected for reopening.', 'error');
        return;
    }
    
    const order = ordersState.find(o => o.id === orderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    
    // Check if order is actually declined
    const orderStatusLower = (order.status || '').toLowerCase().trim();
    if (orderStatusLower !== 'declined') {
        showNotification('This order is not declined and cannot be reopened.', 'error');
        return;
    }
    
    // Confirm reopening
    if (!confirm(`Are you sure you want to reopen order ${order.trackingId || orderId}?`)) {
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            showNotification('Database is not ready. Please try again.', 'error');
            return;
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !fns.doc || !fns.updateDoc || !fns.serverTimestamp) {
            throw new Error('Firestore functions are not available. Please refresh the page.');
        }
        
        if (!window.db) {
            throw new Error('Database connection is not available. Please refresh the page.');
        }
        
        const orderRef = fns.doc(window.db, 'orders', orderId);
        
        // Verify the order document exists
        if (fns.getDoc) {
            const orderDoc = await fns.getDoc(orderRef);
            if (!orderDoc.exists()) {
                throw new Error('Order document does not exist in database.');
            }
        }
        
        await fns.updateDoc(orderRef, {
            status: 'pending',
            reopenedAt: fns.serverTimestamp(),
            previousStatus: 'declined',
            updatedAt: fns.serverTimestamp()
        });
        
        // Update local state
        const orderIndex = ordersState.findIndex(o => o.id === orderId);
        if (orderIndex !== -1) {
            ordersState[orderIndex].status = 'pending';
            ordersState[orderIndex].reopenedAt = new Date();
            ordersState[orderIndex].previousStatus = 'declined';
        }
        
        // Refresh the orders table
        renderOrdersTable(ordersState);
        
        showNotification(`Order ${order.trackingId || orderId} has been reopened.`, 'success');
    } catch (error) {
        console.error('Error reopening order:', error);
        const errorMessage = error.message || error.toString() || 'Unknown error occurred';
        console.error('Full error details:', error);
        showNotification(`Failed to reopen order: ${errorMessage}`, 'error');
    }
}

function formatOrderItemsForDetails(items) {
    if (!Array.isArray(items) || !items.length) {
        return '<div class="order-item-empty">—</div>';
    }
    const itemsList = items.map((item, index) => {
        if (typeof item === 'string') {
            return `<div class="order-item-row">
                <div class="order-item-name">${escapeHtml(item)}</div>
            </div>`;
        }
        const name = item.name || item.itemName || item.itemId || 'Item';
        const quantity = typeof item.quantity === 'number' && item.quantity > 0
            ? item.quantity
            : 1;
        const price = typeof item.price === 'number' && item.price > 0
            ? item.price
            : null;
        const totalPrice = price ? price * quantity : null;
        
        let itemHtml = `<div class="order-item-row">
            <div class="order-item-main">
                <span class="order-item-quantity">${quantity}x</span>
                <span class="order-item-name">${escapeHtml(name)}</span>
            </div>`;
        
        if (totalPrice) {
            itemHtml += `<div class="order-item-price">${formatCurrency(totalPrice)}</div>`;
        } else if (price) {
            itemHtml += `<div class="order-item-price">${formatCurrency(price)}</div>`;
        }
        
        itemHtml += `</div>`;
        return itemHtml;
    });
    return itemsList.length > 0 ? itemsList.join('') : '<div class="order-item-empty">—</div>';
}

/**
 * Open the kitchen receipt in a new window for viewing. User can then click Print in that window.
 * Called from the order details modal.
 */
function viewKitchenReceipt(orderId) {
    const order = ordersState.find(o => o.id === orderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    showReceiptPreview(order, 'kitchen');
}

/**
 * Print a kitchen-only receipt when an order moves to In Kitchen.
 * The cashier gives this to the kitchen so they know what to prepare.
 * No prices—only order info, service type, location, and items.
 * @param {object} order - Order object
 * @param {boolean} [autoPrint=true] - If true, opens print dialog automatically. If false, shows a Print button for viewing first.
 */
function printKitchenReceipt(order, autoPrint) {
    if (!order) return;
    if (autoPrint === undefined) autoPrint = true;
    const receiptHTML = `
        <div class="pos-receipts-container">
            ${generateKitchenReceiptHTML(order)}
        </div>
        ${!autoPrint ? '<div class="kitchen-receipt-actions"><button type="button" onclick="window.print()">Print</button></div>' : ''}
    `;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        showNotification('Pop-up blocked. Please allow pop-ups to view the kitchen receipt.', 'error');
        return;
    }
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Kitchen Receipt</title>
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
                    .kitchen-receipt-actions { display: none !important; }
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
                .pos-receipts-container {
                    display: flex;
                    flex-direction: column;
                    gap: 20px;
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
                .pos-receipt-items { margin: 8px 0; }
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
                .pos-receipt-footer { 
                    text-align: center; 
                    margin-top: 10px; 
                    padding-top: 8px; 
                    border-top: 1px dashed #000; 
                    font-size: 9px; 
                    line-height: 1.3;
                }
                .kitchen-receipt-actions { 
                    text-align: center; 
                    margin-top: 12px; 
                    padding-top: 8px; 
                    border-top: 1px dashed #ccc; 
                }
                .kitchen-receipt-actions button { padding: 6px 16px; font-size: 12px; cursor: pointer; }
            </style>
        </head>
        <body>${receiptHTML}</body>
        </html>`);
    printWindow.document.close();
    if (autoPrint) {
        setTimeout(() => { printWindow.print(); }, 250);
    }
}

/**
 * Open the customer receipt in a modal preview for viewing. User can then click Print in that modal.
 * Shown when order is On The Way or Ready to Pickup.
 */
function viewCustomerReceipt(orderId) {
    const order = ordersState.find(o => o.id === orderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    showReceiptPreview(order, 'customer');
}

/**
 * Print a customer copy receipt (POS-style). Used when order is On The Way or Ready to Pickup.
 * Structure copied from pos.html / pos-script.js showReceipt and printReceipt.
 * @param {object} order - Order object
 * @param {boolean} [autoPrint=true] - If true, opens print dialog automatically. If false, shows a Print button.
 */
function printCustomerReceipt(order, autoPrint) {
    if (!order) return;
    if (autoPrint === undefined) autoPrint = true;
    const orderId = escapeHtml(String(order.trackingId || order.id));
    const subtotal = typeof order.subtotal === 'number' ? order.subtotal : (order.total || 0);
    const total = typeof order.total === 'number' ? order.total : 0;
    const discount = order.discount;
    const paymentMode = escapeHtml(String(order.paymentMode || 'Cash'));
    const customerName = typeof formatOrderCustomer === 'function' ? formatOrderCustomer(order) : (order.customerName || '—');
    const cashierName = escapeHtml(String(order.processedByName || order.cashierName || getCurrentStaffName() || 'Staff'));
    const serviceType = (order.serviceType || '').toLowerCase().trim();
    let serviceLabel = 'DINE IN';
    if (serviceType === 'delivery') serviceLabel = 'DELIVERY';
    else if (serviceType === 'pick-up' || serviceType === 'pickup' || serviceType === 'pick_up') serviceLabel = 'PICK UP';
    else if (serviceType === 'take-out' || serviceType === 'takeout') serviceLabel = 'TAKE OUT';
    else if (serviceType === 'dine-in' || serviceType === 'dinein') serviceLabel = 'DINE IN';

    let extraLine = '';
    if (serviceType === 'dine-in' || serviceType === 'dinein') {
        const tbl = order.tableNumber != null ? String(order.tableNumber) : '—';
        extraLine = `<p>Table: ${escapeHtml(tbl)}</p>`;
    } else if (serviceType === 'delivery') {
        const addr = order.address || order.deliveryInfo?.address || '—';
        extraLine = `<p>Delivery to: ${escapeHtml(addr)}</p>`;
    } else if (serviceType === 'pick-up' || serviceType === 'pickup' || serviceType === 'pick_up') {
        extraLine = '<p>Pick-up</p>';
    }

    const items = Array.isArray(order.items) ? order.items : [];
    const itemsHtml = items.map(item => {
        const name = escapeHtml(String(item.name || item.itemName || item.itemId || 'Item'));
        const qty = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
        const price = typeof item.price === 'number' ? item.price : 0;
        const lineTotal = price * qty;
        const freeNote = item.freeWithPeriRibs ? ' (Free with Peri Chicken & Ribs)' : '';
        return `<div class="pos-receipt-item"><div class="pos-receipt-item-name">${name}${freeNote}</div><div class="pos-receipt-item-qty">${qty}x</div><div class="pos-receipt-item-price">₱${lineTotal.toFixed(2)}</div></div>`;
    }).join('');

    const discountHtml = discount && typeof discount.amount === 'number' && discount.amount > 0
        ? `<div class="pos-receipt-total-row"><span>Discount (${escapeHtml(String(discount.type || ''))} ${Number(discount.percent) || 0}%):</span><span>-₱${(discount.amount).toFixed(2)}</span></div>`
        : '';

    const now = new Date().toLocaleString();
    const receiptHTML = `
        <div class="pos-receipt-content">
            <div class="pos-receipt-header">
                <h3>PABLO'S PERI PERI</h3>
                <p><strong>CUSTOMER COPY</strong></p>
                <p><strong>${serviceLabel}</strong></p>
                <p>Order ID: ${orderId}</p>
                <p>Customer: ${escapeHtml(customerName)}</p>
                ${extraLine}
                <p>Cashier: ${cashierName}</p>
                <p>Date: ${escapeHtml(now)}</p>
            </div>
            <div class="pos-receipt-items">${itemsHtml}</div>
            <div class="pos-receipt-total">
                <div class="pos-receipt-total-row"><span>Subtotal:</span><span>₱${subtotal.toFixed(2)}</span></div>
                ${discountHtml}
                <div class="pos-receipt-total-row"><span>Total:</span><span>₱${total.toFixed(2)}</span></div>
                <div class="pos-receipt-total-row"><span>Payment Method:</span><span><strong>${paymentMode}</strong></span></div>
                <div class="pos-receipt-total-row final"><span>Amount Paid:</span><span>₱${total.toFixed(2)}</span></div>
            </div>
            <div class="pos-receipt-footer">
                <p>Thank you for your order!</p>
                <p>Please come again</p>
            </div>
        </div>
        ${!autoPrint ? '<div class="customer-receipt-actions"><button type="button" onclick="window.print()">Print</button></div>' : ''}`;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        showNotification('Pop-up blocked. Please allow pop-ups to view the customer receipt.', 'error');
        return;
    }
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Customer Receipt - ${orderId}</title>
            <meta charset="UTF-8">
            <style>
                @page { size: 80mm auto; margin: 0; padding: 0; }
                @media print { body { margin: 0; padding: 5mm; width: 80mm; font-size: 10px; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .customer-receipt-actions { display: none !important; } }
                body { font-family: 'Courier New', monospace; padding: 5mm; margin: 0; background: white; width: 80mm; max-width: 80mm; font-size: 10px; line-height: 1.2; }
                .pos-receipt-content { background: white; width: 100%; max-width: 80mm; margin: 0; padding: 0; }
                .pos-receipt-header { text-align: center; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 8px; }
                .pos-receipt-header h3 { margin: 0 0 4px 0; font-size: 14px; font-weight: bold; line-height: 1.2; }
                .pos-receipt-header p { margin: 2px 0; font-size: 9px; line-height: 1.2; }
                .pos-receipt-items { margin: 8px 0; }
                .pos-receipt-item { display: flex; justify-content: space-between; margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px dotted #ccc; font-size: 9px; line-height: 1.3; }
                .pos-receipt-item-name { flex: 1; text-align: left; word-wrap: break-word; padding-right: 4px; }
                .pos-receipt-item-qty { margin: 0 4px; text-align: center; min-width: 20px; flex-shrink: 0; }
                .pos-receipt-item-price { text-align: right; min-width: 50px; flex-shrink: 0; }
                .pos-receipt-total { border-top: 1px solid #000; padding-top: 6px; margin-top: 8px; }
                .pos-receipt-total-row { display: flex; justify-content: space-between; margin-bottom: 3px; font-size: 10px; line-height: 1.3; }
                .pos-receipt-total-row.final { font-weight: bold; font-size: 12px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed #000; }
                .pos-receipt-footer { text-align: center; margin-top: 10px; padding-top: 8px; border-top: 1px dashed #000; font-size: 9px; line-height: 1.3; }
                .customer-receipt-actions { text-align: center; margin-top: 12px; padding-top: 8px; border-top: 1px dashed #ccc; }
                .customer-receipt-actions button { padding: 6px 16px; font-size: 12px; cursor: pointer; }
            </style>
        </head>
        <body>${receiptHTML}</body>
        </html>`);
    printWindow.document.close();
    if (autoPrint) {
        setTimeout(() => { printWindow.print(); }, 250);
    }
}

// Receipt Preview Modal Functions
let currentReceiptPreviewOrder = null;
let currentReceiptPreviewType = null;
let currentReceiptZoom = 100;

/**
 * Show receipt preview in modal
 * @param {object} order - Order object
 * @param {string} type - 'kitchen' or 'customer'
 */
function showReceiptPreview(order, type) {
    if (!order) return;
    
    currentReceiptPreviewOrder = order;
    currentReceiptPreviewType = type;
    currentReceiptZoom = 100;
    
    const modal = document.getElementById('receiptPreviewModal');
    const titleEl = document.getElementById('receiptPreviewTitle');
    const contentEl = document.getElementById('receiptPreviewContent');
    
    if (!modal || !titleEl || !contentEl) {
        // Fallback to old method if modal doesn't exist
        if (type === 'kitchen') {
            printKitchenReceipt(order, false);
        } else {
            printCustomerReceipt(order, false);
        }
        return;
    }
    
    // Set title with order info
    const orderId = escapeHtml(String(order.trackingId || order.id));
    if (type === 'kitchen') {
        titleEl.textContent = `Kitchen Receipt Preview - Order #${orderId}`;
    } else {
        titleEl.textContent = `Customer Receipt Preview - Order #${orderId}`;
    }
    
    // Generate receipt HTML
    let receiptHTML = '';
    if (type === 'kitchen') {
        receiptHTML = generateKitchenReceiptHTML(order);
    } else {
        receiptHTML = generateCustomerReceiptHTML(order);
    }
    
    // Add receipt metadata
    const receiptMeta = generateReceiptMetadata(order, type);
    
    // Wrap in preview container
    contentEl.innerHTML = `
        <div class="receipt-metadata-bar">${receiptMeta}</div>
        <div class="receipt-preview-content-wrapper zoom-100">${receiptHTML}</div>
    `;
    
    // Show modal with animation
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
    
    // Update zoom indicator
    updateZoomIndicator();
    
    // Focus management - focus on close button for accessibility
    setTimeout(() => {
        const closeBtn = modal.querySelector('.close-modal');
        if (closeBtn) closeBtn.focus();
    }, 100);
    
    // Scroll to top of receipt
    const wrapper = contentEl.querySelector('.receipt-preview-content-wrapper');
    if (wrapper) {
        wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

/**
 * Generate kitchen receipt HTML for preview
 */
function generateKitchenReceiptHTML(order) {
    if (!order) return '';
    
    // POS-style kitchen receipt markup (match POS kitchen copy layout/classes)
    const orderId = escapeHtml(String(order.trackingId || order.id));

    const serviceTypeRaw = String(order.serviceType || order.deliveryInfo?.serviceType || '').toLowerCase().trim();
    const isDineIn = serviceTypeRaw === 'dine-in' || serviceTypeRaw === 'dinein';
    const isTakeOut = serviceTypeRaw === 'take-out' || serviceTypeRaw === 'takeout';
    const isPickUp = serviceTypeRaw === 'pick-up' || serviceTypeRaw === 'pickup' || serviceTypeRaw === 'pick_up';
    const isDelivery = serviceTypeRaw === 'delivery' || (!isDineIn && !isTakeOut && !isPickUp && !!serviceTypeRaw);

    let serviceLabel = '—';
    if (isTakeOut) serviceLabel = 'TAKE OUT';
    else if (isDineIn) serviceLabel = 'DINE IN';
    else if (isPickUp) serviceLabel = 'PICK UP';
    else if (isDelivery) serviceLabel = 'DELIVERY';
    else if (serviceTypeRaw) serviceLabel = serviceTypeRaw.replace(/-/g, ' ').toUpperCase();

    const customerName = typeof formatOrderCustomer === 'function'
        ? formatOrderCustomer(order)
        : (order.customerName || order.deliveryInfo?.customerName || '—');

    const cashierName = escapeHtml(String(order.processedByName || order.cashierName || getCurrentStaffName() || 'Staff'));

    const tableNumber = order.tableNumber ?? order.deliveryInfo?.tableNumber ?? '';
    const tableLine = (isDineIn && tableNumber !== '' && tableNumber != null)
        ? `<p>Table: ${escapeHtml(String(tableNumber))}</p>`
        : '';

    const address = order.address || order.deliveryInfo?.address || '';
    const addressLine = (isDelivery && address)
        ? `<p>Address: ${escapeHtml(String(address))}</p>`
        : '';

    const orderNotes = String(order.notes || order.specialInstructions || '').trim();
    const notesLine = orderNotes ? `<p>Notes: ${escapeHtml(orderNotes)}</p>` : '';

    const createdAt = order.createdAt?.toDate?.() || (order.createdAt ? new Date(order.createdAt) : null);
    const dateStr = escapeHtml((createdAt instanceof Date && !isNaN(createdAt.getTime())) ? createdAt.toLocaleString() : new Date().toLocaleString());

    const items = Array.isArray(order.items) ? order.items : [];
    const itemsHtml = items.map(item => {
        const name = escapeHtml(String(item.name || item.itemName || item.itemId || 'Item'));
        const qtyNum = Number(item.quantity);
        const qty = (Number.isFinite(qtyNum) && qtyNum > 0) ? qtyNum : 1;
        const freeNote = item.freeWithPeriRibs ? ' (Free)' : '';
        return `
            <div class="pos-receipt-item">
                <div class="pos-receipt-item-name">${name}${freeNote}</div>
                <div class="pos-receipt-item-qty">${qty}x</div>
                <div class="pos-receipt-item-price">—</div>
            </div>
        `;
    }).join('');

    const totalItems = items.reduce((sum, item) => {
        const q = Number(item.quantity);
        return sum + ((Number.isFinite(q) && q > 0) ? q : 1);
    }, 0);

    return `
        <div class="pos-receipt-content pos-receipt-kitchen">
            <div class="pos-receipt-header">
                <h3>PABLO'S PERI PERI</h3>
                <p><strong>KITCHEN COPY</strong></p>
                <p><strong>${serviceLabel}</strong></p>
                <p>Order ID: ${orderId}</p>
                <p>Customer: ${escapeHtml(String(customerName))}</p>
                ${tableLine}
                ${addressLine}
                <p>Cashier: ${cashierName}</p>
                <p>Date: ${dateStr}</p>
                ${notesLine}
            </div>
            <div class="pos-receipt-items">
                ${itemsHtml || '<div class="pos-receipt-item"><div class="pos-receipt-item-name">—</div><div class="pos-receipt-item-qty">—</div><div class="pos-receipt-item-price">—</div></div>'}
            </div>
            <div class="pos-receipt-total">
                <div class="pos-receipt-total-row">
                    <span>Total Items:</span>
                    <span>${totalItems}</span>
                </div>
            </div>
            <div class="pos-receipt-footer">
                <p>Please prepare order</p>
            </div>
        </div>
    `;
}

/**
 * Generate customer receipt HTML for preview
 */
function generateCustomerReceiptHTML(order) {
    if (!order) return '';
    
    const orderId = escapeHtml(String(order.trackingId || order.id));
    const subtotal = typeof order.subtotal === 'number' ? order.subtotal : (order.total || 0);
    const total = typeof order.total === 'number' ? order.total : 0;
    const discount = order.discount;
    const paymentMode = escapeHtml(String(order.paymentMode || 'Cash'));
    const customerName = typeof formatOrderCustomer === 'function' ? formatOrderCustomer(order) : (order.customerName || '—');
    const cashierName = escapeHtml(String(order.processedByName || order.cashierName || getCurrentStaffName() || 'Staff'));
    const serviceType = (order.serviceType || '').toLowerCase().trim();
    let serviceLabel = 'DINE IN';
    if (serviceType === 'delivery') serviceLabel = 'DELIVERY';
    else if (serviceType === 'pick-up' || serviceType === 'pickup' || serviceType === 'pick_up') serviceLabel = 'PICK UP';
    else if (serviceType === 'take-out' || serviceType === 'takeout') serviceLabel = 'TAKE OUT';
    else if (serviceType === 'dine-in' || serviceType === 'dinein') serviceLabel = 'DINE IN';

    let extraLine = '';
    if (serviceType === 'dine-in' || serviceType === 'dinein') {
        const tbl = order.tableNumber != null ? String(order.tableNumber) : '—';
        extraLine = `<p>Table: ${escapeHtml(tbl)}</p>`;
    } else if (serviceType === 'delivery') {
        const addr = order.address || order.deliveryInfo?.address || '—';
        extraLine = `<p>Delivery to: ${escapeHtml(addr)}</p>`;
    } else if (serviceType === 'pick-up' || serviceType === 'pickup' || serviceType === 'pick_up') {
        extraLine = '<p>Pick-up</p>';
    }

    const items = Array.isArray(order.items) ? order.items : [];
    const itemsHtml = items.map(item => {
        const name = escapeHtml(String(item.name || item.itemName || item.itemId || 'Item'));
        const qty = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
        const price = typeof item.price === 'number' ? item.price : 0;
        const lineTotal = price * qty;
        const freeNote = item.freeWithPeriRibs ? ' (Free with Peri Chicken & Ribs)' : '';
        return `<div class="pos-receipt-item"><div class="pos-receipt-item-name">${name}${freeNote}</div><div class="pos-receipt-item-qty">${qty}x</div><div class="pos-receipt-item-price">₱${lineTotal.toFixed(2)}</div></div>`;
    }).join('');

    const discountHtml = discount && typeof discount.amount === 'number' && discount.amount > 0
        ? `<div class="pos-receipt-total-row"><span>Discount (${escapeHtml(String(discount.type || ''))} ${Number(discount.percent) || 0}%):</span><span>-₱${(discount.amount).toFixed(2)}</span></div>`
        : '';

    const now = new Date().toLocaleString();
    
    return `
        <div class="pos-receipt-content">
            <div class="pos-receipt-header">
                <h3>PABLO'S PERI PERI</h3>
                <p><strong>CUSTOMER COPY</strong></p>
                <p><strong>${serviceLabel}</strong></p>
                <p>Order ID: ${orderId}</p>
                <p>Customer: ${escapeHtml(customerName)}</p>
                ${extraLine}
                <p>Cashier: ${cashierName}</p>
                <p>Date: ${escapeHtml(now)}</p>
            </div>
            <div class="pos-receipt-items">${itemsHtml}</div>
            <div class="pos-receipt-total">
                <div class="pos-receipt-total-row"><span>Subtotal:</span><span>₱${subtotal.toFixed(2)}</span></div>
                ${discountHtml}
                <div class="pos-receipt-total-row"><span>Total:</span><span>₱${total.toFixed(2)}</span></div>
                <div class="pos-receipt-total-row"><span>Payment Method:</span><span><strong>${paymentMode}</strong></span></div>
                <div class="pos-receipt-total-row final"><span>Amount Paid:</span><span>₱${total.toFixed(2)}</span></div>
            </div>
            <div class="pos-receipt-footer">
                <p>Thank you for your order!</p>
                <p>Please come again</p>
            </div>
        </div>
    `;
}

/**
 * Close receipt preview modal
 */
function closeReceiptPreviewModal() {
    const modal = document.getElementById('receiptPreviewModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
    currentReceiptPreviewOrder = null;
    currentReceiptPreviewType = null;
    currentReceiptZoom = 100;
    
    // Update zoom indicator
    updateZoomIndicator();
}

/**
 * Zoom receipt preview
 */
function zoomReceiptPreview(action) {
    const wrapper = document.querySelector('.receipt-preview-content-wrapper');
    if (!wrapper) return;
    
    if (action === 'in') {
        if (currentReceiptZoom < 200) {
            currentReceiptZoom = Math.min(200, currentReceiptZoom + 25);
        }
    } else if (action === 'out') {
        if (currentReceiptZoom > 50) {
            currentReceiptZoom = Math.max(50, currentReceiptZoom - 25);
        }
    } else if (action === 'reset') {
        currentReceiptZoom = 100;
    }
    
    // Remove all zoom classes
    wrapper.classList.remove('zoom-50', 'zoom-75', 'zoom-100', 'zoom-125', 'zoom-150', 'zoom-200');
    wrapper.style.transform = '';
    
    // Add appropriate zoom class
    if (currentReceiptZoom === 50) wrapper.classList.add('zoom-50');
    else if (currentReceiptZoom === 75) wrapper.classList.add('zoom-75');
    else if (currentReceiptZoom === 100) wrapper.classList.add('zoom-100');
    else if (currentReceiptZoom === 125) wrapper.classList.add('zoom-125');
    else if (currentReceiptZoom === 150) wrapper.classList.add('zoom-150');
    else if (currentReceiptZoom === 200) wrapper.classList.add('zoom-200');
    else {
        // Custom zoom using inline style
        wrapper.style.transform = `scale(${currentReceiptZoom / 100})`;
    }
    
    // Update zoom indicator
    updateZoomIndicator();
}

/**
 * Update zoom level indicator
 */
function updateZoomIndicator() {
    const indicator = document.getElementById('zoomIndicator');
    if (indicator) {
        indicator.textContent = `${currentReceiptZoom}%`;
    }
}

/**
 * Print receipt from preview modal
 */
function printReceiptFromPreview() {
    if (!currentReceiptPreviewOrder || !currentReceiptPreviewType) return;
    
    // Close modal first
    closeReceiptPreviewModal();
    
    // Use the existing print functions
    if (currentReceiptPreviewType === 'kitchen') {
        printKitchenReceipt(currentReceiptPreviewOrder, true);
    } else {
        printCustomerReceipt(currentReceiptPreviewOrder, true);
    }
}

/**
 * Quick print customer receipt without preview (for table row quick action)
 */
function quickPrintCustomerReceipt(orderId) {
    const order = ordersState.find(o => o.id === orderId);
    if (!order) {
        showNotification('Order not found.', 'error');
        return;
    }
    // Print directly without showing preview
    printCustomerReceipt(order, true);
}

/**
 * Generate receipt metadata display
 */
function generateReceiptMetadata(order, type) {
    if (!order) return '';
    
    const orderId = escapeHtml(String(order.trackingId || order.id));
    const status = escapeHtml(String(order.status || '—'));
    const serviceType = escapeHtml(String(order.serviceType || '—'));
    const paymentMode = escapeHtml(String(order.paymentMode || 'Cash'));
    const orderDate = order.createdAt ? new Date(order.createdAt.seconds * 1000).toLocaleString() : new Date().toLocaleString();
    
    // Status badge color
    let statusClass = 'status-badge';
    const statusLower = status.toLowerCase();
    if (statusLower.includes('pending') || statusLower.includes('new')) {
        statusClass += ' status-pending';
    } else if (statusLower.includes('preparing') || statusLower.includes('kitchen')) {
        statusClass += ' status-preparing';
    } else if (statusLower.includes('ready')) {
        statusClass += ' status-ready';
    } else if (statusLower.includes('delivered')) {
        statusClass += ' status-delivered';
    } else if (statusLower.includes('declined')) {
        statusClass += ' status-declined';
    }
    
    return `
        <div class="receipt-metadata-item">
            <span class="metadata-label">Order ID:</span>
            <span class="metadata-value">#${orderId}</span>
        </div>
        <div class="receipt-metadata-item">
            <span class="metadata-label">Status:</span>
            <span class="${statusClass}">${status}</span>
        </div>
        <div class="receipt-metadata-item">
            <span class="metadata-label">Service:</span>
            <span class="metadata-value">${serviceType}</span>
        </div>
        <div class="receipt-metadata-item">
            <span class="metadata-label">Payment:</span>
            <span class="metadata-value">${paymentMode}</span>
        </div>
        <div class="receipt-metadata-item">
            <span class="metadata-label">Date:</span>
            <span class="metadata-value">${orderDate}</span>
        </div>
    `;
}

/**
 * Copy receipt text to clipboard
 */
async function copyReceiptText() {
    if (!currentReceiptPreviewOrder || !currentReceiptPreviewType) {
        showNotification('No receipt available to copy.', 'error');
        return;
    }
    
    try {
        const wrapper = document.querySelector('.receipt-preview-content-wrapper');
        if (!wrapper) {
            showNotification('Receipt content not found.', 'error');
            return;
        }
        
        // Get text content from receipt
        const receiptText = extractReceiptText(currentReceiptPreviewOrder, currentReceiptPreviewType);
        
        // Copy to clipboard
        await navigator.clipboard.writeText(receiptText);
        showNotification('Receipt text copied to clipboard!', 'success');
    } catch (error) {
        console.error('Error copying receipt text:', error);
        showNotification('Failed to copy receipt text.', 'error');
    }
}

/**
 * Extract receipt text for copying
 */
function extractReceiptText(order, type) {
    if (!order) return '';
    
    const orderId = String(order.trackingId || order.id);
    const serviceType = (order.serviceType || '').toUpperCase();
    const customerName = typeof formatOrderCustomer === 'function' ? formatOrderCustomer(order) : (order.customerName || '—');
    const now = new Date().toLocaleString();
    
    let text = `PABLO'S PERI PERI\n`;
    text += `${'='.repeat(40)}\n\n`;
    
    if (type === 'kitchen') {
        text += `KITCHEN COPY\n`;
        text += `Order ID: ${orderId}\n`;
        text += `Service: ${serviceType}\n`;
        text += `Customer: ${customerName}\n`;
        text += `Time: ${now}\n\n`;
        text += `ITEMS TO PREPARE:\n`;
        text += `${'-'.repeat(40)}\n`;
        
        const items = Array.isArray(order.items) ? order.items : [];
        items.forEach(item => {
            const name = String(item.name || item.itemName || 'Item');
            const qty = typeof item.quantity === 'number' ? item.quantity : 1;
            const notes = [item.notes, item.instructions, item.specialInstructions].filter(Boolean).join('; ');
            text += `${qty}x ${name}`;
            if (notes) text += ` (${notes})`;
            text += `\n`;
        });
    } else {
        text += `CUSTOMER COPY\n`;
        text += `Service: ${serviceType}\n`;
        text += `Order ID: ${orderId}\n`;
        text += `Customer: ${customerName}\n`;
        if (order.tableNumber) text += `Table: ${order.tableNumber}\n`;
        if (order.address) text += `Address: ${order.address}\n`;
        text += `Date: ${now}\n\n`;
        text += `ITEMS:\n`;
        text += `${'-'.repeat(40)}\n`;
        
        const items = Array.isArray(order.items) ? order.items : [];
        items.forEach(item => {
            const name = String(item.name || item.itemName || 'Item');
            const qty = typeof item.quantity === 'number' ? item.quantity : 1;
            const price = typeof item.price === 'number' ? item.price : 0;
            const total = price * qty;
            text += `${name} - ${qty}x - ₱${total.toFixed(2)}\n`;
        });
        
        text += `\n${'-'.repeat(40)}\n`;
        const subtotal = typeof order.subtotal === 'number' ? order.subtotal : (order.total || 0);
        const total = typeof order.total === 'number' ? order.total : 0;
        text += `Subtotal: ₱${subtotal.toFixed(2)}\n`;
        if (order.discount && order.discount.amount) {
            text += `Discount: -₱${order.discount.amount.toFixed(2)}\n`;
        }
        text += `Total: ₱${total.toFixed(2)}\n`;
        text += `Payment Method: ${order.paymentMode || 'Cash'}\n`;
        text += `Amount Paid: ₱${total.toFixed(2)}\n`;
    }
    
    text += `\n${'='.repeat(40)}\n`;
    text += `Thank you for your order!\n`;
    text += `Please come again\n`;
    
    return text;
}

/**
 * Download receipt as file
 */
function downloadReceipt() {
    if (!currentReceiptPreviewOrder || !currentReceiptPreviewType) {
        showNotification('No receipt available to download.', 'error');
        return;
    }
    
    try {
        const orderId = String(currentReceiptPreviewOrder.trackingId || currentReceiptPreviewOrder.id);
        const receiptText = extractReceiptText(currentReceiptPreviewOrder, currentReceiptPreviewType);
        const receiptType = currentReceiptPreviewType === 'kitchen' ? 'Kitchen' : 'Customer';
        const filename = `Receipt_${receiptType}_${orderId}_${new Date().toISOString().split('T')[0]}.txt`;
        
        // Create blob and download
        const blob = new Blob([receiptText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showNotification('Receipt downloaded successfully!', 'success');
    } catch (error) {
        console.error('Error downloading receipt:', error);
        showNotification('Failed to download receipt.', 'error');
    }
}

// Close modal when clicking outside of it
window.onclick = function(event) {
    const orderModal = document.getElementById('orderDetailsModal');
    const receiptModal = document.getElementById('paymentReceiptModal');
    const receiptPreviewModal = document.getElementById('receiptPreviewModal');
    const driverSelectionModal = document.getElementById('driverSelectionModal');
    const driverProfileModal = document.getElementById('driverProfileModal');
    
    if (event.target === orderModal) {
        closeOrderDetailsModal();
    }
    if (event.target === receiptModal) {
        closePaymentReceiptModal();
    }
    if (event.target === receiptPreviewModal) {
        closeReceiptPreviewModal();
    }
    if (event.target === driverSelectionModal) {
        closeDriverSelectionModal();
    }
    if (event.target === driverProfileModal) {
        closeDriverProfileModal();
    }
}

// Keyboard shortcuts for receipt preview modal
document.addEventListener('keydown', function(event) {
    const receiptPreviewModal = document.getElementById('receiptPreviewModal');
    if (!receiptPreviewModal || receiptPreviewModal.style.display === 'none') {
        return; // Modal is not open
    }
    
    // ESC to close
    if (event.key === 'Escape' || event.keyCode === 27) {
        event.preventDefault();
        closeReceiptPreviewModal();
        return;
    }
    
    // Ctrl/Cmd + Plus to zoom in
    if ((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        zoomReceiptPreview('in');
        return;
    }
    
    // Ctrl/Cmd + Minus to zoom out
    if ((event.ctrlKey || event.metaKey) && event.key === '-') {
        event.preventDefault();
        zoomReceiptPreview('out');
        return;
    }
    
    // Ctrl/Cmd + 0 to reset zoom
    if ((event.ctrlKey || event.metaKey) && event.key === '0') {
        event.preventDefault();
        zoomReceiptPreview('reset');
        return;
    }
    
    // Plus key (without modifier) to zoom in
    if (event.key === '+' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        zoomReceiptPreview('in');
        return;
    }
    
    // Minus key (without modifier) to zoom out
    if (event.key === '-' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        zoomReceiptPreview('out');
        return;
    }
});

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

// Sales report state
let currentReportPeriod = 'weekly'; // 'weekly', 'monthly', 'yearly'

// Sales report functions
// switchAnalyticsTab removed - ingredient logs moved to menu page

function switchReport(reportType) {
    // Remove active class from all sales period tabs (within sales content)
    const salesContent = document.getElementById('sales-content');
    if (salesContent) {
        salesContent.querySelectorAll('.sales-activity-tabs .tab-btn').forEach(tab => {
            tab.classList.remove('active');
        });
        
        // Add active class to clicked tab
        const clickedTab = event?.target || salesContent.querySelector(`.sales-activity-tabs .tab-btn[onclick*="${reportType}"]`);
        if (clickedTab) {
            clickedTab.classList.add('active');
        }
    } else {
        // Fallback for old structure
        document.querySelectorAll('.sales-activity-tabs .tab-btn').forEach(tab => {
            tab.classList.remove('active');
        });
        const clickedTab = event?.target || document.querySelector(`.sales-activity-tabs .tab-btn[onclick*="${reportType}"]`);
        if (clickedTab) {
            clickedTab.classList.add('active');
        }
    }
    
    // Update period selector if it exists
    const periodSelect = document.getElementById('summaryPeriodSelect');
    if (periodSelect) {
        periodSelect.value = reportType;
    }
    
    currentReportPeriod = reportType;
    updateSalesReport();
}

// Filter most ordered items by category
let currentMostOrderedCategory = 'all';
let allMostOrderedItems = [];

function filterMostOrdered(category) {
    currentMostOrderedCategory = category;
    
    // Update active button
    const categoryFilter = document.getElementById('mostOrderedCategoryFilter');
    if (categoryFilter) {
        categoryFilter.querySelectorAll('.category-btn').forEach(btn => {
        btn.classList.remove('active');
            // Mark as active if it matches the selected category
            if (category === 'all' && btn.textContent.trim() === 'All Categories') {
                btn.classList.add('active');
            } else if (category !== 'all' && btn.textContent.trim().toLowerCase() === category.toLowerCase()) {
                btn.classList.add('active');
            }
        });
    }
    
    // Filter items
    let filtered = allMostOrderedItems;
    if (category !== 'all') {
        filtered = allMostOrderedItems.filter(item => {
            const itemCategory = (item.category || '').toLowerCase().trim();
            const filterCategory = category.toLowerCase().trim();
            // Exact match (primary) or normalized match (handles spaces, hyphens, etc.)
            const normalizedItemCategory = itemCategory.replace(/[\s-_]/g, '');
            const normalizedFilterCategory = filterCategory.replace(/[\s-_]/g, '');
            return itemCategory === filterCategory || normalizedItemCategory === normalizedFilterCategory;
        });
    }
    
    // Update display with top 5
    const topItems = filtered.slice(0, 5);
    const mostOrderedContent = document.getElementById('mostOrderedContent');
    if (!mostOrderedContent) return;
    
    if (topItems.length === 0) {
        mostOrderedContent.innerHTML = '<div class="empty-state" style="text-align: center; padding: 40px; color: #6c757d;">No items found in this category</div>';
        return;
    }
    
    mostOrderedContent.innerHTML = topItems.map((item, index) => {
        const menuItem = menuState.find(m => 
            (m.id === item.menuId || m.menuId === item.menuId) ||
            (m.name && m.name.toLowerCase() === item.name.toLowerCase())
        );
        const imageUrl = getMenuItemImage(menuItem);
        
        return `
            <div class="most-ordered-item-template">
                <div class="most-ordered-item-rank">#${index + 1}</div>
                <div class="most-ordered-item-image" style="${imageUrl ? `background-image: url('${escapeHtml(imageUrl)}'); background-size: cover; background-position: center;` : ''}">
                    ${!imageUrl ? '<i class="fas fa-utensils"></i>' : ''}
                </div>
                <div class="most-ordered-item-info">
                    <h4 class="most-ordered-item-name">${escapeHtml(item.name)}</h4>
                    <p class="most-ordered-item-price">${formatCurrency(item.price)}</p>
                    <p class="most-ordered-item-orders">Order ${item.quantity}x</p>
                </div>
            </div>
        `;
    }).join('');
}

// Get date range based on report period
function getDateRangeForPeriod(period) {
    const now = new Date();
    let startDate, endDate;
    
    switch(period) {
        case 'weekly':
            // Last 7 days
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 7);
            endDate = new Date(now);
            break;
        case 'monthly':
            // Current month
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
            break;
        case 'yearly':
            // Current year
            startDate = new Date(now.getFullYear(), 0, 1);
            endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
            break;
        default:
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 7);
            endDate = new Date(now);
    }
    
    return { startDate, endDate };
}

// Get previous period date range for comparison
function getPreviousPeriodRange(period) {
    const now = new Date();
    let startDate, endDate;
    switch(period) {
        case 'weekly':
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 14);
            endDate = new Date(now);
            endDate.setDate(now.getDate() - 8);
            break;
        case 'monthly':
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
            break;
        case 'yearly':
            startDate = new Date(now.getFullYear() - 1, 0, 1);
            endDate = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
            break;
        default:
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 14);
            endDate = new Date(now);
            endDate.setDate(now.getDate() - 8);
    }
    return { startDate, endDate };
}

// Compare current period to previous; returns { pctRevenue, pctOrders, pctAvg } or null
function calculatePeriodComparison(orders, period) {
    if (!orders || !orders.length) return null;
    const prev = getPreviousPeriodRange(period);
    const prevPaid = orders.filter(o => isOrderPaid(o) && isOrderInDateRange(o, prev.startDate, prev.endDate));
    const prevRevenue = prevPaid.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    const prevOrders = prevPaid.length;
    const prevItems = prevPaid.reduce((s, o) => {
        if (!o.items || !Array.isArray(o.items)) return s;
        return s + o.items.reduce((a, i) => a + (typeof i.quantity === 'number' ? i.quantity : 1), 0);
    }, 0);
    const prevAvg = prevOrders > 0 ? prevRevenue / prevOrders : 0;
    const curr = getDateRangeForPeriod(period);
    const currPaid = orders.filter(o => isOrderPaid(o) && isOrderInDateRange(o, curr.startDate, curr.endDate));
    const currRevenue = currPaid.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    const currOrders = currPaid.length;
    const currAvg = currOrders > 0 ? currRevenue / currOrders : 0;
    return {
        pctRevenue: prevRevenue > 0 ? ((currRevenue - prevRevenue) / prevRevenue) * 100 : (currRevenue > 0 ? 100 : 0),
        pctOrders: prevOrders > 0 ? ((currOrders - prevOrders) / prevOrders) * 100 : (currOrders > 0 ? 100 : 0),
        pctAvg: prevAvg > 0 ? ((currAvg - prevAvg) / prevAvg) * 100 : (currAvg > 0 ? 100 : 0)
    };
}

// Format date range for display
function formatDateRangeLabel(period) {
    const { startDate, endDate } = getDateRangeForPeriod(period);
    const f = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${f(startDate)} – ${f(endDate)}`;
}

// Check if order is within date range
function isOrderInDateRange(order, startDate, endDate) {
    if (!order.createdAt) return false;
    
    let orderDate;
    if (order.createdAt.toDate) {
        orderDate = order.createdAt.toDate();
    } else if (order.createdAt instanceof Date) {
        orderDate = order.createdAt;
    } else if (order.createdAt.seconds) {
        orderDate = new Date(order.createdAt.seconds * 1000);
    } else {
        orderDate = new Date(order.createdAt);
    }
    
    return orderDate >= startDate && orderDate <= endDate;
}

// Calculate sales metrics
function calculateSalesMetrics(orders, period) {
    const { startDate, endDate } = getDateRangeForPeriod(period);
    
    // Filter paid orders within date range
    const paidOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        return isOrderInDateRange(order, startDate, endDate);
    });
    
    // Calculate totals
    let totalRevenue = 0;
    let totalOrders = paidOrders.length;
    let totalItems = 0;
    let revenueByServiceType = {
        'dine-in': 0,
        'pick-up': 0,
        'delivery': 0
    };
    let revenueByPaymentMethod = {};
    let orderCountByServiceType = {
        'dine-in': 0,
        'pick-up': 0,
        'delivery': 0
    };
    // Track by order source: Walk-in vs Online
    let revenueByOrderSource = {
        'walk-in': { revenue: 0, orders: 0, breakdown: { 'dine-in': { revenue: 0, orders: 0 }, 'take-out': { revenue: 0, orders: 0 } } },
        'online': { revenue: 0, orders: 0, breakdown: { 'delivery': { revenue: 0, orders: 0 }, 'pick-up': { revenue: 0, orders: 0 } } }
    };
    // Keep legacy tracking for backward compatibility
    let walkInRevenue = 0;
    let walkInOrderCount = 0;
    let walkInByServiceType = {
        'dine-in': { revenue: 0, orders: 0 },
        'pick-up': { revenue: 0, orders: 0 }
    };
    
    paidOrders.forEach(order => {
        const orderTotal = parseFloat(order.total || 0);
        totalRevenue += orderTotal;
        
        // Count items
        if (order.items && Array.isArray(order.items)) {
            order.items.forEach(item => {
                const quantity = typeof item.quantity === 'number' ? item.quantity : 1;
                totalItems += quantity;
            });
        }
        
        // Determine if walk-in or online order
        const isWalkIn = order.walkin === true || order.deliveryInfo?.walkin === true;
        let serviceType = (order.serviceType || order.deliveryInfo?.serviceType || order.deliveryInfo?.deliveryMethod || '').toLowerCase().trim();
        
        if (isWalkIn) {
            // Walk-in orders: Dine-in or Take-out
            walkInRevenue += orderTotal;
            walkInOrderCount++;
            
            if (serviceType === 'dine-in' || serviceType === 'dinein') {
                revenueByOrderSource['walk-in'].revenue += orderTotal;
                revenueByOrderSource['walk-in'].orders++;
                revenueByOrderSource['walk-in'].breakdown['dine-in'].revenue += orderTotal;
                revenueByOrderSource['walk-in'].breakdown['dine-in'].orders++;
                walkInByServiceType['dine-in'].revenue += orderTotal;
                walkInByServiceType['dine-in'].orders++;
                serviceType = 'dine-in';
            } else if (serviceType === 'take-out' || serviceType === 'takeout') {
                revenueByOrderSource['walk-in'].revenue += orderTotal;
                revenueByOrderSource['walk-in'].orders++;
                revenueByOrderSource['walk-in'].breakdown['take-out'].revenue += orderTotal;
                revenueByOrderSource['walk-in'].breakdown['take-out'].orders++;
                walkInByServiceType['pick-up'].revenue += orderTotal;
                walkInByServiceType['pick-up'].orders++;
                serviceType = 'pick-up';
            }
        } else {
            // Online orders: Delivery or Pick-up
            if (serviceType === 'delivery') {
                revenueByOrderSource['online'].revenue += orderTotal;
                revenueByOrderSource['online'].orders++;
                revenueByOrderSource['online'].breakdown['delivery'].revenue += orderTotal;
                revenueByOrderSource['online'].breakdown['delivery'].orders++;
            } else if (serviceType === 'pick-up' || serviceType === 'pickup' || serviceType === 'pick_up') {
                revenueByOrderSource['online'].revenue += orderTotal;
                revenueByOrderSource['online'].orders++;
                revenueByOrderSource['online'].breakdown['pick-up'].revenue += orderTotal;
                revenueByOrderSource['online'].breakdown['pick-up'].orders++;
            }
        }
        
        // Legacy: Categorize by service type (for backward compatibility)
        if (serviceType === 'dine-in' || serviceType === 'dinein') {
            revenueByServiceType['dine-in'] += orderTotal;
            orderCountByServiceType['dine-in']++;
        } else if (serviceType === 'pick-up' || serviceType === 'pickup' || serviceType === 'pick_up' || serviceType === 'take-out' || serviceType === 'takeout') {
            revenueByServiceType['pick-up'] += orderTotal;
            orderCountByServiceType['pick-up']++;
        } else {
            revenueByServiceType['delivery'] += orderTotal;
            orderCountByServiceType['delivery']++;
        }
        
        // Payment method breakdown
        const paymentMethod = (order.paymentMode || 'Unspecified').toLowerCase();
        if (!revenueByPaymentMethod[paymentMethod]) {
            revenueByPaymentMethod[paymentMethod] = 0;
        }
        revenueByPaymentMethod[paymentMethod] += orderTotal;
    });
    
    // Calculate averages
    const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const averageItemsPerOrder = totalOrders > 0 ? totalItems / totalOrders : 0;
    
    return {
        totalRevenue,
        totalOrders,
        totalItems,
        averageOrderValue,
        averageItemsPerOrder,
        revenueByServiceType,
        revenueByPaymentMethod,
        orderCountByServiceType,
        revenueByOrderSource,
        walkInRevenue,
        walkInOrderCount,
        walkInByServiceType,
        startDate,
        endDate
    };
}

// Calculate most ordered items
function calculateMostOrderedItems(orders, period, limit = 20) {
    const { startDate, endDate } = getDateRangeForPeriod(period);
    
    // Filter paid orders within date range
    const paidOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        return isOrderInDateRange(order, startDate, endDate);
    });
    
    const itemStats = {};
    
    paidOrders.forEach(order => {
        if (!order.items || !Array.isArray(order.items)) return;
        
        order.items.forEach(item => {
            const itemName = item.name || item.itemName || 'Unknown';
            const itemId = item.itemId || item.id || '';
            const itemPrice = parseFloat(item.price || item.itemPrice || 0);
            const quantity = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
            
            // Find menu item for category - must exist in menuState and not be deleted
            const menuItem = menuState.find(m => 
                !m.isDeleted && // Item must not be deleted
                ((m.id === itemId || m.menuId === itemId) ||
                (m.name && m.name.toLowerCase() === itemName.toLowerCase()))
            );
            
            // Only include items that exist in the current menu database
            if (!menuItem) return; // Skip items that are no longer in the database
            
            const category = menuItem.category || 'Uncategorized';
            
            if (!itemStats[itemName]) {
                itemStats[itemName] = {
                    name: itemName,
                    id: itemId,
                    menuId: menuItem.id || menuItem.menuId || itemId,
                    category: category,
                    quantity: 0,
                    revenue: 0,
                    price: itemPrice || menuItem.price || 0
                };
            }
            
            itemStats[itemName].quantity += quantity;
            itemStats[itemName].revenue += itemPrice * quantity;
        });
    });
    
    // Convert to array and sort by quantity
    return Object.values(itemStats)
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, limit);
}

// Calculate sales forecast
function calculateSalesForecast(orders, period) {
    // Get historical data for comparison
    const now = new Date();
    let historicalStart, historicalEnd, forecastStart, forecastEnd;
    
    switch(period) {
        case 'weekly':
            // Compare last 4 weeks to forecast next week
            historicalStart = new Date(now);
            historicalStart.setDate(now.getDate() - 28);
            historicalEnd = new Date(now);
            forecastStart = new Date(now);
            forecastStart.setDate(now.getDate() + 1);
            forecastEnd = new Date(now);
            forecastEnd.setDate(now.getDate() + 7);
            break;
        case 'monthly':
            // Compare last 3 months to forecast next month
            historicalStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
            historicalEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
            forecastStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            forecastEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59);
            break;
        case 'yearly':
            // Compare last 3 years to forecast next year
            historicalStart = new Date(now.getFullYear() - 3, 0, 1);
            historicalEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
            forecastStart = new Date(now.getFullYear() + 1, 0, 1);
            forecastEnd = new Date(now.getFullYear() + 1, 11, 31, 23, 59, 59);
            break;
        default:
            return null;
    }
    
    // Calculate average from historical data
    const historicalOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        return isOrderInDateRange(order, historicalStart, historicalEnd);
    });
    
    let totalHistoricalRevenue = 0;
    historicalOrders.forEach(order => {
        totalHistoricalRevenue += parseFloat(order.total || 0);
    });
    
    // Simple forecast: average of historical periods
    let periodsCount;
    switch(period) {
        case 'weekly':
            periodsCount = 4;
            break;
        case 'monthly':
            periodsCount = 3;
            break;
        case 'yearly':
            periodsCount = 3;
            break;
        default:
            periodsCount = 1;
    }
    
    const averageRevenuePerPeriod = totalHistoricalRevenue / periodsCount;
    
    return {
        forecastedRevenue: averageRevenuePerPeriod,
        forecastStart,
        forecastEnd,
        historicalAverage: averageRevenuePerPeriod,
        historicalTotal: totalHistoricalRevenue
    };
}

// Calculate daily sales for chart
function calculateDailySales(orders, period) {
    const { startDate, endDate } = getDateRangeForPeriod(period);
    
    const paidOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        return isOrderInDateRange(order, startDate, endDate);
    });
    
    const dailySales = {};
    
    paidOrders.forEach(order => {
        let orderDate;
        if (order.createdAt.toDate) {
            orderDate = order.createdAt.toDate();
        } else if (order.createdAt instanceof Date) {
            orderDate = order.createdAt;
        } else if (order.createdAt.seconds) {
            orderDate = new Date(order.createdAt.seconds * 1000);
        } else {
            orderDate = new Date(order.createdAt);
        }
        
        const dateKey = orderDate.toISOString().split('T')[0]; // YYYY-MM-DD
        
        if (!dailySales[dateKey]) {
            dailySales[dateKey] = 0;
        }
        
        dailySales[dateKey] += parseFloat(order.total || 0);
    });
    
    return dailySales;
}

// Calculate peak hours (busiest hours of the day)
function calculatePeakHours(orders, period) {
    const { startDate, endDate } = getDateRangeForPeriod(period);
    const paidOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        return isOrderInDateRange(order, startDate, endDate);
    });
    
    const hourStats = {};
    for (let h = 0; h < 24; h++) {
        hourStats[h] = { hour: h, orders: 0, revenue: 0 };
    }
    
    paidOrders.forEach(order => {
        let orderDate;
        if (order.createdAt?.toDate) orderDate = order.createdAt.toDate();
        else if (order.createdAt instanceof Date) orderDate = order.createdAt;
        else if (order.createdAt?.seconds) orderDate = new Date(order.createdAt.seconds * 1000);
        else orderDate = new Date(order.createdAt);
        
        const hour = orderDate.getHours();
        hourStats[hour].orders++;
        hourStats[hour].revenue += parseFloat(order.total || 0);
    });
    
    return Object.values(hourStats)
        .filter(h => h.orders > 0)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);
}

// Calculate best days of the week
function calculateBestDays(orders, period) {
    const { startDate, endDate } = getDateRangeForPeriod(period);
    const paidOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        return isOrderInDateRange(order, startDate, endDate);
    });
    
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayStats = {};
    dayNames.forEach((name, idx) => {
        dayStats[idx] = { day: name, dayIndex: idx, orders: 0, revenue: 0 };
    });
    
    paidOrders.forEach(order => {
        let orderDate;
        if (order.createdAt?.toDate) orderDate = order.createdAt.toDate();
        else if (order.createdAt instanceof Date) orderDate = order.createdAt;
        else if (order.createdAt?.seconds) orderDate = new Date(order.createdAt.seconds * 1000);
        else orderDate = new Date(order.createdAt);
        
        const dayIndex = orderDate.getDay();
        dayStats[dayIndex].orders++;
        dayStats[dayIndex].revenue += parseFloat(order.total || 0);
    });
    
    return Object.values(dayStats)
        .filter(d => d.orders > 0)
        .sort((a, b) => b.revenue - a.revenue);
}

// Calculate category performance
function calculateCategoryPerformance(orders, period) {
    const { startDate, endDate } = getDateRangeForPeriod(period);
    const paidOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        return isOrderInDateRange(order, startDate, endDate);
    });
    
    const categoryStats = {};
    
    paidOrders.forEach(order => {
        if (!order.items || !Array.isArray(order.items)) return;
        
        order.items.forEach(item => {
            const itemId = item.itemId || item.id || '';
            const itemName = item.name || item.itemName || 'Unknown';
            const quantity = typeof item.quantity === 'number' ? item.quantity : 1;
            const price = parseFloat(item.price || item.itemPrice || 0);
            const revenue = price * quantity;
            
            const menuItem = menuState.find(m => 
                !m.isDeleted &&
                ((m.id === itemId || m.menuId === itemId) ||
                (m.name && m.name.toLowerCase() === itemName.toLowerCase()))
            );
            
            if (!menuItem) return;
            
            const category = menuItem.category || 'Uncategorized';
            if (!categoryStats[category]) {
                categoryStats[category] = {
                    category: category,
                    revenue: 0,
                    quantity: 0,
                    orders: new Set()
                };
            }
            
            categoryStats[category].revenue += revenue;
            categoryStats[category].quantity += quantity;
            categoryStats[category].orders.add(order.id);
        });
    });
    
    return Object.values(categoryStats)
        .map(cat => ({
            ...cat,
            orders: cat.orders.size,
            avgOrderValue: cat.orders.size > 0 ? cat.revenue / cat.orders.size : 0
        }))
        .sort((a, b) => b.revenue - a.revenue);
}

// Calculate low performers (items with low sales that may need attention)
function calculateLowPerformers(orders, period, mostOrdered) {
    const { startDate, endDate } = getDateRangeForPeriod(period);
    const paidOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        return isOrderInDateRange(order, startDate, endDate);
    });
    
    // Get all items that exist in menu but have low or no sales
    if (!menuState || menuState.length === 0) return [];
    const allMenuItems = menuState.filter(m => !m.isDeleted && m.isActive !== false);
    const topItemNames = new Set(mostOrdered.map(item => item.name.toLowerCase()));
    
    const itemSales = {};
    paidOrders.forEach(order => {
        if (!order.items || !Array.isArray(order.items)) return;
        order.items.forEach(item => {
            const itemName = (item.name || item.itemName || '').toLowerCase();
            if (!itemSales[itemName]) {
                itemSales[itemName] = { quantity: 0, revenue: 0 };
            }
            itemSales[itemName].quantity += (typeof item.quantity === 'number' ? item.quantity : 1);
            itemSales[itemName].revenue += parseFloat(item.price || item.itemPrice || 0) * (typeof item.quantity === 'number' ? item.quantity : 1);
        });
    });
    
    // Find items with low or zero sales
    const lowPerformers = allMenuItems
        .filter(menuItem => {
            const itemName = (menuItem.name || '').toLowerCase();
            const sales = itemSales[itemName] || { quantity: 0, revenue: 0 };
            // Low performer: not in top sellers and has low sales
            return !topItemNames.has(itemName) && (sales.quantity < 5 || sales.revenue < 500);
        })
        .map(menuItem => {
            const itemName = (menuItem.name || '').toLowerCase();
            const sales = itemSales[itemName] || { quantity: 0, revenue: 0 };
            return {
                name: menuItem.name,
                category: menuItem.category || 'Uncategorized',
                quantity: sales.quantity,
                revenue: sales.revenue,
                price: menuItem.price || 0,
                menuId: menuItem.id || menuItem.menuId
            };
        })
        .sort((a, b) => a.quantity - b.quantity)
        .slice(0, 10);
    
    return lowPerformers;
}

// Update sales report with calculated data
async function updateSalesReport() {
    if (!ordersState || ordersState.length === 0) {
        await loadOrdersCollectionOnce();
    }
    
    if (!ordersState || ordersState.length === 0) {
        console.warn('No orders data available for sales report');
        return;
    }
    
    // Calculate metrics
    const metrics = calculateSalesMetrics(ordersState, currentReportPeriod);
    const comparison = calculatePeriodComparison(ordersState, currentReportPeriod);
    const mostOrdered = calculateMostOrderedItems(ordersState, currentReportPeriod, 20);
    const forecast = calculateSalesForecast(ordersState, currentReportPeriod);
    const dailySales = calculateDailySales(ordersState, currentReportPeriod);
    const loyalCustomers = calculateLoyalCustomers(ordersState, 4);
    
    // Ensure menu state is loaded for category and low performer analysis
    if (!menuState || menuState.length === 0) {
        await ensureMenuStateLoaded();
    }
    
    // Calculate new analytics
    const peakHours = calculatePeakHours(ordersState, currentReportPeriod);
    const bestDays = calculateBestDays(ordersState, currentReportPeriod);
    const categoryPerformance = calculateCategoryPerformance(ordersState, currentReportPeriod);
    const lowPerformers = calculateLowPerformers(ordersState, currentReportPeriod, mostOrdered);
    
    // Update KPI strip, date range label, and today snapshot
    updateSalesKpiStrip(metrics, comparison);
    updateSalesDateRangeLabel(currentReportPeriod);
    updateTodaySnapshot(ordersState);
    
    // Update all sections
    updateSalesSummary(metrics);
    updateRevenueBreakdowns(metrics);
    updateMostOrderedItemsSection(mostOrdered);
    updateLoyalCustomers(loyalCustomers);
    updateBestSeller(mostOrdered);
    updateInDepthViewTable(mostOrdered);
    
    // Update new analytics sections
    updatePeakHours(peakHours);
    updateBestDays(bestDays);
    updateCategoryPerformance(categoryPerformance);
    updateLowPerformers(lowPerformers);
    
    // Update legacy sections (if they exist)
    updateSalesSummaryMetrics(metrics);
    // updateSalesChart removed - revenue over time chart removed from UI
    updateSalesForecast(forecast);
    
    // Update daily sales report
    updateDailySalesReport();
}

// Refresh sales: reload orders then update report
async function refreshSalesReport() {
    const btn = document.querySelector('.sales-refresh-btn');
    if (btn) {
        btn.disabled = true;
        btn.querySelector('i')?.classList.add('fa-spin');
    }
    try {
        await loadOrdersCollectionOnce();
        await updateSalesReport();
        if (typeof showNotification === 'function') {
            showNotification('Sales report refreshed', 'success');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.querySelector('i')?.classList.remove('fa-spin');
        }
    }
}

function updateSalesKpiStrip(metrics, comparison) {
    const revenueEl = document.getElementById('salesKpiRevenue');
    const ordersEl = document.getElementById('salesKpiOrders');
    const avgEl = document.getElementById('salesKpiAvg');
    const vsEl = document.getElementById('salesKpiVsPrior');
    if (revenueEl) revenueEl.textContent = formatCurrency(metrics.totalRevenue);
    if (ordersEl) ordersEl.textContent = metrics.totalOrders.toLocaleString();
    if (avgEl) avgEl.textContent = formatCurrency(metrics.averageOrderValue);
    if (vsEl) {
        if (!comparison || (comparison.pctRevenue === 0 && comparison.pctOrders === 0)) {
            vsEl.textContent = '—';
            vsEl.className = 'sales-kpi-value sales-kpi-trend';
        } else {
            const pct = comparison.pctRevenue;
            const sign = pct >= 0 ? '+' : '';
            vsEl.textContent = `${sign}${pct.toFixed(1)}%`;
            vsEl.className = 'sales-kpi-value sales-kpi-trend ' + (pct >= 0 ? 'sales-kpi-up' : 'sales-kpi-down');
        }
    }
}

function updateSalesDateRangeLabel(period) {
    const el = document.getElementById('salesDateRangeLabel');
    if (el) el.textContent = formatDateRangeLabel(period);
}

function updateTodaySnapshot(orders) {
    const el = document.getElementById('salesKpiToday');
    if (!el) return;
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const dayOrders = (orders || []).filter(o => {
        if (!isOrderPaid(o) || !o.createdAt) return false;
        let d;
        if (o.createdAt.toDate) d = o.createdAt.toDate();
        else if (o.createdAt instanceof Date) d = o.createdAt;
        else if (o.createdAt.seconds) d = new Date(o.createdAt.seconds * 1000);
        else d = new Date(o.createdAt);
        return d.toISOString().split('T')[0] === todayStr;
    });
    const rev = dayOrders.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    el.textContent = formatCurrency(rev) + ' · ' + dayOrders.length + ' orders';
}

// Update sales summary metrics
function updateSalesSummaryMetrics(metrics) {
    // Update average sale value
    const avgSaleValueCards = document.querySelectorAll('.metric-card.light-green');
    if (avgSaleValueCards.length > 0) {
        // Find the card with "Average Sale Value"
        Array.from(avgSaleValueCards).forEach(card => {
            const h4 = card.querySelector('h4');
            if (h4 && h4.textContent.includes('Average Sale Value')) {
                const valueEl = card.querySelector('.metric-value');
                if (valueEl) {
                    valueEl.textContent = formatCurrency(metrics.averageOrderValue);
                }
            }
        });
    }
    
    // Update average items per sale
    if (avgSaleValueCards.length > 1) {
        Array.from(avgSaleValueCards).forEach(card => {
            const h4 = card.querySelector('h4');
            if (h4 && h4.textContent.includes('Avg. Items Per Sale')) {
                const valueEl = card.querySelector('.metric-value');
                if (valueEl) {
                    valueEl.textContent = metrics.averageItemsPerOrder.toFixed(1);
                }
            }
        });
    }
    
    // Add total revenue card if it doesn't exist
    const activityMetrics = document.querySelector('.activity-metrics');
    if (activityMetrics) {
        let totalRevenueCard = activityMetrics.querySelector('.metric-card.total-revenue');
        if (!totalRevenueCard) {
            totalRevenueCard = document.createElement('div');
            totalRevenueCard.className = 'metric-card light-green total-revenue';
            totalRevenueCard.innerHTML = `
                <h4>Total Revenue</h4>
                <span class="metric-value">${formatCurrency(metrics.totalRevenue)}</span>
            `;
            activityMetrics.appendChild(totalRevenueCard);
        } else {
            const valueEl = totalRevenueCard.querySelector('.metric-value');
            if (valueEl) {
                valueEl.textContent = formatCurrency(metrics.totalRevenue);
            }
        }
        
        // Add total orders card
        let totalOrdersCard = activityMetrics.querySelector('.metric-card.total-orders');
        if (!totalOrdersCard) {
            totalOrdersCard = document.createElement('div');
            totalOrdersCard.className = 'metric-card light-green total-orders';
            totalOrdersCard.innerHTML = `
                <h4>Total Orders</h4>
                <span class="metric-value">${metrics.totalOrders}</span>
            `;
            activityMetrics.appendChild(totalOrdersCard);
        } else {
            const valueEl = totalOrdersCard.querySelector('.metric-value');
            if (valueEl) {
                valueEl.textContent = metrics.totalOrders;
            }
        }
    }
    
    // Update chart metrics
    const chartMetrics = document.querySelector('.chart-metrics');
    if (chartMetrics) {
        const metricSpans = chartMetrics.querySelectorAll('span');
        if (metricSpans.length >= 3) {
            // Sales Target (can be calculated or set manually)
            // For now, use average as target
            metricSpans[0].textContent = formatCurrency(metrics.averageOrderValue * metrics.totalOrders);
            // Avg. Sales Target
            metricSpans[1].textContent = formatCurrency(metrics.averageOrderValue);
            // Avg. Items per Sale
            metricSpans[2].textContent = metrics.averageItemsPerOrder.toFixed(1);
        }
    }
}

// Update sales chart
function updateSalesChart(dailySales, period) {
    const chartPlaceholder = document.getElementById('salesRevenueChart') || document.querySelector('#sales .chart-placeholder');
    if (!chartPlaceholder) return;
    
    // Get dates for the period
    const { startDate, endDate } = getDateRangeForPeriod(period);
    const dates = [];
    const currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
        dates.push(new Date(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Calculate max revenue for scaling
    const maxRevenue = Math.max(...Object.values(dailySales), 1);
    
    // Generate chart bars
    const chartBars = chartPlaceholder.querySelector('.chart-bars');
    const chartLabels = chartPlaceholder.querySelector('.chart-labels');
    
    if (chartBars && chartLabels) {
        chartBars.innerHTML = '';
        chartLabels.innerHTML = '';
        
        dates.forEach(date => {
            const dateKey = date.toISOString().split('T')[0];
            const revenue = dailySales[dateKey] || 0;
            const height = maxRevenue > 0 ? (revenue / maxRevenue) * 100 : 0;
            
            const bar = document.createElement('div');
            bar.className = 'chart-bar';
            bar.style.height = `${height}%`;
            bar.title = `${date.toLocaleDateString()}: ${formatCurrency(revenue)}`;
            chartBars.appendChild(bar);
            
            const label = document.createElement('span');
            label.textContent = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            chartLabels.appendChild(label);
        });
    }
}

// Update most ordered items category filter buttons
function updateMostOrderedCategoryFilters() {
    const categoryFilter = document.getElementById('mostOrderedCategoryFilter');
    if (!categoryFilter) return;
    
    // Get unique categories from menuState (only active, non-deleted items)
    const categories = new Set();
    if (menuState && menuState.length) {
        menuState.forEach(item => {
            if (item.category && item.isDeleted !== true && item.isActive !== false) {
                categories.add(item.category);
            }
        });
    }
    
    // Get current active category before clearing
    const currentActive = currentMostOrderedCategory || 'all';
    
    // Clear existing category buttons
    categoryFilter.innerHTML = '';
    
    // Add "All Categories" button
    const allBtn = document.createElement('button');
    allBtn.className = 'category-btn' + (currentActive === 'all' ? ' active' : '');
    allBtn.textContent = 'All Categories';
    allBtn.onclick = function() { filterMostOrdered('all'); };
    categoryFilter.appendChild(allBtn);
    
    // Add category buttons for each unique category
    const sortedCategories = Array.from(categories).sort();
    sortedCategories.forEach(category => {
        const btn = document.createElement('button');
        const categoryLower = category.toLowerCase();
        btn.className = 'category-btn' + (currentActive === categoryLower ? ' active' : '');
        btn.textContent = category;
        btn.onclick = function() { filterMostOrdered(categoryLower); };
        categoryFilter.appendChild(btn);
    });
}

// Update most ordered items section
function updateMostOrderedItemsSection(mostOrdered) {
    const mostOrderedContent = document.getElementById('mostOrderedContent');
    if (!mostOrderedContent) return;
    
    // Update category filter buttons based on actual categories
    updateMostOrderedCategoryFilters();
    
    // Store all items for filtering
    allMostOrderedItems = mostOrdered;
    
    if (mostOrdered.length === 0) {
        mostOrderedContent.innerHTML = '<div class="empty-state" style="text-align: center; padding: 40px; color: #6c757d;">No sales data available for this period</div>';
        return;
    }
    
    // Filter based on current category
    filterMostOrdered(currentMostOrderedCategory);
}

// Helper function to get menu item image
function getMenuItemImage(menuItem) {
    if (!menuItem) return '';
    return menuItem.imageDataUrl || '';
}

// Update revenue breakdowns (template style)
function updateRevenueBreakdowns(metrics) {
    const breakdownContent = document.getElementById('revenueBreakdownContent');
    if (!breakdownContent) return;
    
    const total = metrics.totalRevenue;
    const orderSource = metrics.revenueByOrderSource || {
        'walk-in': { revenue: 0, orders: 0, breakdown: { 'dine-in': { revenue: 0, orders: 0 }, 'take-out': { revenue: 0, orders: 0 } } },
        'online': { revenue: 0, orders: 0, breakdown: { 'delivery': { revenue: 0, orders: 0 }, 'pick-up': { revenue: 0, orders: 0 } } }
    };
    
    // Payment Method Breakdown
    const paymentMethodItems = Object.entries(metrics.revenueByPaymentMethod)
        .filter(([_, revenue]) => revenue > 0)
        .sort(([_, a], [__, b]) => b - a)
        .map(([method, revenue]) => {
            const percentage = total > 0 ? (revenue / total * 100).toFixed(1) : 0;
            return { method, revenue, percentage };
        });
    
    const walkIn = orderSource['walk-in'] || { revenue: 0, orders: 0, breakdown: { 'dine-in': { revenue: 0, orders: 0 }, 'take-out': { revenue: 0, orders: 0 } } };
    const online = orderSource['online'] || { revenue: 0, orders: 0, breakdown: { 'delivery': { revenue: 0, orders: 0 }, 'pick-up': { revenue: 0, orders: 0 } } };
    
    const walkInPercentage = total > 0 ? (walkIn.revenue / total * 100).toFixed(1) : 0;
    const onlinePercentage = total > 0 ? (online.revenue / total * 100).toFixed(1) : 0;
    
    breakdownContent.innerHTML = `
        <div class="revenue-breakdown-item revenue-breakdown-walkin">
            <div class="revenue-breakdown-item-header">
                <h4 class="revenue-breakdown-item-title">
                    <i class="fas fa-walking" style="margin-right: 8px; color: #7E2021;"></i>
                    Walk-in Orders
                </h4>
                <span class="revenue-breakdown-item-value">${formatCurrency(walkIn.revenue)}</span>
            </div>
            <div class="revenue-breakdown-item-content">
                <div class="revenue-breakdown-bar-item">
                    <div class="revenue-breakdown-bar-label">
                        <span>Total Walk-in</span>
                        <span>${walkIn.orders} orders</span>
                    </div>
                    <div class="revenue-breakdown-bar">
                        <div class="revenue-breakdown-bar-fill" style="width: ${walkInPercentage}%; background: linear-gradient(90deg, #7E2021 0%, #a0282a 100%);">
                            ${walkInPercentage > 10 ? `${walkInPercentage}%` : ''}
                        </div>
                    </div>
                    <div style="font-size: 12px; color: #495057; margin-top: 4px;">
                        ${formatCurrency(walkIn.revenue)} of ${formatCurrency(total)}
                    </div>
                </div>
                <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #e9ecef;">
                    <div style="font-size: 12px; color: #6c757d; margin-bottom: 10px; font-weight: 600;">Breakdown:</div>
                    ${walkIn.breakdown['dine-in'].orders > 0 ? `
                    <div class="revenue-breakdown-bar-item" style="margin-bottom: 10px;">
                        <div class="revenue-breakdown-bar-label">
                            <span>Dine-in</span>
                            <span>${walkIn.breakdown['dine-in'].orders} orders</span>
                        </div>
                        <div class="revenue-breakdown-bar">
                            <div class="revenue-breakdown-bar-fill" style="width: ${walkIn.revenue > 0 ? (walkIn.breakdown['dine-in'].revenue / walkIn.revenue * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #7E2021 0%, #9a2a2b 100%);">
                            </div>
                        </div>
                        <div style="font-size: 12px; color: #495057; margin-top: 4px;">
                            ${formatCurrency(walkIn.breakdown['dine-in'].revenue)}
                        </div>
                    </div>
                    ` : ''}
                    ${walkIn.breakdown['take-out'].orders > 0 ? `
                    <div class="revenue-breakdown-bar-item">
                        <div class="revenue-breakdown-bar-label">
                            <span>Take-out</span>
                            <span>${walkIn.breakdown['take-out'].orders} orders</span>
                        </div>
                        <div class="revenue-breakdown-bar">
                            <div class="revenue-breakdown-bar-fill" style="width: ${walkIn.revenue > 0 ? (walkIn.breakdown['take-out'].revenue / walkIn.revenue * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #7E2021 0%, #9a2a2b 100%);">
                            </div>
                        </div>
                        <div style="font-size: 12px; color: #495057; margin-top: 4px;">
                            ${formatCurrency(walkIn.breakdown['take-out'].revenue)}
                        </div>
                    </div>
                    ` : ''}
                    ${walkIn.orders === 0 ? '<div style="text-align: center; color: #6c757d; padding: 10px;">No walk-in orders</div>' : ''}
                </div>
            </div>
        </div>
        <div class="revenue-breakdown-item revenue-breakdown-online">
            <div class="revenue-breakdown-item-header">
                <h4 class="revenue-breakdown-item-title">
                    <i class="fas fa-shopping-cart" style="margin-right: 8px; color: #2d8c6f;"></i>
                    Online Orders
                </h4>
                <span class="revenue-breakdown-item-value">${formatCurrency(online.revenue)}</span>
            </div>
            <div class="revenue-breakdown-item-content">
                <div class="revenue-breakdown-bar-item">
                    <div class="revenue-breakdown-bar-label">
                        <span>Total Online</span>
                        <span>${online.orders} orders</span>
                    </div>
                    <div class="revenue-breakdown-bar">
                        <div class="revenue-breakdown-bar-fill" style="width: ${onlinePercentage}%; background: linear-gradient(90deg, #2d8c6f 0%, #44a08d 100%);">
                            ${onlinePercentage > 10 ? `${onlinePercentage}%` : ''}
                        </div>
                    </div>
                    <div style="font-size: 12px; color: #495057; margin-top: 4px;">
                        ${formatCurrency(online.revenue)} of ${formatCurrency(total)}
                    </div>
                </div>
                <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #e9ecef;">
                    <div style="font-size: 12px; color: #6c757d; margin-bottom: 10px; font-weight: 600;">Breakdown:</div>
                    ${online.breakdown['delivery'].orders > 0 ? `
                    <div class="revenue-breakdown-bar-item" style="margin-bottom: 10px;">
                        <div class="revenue-breakdown-bar-label">
                            <span>Delivery</span>
                            <span>${online.breakdown['delivery'].orders} orders</span>
                        </div>
                        <div class="revenue-breakdown-bar">
                            <div class="revenue-breakdown-bar-fill" style="width: ${online.revenue > 0 ? (online.breakdown['delivery'].revenue / online.revenue * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #2d8c6f 0%, #44a08d 100%);">
                            </div>
                        </div>
                        <div style="font-size: 12px; color: #495057; margin-top: 4px;">
                            ${formatCurrency(online.breakdown['delivery'].revenue)}
                        </div>
                    </div>
                    ` : ''}
                    ${online.breakdown['pick-up'].orders > 0 ? `
                    <div class="revenue-breakdown-bar-item">
                        <div class="revenue-breakdown-bar-label">
                            <span>Pick-up</span>
                            <span>${online.breakdown['pick-up'].orders} orders</span>
                        </div>
                        <div class="revenue-breakdown-bar">
                            <div class="revenue-breakdown-bar-fill" style="width: ${online.revenue > 0 ? (online.breakdown['pick-up'].revenue / online.revenue * 100).toFixed(1) : 0}%; background: linear-gradient(90deg, #2d8c6f 0%, #44a08d 100%);">
                            </div>
                        </div>
                        <div style="font-size: 12px; color: #495057; margin-top: 4px;">
                            ${formatCurrency(online.breakdown['pick-up'].revenue)}
                        </div>
                    </div>
                    ` : ''}
                    ${online.orders === 0 ? '<div style="text-align: center; color: #6c757d; padding: 10px;">No online orders</div>' : ''}
                </div>
            </div>
        </div>
        <div class="revenue-breakdown-item">
            <div class="revenue-breakdown-item-header">
                <h4 class="revenue-breakdown-item-title">By Payment Method</h4>
                <span class="revenue-breakdown-item-value">${formatCurrency(total)}</span>
            </div>
            <div class="revenue-breakdown-item-content">
                ${paymentMethodItems.map(item => `
                    <div class="revenue-breakdown-bar-item">
                        <div class="revenue-breakdown-bar-label">
                            <span>${item.method.charAt(0).toUpperCase() + item.method.slice(1)}</span>
                        </div>
                        <div class="revenue-breakdown-bar">
                            <div class="revenue-breakdown-bar-fill" style="width: ${item.percentage}%">
                                ${item.percentage > 10 ? `${item.percentage}%` : ''}
                            </div>
                        </div>
                        <div style="font-size: 12px; color: #495057; margin-top: 4px;">
                            ${formatCurrency(item.revenue)}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

// Update peak hours section
function updatePeakHours(peakHours) {
    const content = document.getElementById('peakHoursContent');
    if (!content) return;
    
    if (!peakHours || peakHours.length === 0) {
        content.innerHTML = '<div class="empty-state" style="text-align: center; padding: 40px; color: #6c757d;">No data available</div>';
        return;
    }
    
    const maxRevenue = Math.max(...peakHours.map(h => h.revenue), 1);
    
    content.innerHTML = peakHours.map(hour => {
        const hourLabel = hour.hour === 0 ? '12 AM' : hour.hour < 12 ? `${hour.hour} AM` : hour.hour === 12 ? '12 PM' : `${hour.hour - 12} PM`;
        const barHeight = (hour.revenue / maxRevenue) * 100;
        return `
            <div class="peak-hour-item">
                <div class="peak-hour-label">${hourLabel}</div>
                <div class="peak-hour-bar-container">
                    <div class="peak-hour-bar" style="height: ${barHeight}%"></div>
                </div>
                <div class="peak-hour-stats">
                    <div class="peak-hour-revenue">${formatCurrency(hour.revenue)}</div>
                    <div class="peak-hour-orders">${hour.orders} orders</div>
                </div>
            </div>
        `;
    }).join('');
}

// Update best days section
function updateBestDays(bestDays) {
    const content = document.getElementById('bestDaysContent');
    if (!content) return;
    
    if (!bestDays || bestDays.length === 0) {
        content.innerHTML = '<div class="empty-state" style="text-align: center; padding: 40px; color: #6c757d;">No data available</div>';
        return;
    }
    
    const maxRevenue = Math.max(...bestDays.map(d => d.revenue), 1);
    
    content.innerHTML = bestDays.map((day, index) => {
        const barWidth = (day.revenue / maxRevenue) * 100;
        const isTop = index === 0;
        return `
            <div class="best-day-item ${isTop ? 'top-day' : ''}">
                <div class="best-day-label">
                    <span>${day.day}</span>
                    ${isTop ? '<span class="top-badge"><i class="fas fa-trophy"></i> Best</span>' : ''}
                </div>
                <div class="best-day-bar-container">
                    <div class="best-day-bar" style="width: ${barWidth}%"></div>
                </div>
                <div class="best-day-stats">
                    <span>${formatCurrency(day.revenue)}</span>
                    <span>${day.orders} orders</span>
                </div>
            </div>
        `;
    }).join('');
}

// Update category performance section
function updateCategoryPerformance(categoryPerformance) {
    const content = document.getElementById('categoryPerformanceContent');
    if (!content) return;
    
    if (!categoryPerformance || categoryPerformance.length === 0) {
        content.innerHTML = '<div class="empty-state" style="text-align: center; padding: 40px; color: #6c757d;">No data available</div>';
        return;
    }
    
    const totalRevenue = categoryPerformance.reduce((sum, cat) => sum + cat.revenue, 0);
    
    content.innerHTML = categoryPerformance.map(cat => {
        const percentage = totalRevenue > 0 ? (cat.revenue / totalRevenue * 100).toFixed(1) : 0;
        return `
            <div class="category-performance-item">
                <div class="category-performance-header">
                    <span class="category-name">${escapeHtml(cat.category)}</span>
                    <span class="category-percentage">${percentage}%</span>
                </div>
                <div class="category-performance-bar">
                    <div class="category-performance-bar-fill" style="width: ${percentage}%"></div>
                </div>
                <div class="category-performance-stats">
                    <span>${formatCurrency(cat.revenue)}</span>
                    <span>${cat.quantity} items</span>
                    <span>${cat.orders} orders</span>
                </div>
            </div>
        `;
    }).join('');
}

// Update low performers section
function updateLowPerformers(lowPerformers) {
    const content = document.getElementById('lowPerformersContent');
    if (!content) return;
    
    if (!lowPerformers || lowPerformers.length === 0) {
        content.innerHTML = '<div class="empty-state" style="text-align: center; padding: 40px; color: #6c757d;">All items performing well!</div>';
        return;
    }
    
    content.innerHTML = lowPerformers.map(item => {
        const statusClass = item.quantity === 0 ? 'zero-sales' : 'low-sales';
        return `
            <div class="low-performer-item ${statusClass}">
                <div class="low-performer-info">
                    <span class="low-performer-name">${escapeHtml(item.name)}</span>
                    <span class="low-performer-category">${escapeHtml(item.category)}</span>
                </div>
                <div class="low-performer-stats">
                    <span class="low-performer-qty">${item.quantity} sold</span>
                    <span class="low-performer-revenue">${formatCurrency(item.revenue)}</span>
                </div>
            </div>
        `;
    }).join('');
}

// Update sales forecast
function updateSalesForecast(forecast) {
    if (!forecast) return;
    
    let forecastSection = document.getElementById('salesForecastSection');
    
    if (!forecastSection) {
        const salesSection = document.getElementById('sales');
        if (salesSection) {
            forecastSection = document.createElement('div');
            forecastSection.id = 'salesForecastSection';
            forecastSection.className = 'sales-forecast-section';
            salesSection.appendChild(forecastSection);
        }
    }
    
    if (forecastSection) {
        const forecastStart = forecast.forecastStart.toLocaleDateString();
        const forecastEnd = forecast.forecastEnd.toLocaleDateString();
        
        forecastSection.innerHTML = `
            <div class="section-header">
                <h3>Sales Forecast</h3>
            </div>
            <div class="forecast-content">
                <div class="forecast-card">
                    <h4>Projected Revenue</h4>
                    <p class="forecast-period">${forecastStart} - ${forecastEnd}</p>
                    <div class="forecast-value">${formatCurrency(forecast.forecastedRevenue)}</div>
                    <p class="forecast-note">Based on historical average</p>
                </div>
                <div class="forecast-details">
                    <div class="forecast-detail">
                        <span>Historical Average:</span>
                        <span>${formatCurrency(forecast.historicalAverage)}</span>
                    </div>
                    <div class="forecast-detail">
                        <span>Historical Total:</span>
                        <span>${formatCurrency(forecast.historicalTotal)}</span>
                    </div>
                </div>
            </div>
        `;
    }
}

// Update sales summary section
function updateSalesSummary(metrics) {
    // Update metrics
    const totalMenuSold = document.getElementById('totalMenuSold');
    const totalRevenue = document.getElementById('totalRevenue');
    const safeAmount = document.getElementById('safeAmount');
    
    if (totalMenuSold) {
        totalMenuSold.textContent = metrics.totalItems.toLocaleString();
    }
    if (totalRevenue) {
        totalRevenue.textContent = formatCurrency(metrics.totalRevenue);
    }
    if (safeAmount) {
        const safe = metrics.totalRevenue * 0.2;
        safeAmount.textContent = formatCurrency(safe);
    }
    
    // Update donut chart
    updateSalesDonutChart(metrics);
}

// Calculate daily sales by category
function calculateDailySalesByCategory(orders, selectedDate) {
    if (!orders || !orders.length) return [];
    
    // Filter orders for the selected date
    const selectedDateStr = selectedDate.toISOString().split('T')[0]; // YYYY-MM-DD
    const dailyOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        
        let orderDate;
        if (order.createdAt) {
            if (order.createdAt.toDate) {
                orderDate = order.createdAt.toDate();
            } else if (order.createdAt instanceof Date) {
                orderDate = order.createdAt;
            } else if (order.createdAt.seconds) {
                orderDate = new Date(order.createdAt.seconds * 1000);
            } else {
                orderDate = new Date(order.createdAt);
            }
        } else {
            return false;
        }
        
        const orderDateStr = orderDate.toISOString().split('T')[0];
        return orderDateStr === selectedDateStr;
    });
    
    if (!dailyOrders.length) return [];
    
    // Group by category
    const categoryStats = {};
    let totalRevenue = 0;
    
    dailyOrders.forEach(order => {
        if (!order.items || !Array.isArray(order.items)) return;
        
        order.items.forEach(item => {
            const itemName = item.name || item.itemName || 'Unknown';
            const itemId = item.itemId || item.id || '';
            const itemPrice = parseFloat(item.price || item.itemPrice || 0);
            const quantity = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
            
            // Find menu item for category
            const menuItem = menuState.find(m => 
                (m.id === itemId || m.menuId === itemId) ||
                (m.name && m.name.toLowerCase() === itemName.toLowerCase())
            );
            
            const category = menuItem?.category || 'Uncategorized';
            const revenue = itemPrice * quantity;
            totalRevenue += revenue;
            
            if (!categoryStats[category]) {
                categoryStats[category] = {
                    category: category,
                    quantity: 0,
                    revenue: 0,
                    topItem: { name: itemName, quantity: 0, revenue: 0 }
                };
            }
            
            categoryStats[category].quantity += quantity;
            categoryStats[category].revenue += revenue;
            
            // Track top item in category
            const itemRevenue = itemPrice * quantity;
            if (itemRevenue > categoryStats[category].topItem.revenue) {
                categoryStats[category].topItem = {
                    name: itemName,
                    quantity: quantity,
                    revenue: itemRevenue
                };
            }
        });
    });
    
    // Convert to array and calculate percentages
    return Object.values(categoryStats)
        .map(stat => ({
            ...stat,
            percentage: totalRevenue > 0 ? (stat.revenue / totalRevenue) * 100 : 0
        }))
        .sort((a, b) => b.revenue - a.revenue);
}

// Calculate daily sales by payment method
function calculateDailySalesByPaymentMethod(orders, selectedDate) {
    if (!orders || !orders.length) return [];
    
    // Filter orders for the selected date
    const selectedDateStr = selectedDate.toISOString().split('T')[0]; // YYYY-MM-DD
    const dailyOrders = orders.filter(order => {
        if (!isOrderPaid(order)) return false;
        
        let orderDate;
        if (order.createdAt) {
            if (order.createdAt.toDate) {
                orderDate = order.createdAt.toDate();
            } else if (order.createdAt instanceof Date) {
                orderDate = order.createdAt;
            } else if (order.createdAt.seconds) {
                orderDate = new Date(order.createdAt.seconds * 1000);
            } else {
                orderDate = new Date(order.createdAt);
            }
        } else {
            return false;
        }
        
        const orderDateStr = orderDate.toISOString().split('T')[0];
        return orderDateStr === selectedDateStr;
    });
    
    if (!dailyOrders.length) return [];
    
    // Group by payment method
    const paymentStats = {};
    let totalRevenue = 0;
    
    dailyOrders.forEach(order => {
        const paymentMethod = (order.paymentMode || 'Unspecified').toLowerCase();
        const orderTotal = parseFloat(order.total || 0);
        totalRevenue += orderTotal;
        
        if (!paymentStats[paymentMethod]) {
            paymentStats[paymentMethod] = {
                method: paymentMethod,
                transactions: 0,
                revenue: 0
            };
        }
        
        paymentStats[paymentMethod].transactions++;
        paymentStats[paymentMethod].revenue += orderTotal;
    });
    
    // Convert to array and calculate percentages and averages
    return Object.values(paymentStats)
        .map(stat => ({
            ...stat,
            percentage: totalRevenue > 0 ? (stat.revenue / totalRevenue) * 100 : 0,
            averageTransaction: stat.transactions > 0 ? stat.revenue / stat.transactions : 0
        }))
        .sort((a, b) => b.revenue - a.revenue);
}

// Calculate daily sales by service type
function calculateDailySalesByServiceType(orders, selectedDate) {
    if (!orders || !orders.length) return [];
    const selectedDateStr = selectedDate.toISOString().split('T')[0];
    const dailyOrders = orders.filter(order => {
        if (!isOrderPaid(order) || !order.createdAt) return false;
        let orderDate;
        if (order.createdAt.toDate) orderDate = order.createdAt.toDate();
        else if (order.createdAt instanceof Date) orderDate = order.createdAt;
        else if (order.createdAt.seconds) orderDate = new Date(order.createdAt.seconds * 1000);
        else orderDate = new Date(order.createdAt);
        return orderDate.toISOString().split('T')[0] === selectedDateStr;
    });
    if (!dailyOrders.length) return [];
    const typeLabels = { 'dine-in': 'Dine-in', 'dinein': 'Dine-in', 'pick-up': 'Pick-up', 'pickup': 'Pick-up', 'pick_up': 'Pick-up', 'take-out': 'Pick-up', 'takeout': 'Pick-up', 'delivery': 'Delivery' };
    const stats = {};
    let totalRevenue = 0;
    let walkInStats = { 'dine-in': { orders: 0, revenue: 0 }, 'pick-up': { orders: 0, revenue: 0 } };
    dailyOrders.forEach(order => {
        // Handle walk-in orders: check walkin flag first, then serviceType
        const isWalkIn = order.walkin === true || order.deliveryInfo?.walkin === true;
        let st = (order.serviceType || order.deliveryInfo?.serviceType || order.deliveryInfo?.deliveryMethod || 'delivery').toLowerCase().trim();
        
        // For walk-in orders, ensure serviceType is properly normalized
        if (isWalkIn) {
            // If walk-in order has take-out, map it to pick-up for consistency
            if (st === 'take-out' || st === 'takeout') {
                st = 'pick-up';
                walkInStats['pick-up'].orders++;
                walkInStats['pick-up'].revenue += parseFloat(order.total || 0);
            }
            // If walk-in order has dine-in, keep it as dine-in
            if (st === 'dine-in' || st === 'dinein') {
                st = 'dine-in';
                walkInStats['dine-in'].orders++;
                walkInStats['dine-in'].revenue += parseFloat(order.total || 0);
            }
        }
        
        const type = st === 'dine-in' || st === 'dinein' ? 'dine-in' : (st === 'pick-up' || st === 'pickup' || st === 'pick_up' || st === 'take-out' || st === 'takeout' ? 'pick-up' : 'delivery');
        const label = typeLabels[type] || type;
        const rev = parseFloat(order.total || 0);
        totalRevenue += rev;
        if (!stats[type]) stats[type] = { type, label, orders: 0, revenue: 0, walkInOrders: 0, walkInRevenue: 0 };
        stats[type].orders++;
        stats[type].revenue += rev;
        if (isWalkIn && (type === 'dine-in' || type === 'pick-up')) {
            stats[type].walkInOrders = (stats[type].walkInOrders || 0) + 1;
            stats[type].walkInRevenue = (stats[type].walkInRevenue || 0) + rev;
        }
    });
    return Object.values(stats)
        .map(s => ({ ...s, percentage: totalRevenue > 0 ? (s.revenue / totalRevenue) * 100 : 0 }))
        .sort((a, b) => b.revenue - a.revenue);
}

// Update daily sales report tables
async function updateDailySalesReport() {
    const dateInput = document.getElementById('dailyReportDate');
    const categoryTableBody = document.getElementById('dailyCategoryTableBody');
    const paymentTableBody = document.getElementById('dailyPaymentTableBody');
    const serviceTypeTableBody = document.getElementById('dailyServiceTypeTableBody');
    const summaryEl = document.getElementById('dailyReportSummaryText');
    
    if (!dateInput || !categoryTableBody || !paymentTableBody) return;
    
    let selectedDate;
    if (dateInput.value) {
        selectedDate = new Date(dateInput.value);
    } else {
        selectedDate = new Date();
        dateInput.value = selectedDate.toISOString().split('T')[0];
    }
    
    if (!ordersState || ordersState.length === 0) await loadOrdersCollectionOnce();
    if (!menuState || menuState.length === 0) await ensureMenuStateLoaded();
    
    const categoryData = calculateDailySalesByCategory(ordersState, selectedDate);
    const paymentData = calculateDailySalesByPaymentMethod(ordersState, selectedDate);
    const serviceTypeData = calculateDailySalesByServiceType(ordersState, selectedDate);
    
    // Day summary
    const dayRevenue = paymentData.reduce((s, p) => s + p.revenue, 0);
    const dayOrders = paymentData.reduce((s, p) => s + p.transactions, 0);
    if (summaryEl) {
        const d = selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
        summaryEl.textContent = dayOrders === 0 && dayRevenue === 0
            ? 'No sales for this date'
            : `${d}: ${dayOrders} orders · ${formatCurrency(dayRevenue)}`;
    }
    
    // Category table
    if (categoryData.length === 0) {
        categoryTableBody.innerHTML = '<tr><td colspan="5" class="empty-table">No sales data for selected date</td></tr>';
    } else {
        categoryTableBody.innerHTML = categoryData.map(stat => `
            <tr>
                <td>${escapeHtml(stat.category)}</td>
                <td>${stat.quantity}</td>
                <td>${formatCurrency(stat.revenue)}</td>
                <td>${stat.percentage.toFixed(2)}%</td>
                <td>${escapeHtml(stat.topItem.name)} (${stat.topItem.quantity} sold)</td>
            </tr>
        `).join('');
    }
    
    // Payment method table
    if (paymentData.length === 0) {
        paymentTableBody.innerHTML = '<tr><td colspan="5" class="empty-table">No sales data for selected date</td></tr>';
    } else {
        paymentTableBody.innerHTML = paymentData.map(stat => `
            <tr>
                <td>${escapeHtml(stat.method.charAt(0).toUpperCase() + stat.method.slice(1))}</td>
                <td>${stat.transactions}</td>
                <td>${formatCurrency(stat.revenue)}</td>
                <td>${stat.percentage.toFixed(2)}%</td>
                <td>${formatCurrency(stat.averageTransaction)}</td>
            </tr>
        `).join('');
    }
    
    // Service type table
    if (serviceTypeTableBody) {
        if (serviceTypeData.length === 0) {
            serviceTypeTableBody.innerHTML = '<tr><td colspan="4" class="empty-table">No sales data for selected date</td></tr>';
        } else {
            serviceTypeTableBody.innerHTML = serviceTypeData.map(stat => {
                const walkInInfo = (stat.walkInOrders > 0 || stat.walkInRevenue > 0) 
                    ? ` <span style="color: #7E2021; font-weight: 600; font-size: 12px;">(${stat.walkInOrders} walk-in: ${formatCurrency(stat.walkInRevenue)})</span>`
                    : '';
                return `
                <tr>
                    <td>${escapeHtml(stat.label)}${walkInInfo}</td>
                    <td>${stat.orders}</td>
                    <td>${formatCurrency(stat.revenue)}</td>
                    <td>${stat.percentage.toFixed(2)}%</td>
                </tr>
            `;
            }).join('');
        }
    }
}

// Update sales donut chart – Revenue by service type (dine-in, pick-up, delivery)
function updateSalesDonutChart(metrics) {
    const donutChart = document.getElementById('salesDonutChart');
    if (!donutChart) return;
    
    const revenue = metrics.totalRevenue;
    const byType = metrics.revenueByServiceType || {};
    const segments = [
        { key: 'dine-in', label: 'Dine-in', value: byType['dine-in'] || 0, color: '#7E2021' },
        { key: 'pick-up', label: 'Pick-up', value: byType['pick-up'] || 0, color: '#f6c056' },
        { key: 'delivery', label: 'Delivery', value: byType['delivery'] || 0, color: '#2d8c6f' }
    ].filter(s => s.value > 0);
    
    const radius = 80;
    const circumference = 2 * Math.PI * radius;
    const total = segments.reduce((s, x) => s + x.value, 0) || 1;
    
    let offset = 0;
    const circles = segments.map(s => {
        const pct = (s.value / total) * 100;
        const arc = (pct / 100) * circumference;
        const dashOffset = -offset;
        offset += arc;
        return `<circle cx="100" cy="100" r="${radius}" fill="none" stroke="${s.color}" stroke-width="20" 
            stroke-dasharray="${arc} ${circumference}" stroke-dashoffset="${dashOffset}" 
            transform="rotate(-90 100 100)"/>`;
    }).join('');
    
    donutChart.innerHTML = `
        <svg viewBox="0 0 200 200">
            <circle cx="100" cy="100" r="${radius}" fill="none" stroke="#e9ecef" stroke-width="20"/>
            ${circles}
        </svg>
        <div class="donut-chart-center">
            <div class="donut-chart-center-value">${formatCurrency(revenue)}</div>
            <div class="donut-chart-center-label">Revenue by channel</div>
        </div>
    `;
}

// Calculate loyal customers
function calculateLoyalCustomers(orders, limit = 4) {
    if (!orders || !Array.isArray(orders)) return [];
    
    const customerStats = {};
    
    orders.forEach(order => {
        if (!isOrderPaid(order)) return;
        
        const userId = order.userId || order.customerId;
        if (!userId) return;
        
        if (!customerStats[userId]) {
            customerStats[userId] = {
                userId: userId,
                orderCount: 0,
                totalSpent: 0,
                displayName: order.customerName || order.userName || 'Unknown Customer'
            };
        }
        
        customerStats[userId].orderCount++;
        customerStats[userId].totalSpent += parseFloat(order.total || 0);
    });
    
    // Convert to array and sort by order count
    return Object.values(customerStats)
        .sort((a, b) => b.orderCount - a.orderCount)
        .slice(0, limit);
}

// Update loyal customers section
function updateLoyalCustomers(loyalCustomers) {
    const loyalCustomersContent = document.getElementById('loyalCustomersContent');
    if (!loyalCustomersContent) return;
    
    if (loyalCustomers.length === 0) {
        loyalCustomersContent.innerHTML = '<div class="empty-state" style="text-align: center; padding: 40px; color: #6c757d;">No customer data available</div>';
        return;
    }
    
    loyalCustomersContent.innerHTML = loyalCustomers.map(customer => {
        const initials = customer.displayName
            .split(' ')
            .map(n => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2);
        
        return `
            <div class="loyal-customer-item">
                <div class="loyal-customer-avatar">${initials}</div>
                <div class="loyal-customer-info">
                    <h4 class="loyal-customer-name">${escapeHtml(customer.displayName)}</h4>
                    <p class="loyal-customer-orders">${customer.orderCount} orders · ${formatCurrency(customer.totalSpent || 0)}</p>
                </div>
            </div>
        `;
    }).join('');
}

// Update best seller section
function updateBestSeller(mostOrdered) {
    const bestSellerContent = document.getElementById('bestSellerContent');
    if (!bestSellerContent) return;
    
    if (mostOrdered.length === 0) {
        bestSellerContent.innerHTML = '<div class="empty-state" style="text-align: center; padding: 40px; color: #6c757d;">No sales data available</div>';
        return;
    }
    
    const bestSeller = mostOrdered[0];
    
    // Find menu item for image
    const menuItem = menuState.find(m => 
        (m.id === bestSeller.menuId || m.menuId === bestSeller.menuId) ||
        (m.name && m.name.toLowerCase() === bestSeller.name.toLowerCase())
    );
    const imageUrl = getMenuItemImage(menuItem);
    
    // Calculate sales bar heights based on quantity (normalized to max 40px)
    const maxQuantity = mostOrdered.length > 1 ? mostOrdered[0].quantity : bestSeller.quantity;
    const bar1Height = maxQuantity > 0 ? Math.max(15, (bestSeller.quantity / maxQuantity) * 30) : 20;
    const bar2Height = maxQuantity > 0 ? Math.max(15, (bestSeller.quantity / maxQuantity) * 25) : 25;
    const bar3Height = maxQuantity > 0 ? Math.max(15, (bestSeller.quantity / maxQuantity) * 35) : 30;
    
    bestSellerContent.innerHTML = `
        <div class="best-seller-content">
            <div class="best-seller-image" style="${imageUrl ? `background-image: url('${escapeHtml(imageUrl)}'); background-size: cover; background-position: center;` : ''}">
                ${!imageUrl ? '<i class="fas fa-utensils"></i>' : ''}
            </div>
            <div class="best-seller-info">
                <h3 class="best-seller-name">${escapeHtml(bestSeller.name)}</h3>
                <p class="best-seller-price">${formatCurrency(bestSeller.price)}</p>
                <div class="best-seller-stats">
                    <div class="best-seller-likes">
                        <i class="fas fa-heart"></i>
                        <span>${bestSeller.quantity.toLocaleString()}</span>
                    </div>
                    <div class="best-seller-sales">
                        <div class="best-seller-sales-bars">
                            <div class="best-seller-sales-bar" style="height: ${bar1Height}px;"></div>
                            <div class="best-seller-sales-bar" style="height: ${bar2Height}px;"></div>
                            <div class="best-seller-sales-bar" style="height: ${bar3Height}px;"></div>
                        </div>
                        <span class="best-seller-sales-count">${bestSeller.quantity.toLocaleString()}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Update in-depth view table
function updateInDepthViewTable(mostOrdered) {
    const tableBody = document.getElementById('inDepthTableBody');
    if (!tableBody) return;
    
    if (mostOrdered.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No sales data available for this period</td></tr>';
        return;
    }
    
    tableBody.innerHTML = mostOrdered.map(item => {
        return `
            <tr>
                <td>${escapeHtml(item.menuId || item.id || '—')}</td>
                <td>${escapeHtml(item.name)}</td>
                <td>${escapeHtml(item.category)}</td>
                <td>${item.quantity}</td>
                <td>${formatCurrency(item.price)}</td>
                <td>${formatCurrency(item.revenue)}</td>
            </tr>
        `;
    }).join('');
}

// Initialize sales page
async function initSalesPage() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    
    // Initialize daily sales report date picker to today
    const dailyReportDate = document.getElementById('dailyReportDate');
    if (dailyReportDate && !dailyReportDate.value) {
        const today = new Date();
        dailyReportDate.value = today.toISOString().split('T')[0];
    }
    
    // Load orders if not already loaded
    if (!ordersState || ordersState.length === 0) {
        await loadOrdersCollectionOnce();
    }
    
    // Load menu if not already loaded
    if (!menuState || menuState.length === 0) {
        await refreshMenuState();
    }
    
    // Initialize period selector
    const periodSelect = document.getElementById('summaryPeriodSelect');
    if (periodSelect) {
        periodSelect.value = currentReportPeriod;
        periodSelect.addEventListener('change', (e) => {
            switchReport(e.target.value);
        });
    }
    
    // Initial report update
    updateSalesReport();
    
    // Initialize daily sales report with today's date
    updateDailySalesReport();
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

async function exportReport() {
    try {
        if (!ordersState || ordersState.length === 0) {
            await loadOrdersCollectionOnce();
        }
        
        const metrics = calculateSalesMetrics(ordersState, currentReportPeriod);
        const mostOrdered = calculateMostOrderedItems(ordersState, currentReportPeriod, 100);
        
        // Create CSV content
        let csv = `Sales Report - ${currentReportPeriod.charAt(0).toUpperCase() + currentReportPeriod.slice(1)}\n`;
        csv += `Period: ${formatDateRangeLabel(currentReportPeriod)}\n`;
        csv += `Generated: ${new Date().toLocaleString()}\n\n`;
        
        // Summary
        csv += `SUMMARY\n`;
        csv += `Total Revenue,${formatCurrency(metrics.totalRevenue).replace('₱', '')}\n`;
        csv += `Total Orders,${metrics.totalOrders}\n`;
        csv += `Average Order Value,${formatCurrency(metrics.averageOrderValue).replace('₱', '')}\n`;
        csv += `Average Items Per Order,${metrics.averageItemsPerOrder.toFixed(2)}\n\n`;
        
        // Revenue by Service Type
        csv += `REVENUE BY SERVICE TYPE\n`;
        csv += `Service Type,Revenue,Orders,Percentage\n`;
        Object.entries(metrics.revenueByServiceType).forEach(([type, revenue]) => {
            if (revenue > 0) {
                const percentage = metrics.totalRevenue > 0 ? (revenue / metrics.totalRevenue * 100).toFixed(2) : 0;
                const orderCount = metrics.orderCountByServiceType[type] || 0;
                csv += `${type},${formatCurrency(revenue).replace('₱', '')},${orderCount},${percentage}%\n`;
            }
        });
        csv += `\n`;
        
        // Revenue by Payment Method
        csv += `REVENUE BY PAYMENT METHOD\n`;
        csv += `Payment Method,Revenue,Percentage\n`;
        Object.entries(metrics.revenueByPaymentMethod)
            .sort(([_, a], [__, b]) => b - a)
            .forEach(([method, revenue]) => {
                if (revenue > 0) {
                    const percentage = metrics.totalRevenue > 0 ? (revenue / metrics.totalRevenue * 100).toFixed(2) : 0;
                    csv += `${method},${formatCurrency(revenue).replace('₱', '')},${percentage}%\n`;
                }
            });
        csv += `\n`;
        
        // Most Ordered Items
        csv += `MOST ORDERED ITEMS\n`;
        csv += `Rank,Item Name,Category,Quantity Sold,Price,Total Revenue\n`;
        mostOrdered.forEach((item, index) => {
            csv += `${index + 1},"${item.name}",${item.category},${item.quantity},${formatCurrency(item.price).replace('₱', '')},${formatCurrency(item.revenue).replace('₱', '')}\n`;
        });
        
        // Create download
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `sales_report_${currentReportPeriod}_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        showNotification('Sales report exported successfully!', 'success');
    } catch (error) {
        console.error('Error exporting sales report:', error);
        showNotification('Failed to export sales report. Please try again.', 'error');
    }
}

async function exportReportAsPDF() {
    try {
        if (typeof window.jspdf === 'undefined') {
            showNotification('PDF library not loaded. Please refresh the page.', 'error');
            return;
        }

        if (!ordersState || ordersState.length === 0) {
            await loadOrdersCollectionOnce();
        }
        
        const metrics = calculateSalesMetrics(ordersState, currentReportPeriod);
        const mostOrdered = calculateMostOrderedItems(ordersState, currentReportPeriod, 100);
        const comparison = calculatePeriodComparison(ordersState, currentReportPeriod);
        
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
        });
        
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        let yPos = 20;
        const margin = 15;
        const lineHeight = 7;
        const sectionSpacing = 10;
        
        // Helper function to add a new page if needed
        const checkNewPage = (requiredSpace = 20) => {
            if (yPos + requiredSpace > pageHeight - margin) {
                doc.addPage();
                yPos = margin;
                return true;
            }
            return false;
        };
        
        // Header
        doc.setFontSize(20);
        doc.setFont(undefined, 'bold');
        doc.text('Sales Report', margin, yPos);
        yPos += lineHeight;
        
        doc.setFontSize(11);
        doc.setFont(undefined, 'normal');
        doc.text(`${currentReportPeriod.charAt(0).toUpperCase() + currentReportPeriod.slice(1)} Report`, margin, yPos);
        yPos += lineHeight;
        doc.text(`Period: ${formatDateRangeLabel(currentReportPeriod)}`, margin, yPos);
        yPos += lineHeight;
        doc.text(`Generated: ${new Date().toLocaleString()}`, margin, yPos);
        yPos += sectionSpacing * 1.5;
        
        // Summary Section
        checkNewPage(30);
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('Summary', margin, yPos);
        yPos += lineHeight * 1.5;
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        const summaryData = [
            ['Total Revenue', formatCurrency(metrics.totalRevenue)],
            ['Total Orders', metrics.totalOrders.toString()],
            ['Average Order Value', formatCurrency(metrics.averageOrderValue)],
            ['Average Items Per Order', metrics.averageItemsPerOrder.toFixed(2)],
            ['Total Items Sold', metrics.totalItems.toString()]
        ];
        
        if (comparison && (comparison.pctRevenue !== 0 || comparison.pctOrders !== 0)) {
            summaryData.push(['vs Prior Period', `${comparison.pctRevenue >= 0 ? '+' : ''}${comparison.pctRevenue.toFixed(1)}%`]);
        }
        
        summaryData.forEach(([label, value]) => {
            doc.setFont(undefined, 'bold');
            doc.text(label + ':', margin, yPos);
            doc.setFont(undefined, 'normal');
            doc.text(value, margin + 60, yPos);
            yPos += lineHeight;
        });
        yPos += sectionSpacing;
        
        // Revenue by Service Type
        checkNewPage(30);
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('Revenue by Service Type', margin, yPos);
        yPos += lineHeight * 1.5;
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'bold');
        doc.text('Service Type', margin, yPos);
        doc.text('Revenue', margin + 60, yPos);
        doc.text('Orders', margin + 100, yPos);
        doc.text('%', margin + 130, yPos);
        yPos += lineHeight;
        
        doc.setFont(undefined, 'normal');
        Object.entries(metrics.revenueByServiceType).forEach(([type, revenue]) => {
            if (revenue > 0) {
                const percentage = metrics.totalRevenue > 0 ? (revenue / metrics.totalRevenue * 100).toFixed(1) : 0;
                const orderCount = metrics.orderCountByServiceType[type] || 0;
                const typeLabel = type === 'dine-in' ? 'Dine-in' : (type === 'pick-up' ? 'Pick-up' : 'Delivery');
                doc.text(typeLabel, margin, yPos);
                doc.text(formatCurrency(revenue), margin + 60, yPos);
                doc.text(orderCount.toString(), margin + 100, yPos);
                doc.text(percentage + '%', margin + 130, yPos);
                yPos += lineHeight;
            }
        });
        yPos += sectionSpacing;
        
        // Revenue by Payment Method
        checkNewPage(30);
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('Revenue by Payment Method', margin, yPos);
        yPos += lineHeight * 1.5;
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'bold');
        doc.text('Payment Method', margin, yPos);
        doc.text('Revenue', margin + 60, yPos);
        doc.text('%', margin + 100, yPos);
        yPos += lineHeight;
        
        doc.setFont(undefined, 'normal');
        Object.entries(metrics.revenueByPaymentMethod)
            .sort(([_, a], [__, b]) => b - a)
            .forEach(([method, revenue]) => {
                if (revenue > 0) {
                    const percentage = metrics.totalRevenue > 0 ? (revenue / metrics.totalRevenue * 100).toFixed(1) : 0;
                    const methodLabel = method.charAt(0).toUpperCase() + method.slice(1);
                    doc.text(methodLabel, margin, yPos);
                    doc.text(formatCurrency(revenue), margin + 60, yPos);
                    doc.text(percentage + '%', margin + 100, yPos);
                    yPos += lineHeight;
                }
            });
        yPos += sectionSpacing;
        
        // Most Ordered Items
        checkNewPage(40);
        doc.setFontSize(14);
        doc.setFont(undefined, 'bold');
        doc.text('Most Ordered Items', margin, yPos);
        yPos += lineHeight * 1.5;
        
        doc.setFontSize(9);
        doc.setFont(undefined, 'bold');
        doc.text('Rank', margin, yPos);
        doc.text('Item Name', margin + 10, yPos);
        doc.text('Category', margin + 70, yPos);
        doc.text('Qty', margin + 100, yPos);
        doc.text('Price', margin + 110, yPos);
        doc.text('Revenue', margin + 140, yPos);
        yPos += lineHeight;
        
        doc.setFont(undefined, 'normal');
        const maxItems = Math.min(mostOrdered.length, 30); // Limit to 30 items per page
        for (let i = 0; i < maxItems; i++) {
            checkNewPage(10);
            const item = mostOrdered[i];
            const itemName = item.name.length > 25 ? item.name.substring(0, 22) + '...' : item.name;
            doc.text((i + 1).toString(), margin, yPos);
            doc.text(itemName, margin + 10, yPos);
            doc.text(item.category || '—', margin + 70, yPos);
            doc.text(item.quantity.toString(), margin + 100, yPos);
            doc.text(formatCurrency(item.price), margin + 110, yPos);
            doc.text(formatCurrency(item.revenue), margin + 140, yPos);
            yPos += lineHeight;
        }
        
        // Footer on last page
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setFont(undefined, 'italic');
            doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin - 20, pageHeight - 10);
            doc.text('Pablo\'s Peri Peri - Sales Report', margin, pageHeight - 10);
        }
        
        // Save PDF
        const fileName = `sales_report_${currentReportPeriod}_${new Date().toISOString().split('T')[0]}.pdf`;
        doc.save(fileName);
        
        showNotification('PDF exported successfully!', 'success');
    } catch (error) {
        console.error('Error exporting PDF:', error);
        showNotification('Failed to export PDF. Please try again.', 'error');
    }
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

// exportReport: real implementation is the async function above (CSV download)

// exportInventoryReport removed - system is now recipe-based

// initInventoryManagement removed - system is now recipe-based
// Ingredient logs can still be initialized separately if needed
async function initInventoryManagement() {
    // Recipe-based system: no inventory management needed
    // Initialize ingredient logs if the UI exists
    const logsSection = document.getElementById('ingredientLogsSection');
    if (logsSection) {
        initIngredientLogs();
    }
}

// ============================================================================
// INGREDIENT LOGS UI FUNCTIONS
// ============================================================================

let ingredientLogsUnsubscribe = null;
let ingredientLogsState = [];

// Initialize ingredient logs
async function initIngredientLogs() {
    const logsTableBody = document.getElementById('ingredientLogsTableBody');
    if (!logsTableBody) return; // Logs table not on this page
    
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    
    const fns = window.firestoreFunctions;
    if (!fns || !window.db) return;
    
    // Initialize date filter (optional - leave empty to show all dates)
    const dateInput = document.getElementById('ingredientLogDateFilter');
    if (dateInput) {
        // Leave empty by default to show all logs
        dateInput.value = '';
    }
    
    // Subscribe to real-time logs
    const logsCol = fns.collection(window.db, 'ingredientLogs');
    const logsQuery = fns.query(logsCol, fns.orderBy('timestamp', 'desc'), fns.limit(200));
    
    if (typeof fns.onSnapshot === 'function') {
        if (typeof ingredientLogsUnsubscribe === 'function') {
            ingredientLogsUnsubscribe();
        }
        
        ingredientLogsUnsubscribe = fns.onSnapshot(
            logsQuery,
            (snapshot) => {
                ingredientLogsState = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
                // Apply current filters
                const ingredientSelect = document.getElementById('ingredientLogFilter');
                const dateInput = document.getElementById('ingredientLogDateFilter');
                const typeSelect = document.getElementById('ingredientLogTypeFilter');
                const searchInput = document.getElementById('ingredientLogSearch');
                const ingredientId = ingredientSelect ? ingredientSelect.value || null : null;
                const filterDate = dateInput && dateInput.value ? dateInput.value : null;
                const filterType = typeSelect ? typeSelect.value || null : null;
                const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : null;
                renderIngredientLogs(ingredientId, filterDate, filterType, searchTerm);
                updateIngredientLogFilter();
            },
            (error) => {
                console.error('Error subscribing to ingredient logs:', error);
            }
        );
    }
}

// Current sort state
let ingredientLogsSortColumn = 'timestamp';
let ingredientLogsSortDirection = 'desc';

// Render ingredient logs table
function renderIngredientLogs(filterIngredientId = null, filterDate = null, filterType = null, searchTerm = null) {
    const tableBody = document.getElementById('ingredientLogsTableBody');
    if (!tableBody) return;
    
    let logsToShow = [...ingredientLogsState];
    
    // Filter by ingredient
    if (filterIngredientId) {
        logsToShow = logsToShow.filter(log => log.ingredientId === filterIngredientId);
    }
    
    // Filter by date
    if (filterDate) {
        const filterDateStr = filterDate; // YYYY-MM-DD format
        logsToShow = logsToShow.filter(log => {
            const logDate = log.date || (log.timestamp?.toDate ? log.timestamp.toDate().toISOString().split('T')[0] : new Date(log.timestamp).toISOString().split('T')[0]);
            return logDate === filterDateStr;
        });
    }
    
    // Filter by type
    if (filterType) {
        logsToShow = logsToShow.filter(log => log.type === filterType);
    }
    
    // Filter by search term
    if (searchTerm) {
        logsToShow = logsToShow.filter(log => {
            const ingredientName = (log.ingredientName || log.ingredientId || '').toLowerCase();
            const orderId = (log.orderId || '').toLowerCase();
            const menuItem = (log.menuItemName || '').toLowerCase();
            return ingredientName.includes(searchTerm) || 
                   orderId.includes(searchTerm) || 
                   menuItem.includes(searchTerm);
        });
    }
    
    // Sort logs
    logsToShow.sort((a, b) => {
        let aVal, bVal;
        
        switch (ingredientLogsSortColumn) {
            case 'timestamp':
                aVal = a.timestamp?.toDate ? a.timestamp.toDate().getTime() : new Date(a.timestamp).getTime();
                bVal = b.timestamp?.toDate ? b.timestamp.toDate().getTime() : new Date(b.timestamp).getTime();
                break;
            case 'ingredient':
                aVal = (a.ingredientName || a.ingredientId || '').toLowerCase();
                bVal = (b.ingredientName || b.ingredientId || '').toLowerCase();
                break;
            case 'type':
                aVal = a.type || '';
                bVal = b.type || '';
                break;
            case 'amount':
                aVal = Number(a.amount || 0);
                bVal = Number(b.amount || 0);
                break;
            default:
                return 0;
        }
        
        if (ingredientLogsSortColumn === 'timestamp' || ingredientLogsSortColumn === 'amount') {
            return ingredientLogsSortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        } else {
            if (aVal < bVal) return ingredientLogsSortDirection === 'asc' ? -1 : 1;
            if (aVal > bVal) return ingredientLogsSortDirection === 'asc' ? 1 : -1;
            return 0;
        }
    });
    
    // Update summary statistics
    updateIngredientLogsSummary(logsToShow);
    
    if (logsToShow.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="empty-table">No logs match the current filters.</td></tr>';
        return;
    }
    
    tableBody.innerHTML = logsToShow.map(log => {
        const timestamp = log.timestamp?.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
        const timeStr = timestamp.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        const typeClass = log.type === 'received' ? 'text-success' : 'text-danger';
        const typeIcon = log.type === 'received' ? 'fa-arrow-down' : 'fa-arrow-up';
        const typeLabel = log.type === 'received' ? 'Received' : 'Used';
        
        const amount = Number(log.amount || 0);
        const amountStr = amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
        
        const orderInfo = log.orderId 
            ? `Order: ${log.orderId}${log.menuItemName ? ` (${log.menuItemName})` : ''}`
            : (log.menuItemName || '—');
        
        return `
            <tr>
                <td>${escapeHtml(timeStr)}</td>
                <td>${escapeHtml(log.ingredientName || log.ingredientId || 'Unknown')}</td>
                <td style="text-align: center;"><span class="${typeClass}"><i class="fas ${typeIcon}"></i> ${typeLabel}</span></td>
                <td style="text-align: right; font-weight: 600;">${amountStr}</td>
                <td>${escapeHtml(orderInfo)}</td>
            </tr>
        `;
    }).join('');
    
    // Update sort icons
    updateSortIcons();
}

// Update summary statistics
function updateIngredientLogsSummary(logs) {
    const summarySection = document.getElementById('ingredientLogsSummary');
    const totalUsedEl = document.getElementById('totalUsed');
    const totalReceivedEl = document.getElementById('totalReceived');
    const netUsageEl = document.getElementById('netUsage');
    
    if (!summarySection) return;
    
    let totalUsed = 0;
    let totalReceived = 0;
    
    logs.forEach(log => {
        const amount = Number(log.amount || 0);
        if (log.type === 'used') {
            totalUsed += amount;
        } else if (log.type === 'received') {
            totalReceived += amount;
        }
    });
    
    const netUsage = totalReceived - totalUsed;
    
    if (totalUsedEl) totalUsedEl.textContent = totalUsed.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (totalReceivedEl) totalReceivedEl.textContent = totalReceived.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (netUsageEl) {
        netUsageEl.textContent = netUsage.toLocaleString('en-US', { maximumFractionDigits: 2 });
        netUsageEl.className = 'summary-value ' + (netUsage >= 0 ? 'positive' : 'negative');
    }
    
    // Show summary if there are logs
    summarySection.style.display = logs.length > 0 ? 'flex' : 'none';
}

// Sort ingredient logs
function sortIngredientLogs(column) {
    if (ingredientLogsSortColumn === column) {
        // Toggle direction if same column
        ingredientLogsSortDirection = ingredientLogsSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        // New column, default to desc for timestamp/amount, asc for text
        ingredientLogsSortColumn = column;
        ingredientLogsSortDirection = (column === 'timestamp' || column === 'amount') ? 'desc' : 'asc';
    }
    
    // Get current filter values and re-render
    const ingredientSelect = document.getElementById('ingredientLogFilter');
    const dateInput = document.getElementById('ingredientLogDateFilter');
    const typeSelect = document.getElementById('ingredientLogTypeFilter');
    const searchInput = document.getElementById('ingredientLogSearch');
    
    const ingredientId = ingredientSelect ? ingredientSelect.value || null : null;
    const filterDate = dateInput && dateInput.value ? dateInput.value : null;
    const filterType = typeSelect ? typeSelect.value || null : null;
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : null;
    
    renderIngredientLogs(ingredientId, filterDate, filterType, searchTerm);
}

// Update sort icons
function updateSortIcons() {
    // Reset all icons
    document.querySelectorAll('.sort-icon').forEach(icon => {
        icon.className = 'fas fa-sort sort-icon';
    });
    
    // Update active column icon
    const activeIcon = document.getElementById(`sortIcon-${ingredientLogsSortColumn}`);
    if (activeIcon) {
        activeIcon.className = `fas fa-sort-${ingredientLogsSortDirection === 'asc' ? 'up' : 'down'} sort-icon active`;
    }
}

// Update filter dropdown
function updateIngredientLogFilter() {
    const filterSelect = document.getElementById('ingredientLogFilter');
    if (!filterSelect) return;
    
    const uniqueIngredients = [...new Map(ingredientLogsState.map(log => [
        log.ingredientId,
        { id: log.ingredientId, name: log.ingredientName || log.ingredientId }
    ])).values()];
    
    const currentValue = filterSelect.value;
    filterSelect.innerHTML = '<option value="">All Ingredients</option>' +
        uniqueIngredients.map(ing => 
            `<option value="${escapeHtml(ing.id)}">${escapeHtml(ing.name)}</option>`
        ).join('');
    
    if (currentValue) {
        filterSelect.value = currentValue;
    }
}

// Filter logs by ingredient, date, type, and search term
function filterIngredientLogs() {
    const ingredientSelect = document.getElementById('ingredientLogFilter');
    const dateInput = document.getElementById('ingredientLogDateFilter');
    const typeSelect = document.getElementById('ingredientLogTypeFilter');
    const searchInput = document.getElementById('ingredientLogSearch');
    
    const ingredientId = ingredientSelect ? ingredientSelect.value || null : null;
    const filterDate = dateInput && dateInput.value ? dateInput.value : null;
    const filterType = typeSelect ? typeSelect.value || null : null;
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : null;
    
    renderIngredientLogs(ingredientId, filterDate, filterType, searchTerm);
}

// Clear all filters
function clearIngredientLogFilters() {
    const ingredientSelect = document.getElementById('ingredientLogFilter');
    const dateInput = document.getElementById('ingredientLogDateFilter');
    const typeSelect = document.getElementById('ingredientLogTypeFilter');
    const searchInput = document.getElementById('ingredientLogSearch');
    
    if (ingredientSelect) ingredientSelect.value = '';
    if (dateInput) dateInput.value = '';
    if (typeSelect) typeSelect.value = '';
    if (searchInput) searchInput.value = '';
    
    filterIngredientLogs();
}

// Export logs
async function exportIngredientLogs() {
    try {
        const logs = ingredientLogsState.length > 0 
            ? ingredientLogsState 
            : await IngredientLogStore.getLogs();
        
        if (!logs || logs.length === 0) {
            showNotification('No logs available to export.', 'info');
            return;
        }
        
        const csv = [
            ['Timestamp', 'Ingredient', 'Type', 'Amount', 'Order ID', 'Menu Item'].join(','),
            ...logs.map(log => {
                const timestamp = log.timestamp?.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
                return [
                    timestamp.toISOString(),
                    `"${log.ingredientName || log.ingredientId || ''}"`,
                    log.type || '',
                    log.amount || 0,
                    log.orderId || '',
                    `"${log.menuItemName || ''}"`
                ].join(',');
            })
        ].join('\n');
        
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ingredient_logs_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showNotification('Ingredient logs exported successfully!', 'success');
    } catch (error) {
        console.error('Export ingredient logs failed:', error);
        showNotification(error.message || 'Unable to export ingredient logs.', 'error');
    }
}

// Expose functions globally
window.filterIngredientLogs = filterIngredientLogs;
window.exportIngredientLogs = exportIngredientLogs;
window.clearIngredientLogFilters = clearIngredientLogFilters;
window.sortIngredientLogs = sortIngredientLogs;

// Inventory functions removed - system is now recipe-based

// handleInventoryFormSubmit removed - system is now recipe-based

// Inventory UI functions removed - system is now recipe-based

async function checkAndDeactivateExpiredMenuItems() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    
    if (!menuState || !menuState.length) {
        console.log('[Expiration Check] No menu items to check');
        return;
    }
    
    const fns = window.firestoreFunctions;
    if (!fns || !fns.Timestamp) {
        console.warn('[Expiration Check] Firestore Timestamp not available');
        return;
    }
    
    const now = fns.Timestamp.now();
    const nowDate = now.toDate();
    console.log('[Expiration Check] Current time:', nowDate.toISOString());
    
    const expiredItems = [];
    let itemsChecked = 0;
    let itemsWithEndDate = 0;
    
    // Check each menu item for expired limitedEndDate
    for (const item of menuState) {
        itemsChecked++;
        
        if (!item.limitedEndDate) {
            continue; // No end date set, skip
        }
        
        itemsWithEndDate++;
        
        // Skip if already archived or deleted
        if (item.isDeleted === true) {
            continue;
        }
        
        // Convert limitedEndDate to Timestamp if it's not already
        const endDate = item.limitedEndDate;
        let endDateTimestamp = null;
        
        try {
            // Try different timestamp formats
            if (endDate && typeof endDate.toDate === 'function') {
                // It's already a Firestore Timestamp
                endDateTimestamp = endDate;
            } else if (endDate && endDate.seconds !== undefined) {
                // It's a Timestamp object with seconds property
                if (endDate.nanoseconds !== undefined) {
                    endDateTimestamp = fns.Timestamp.fromMillis(endDate.seconds * 1000 + Math.floor(endDate.nanoseconds / 1000000));
                } else {
                    endDateTimestamp = fns.Timestamp.fromMillis(endDate.seconds * 1000);
                }
            } else if (endDate && endDate._seconds !== undefined) {
                // Alternative timestamp format
                const seconds = endDate._seconds || endDate.seconds;
                const nanoseconds = endDate._nanoseconds || endDate.nanoseconds || 0;
                endDateTimestamp = fns.Timestamp.fromMillis(seconds * 1000 + Math.floor(nanoseconds / 1000000));
            } else if (endDate) {
                // Try to convert from Date or other format
                const date = endDate.toDate ? endDate.toDate() : new Date(endDate);
                if (!isNaN(date.getTime())) {
                    endDateTimestamp = fns.Timestamp.fromDate(date);
                }
            }
            
            if (!endDateTimestamp) {
                console.warn('[Expiration Check] Could not parse limitedEndDate for item:', item.id, item.name, 'Raw value:', endDate, 'Type:', typeof endDate);
                continue;
            }
            
            const endDateObj = endDateTimestamp.toDate();
            const endMillis = endDateTimestamp.toMillis();
            const nowMillis = now.toMillis();
            const comparison = endMillis - nowMillis; // Positive if future, negative if past
            
            console.log(`[Expiration Check] Item "${item.name}" (${item.id}): End date: ${endDateObj.toISOString()}, Now: ${now.toDate().toISOString()}, Diff (ms): ${comparison}, isActive: ${item.isActive}`);
            
            // Check if end date has passed (comparison <= 0 means endDate <= now)
            if (comparison <= 0) {
                // End date has passed or is exactly now
                if (item.isActive !== false) {
                    // Item is still active, needs to be archived
                    console.log(`[Expiration Check] Item "${item.name}" is expired and still active - will archive`);
                    expiredItems.push(item);
                } else {
                    console.log(`[Expiration Check] Item "${item.name}" is expired but already inactive`);
                }
            } else {
                console.log(`[Expiration Check] Item "${item.name}" is not yet expired (${Math.ceil((endDateTimestamp.toMillis() - now.toMillis()) / 1000 / 60)} minutes remaining)`);
            }
        } catch (e) {
            console.error('[Expiration Check] Error checking limitedEndDate for item:', item.id, item.name, e);
            continue;
        }
    }
    
    console.log(`[Expiration Check] Checked ${itemsChecked} items, ${itemsWithEndDate} have end dates, ${expiredItems.length} are expired`);
    
    // Archive expired items (this will move them to menuArchives)
    if (expiredItems.length > 0) {
        console.log(`[Expiration Check] Found ${expiredItems.length} expired menu items to archive:`, expiredItems.map(i => `${i.name} (${i.id})`));
        
        for (const item of expiredItems) {
            try {
                console.log(`[Expiration Check] Archiving item: ${item.name} (${item.id})`);
                // Use updateItem with isActive: false to trigger archiving
                await MenuStore.updateItem(item.id, { isActive: false });
                console.log(`[Expiration Check] Successfully archived: ${item.name} (${item.id})`);
            } catch (error) {
                console.error(`[Expiration Check] Failed to archive expired menu item ${item.id}:`, error);
            }
        }
        
        // Refresh menu state after archiving
        console.log('[Expiration Check] Refreshing menu state after archiving');
        menuState = await MenuStore.getItems();
    } else {
        console.log('[Expiration Check] No expired items found');
    }
}

// Manual trigger for testing - can be called from console: checkExpiredMenuItems()
window.checkExpiredMenuItems = checkAndDeactivateExpiredMenuItems;

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
    
    // Check and deactivate expired menu items (past their limitedEndDate)
    try {
        await checkAndDeactivateExpiredMenuItems();
    } catch (error) {
        console.error('Failed to check and deactivate expired menu items:', error);
        // Don't block menu loading if deactivation check fails
    }
    
    renderMenuState();
    // Update category filters (e.g., customer reviews/most ordered) when menu data changes
    if (typeof updateCategoryFilters === 'function') {
        updateCategoryFilters();
    }
    // Update most ordered category filter buttons
    if (typeof updateMostOrderedCategoryFilters === 'function') {
        updateMostOrderedCategoryFilters();
    }
    return menuState;
}

async function renderMenuState() {
    // Ensure orders are loaded so menu stats reflect paid orders
    ensureOrdersSubscription();
    
    // Check which view is currently active
    const menuListTable = document.getElementById('menu-list');
    const catalogueGrid = document.getElementById('menu-catalogue-grid');
    const isMenuListVisible = menuListTable && menuListTable.style.display !== 'none';
    const isCatalogueVisible = catalogueGrid && catalogueGrid.style.display !== 'none';
    
    // Only render the appropriate view
    if (isMenuListVisible) {
    await renderMenuListTable();
    } else if (isCatalogueVisible) {
        renderMenuItemsTable(menuState);
    } else {
        // Default to catalogue if neither is explicitly shown
        renderMenuItemsTable(menuState);
    }
    
    renderSalesMenuAlerts();
    renderMenuDetailsCarousel();
    updateIncludedSaucesCheckboxes();
    
    // If we have a product detail hash and menuState is now loaded, show product detail
    const hash = window.location.hash;
    if ((hash === '#menu-product-detail' || hash === '#product-detail') && menuState && menuState.length && !menuDetailVisible) {
        showMenuProductDetail();
    }
}

async function refreshMenuOrderDependentViews() {
    // Update menu views that display order-derived stats
    // Check which view is currently active
    const menuListTable = document.getElementById('menu-list');
    const catalogueGrid = document.getElementById('menu-catalogue-grid');
    const isMenuListVisible = menuListTable && menuListTable.style.display !== 'none';
    const isCatalogueVisible = catalogueGrid && catalogueGrid.style.display !== 'none';
    
    // Only render the appropriate view
    if (isMenuListVisible) {
    await renderMenuListTable();
    } else if (isCatalogueVisible) {
        renderMenuItemsTable(menuState);
    }
    
    if (menuDetailVisible) {
        renderMenuDetailsCarousel();
    }
    
    // Also refresh sales views if sales section is active
    // This ensures daily sales report and other sales metrics update automatically when orders change
    const salesSection = document.getElementById('sales');
    if (salesSection && salesSection.style.display !== 'none') {
        // Only update daily sales report (lightweight) instead of full sales report
        // Full sales report is updated when period changes or page loads
        updateDailySalesReport();
    }
}

async function ensureOrdersSubscription() {
    // Ensure orders are being listened to even outside the Orders tab
    if (ordersSubscriptionInitialized) return;
    ordersSubscriptionInitialized = true;
    try {
        await waitForFirebaseReady();
        await loadOrdersCollectionOnce();
        await subscribeToOrdersCollection();
    } catch (error) {
        ordersSubscriptionInitialized = false; // allow retry on failure
        console.error('Failed to initialize orders subscription for menu views:', error);
    }
}

// initMenuQuantityModeToggle and handleQuantityModeChange removed - ingredients mode no longer supported

// NEW: Get remaining daily servings for a menu item
async function getMenuRemainingServings(menuItemId) {
    // Get from cache if available
    const cached = await getCachedTodayServings(menuItemId);
    return cached;
}

// Get menu item's serving availability: quantity = actual stock, dailyLimit = max per day, available = min(quantity, dailyLimit - servedToday).
// If variation is provided, uses that variation's quantity (stock) and maxServingsPerDay (daily limit; fallback variation.quantity for old data).
// If item has variations and variation is null, aggregates across all variations for parent row.
function getMenuServingInfo(item, variation) {
    let stock, effectiveDailyLimit, todayCount;

    if (variation != null) {
        // Variation: quantity = actual stock; maxServingsPerDay = daily limit (fallback to quantity for old data)
        const varId = variation.variationId || variation.id;
        stock = (variation.quantity !== undefined && variation.quantity !== null) ? Number(variation.quantity) : 0;
        const limitVal = (variation.maxServingsPerDay !== undefined && variation.maxServingsPerDay !== null) ? Number(variation.maxServingsPerDay) : null;
        effectiveDailyLimit = (limitVal != null && limitVal > 0) ? limitVal : (stock > 0 ? stock : null); // fallback for old data
        todayCount = (varId && todayServingsCache[varId] !== undefined) ? todayServingsCache[varId] : 0;
    } else if (Array.isArray(item.variations) && item.variations.length > 0) {
        // Parent with variations: aggregate from each variation
        let sumRemaining = 0, sumMax = 0, sumToday = 0, sumStock = 0;
        item.variations.forEach(function (v) {
            const si = getMenuServingInfo(item, v);
            sumRemaining += si.remaining;
            sumMax += (si.maxServings != null ? si.maxServings : 0);
            sumToday += si.todayCount;
            sumStock += (si.rawQuantity != null ? si.rawQuantity : 0);
        });
        const remaining = sumRemaining;
        let label = remaining <= 0 ? 'Out of Stock' : 'Available';
        let className = remaining <= 0 ? 'unavailable' : 'available';
        return {
            remaining,
            maxServings: sumMax || null,
            todayCount: sumToday,
            rawQuantity: sumStock,
            label,
            className
        };
    } else {
        // No variations: quantity = stock; maxServingsPerDay = daily limit (fallback to quantity for old data)
        stock = (item.quantity !== undefined && item.quantity !== null) ? Number(item.quantity) : 0;
        const limitVal = (item.maxServingsPerDay !== undefined && item.maxServingsPerDay !== null) ? Number(item.maxServingsPerDay) : null;
        effectiveDailyLimit = (limitVal != null && limitVal > 0) ? limitVal : (stock > 0 ? stock : null);
        todayCount = todayServingsCache[item.id] || 0;
    }

    // remainingFromLimit: how many more allowed today by daily cap (null = unlimited)
    const remainingFromLimit = (effectiveDailyLimit != null && effectiveDailyLimit > 0)
        ? Math.max(0, effectiveDailyLimit - todayCount)
        : null;
    // available = min(stock, remainingFromLimit); if unlimited, available = stock
    const remaining = remainingFromLimit === null ? stock : Math.min(stock, remainingFromLimit);

    let label = remaining <= 0 ? 'Out of Stock' : 'Available';
    let className = remaining <= 0 ? 'unavailable' : 'available';

    return {
        remaining,
        maxServings: (effectiveDailyLimit != null && effectiveDailyLimit > 0) ? effectiveDailyLimit : null,
        todayCount,
        rawQuantity: stock,
        label,
        className
    };
}

// Legacy function - kept for backward compatibility but now uses serving info
function getMenuQuantity(item, variation) {
    const servingInfo = getMenuServingInfo(item, variation || undefined);
    if (servingInfo.remaining !== null) {
        return servingInfo.remaining;
    }
    // Fallback to old calculation for items without serving limits
    const ordersSold = getMenuItemOrderCount(item);
    let baseQuantity = 0;
    if (variation) {
        const variationQty = (variation.quantity !== undefined && variation.quantity !== null)
            ? Number(variation.quantity)
            : null;
        const itemQty = (item.quantity !== undefined && item.quantity !== null) ? Number(item.quantity) : 0;
        baseQuantity = (variationQty !== null && variationQty > 0) ? variationQty : itemQty;
    } else {
        baseQuantity = (item.quantity !== undefined && item.quantity !== null) ? Number(item.quantity) : 0;
    }
    return Math.max(0, baseQuantity - ordersSold);
}

// Apply filter to menu list
function applyMenuListFilter(filterType, filterValue) {
    currentMenuListFilter[filterType] = filterValue;
    renderMenuListTable();
    // Update active state in dropdown
    const dropdown = document.getElementById('menuListFilterDropdown');
    if (dropdown) {
        dropdown.querySelectorAll('.dropdown-item').forEach(item => {
            item.classList.remove('active');
            if (item.getAttribute('data-filter-type') === filterType && 
                item.getAttribute('data-filter-value') === filterValue) {
                item.classList.add('active');
            }
        });
    }
}

// Apply sort to menu list
function applyMenuListSort() {
    const sortSelect = document.getElementById('menuListSort');
    if (sortSelect) {
        currentMenuListSort = sortSelect.value;
        renderMenuListTable();
    }
}

// Apply search to menu list
function applyMenuListSearch() {
    const searchInput = document.getElementById('menuListSearch');
    if (searchInput) {
        currentMenuListSearch = searchInput.value.trim().toLowerCase();
        renderMenuListTable();
    }
}

// Filter menu items for list
function filterMenuListItems(items) {
    if (!items || !items.length) return [];
    
    let filtered = [...items];
    
    // Filter out deleted items
    filtered = filtered.filter(item => item.isDeleted !== true);
    
    // Filter by search term
    if (currentMenuListSearch) {
        filtered = filtered.filter(item => {
            const name = (item.displayName || item.name || '').toLowerCase();
            const menuId = (item.menuId || item.id || '').toLowerCase();
            const category = (item.category || '').toLowerCase();
            return name.includes(currentMenuListSearch) || 
                   menuId.includes(currentMenuListSearch) || 
                   category.includes(currentMenuListSearch);
        });
    }
    
    // Filter by status (default to active only - inactive should not appear)
    if (currentMenuListFilter.status === 'active') {
        filtered = filtered.filter(item => {
            const isActive = item.isActive !== false;
            const isTimeAvailable = isMenuItemTimeAvailable(item);
            return isActive && isTimeAvailable;
        });
    } else if (currentMenuListFilter.status === 'inactive') {
        filtered = filtered.filter(item => item.isActive === false);
    }
    // 'all' shows both active and inactive (but not deleted)
    
    // Filter by category
    if (currentMenuListFilter.category !== 'all') {
        const categoryLower = currentMenuListFilter.category.toLowerCase();
        filtered = filtered.filter(item => {
            const itemCategory = (item.category || '').toLowerCase();
            return itemCategory === categoryLower || itemCategory.includes(categoryLower);
        });
    }
    
    return filtered;
}

// Sort menu items for list
function sortMenuListItems(items) {
    if (!items || !items.length) return [];
    
    const sorted = [...items];
    
    switch (currentMenuListSort) {
        case 'most-sold':
            sorted.sort((a, b) => {
                const aCount = getMenuItemOrderCount(a);
                const bCount = getMenuItemOrderCount(b);
                return bCount - aCount;
            });
            break;
        case 'least-remaining':
            sorted.sort((a, b) => {
                const aQty = getMenuQuantity(a);
                const bQty = getMenuQuantity(b);
                return aQty - bQty;
            });
            break;
        case 'most-remaining':
            sorted.sort((a, b) => {
                const aQty = getMenuQuantity(a);
                const bQty = getMenuQuantity(b);
                return bQty - aQty;
            });
            break;
        case 'name':
        default:
            sorted.sort((a, b) => {
                const aName = (a.displayName || a.name || '').toLowerCase();
                const bName = (b.displayName || b.name || '').toLowerCase();
                return aName.localeCompare(bName);
            });
            break;
    }
    
    return sorted;
}

// Update reset time countdown in menu list header
let resetTimeCountdownInterval = null;

function updateResetTimeHeader() {
    const resetTimeHeader = document.getElementById('resetTimeHeader');
    if (resetTimeHeader) {
        const resetInfo = getNextResetTime();
        const timeUntilReset = `${resetInfo.hoursUntilReset}h ${resetInfo.minutesUntilReset}m`;
        resetTimeHeader.innerHTML = `(Resets: ${resetInfo.resetTime} - <span style="color: #f6c056;">${timeUntilReset}</span>)`;
    }
}

function startResetTimeCountdown() {
    // Clear existing interval if any
    if (resetTimeCountdownInterval) {
        clearInterval(resetTimeCountdownInterval);
    }
    
    // Update immediately
    updateResetTimeHeader();
    
    // Update every minute
    resetTimeCountdownInterval = setInterval(() => {
        updateResetTimeHeader();
    }, 60000); // Update every minute
}

function stopResetTimeCountdown() {
    if (resetTimeCountdownInterval) {
        clearInterval(resetTimeCountdownInterval);
        resetTimeCountdownInterval = null;
    }
}

async function renderMenuListTable() {
    const tableBody = document.getElementById('menuListTableBody');
    if (!tableBody) return;
    
    // Update reset time in header and start countdown
    updateResetTimeHeader();
    startResetTimeCountdown();
    
    // Refresh serving cache: for items with variations use each variation's id; otherwise use item id
    if (menuState && menuState.length > 0) {
        const menuItemIds = [];
        menuState.forEach(function (item) {
            if (Array.isArray(item.variations) && item.variations.length > 0) {
                item.variations.forEach(function (v) {
                    const id = v.variationId || v.id;
                    if (id) menuItemIds.push(id);
                });
            } else {
                if (item.id) menuItemIds.push(item.id);
            }
        });
        await refreshServingsCache(menuItemIds);
    }

    tableBody.innerHTML = '';

    if (!menuState || !menuState.length) {
        tableBody.innerHTML = '<tr><td colspan="7" class="empty-table">No menu items found.</td></tr>';
        return;
    }

    // Apply filters
    let visibleItems = filterMenuListItems(menuState);
    
    if (!visibleItems.length) {
        tableBody.innerHTML = '<tr><td colspan="7" class="empty-table">No menu items found matching the filters.</td></tr>';
        return;
    }

    // Sort items
    const sortedItems = sortMenuListItems(visibleItems);
    
    // Process items with improved parent/child logic
    sortedItems.forEach(item => {
        const menuId = item.menuId || item.id || '—';
        const baseDisplayName = item.displayName || item.name;
        const itemId = item.id;
        const hasVariations = Array.isArray(item.variations) && item.variations.length > 0;
        const variationCount = hasVariations ? item.variations.length : 0;
        const ordersCount = getMenuItemOrderCount(item);
        
        // Store maxServingsPerDay at the start to ensure it doesn't change during rendering
        const maxServingsPerDay = item.maxServingsPerDay !== null && item.maxServingsPerDay !== undefined ? item.maxServingsPerDay : 0;
        
        // Only show parent/child structure if there are 2+ variations
        // If there's only 1 variation, show it as a single row (no parent)
        if (hasVariations && variationCount >= 2) {
            // For items with 2+ variations, aggregate data from variations for parent row
            // This ensures parent shows meaningful data even when parent item has null data
            
            // Calculate aggregated values from variations
            const variationPrices = item.variations
                .map(v => parseMoney(
                    v.price ?? v.sellingPrice ?? v.regularPrice ?? v.displayPrice ?? 
                    v.unitPrice ?? v.priceValue ?? v.amount ?? v.cost ?? 0
                ))
                .filter(p => p > 0);
            
            const minPrice = variationPrices.length > 0 ? Math.min(...variationPrices) : 0;
            const maxPrice = variationPrices.length > 0 ? Math.max(...variationPrices) : 0;
            
            // Get serving info for parent (aggregates across variations)
            const parentServingInfo = getMenuServingInfo(item);
            const parentStockStatus = { label: parentServingInfo.label, className: parentServingInfo.className };
            
            // Display price: show range if different, or single price if same
            const parentPriceDisplay = minPrice === maxPrice 
                ? minPrice.toFixed(2)
                : `${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)}`;
            
            const parentRow = document.createElement('tr');
            parentRow.className = 'menu-list-parent-row';
            
            const imageUrl = item.imageDataUrl || '';
            const imageCell = imageUrl 
                ? `<td class="menu-list-image"><img src="${imageUrl}" alt="${escapeHtml(baseDisplayName)}" class="menu-list-item-image"></td>`
                : `<td class="menu-list-image"><div class="menu-list-item-image-placeholder">${(baseDisplayName || '?').charAt(0).toUpperCase()}</div></td>`;
            
            const parentQty = (parentServingInfo.rawQuantity != null) ? parentServingInfo.rawQuantity : 0;
            const parentLimit = (parentServingInfo.maxServings != null && parentServingInfo.maxServings > 0) ? parentServingInfo.maxServings : '∞';
            parentRow.innerHTML = `
                ${imageCell}
                <td class="menu-list-id">${menuId}</td>
                <td class="menu-list-name">
                    <span class="menu-list-parent-name">${escapeHtml(baseDisplayName)}</span>
                    <span class="menu-list-variation-count">(${variationCount} variations)</span>
                </td>
                <td class="menu-list-quantity" title="Actual stock" style="text-align: center;">${parentQty}</td>
                <td class="menu-list-daily-servings" style="text-align: center;">${parentLimit}</td>
                <td class="menu-list-status" style="text-align: center;"><span class="status ${parentStockStatus.className}">${parentStockStatus.label}</span></td>
                <td class="menu-list-price">PHP ${parentPriceDisplay}</td>
            `;
            
            // Make parent row clickable
            parentRow.style.cursor = 'pointer';
            parentRow.onclick = function(e) {
                // Don't trigger if clicking on a button or link
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A' && !e.target.closest('button') && !e.target.closest('a')) {
                    showMenuListDetail(itemId);
                }
            };
            
            tableBody.appendChild(parentRow);
            
            // Create variation rows for each variation (quantity and remaining are per variation)
            item.variations.forEach((variation, index) => {
                const variationRow = document.createElement('tr');
                variationRow.className = 'menu-list-variation-row';
                
                const variationId = variation.variationId || variation.id || `${itemId}_var_${index}`;
                const variationName = variation.name || `${baseDisplayName} Variation ${index + 1}`;
                const variationPrice = parseMoney(
                    variation.price ??
                    variation.sellingPrice ??
                    variation.regularPrice ??
                    variation.displayPrice ??
                    variation.unitPrice ??
                    variation.priceValue ??
                    variation.amount ??
                    variation.cost ??
                    0
                );
                const variationServingInfo = getMenuServingInfo(item, variation);
                const varQty = (variationServingInfo.rawQuantity != null) ? variationServingInfo.rawQuantity : 0;
                const varLimit = (variationServingInfo.maxServings != null && variationServingInfo.maxServings > 0) ? variationServingInfo.maxServings : '∞';
                
                const variationImageUrl = item.imageDataUrl || '';
                const variationImageCell = variationImageUrl 
                    ? `<td class="menu-list-image"><img src="${variationImageUrl}" alt="${escapeHtml(variationName)}" class="menu-list-item-image"></td>`
                    : `<td class="menu-list-image"><div class="menu-list-item-image-placeholder">${(variationName || '?').charAt(0).toUpperCase()}</div></td>`;
                
                const childId = variation.variationId || variation.id || menuId;
                
                variationRow.innerHTML = `
                    ${variationImageCell}
                    <td class="menu-list-id">${escapeHtml(childId)}</td>
                    <td class="menu-list-name">
                        <span class="menu-list-variation-indicator">└─</span>
                        <span class="menu-list-variation-name">${escapeHtml(variationName)}</span>
                    </td>
                    <td class="menu-list-quantity" title="Actual stock" style="text-align: center;">${varQty}</td>
                    <td class="menu-list-daily-servings" style="text-align: center;">${varLimit}</td>
                    <td class="menu-list-status" style="text-align: center;"><span class="status ${variationServingInfo.className}">${variationServingInfo.label}</span></td>
                    <td class="menu-list-price">PHP ${variationPrice.toFixed(2)}</td>
                `;
                
                // Make variation row clickable
                variationRow.style.cursor = 'pointer';
                variationRow.onclick = function(e) {
                    // Don't trigger if clicking on a button or link
                    if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A' && !e.target.closest('button') && !e.target.closest('a')) {
                        showMenuListDetail(itemId);
                    }
                };
                
                tableBody.appendChild(variationRow);
            });
        } else if (hasVariations && variationCount === 1) {
            // If there's exactly 1 variation, show it as a single row (no parent row); use variation's quantity
            const variation = item.variations[0];
            const variationName = variation.name || baseDisplayName;
            const variationPrice = parseMoney(
                variation.price ??
                variation.sellingPrice ??
                variation.regularPrice ??
                variation.displayPrice ??
                variation.unitPrice ??
                variation.priceValue ??
                variation.amount ??
                variation.cost ??
                0
            );
            const variationServingInfo = getMenuServingInfo(item, variation);
            const varQty = (variationServingInfo.rawQuantity != null) ? variationServingInfo.rawQuantity : 0;
            const varLimit = (variationServingInfo.maxServings != null && variationServingInfo.maxServings > 0) ? variationServingInfo.maxServings : '∞';
                
            const row = document.createElement('tr');
            row.className = 'menu-list-item-row';
            
            const childId = variation.variationId || variation.id || menuId;
            
            const variationImageUrl = item.imageDataUrl || '';
            const variationImageCell = variationImageUrl 
                ? `<td class="menu-list-image"><img src="${variationImageUrl}" alt="${escapeHtml(variationName)}" class="menu-list-item-image"></td>`
                : `<td class="menu-list-image"><div class="menu-list-item-image-placeholder">${(variationName || '?').charAt(0).toUpperCase()}</div></td>`;
            
            row.innerHTML = `
                ${variationImageCell}
                <td class="menu-list-id">${escapeHtml(childId)}</td>
                <td class="menu-list-name">${escapeHtml(variationName)}</td>
                <td class="menu-list-quantity" title="Actual stock" style="text-align: center;">${varQty}</td>
                <td class="menu-list-daily-servings" style="text-align: center;">${varLimit}</td>
                <td class="menu-list-status" style="text-align: center;"><span class="status ${variationServingInfo.className}">${variationServingInfo.label}</span></td>
                <td class="menu-list-price">PHP ${variationPrice.toFixed(2)}</td>
            `;
                
                // Make row clickable
                row.style.cursor = 'pointer';
                row.onclick = function(e) {
                    // Don't trigger if clicking on a button or link
                    if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A' && !e.target.closest('button') && !e.target.closest('a')) {
                        showMenuListDetail(itemId);
                    }
                };
                
                tableBody.appendChild(row);
        } else {
            // Show single row for item without variations
            const row = document.createElement('tr');
            row.className = 'menu-list-item-row';
            
            // Get serving info for item (remaining = available = min(quantity, dailyLimit - servedToday))
            const servingInfo = getMenuServingInfo(item);
            const stockStatus = getMenuItemStatus(item);
            const price = getMenuItemDisplayPrice(item).toFixed(2);
            const itemQty = (servingInfo.rawQuantity != null) ? servingInfo.rawQuantity : 0;
            const itemLimit = (servingInfo.maxServings != null && servingInfo.maxServings > 0) ? servingInfo.maxServings : '∞';
            
            const itemImageUrl = item.imageDataUrl || '';
            const itemImageCell = itemImageUrl 
                ? `<td class="menu-list-image"><img src="${itemImageUrl}" alt="${escapeHtml(baseDisplayName)}" class="menu-list-item-image"></td>`
                : `<td class="menu-list-image"><div class="menu-list-item-image-placeholder">${(baseDisplayName || '?').charAt(0).toUpperCase()}</div></td>`;
            
            row.innerHTML = `
                ${itemImageCell}
                <td class="menu-list-id">${menuId}</td>
                <td class="menu-list-name">${escapeHtml(baseDisplayName)}</td>
                <td class="menu-list-quantity" title="Actual stock" style="text-align: center;">${itemQty}</td>
                <td class="menu-list-daily-servings" style="text-align: center;">${itemLimit}</td>
                <td class="menu-list-status" style="text-align: center;"><span class="status ${stockStatus.className}">${stockStatus.label}</span></td>
                <td class="menu-list-price">PHP ${price}</td>
            `;
            
            // Make row clickable
            row.style.cursor = 'pointer';
            row.onclick = function(e) {
                // Don't trigger if clicking on a button or link
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A' && !e.target.closest('button') && !e.target.closest('a')) {
                    showMenuListDetail(itemId);
                }
            };
            
            tableBody.appendChild(row);
        }
    });
    
    // Update category filter dropdown with available categories
    updateMenuListCategoryFilter();
}

// Inline edit function for serving limit from table
function editMenuServingLimitInline(itemId, itemName, currentLimit) {
    // Open the detail panel and focus the input field
    showMenuListDetail(itemId);
    
    // Wait a bit for the panel to render, then focus the input
    setTimeout(() => {
        const input = document.getElementById('menuListDetailLimitInput');
        if (input) {
            input.focus();
            input.select();
        }
    }, 100);
}

// Get next reset time information
function getNextResetTime() {
    // Use Asia/Manila timezone (GMT+8)
    const timezone = 'Asia/Manila';
    const now = new Date();
    
    // Get current date/time in Manila using Intl API
    const formatter = new Intl.DateTimeFormat('en-CA', { // en-CA gives YYYY-MM-DD format
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    
    const parts = formatter.formatToParts(now);
    const getPart = (type) => parseInt(parts.find(p => p.type === type).value);
    
    const year = getPart('year');
    const month = getPart('month') - 1; // JavaScript months are 0-indexed
    const day = getPart('day');
    const hour = getPart('hour');
    const minute = getPart('minute');
    const second = getPart('second');
    
    // Create a date representing current time in Manila (as if it were local time)
    // This is just for calculation purposes
    const nowManila = new Date(year, month, day, hour, minute, second);
    
    // Calculate next midnight in Manila (tomorrow at 00:00:00)
    const resetDateManila = new Date(year, month, day + 1, 0, 0, 0);
    
    // Calculate time difference
    const timeUntilReset = resetDateManila - nowManila;
    const hours = Math.floor(timeUntilReset / (1000 * 60 * 60));
    const minutes = Math.floor((timeUntilReset % (1000 * 60 * 60)) / (1000 * 60));
    
    // Format reset time in Asia/Manila timezone for display
    // We need to create a proper Date object that represents midnight in Manila
    // Manila is UTC+8, so midnight Manila = 16:00 previous day UTC
    const resetUTC = new Date(Date.UTC(year, month, day + 1, 0, 0, 0));
    resetUTC.setUTCHours(resetUTC.getUTCHours() - 8); // Convert to UTC (Manila is +8)
    
    const resetTimeStr = resetUTC.toLocaleString('en-US', {
        timeZone: timezone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
    
    return {
        resetTime: resetTimeStr,
        hoursUntilReset: Math.max(0, hours),
        minutesUntilReset: Math.max(0, minutes),
        resetDate: resetUTC,
        timezone: timezone
    };
}

// Show reset time information
function showResetTimeInfo() {
    const resetInfo = getNextResetTime();
    const timezone = resetInfo.timezone || 'Asia/Manila';
    
    // Format reset time in long format for dialog (Asia/Manila timezone)
    const resetTimeStrLong = resetInfo.resetDate.toLocaleString('en-US', {
        timeZone: timezone,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short'
    });
    
    // Get or create modal
    let modal = document.getElementById('resetTimeModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'resetTimeModal';
        modal.className = 'modal';
        modal.setAttribute('aria-hidden', 'true');
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h2>Daily Serving Count Reset Information</h2>
                    <span class="close-modal" onclick="closeResetTimeModal()">&times;</span>
                </div>
                <div class="modal-body" id="resetTimeModalBody">
                    <!-- Content will be inserted here -->
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Close modal when clicking outside
        modal.addEventListener('click', function(event) {
            if (event.target === modal) {
                closeResetTimeModal();
            }
        });
    }
    
    // Update modal content with live countdown
    const modalBody = document.getElementById('resetTimeModalBody');
    if (modalBody) {
        const updateModalContent = () => {
            const currentResetInfo = getNextResetTime();
            modalBody.innerHTML = `
                <div style="line-height: 1.8;">
                    <p style="margin-bottom: 15px;">
                        <strong>⏰ Reset Time:</strong><br>
                        ${escapeHtml(resetTimeStrLong)}
                    </p>
                    <p style="margin-bottom: 15px;">
                        <strong>📍 Timezone:</strong><br>
                        ${escapeHtml(timezone)}
                    </p>
                    <p style="margin-bottom: 15px;">
                        <strong>⏳ Time Until Reset:</strong><br>
                        <span id="resetTimeCountdown" style="font-weight: 600; color: #7E2021;">
                            ${currentResetInfo.hoursUntilReset} hour${currentResetInfo.hoursUntilReset !== 1 ? 's' : ''} and ${currentResetInfo.minutesUntilReset} minute${currentResetInfo.minutesUntilReset !== 1 ? 's' : ''}
                        </span>
                    </p>
                    <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-top: 20px;">
                        <p style="margin-bottom: 10px;"><strong>How it works:</strong></p>
                        <ul style="margin: 0; padding-left: 20px;">
                            <li>Today's serving count will reset to 0</li>
                            <li>The remaining servings will be restored to the daily limit</li>
                            <li>All menu items will be available again (if they have remaining servings)</li>
                        </ul>
                    </div>
                    <p style="margin-top: 15px; color: #6c757d; font-size: 0.9rem;">
                        <em>Note: The reset happens automatically based on your local timezone.</em>
                    </p>
                </div>
            `;
        };
        
        updateModalContent();
        
        // Update countdown every minute
        const countdownInterval = setInterval(() => {
            if (modal.style.display === 'none') {
                clearInterval(countdownInterval);
                return;
            }
            const countdownEl = document.getElementById('resetTimeCountdown');
            if (countdownEl) {
                const currentResetInfo = getNextResetTime();
                countdownEl.textContent = `${currentResetInfo.hoursUntilReset} hour${currentResetInfo.hoursUntilReset !== 1 ? 's' : ''} and ${currentResetInfo.minutesUntilReset} minute${currentResetInfo.minutesUntilReset !== 1 ? 's' : ''}`;
            }
        }, 60000); // Update every minute
        
        // Store interval ID on modal for cleanup
        modal._countdownInterval = countdownInterval;
    }
    
    // Show modal
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
}

// Close reset time modal
function closeResetTimeModal() {
    const modal = document.getElementById('resetTimeModal');
    if (modal) {
        // Clear countdown interval if it exists
        if (modal._countdownInterval) {
            clearInterval(modal._countdownInterval);
            modal._countdownInterval = null;
        }
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
}

// Expose globally
window.closeResetTimeModal = closeResetTimeModal;

// Update menu daily serving limit
async function updateMenuServingLimit(itemId, newLimit) {
    if (!itemId) return;
    
    // Allow empty string or 0 for unlimited
    const limit = newLimit === '' || newLimit === null || newLimit === undefined 
        ? null 
        : parseInt(newLimit, 10);
    
    if (limit !== null && (isNaN(limit) || limit < 0)) {
        showNotification('Invalid serving limit value. Use 0 or leave empty for unlimited.', 'error');
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            showNotification('Database is not ready. Please try again.', 'error');
            return;
        }
        
        const fns = window.firestoreFunctions;
        const itemRef = fns.doc(window.db, 'menu', itemId);
        
        const updateData = {
            updatedAt: fns.serverTimestamp()
        };
        
        if (limit === null || limit === 0) {
            updateData.maxServingsPerDay = null; // Unlimited
        } else {
            updateData.maxServingsPerDay = limit;
        }
        
        await fns.updateDoc(itemRef, updateData);
        
        // Refresh menu state
        menuState = await MenuStore.getItems();
        await renderMenuListTable();
        
        // Refresh detail panel if it's open for this item
        const detailPanel = document.getElementById('menuListDetailPanel');
        if (detailPanel && detailPanel.style.display !== 'none') {
            const currentItemId = detailPanel.dataset.currentItemId;
            if (currentItemId === itemId) {
                showMenuListDetail(itemId);
            }
        }
        
        showNotification(`Daily serving limit ${limit === null ? 'removed (unlimited)' : `set to ${limit}`} successfully.`, 'success');
    } catch (error) {
        console.error('Error updating serving limit:', error);
        showNotification('Failed to update serving limit.', 'error');
    }
}

// Update menu item quantity (actual stock). Separate from daily serving limit.
async function updateMenuQuantity(itemId, newQuantity) {
    if (!itemId) return;
    const qty = newQuantity === '' || newQuantity === null || newQuantity === undefined
        ? 0
        : parseInt(newQuantity, 10);
    if (isNaN(qty) || qty < 0) {
        showNotification('Invalid quantity. Use 0 or a positive number.', 'error');
        return;
    }
    try {
        if (!isFirestoreReady()) {
            showNotification('Database is not ready. Please try again.', 'error');
            return;
        }
        const fns = window.firestoreFunctions;
        const itemRef = fns.doc(window.db, 'menu', itemId);
        await fns.updateDoc(itemRef, { quantity: qty, updatedAt: fns.serverTimestamp() });
        menuState = await MenuStore.getItems();
        await renderMenuListTable();
        const detailPanel = document.getElementById('menuListDetailPanel');
        if (detailPanel && detailPanel.style.display !== 'none' && detailPanel.dataset.currentItemId === itemId) {
            showMenuListDetail(itemId);
        }
        showNotification('Quantity updated successfully.', 'success');
    } catch (e) {
        console.error('Error updating quantity:', e);
        showNotification('Failed to update quantity.', 'error');
    }
}

// Update variation serving limit (maxServingsPerDay)
async function updateMenuVariationQuantity(itemId, variationId, newLimit) {
    if (!itemId || !variationId) return;
    
    // Allow empty string or 0 for unlimited
    const limit = newLimit === '' || newLimit === null || newLimit === undefined 
        ? null 
        : parseInt(newLimit, 10);
    
    if (limit !== null && (isNaN(limit) || limit < 0)) {
        showNotification('Invalid serving limit value. Use 0 or leave empty for unlimited.', 'error');
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            showNotification('Database is not ready. Please try again.', 'error');
            return;
        }
        
        const fns = window.firestoreFunctions;
        const itemRef = fns.doc(window.db, 'menu', itemId);
        const itemDoc = await fns.getDoc(itemRef);
        
        if (!itemDoc.exists()) {
            showNotification('Menu item not found.', 'error');
            return;
        }
        
        const itemData = itemDoc.data();
        const variations = Array.isArray(itemData.variations) ? [...itemData.variations] : [];
        
        // Find and update the variation
        const variationIndex = variations.findIndex(v => 
            (v.variationId || v.id) === variationId
        );
        
        if (variationIndex === -1) {
            showNotification('Variation not found.', 'error');
            return;
        }
        
        variations[variationIndex] = {
            ...variations[variationIndex],
            maxServingsPerDay: limit === null || limit === 0 ? null : limit
        };
        
        await fns.updateDoc(itemRef, {
            variations: variations,
            updatedAt: fns.serverTimestamp()
        });
        
        // Refresh menu state
        menuState = await MenuStore.getItems();
        await renderMenuListTable();
        
        // Refresh detail panel if it's open for this item
        const detailPanel = document.getElementById('menuListDetailPanel');
        if (detailPanel && detailPanel.style.display !== 'none') {
            const currentItemId = detailPanel.dataset.currentItemId;
            if (currentItemId === itemId) {
                showMenuListDetail(itemId);
            }
        }
        
        showNotification(`Variation serving limit ${limit === null ? 'removed (unlimited)' : `set to ${limit}`} successfully.`, 'success');
    } catch (error) {
        console.error('Error updating variation serving limit:', error);
        showNotification('Failed to update variation serving limit.', 'error');
    }
}

// Update variation quantity (actual stock). Separate from daily serving limit.
async function updateMenuVariationStock(itemId, variationId, newQuantity) {
    if (!itemId || !variationId) return;
    const qty = newQuantity === '' || newQuantity === null || newQuantity === undefined
        ? 0
        : parseInt(newQuantity, 10);
    if (isNaN(qty) || qty < 0) {
        showNotification('Invalid quantity. Use 0 or a positive number.', 'error');
        return;
    }
    try {
        if (!isFirestoreReady()) {
            showNotification('Database is not ready. Please try again.', 'error');
            return;
        }
        const fns = window.firestoreFunctions;
        const itemRef = fns.doc(window.db, 'menu', itemId);
        const itemDoc = await fns.getDoc(itemRef);
        if (!itemDoc.exists()) {
            showNotification('Menu item not found.', 'error');
            return;
        }
        const itemData = itemDoc.data();
        const variations = Array.isArray(itemData.variations) ? [...itemData.variations] : [];
        const vi = variations.findIndex(v => (v.variationId || v.id) === variationId);
        if (vi === -1) {
            showNotification('Variation not found.', 'error');
            return;
        }
        variations[vi] = { ...variations[vi], quantity: qty };
        await fns.updateDoc(itemRef, { variations, updatedAt: fns.serverTimestamp() });
        menuState = await MenuStore.getItems();
        await renderMenuListTable();
        const detailPanel = document.getElementById('menuListDetailPanel');
        if (detailPanel && detailPanel.style.display !== 'none' && detailPanel.dataset.currentItemId === itemId) {
            showMenuListDetail(itemId);
        }
        showNotification('Quantity updated successfully.', 'success');
    } catch (e) {
        console.error('Error updating variation quantity:', e);
        showNotification('Failed to update quantity.', 'error');
    }
}

// Show menu detail in right panel
function showMenuListDetail(itemId) {
    try {
        const item = menuState.find(m => m.id === itemId);
        if (!item) {
            showNotification('Menu item not found.', 'error');
            return;
        }
        
        const detailPanel = document.getElementById('menuListDetailPanel');
        const detailContent = document.getElementById('menuListDetailContent');
        const detailTitle = document.getElementById('menuListDetailTitle');
        
        if (!detailPanel) {
            console.error('menuListDetailPanel not found');
            return;
        }
        if (!detailContent) {
            console.error('menuListDetailContent not found');
            return;
        }
        if (!detailTitle) {
            console.error('menuListDetailTitle not found');
            return;
        }
        
        // Ensure the menu list wrapper is visible
        const menuListWrapper = document.getElementById('menu-list');
        if (menuListWrapper) {
            menuListWrapper.style.display = 'flex';
            menuListWrapper.style.visibility = 'visible';
        }
        
        // Show the panel (use flex to maintain layout)
        detailPanel.style.display = 'flex';
        detailPanel.style.visibility = 'visible';
        detailPanel.dataset.currentItemId = itemId; // Store current item ID for refresh
        
        // Shrink the tan container so the detail panel fits beside it; left-panel fills the tan container
        const leftPanel = document.querySelector('.menu-list-left-panel');
        const tanContainer = document.querySelector('.menu-list-tan-container');
        if (tanContainer) {
            tanContainer.style.flex = '1 1 0%';
            tanContainer.style.maxWidth = 'none';
            tanContainer.style.width = 'auto';
        }
        if (leftPanel) {
            leftPanel.style.maxWidth = '100%';
            leftPanel.style.width = '100%';
        }
        
        // Update title
        detailTitle.textContent = item.displayName || item.name || 'Menu Item Details';
        
        // Get item data
        const menuId = item.menuId || item.id || '—';
        const hasVariations = Array.isArray(item.variations) && item.variations.length > 0;
        const variationCount = hasVariations ? item.variations.length : 0;
        
        // Get serving info for this item
        const servingInfo = getMenuServingInfo(item);
        
        // For items with 2+ variations, aggregate data from variations (parent has null data)
        // For single variation or no variations, use item data as normal
        let price, quantity, ordersCount;
        
        if (hasVariations && variationCount >= 2) {
        // Parent item with 2+ variations - aggregate from variations
        const variationPrices = item.variations
            .map(v => parseMoney(
                v.price ?? v.sellingPrice ?? v.regularPrice ?? v.displayPrice ?? 
                v.unitPrice ?? v.priceValue ?? v.amount ?? v.cost ?? 0
            ))
            .filter(p => p > 0);
        
        const minPrice = variationPrices.length > 0 ? Math.min(...variationPrices) : 0;
        const maxPrice = variationPrices.length > 0 ? Math.max(...variationPrices) : 0;
        
        // Aggregate quantity: sum of all variation quantities
        quantity = item.variations.reduce((sum, variation) => {
            const varQty = getMenuQuantity(item, variation);
            return sum + varQty;
        }, 0);
        
        // Price display: show range if different, or single price if same
        price = minPrice === maxPrice 
            ? minPrice.toFixed(2)
            : `${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)}`;
        
        ordersCount = getMenuItemOrderCount(item);
    } else {
        // Single variation or no variations - use item data as normal
        price = getMenuItemDisplayPrice(item).toFixed(2);
        quantity = getMenuQuantity(item);
        ordersCount = getMenuItemOrderCount(item);
    }
    
        const status = getMenuItemStatus(item);
        const category = item.category || 'Uncategorized';
        const description = item.description || 'No description available.';
        const allergens = item.allergens || 'None';
        const imageUrl = item.imageDataUrl || '';
        
        // Build detail content HTML
        let detailHTML = `
        <div class="menu-list-detail-image">
            ${imageUrl 
                ? `<img src="${imageUrl}" alt="${escapeHtml(item.displayName || item.name)}">` 
                : `<div class="menu-list-detail-image-placeholder">${(item.displayName || item.name || '?').charAt(0).toUpperCase()}</div>`
            }
        </div>
        <div class="menu-list-detail-info">
            <div class="menu-list-detail-row">
                <span class="menu-list-detail-label">Menu ID:</span>
                <span class="menu-list-detail-value">${menuId}</span>
            </div>
            <div class="menu-list-detail-row">
                <span class="menu-list-detail-label">Category:</span>
                <span class="menu-list-detail-value">${escapeHtml(category)}</span>
            </div>
            <div class="menu-list-detail-row">
                <span class="menu-list-detail-label">Price:</span>
                <span class="menu-list-detail-value">PHP ${price}</span>
            </div>
            <div class="menu-list-detail-row">
                <span class="menu-list-detail-label">Available (to serve):</span>
                <span class="menu-list-detail-value">${servingInfo.remaining} <small style="color:#666">(min of Quantity and Daily Limit − Served Today)</small></span>
            </div>
            <div class="menu-list-detail-row">
                <span class="menu-list-detail-label">Status:</span>
                <span class="status ${status.className}">${status.label}</span>
            </div>
            <div class="menu-list-detail-row">
                <span class="menu-list-detail-label">Orders Count:</span>
                <span class="menu-list-detail-value">${ordersCount}</span>
            </div>
            <div class="menu-list-detail-section">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <h4 style="margin: 0;">Daily Serving Limit</h4>
                    <button type="button" class="btn btn-sm btn-info" 
                            onclick="showResetTimeInfo()" 
                            title="View Reset Time Information"
                            style="font-size: 0.75rem;">
                        <i class="fas fa-clock"></i> Reset Time
                    </button>
                </div>
                <div class="menu-list-detail-limit-control">
                    ${hasVariations && variationCount >= 2 
                        ? `<p style="color: #666; font-style: italic; margin-bottom: 12px;">This is a parent item. You can set a daily serving limit for the parent item, or set individual limits for each variation below.</p>
                           <label for="menuListDetailParentLimitInput">Parent Item Max Servings Per Day (0 = Unlimited):</label>
                           <div style="display: flex; gap: 10px; align-items: center; margin-top: 8px; margin-bottom: 12px;">
                               <input type="number" id="menuListDetailParentLimitInput" class="form-control" 
                                      value="${item.maxServingsPerDay || ''}" min="0" step="1" 
                                      style="width: 120px;"
                                      placeholder="Unlimited"
                                      onchange="updateMenuServingLimit('${escapeHtml(itemId)}', this.value)">
                               <button type="button" class="btn btn-sm btn-primary" 
                                       onclick="const input = document.getElementById('menuListDetailParentLimitInput'); updateMenuServingLimit('${escapeHtml(itemId)}', input.value);">
                                   <i class="fas fa-save"></i> Save
                               </button>
                           </div>
                           <div style="margin-top: 12px; padding: 12px; background: #f8f9fa; border-radius: 6px;">
                               <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                   <span style="color: #666;">Quantity (total):</span>
                                   <strong>${servingInfo.rawQuantity != null ? servingInfo.rawQuantity : '—'}</strong>
                               </div>
                               <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                   <span style="color: #666;">Daily Limit:</span>
                                   <strong>${item.maxServingsPerDay || 'Unlimited'}</strong>
                               </div>
                               <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                   <span style="color: #666;">Served Today:</span>
                                   <strong style="color: #7E2021;">${servingInfo.todayCount || 0}</strong>
                               </div>
                               <div style="display: flex; justify-content: space-between; padding-top: 8px; border-top: 1px solid #ddd;">
                                   <span style="color: #666;">Available:</span>
                                   <strong style="color: ${servingInfo.remaining > 0 ? '#28a745' : '#dc3545'};">${servingInfo.remaining}</strong>
                               </div>
                           </div>`
                        : `<label for="menuListDetailQuantityInput">Quantity (Actual stock):</label>
                           <div style="display: flex; gap: 10px; align-items: center; margin-top: 8px; margin-bottom: 12px;">
                               <input type="number" id="menuListDetailQuantityInput" class="form-control" 
                                      value="${item.quantity != null ? item.quantity : 0}" min="0" step="1" 
                                      style="width: 120px;"
                                      onchange="updateMenuQuantity('${escapeHtml(itemId)}', this.value)">
                               <button type="button" class="btn btn-sm btn-primary" 
                                       onclick="const i = document.getElementById('menuListDetailQuantityInput'); updateMenuQuantity('${escapeHtml(itemId)}', i.value);">
                                   <i class="fas fa-save"></i> Save
                               </button>
                           </div>
                           <label for="menuListDetailLimitInput">Daily Serving Limit (0 = Unlimited):</label>
                           <div style="display: flex; gap: 10px; align-items: center; margin-top: 8px;">
                               <input type="number" id="menuListDetailLimitInput" class="form-control" 
                                      value="${item.maxServingsPerDay || ''}" min="0" step="1" 
                                      style="width: 120px;"
                                      placeholder="Unlimited"
                                      onchange="updateMenuServingLimit('${escapeHtml(itemId)}', this.value)">
                               <button type="button" class="btn btn-sm btn-primary" 
                                       onclick="const input = document.getElementById('menuListDetailLimitInput'); updateMenuServingLimit('${escapeHtml(itemId)}', input.value);">
                                   <i class="fas fa-save"></i> Save
                               </button>
                           </div>
                           <div style="margin-top: 12px; padding: 12px; background: #f8f9fa; border-radius: 6px;">
                               <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                   <span style="color: #666;">Quantity:</span>
                                   <strong>${servingInfo.rawQuantity != null ? servingInfo.rawQuantity : 0}</strong>
                               </div>
                               <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                   <span style="color: #666;">Daily Limit:</span>
                                   <strong>${item.maxServingsPerDay || 'Unlimited'}</strong>
                               </div>
                               <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                   <span style="color: #666;">Served Today:</span>
                                   <strong style="color: #7E2021;">${servingInfo.todayCount || 0}</strong>
                               </div>
                               <div style="display: flex; justify-content: space-between; padding-top: 8px; border-top: 1px solid #ddd;">
                                   <span style="color: #666;">Available:</span>
                                   <strong style="color: ${servingInfo.remaining > 0 ? '#28a745' : '#dc3545'};">${servingInfo.remaining}</strong>
                               </div>
                           </div>`
                    }
                </div>
            </div>
            <div class="menu-list-detail-section">
                <h4>Description</h4>
                <p>${escapeHtml(description)}</p>
            </div>
            <div class="menu-list-detail-section">
                <h4>Allergens</h4>
                <p>${escapeHtml(allergens)}</p>
            </div>
        `;
        
        // Add variations if they exist
        if (Array.isArray(item.variations) && item.variations.length > 0) {
            detailHTML += `
            <div class="menu-list-detail-section">
                <h4>Variations (${item.variations.length})</h4>
                <ul class="menu-list-detail-variations">
        `;
            item.variations.forEach((variation, index) => {
                const varId = variation.variationId || variation.id || `${itemId}_var_${index}`;
                const varName = variation.name || `Variation ${index + 1}`;
                const varPrice = parseMoney(
                    variation.price ??
                    variation.sellingPrice ??
                    variation.regularPrice ??
                    variation.displayPrice ??
                    variation.unitPrice ??
                    variation.priceValue ??
                    variation.amount ??
                    variation.cost ??
                    0
                );
                const varSi = getMenuServingInfo(item, variation);
                const varQty = (variation.quantity !== undefined && variation.quantity !== null) ? Number(variation.quantity) : 0;
                const varLimit = (variation.maxServingsPerDay !== undefined && variation.maxServingsPerDay !== null) ? variation.maxServingsPerDay : '';
                
                const availClass = varSi.remaining > 0 ? 'variation-avail--ok' : 'variation-avail--out';
                detailHTML += `
                    <li class="menu-list-detail-variation-card">
                        <div class="menu-list-detail-variation-head">
                            <span class="menu-list-detail-variation-name">${escapeHtml(varName)}</span>
                            <span class="menu-list-detail-variation-meta">
                                <span class="menu-list-detail-variation-price">PHP ${varPrice.toFixed(2)}</span>
                                <span class="menu-list-detail-variation-id">ID: ${escapeHtml(String(varId))}</span>
                            </span>
                        </div>
                        <div class="menu-list-detail-variation-controls">
                            <div class="menu-list-detail-variation-field">
                                <label>Quantity (Actual stock)</label>
                                <div class="menu-list-detail-variation-input-row">
                                    <input type="number" class="form-control" value="${varQty}" min="0" step="1"
                                           onchange="updateMenuVariationStock('${escapeHtml(itemId)}', '${escapeHtml(String(varId))}', this.value)">
                                    <button type="button" class="btn btn-sm btn-primary" onclick="var r=event.target.closest('.menu-list-detail-variation-input-row'); var i=r?r.querySelector('input[type=number]'):null; if(i) updateMenuVariationStock('${escapeHtml(itemId)}', '${escapeHtml(String(varId))}', i.value);"><i class="fas fa-save"></i> Save</button>
                                </div>
                            </div>
                            <div class="menu-list-detail-variation-field">
                                <label>Daily Serving Limit (0 = Unlimited)</label>
                                <div class="menu-list-detail-variation-input-row">
                                    <input type="number" class="form-control" value="${varLimit}" min="0" step="1" placeholder="Unlimited"
                                           onchange="updateMenuVariationQuantity('${escapeHtml(itemId)}', '${escapeHtml(String(varId))}', this.value)">
                                    <button type="button" class="btn btn-sm btn-primary" onclick="var r=event.target.closest('.menu-list-detail-variation-input-row'); var i=r?r.querySelector('input[type=number]'):null; if(i) updateMenuVariationQuantity('${escapeHtml(itemId)}', '${escapeHtml(String(varId))}', i.value);"><i class="fas fa-save"></i> Save</button>
                                </div>
                            </div>
                        </div>
                        <div class="menu-list-detail-variation-summary">
                            <span>Qty: ${varSi.rawQuantity != null ? varSi.rawQuantity : 0}</span>
                            <span>Limit: ${(varSi.maxServings != null && varSi.maxServings > 0) ? varSi.maxServings : '∞'}</span>
                            <span>Served: ${varSi.todayCount || 0}</span>
                            <span class="menu-list-detail-variation-available ${availClass}">Available: ${varSi.remaining}</span>
                        </div>
                    </li>
                `;
            });
            detailHTML += `</ul></div>`;
        }
        
        // Add ingredients if they exist
        if (Array.isArray(item.ingredients) && item.ingredients.length > 0) {
            detailHTML += `
                <div class="menu-list-detail-section">
                    <h4>Linked Ingredients (${item.ingredients.length})</h4>
                    <ul class="menu-list-detail-ingredients">
            `;
            item.ingredients.forEach(ingredient => {
                const ingName = ingredient.ingredientName || 'Unknown';
                const displayAmount = ingredient.displayAmount || '';
                detailHTML += `
                    <li>
                        <strong>${escapeHtml(ingName)}</strong>
                        ${displayAmount ? `<span>${escapeHtml(displayAmount)}</span>` : ''}
                    </li>
                `;
            });
            detailHTML += `</ul></div>`;
        }
        
        detailHTML += `
            <div class="menu-list-detail-actions">
                <button type="button" class="btn btn-primary" onclick="showMenuDetailForItem('${escapeHtml(itemId)}')">
                    <i class="fas fa-edit"></i> Edit Full Details
                </button>
            </div>
        </div>
    `;
    
        detailContent.innerHTML = detailHTML;
    } catch (error) {
        console.error('Error showing menu list detail:', error);
        showNotification('Failed to load menu item details. Please try again.', 'error');
    }
}

// Close menu list detail panel
function closeMenuListDetail() {
    const detailPanel = document.getElementById('menuListDetailPanel');
    if (detailPanel) {
        detailPanel.style.display = 'none';
    }
    
    // Restore tan container and left panel to full width
    const leftPanel = document.querySelector('.menu-list-left-panel');
    const tanContainer = document.querySelector('.menu-list-tan-container');
    if (tanContainer) {
        tanContainer.style.flex = '';
        tanContainer.style.maxWidth = '';
        tanContainer.style.width = '';
    }
    if (leftPanel) {
        leftPanel.style.maxWidth = '100%';
        leftPanel.style.width = '100%';
    }
}

// Update category filter dropdown
function updateMenuListCategoryFilter() {
    const categorySection = document.getElementById('menuListCategoryFilterSection');
    if (!categorySection || !menuState || !menuState.length) return;
    
    // Get unique categories
    const categories = new Set();
        menuState.forEach(item => {
        if (item.category && item.isDeleted !== true) {
            categories.add(item.category);
        }
    });
    
    // Clear existing category options (except "All Categories")
    const allCategoriesLink = categorySection.querySelector('.dropdown-item[data-filter-value="all"]');
    categorySection.innerHTML = '<div class="filter-section-title">Category</div>';
    if (allCategoriesLink) {
        categorySection.appendChild(allCategoriesLink);
    }
    
    // Add category options
    const sortedCategories = Array.from(categories).sort();
    sortedCategories.forEach(category => {
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'dropdown-item';
        link.setAttribute('data-filter-type', 'category');
        link.setAttribute('data-filter-value', category.toLowerCase());
        link.textContent = category;
        link.onclick = function() {
            applyMenuListFilter('category', category.toLowerCase());
            return false;
        };
        categorySection.appendChild(link);
    });
}

function updateMenuDetailIncludedSaucesCheckboxes(menuItem) {
    const container = document.getElementById('menuDetailIncludedSaucesContainer');
    if (!container) return;
    
    // Filter menu items to only show active, non-deleted sauces
    let sauceItems = [];
    if (menuState && menuState.length) {
        sauceItems = menuState.filter(item => {
            if (!item || !item.name) return false;
            // Don't include the current item itself
            if (menuItem && item.id === menuItem.id) return false;
            // Exclude inactive or deleted items
            if (item.isDeleted === true || item.isActive === false) {
                return false;
            }
            // Check if item is a sauce (by category or name)
            const category = (item.category || '').toLowerCase();
            const name = (item.name || item.displayName || '').toLowerCase();
            return category.includes('sauce') || 
                   category === 'sauces' ||
                   name.includes('sauce');
        });
    }
    
    // Get current selections from menuItem - handle multiple ID formats
    const currentSelections = new Set();
    if (menuItem && menuItem.includedSauces && Array.isArray(menuItem.includedSauces)) {
        menuItem.includedSauces.forEach(sauce => {
            // Try multiple ID fields and convert to string for consistent comparison
            const sauceId = String(sauce.sauceId || sauce.menuId || sauce.id || '');
            if (sauceId && sauceId !== 'undefined' && sauceId !== 'null') {
                currentSelections.add(sauceId);
            }
        });
    }
    
    console.log('Product Detail - Current linked sauces:', {
        menuItemId: menuItem?.id,
        includedSauces: menuItem?.includedSauces,
        currentSelections: Array.from(currentSelections)
    });
    
    // Clear existing content
    container.innerHTML = '';
    
    if (sauceItems.length === 0) {
        container.innerHTML = '<div class="empty-state" style="text-align: center; color: #999; padding: 20px;">No sauces available. Add sauce items to the menu first.</div>';
        return;
    }
    
    // Add checkbox for each sauce
    sauceItems.forEach(item => {
        const checkboxWrapper = document.createElement('label');
        checkboxWrapper.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 10px 12px; cursor: pointer; border-radius: 6px; margin-bottom: 6px; transition: background-color 0.2s ease;';
        checkboxWrapper.onmouseover = function() {
            this.style.backgroundColor = '#f0f0f0';
        };
        checkboxWrapper.onmouseout = function() {
            this.style.backgroundColor = 'transparent';
        };
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = item.id;
        checkbox.style.cssText = 'width: 18px; height: 18px; margin: 0; cursor: pointer; accent-color: #7E2021; flex-shrink: 0;';
        
        // Check if this sauce is already selected - compare both id and menuId as strings
        const itemIdStr = String(item.id || '');
        const itemMenuIdStr = String(item.menuId || item.id || '');
        const isChecked = currentSelections.has(itemIdStr) || currentSelections.has(itemMenuIdStr);
        
        if (isChecked) {
            checkbox.checked = true;
            console.log('Product Detail - Pre-checking sauce:', {
                sauceName: item.displayName || item.name,
                sauceId: item.id,
                menuId: item.menuId
            });
        }
        
        const label = document.createElement('span');
        label.textContent = item.displayName || item.name;
        label.style.cssText = 'flex: 1; cursor: pointer; font-size: 0.9375rem; color: #333; line-height: 1.5;';
        
        checkboxWrapper.appendChild(checkbox);
        checkboxWrapper.appendChild(label);
        container.appendChild(checkboxWrapper);
    });
}

function updateIncludedSaucesCheckboxes() {
    // Update both add form and edit form checkbox containers
    const includedSaucesContainer = document.getElementById('includedSaucesContainer');
    const menuEditIncludedSaucesContainer = document.getElementById('menuEditIncludedSaucesContainer');
    
    const containers = [includedSaucesContainer, menuEditIncludedSaucesContainer].filter(Boolean);
    if (containers.length === 0) return;
    
    // Filter menu items to only show active, non-deleted sauces
    let sauceItems = [];
    if (menuState && menuState.length) {
        sauceItems = menuState.filter(item => {
            if (!item || !item.name) return false;
            
            // Exclude inactive or deleted items
            if (item.isDeleted === true || item.isActive === false) {
                return false;
            }
            
            // Check if item is a sauce (by category or name)
            const category = (item.category || '').toLowerCase();
            const name = (item.name || item.displayName || '').toLowerCase();
            return category.includes('sauce') || 
                   category === 'sauces' ||
                   name.includes('sauce');
        });
    }
    
    // Update each container
    containers.forEach(container => {
        // Store current selections before clearing
        const currentSelections = new Set();
        if (container.id === 'menuEditIncludedSaucesContainer') {
            container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
                if (checkbox.checked) {
                    currentSelections.add(checkbox.value);
                }
            });
        }
        
        // Clear existing content
        container.innerHTML = '';
        
        if (sauceItems.length === 0) {
            container.innerHTML = '<div class="empty-state" style="text-align: center; color: #999; padding: 20px;">No sauces available. Add sauce items to the menu first.</div>';
            return;
        }
        
        // Add checkbox for each sauce
        sauceItems.forEach(item => {
            const checkboxWrapper = document.createElement('label');
            checkboxWrapper.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 8px; cursor: pointer; border-radius: 4px;';
            checkboxWrapper.style.marginBottom = '4px';
            checkboxWrapper.onmouseover = function() {
                this.style.backgroundColor = '#f5f5f5';
            };
            checkboxWrapper.onmouseout = function() {
                this.style.backgroundColor = 'transparent';
            };
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = item.id;
            checkbox.style.cssText = 'width: auto; margin: 0; cursor: pointer;';
            
            // Restore selection if this is edit form
            if (container.id === 'menuEditIncludedSaucesContainer' && currentSelections.has(item.id)) {
                checkbox.checked = true;
            }
            
            const label = document.createElement('span');
            label.textContent = item.displayName || item.name;
            label.style.cssText = 'flex: 1; cursor: pointer;';
            
            checkboxWrapper.appendChild(checkbox);
            checkboxWrapper.appendChild(label);
            container.appendChild(checkboxWrapper);
        });
    });
}

let currentMenuFilter = { status: 'all', category: 'all' };
let currentMenuListFilter = { status: 'active', category: 'all' }; // Default to active only
let currentMenuListSort = 'name';
let currentMenuListSearch = ''; // Search term for menu list

function isMenuItemTimeAvailable(item) {
    if (!item.limitedEndDate) {
        return true; // No end date set, always available
    }
    
    try {
        const fns = window.firestoreFunctions;
        if (!fns || !fns.Timestamp) {
            return true; // Can't check, assume available
        }
        
        const now = fns.Timestamp.now();
        let endDate = item.limitedEndDate;
        let endDateTimestamp = null;
        
        // Convert limitedEndDate to Timestamp if needed
        if (endDate && typeof endDate.toDate === 'function') {
            endDateTimestamp = endDate;
        } else if (endDate && endDate.seconds !== undefined) {
            if (endDate.nanoseconds !== undefined) {
                endDateTimestamp = fns.Timestamp.fromMillis(endDate.seconds * 1000 + Math.floor(endDate.nanoseconds / 1000000));
            } else {
                endDateTimestamp = fns.Timestamp.fromMillis(endDate.seconds * 1000);
            }
        } else if (endDate && endDate._seconds !== undefined) {
            const seconds = endDate._seconds || endDate.seconds;
            const nanoseconds = endDate._nanoseconds || endDate.nanoseconds || 0;
            endDateTimestamp = fns.Timestamp.fromMillis(seconds * 1000 + Math.floor(nanoseconds / 1000000));
        } else if (endDate) {
            try {
                const date = endDate.toDate ? endDate.toDate() : new Date(endDate);
                if (!isNaN(date.getTime())) {
                    endDateTimestamp = fns.Timestamp.fromDate(date);
                }
            } catch (e) {
                return true; // Can't parse, assume available
            }
        }
        
        if (!endDateTimestamp) {
            return true; // Can't parse, assume available
        }
        
        // Check if end date has passed (compare using milliseconds)
        const endMillis = endDateTimestamp.toMillis();
        const nowMillis = now.toMillis();
        if (endMillis <= nowMillis) {
            return false; // End date has passed
        }
        
        // Check if start date hasn't been reached yet
        if (item.limitedStartDate) {
            let startDate = item.limitedStartDate;
            let startDateTimestamp = null;
            
            if (startDate && typeof startDate.toDate === 'function') {
                startDateTimestamp = startDate;
            } else if (startDate && startDate.seconds !== undefined) {
                if (startDate.nanoseconds !== undefined) {
                    startDateTimestamp = fns.Timestamp.fromMillis(startDate.seconds * 1000 + Math.floor(startDate.nanoseconds / 1000000));
                } else {
                    startDateTimestamp = fns.Timestamp.fromMillis(startDate.seconds * 1000);
                }
            } else if (startDate && startDate._seconds !== undefined) {
                const seconds = startDate._seconds || startDate.seconds;
                const nanoseconds = startDate._nanoseconds || startDate.nanoseconds || 0;
                startDateTimestamp = fns.Timestamp.fromMillis(seconds * 1000 + Math.floor(nanoseconds / 1000000));
            } else if (startDate) {
                try {
                    const date = startDate.toDate ? startDate.toDate() : new Date(startDate);
                    if (!isNaN(date.getTime())) {
                        startDateTimestamp = fns.Timestamp.fromDate(date);
                    }
                } catch (e) {
                    return true; // Can't parse, assume available
                }
            }
            
            if (startDateTimestamp) {
                const startMillis = startDateTimestamp.toMillis();
                const nowMillis = now.toMillis();
                if (startMillis > nowMillis) {
                    return false; // Start date hasn't been reached yet
                }
            }
        }
        
        return true; // Within time range
    } catch (error) {
        console.warn('Error checking menu item time availability:', error);
        return true; // On error, assume available
    }
}

function applyMenuFilter(items) {
    if (!items || !items.length) return [];
    
    let filtered = [...items];
    
    // Filter by status
    if (currentMenuFilter.status === 'active') {
        filtered = filtered.filter(item => {
            // Check both isActive status and time-based availability
            const isActive = item.isActive !== false && item.isDeleted !== true;
            const isTimeAvailable = isMenuItemTimeAvailable(item);
            return isActive && isTimeAvailable;
        });
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
    const expandedItems = expandMenuItemsForRender(filteredItems);
    
    if (!expandedItems.length) {
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

    const sortedItems = [...expandedItems].sort((a, b) => a.name.localeCompare(b.name));
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
        const detailId = item.parentId || item.id;
        const buttonsSection = `
            <div class="menu-card-buttons">
                <button class="menu-card-button" type="button" onclick="showMenuDetailForItem('${detailId}')">View Details</button>
            </div>
        `;
        
        card.style.position = 'relative';
        const titleRow = isDeleted 
            ? `
                <div class="menu-card-title-row">
                    <h4 class="menu-card-title">${displayName}</h4>
                    <div class="menu-card-meatball-menu">
                        <button class="meatball-menu-btn" type="button" onclick="toggleMeatballMenu('${detailId}')" aria-label="Menu options">
                            <i class="fas fa-ellipsis-v"></i>
                        </button>
                        <div class="meatball-menu-dropdown" id="meatballMenu_${detailId}" style="display: none;">
                            <button class="meatball-menu-item" onclick="restoreMenuItem('${detailId}')">
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
                        <span class="stat-label">Purchased Orders:</span>
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

function calculateAvailableQuantity(menuItem, variation = null) {
    // Recipe-based system: availability is only based on daily serving limits
    if (!menuItem) return 0;
    
    // If no daily serving limit is set, return unlimited (999999 for display purposes)
    const maxServings = menuItem.maxServingsPerDay;
    if (!maxServings || maxServings <= 0) {
        return 999999; // Unlimited
    }
    
    // Get today's serving count
    const todayCount = todayServingsCache[menuItem.id] || 0;
    
    // Calculate remaining available
    const available = Math.max(0, maxServings - todayCount);
    return available;
}

function getMenuItemStatus(menuItem) {
    // Check for deleted status first
    if (menuItem && menuItem.isDeleted === true) {
        return { label: 'For Deletion', className: 'for-deleted' };
    }
    
    // Check if item has expired (past limitedEndDate)
    if (menuItem && !isMenuItemTimeAvailable(menuItem)) {
        return { label: 'Unavailable', className: 'unavailable' };
    }
    
    if (menuItem && menuItem.isActive === false) {
        return { label: 'Unavailable', className: 'unavailable' };
    }
    
    // Use getMenuServingInfo: available = min(quantity, dailyLimit - servedToday); covers variations
    const si = getMenuServingInfo(menuItem);
    return { label: si.label, className: si.className };
}

function getMenuItemDisplayPrice(menuItem) {
    if (!menuItem) return 0;

    const basePrice = parseMoney(menuItem.price);
    const candidatePrices = [];
    if (basePrice > 0) candidatePrices.push(basePrice);

    if (Array.isArray(menuItem.variations) && menuItem.variations.length) {
        menuItem.variations.forEach(v => {
            const candidates = [
                parseMoney(v?.price),
                parseMoney(v?.sellingPrice),
                parseMoney(v?.regularPrice),
                parseMoney(v?.displayPrice)
            ].filter(p => p > 0);
            candidatePrices.push(...candidates);
        });
    }

    if (!candidatePrices.length) return 0;
    return Math.min(...candidatePrices);
}

// Expand menu items so that each variation becomes its own renderable item
function expandMenuItemsForRender(items) {
    if (!Array.isArray(items)) return [];
    const expanded = [];

    items.forEach(item => {
        const hasVariations = Array.isArray(item.variations) && item.variations.length > 0;
        if (hasVariations) {
            const baseImage = item.imageDataUrl;
            const baseCategory = item.category;
            const baseDescription = item.description;
            const baseMenuId = item.menuId || item.id || '—';
            const parentId = item.id || baseMenuId;
            const parentActive = item.isActive !== false;

            item.variations.forEach((variation, index) => {
                const variationId = variation.variationId || variation.id || generateVariationId();
                const variationName = variation.name || `${item.name || 'Variation'} ${index + 1}`;
                const variationPrice = parseMoney(
                    variation.price ??
                    variation.sellingPrice ??
                    variation.regularPrice ??
                    variation.displayPrice ??
                    variation.unitPrice ??
                    variation.priceValue ??
                    variation.amount ??
                    variation.cost ??
                    0
                );
                const variationQuantity = typeof variation.quantity === 'number' && !Number.isNaN(variation.quantity)
                    ? variation.quantity
                    : Number(item.quantity || 0);
                const variationActive = variation.isActive !== false && parentActive;

                expanded.push({
                    ...item,
                    id: `${parentId}__${variationId}`,
                    menuId: `${baseMenuId}-${variationId}`,
                    parentId,
                    parentMenuId: baseMenuId,
                    isVariation: true,
                    variationId,
                    variations: [], // avoid nesting
                    name: variationName,
                    displayName: variationName,
                    price: variationPrice,
                    quantity: variationQuantity,
                    isActive: variationActive,
                    imageDataUrl: baseImage,
                    category: baseCategory,
                    description: variation.description || baseDescription
                });
            });
        } else {
            expanded.push(item);
        }
    });

    return expanded;
}

function isOrderPaid(order) {
    if (!order) return false;
    const status = (order.status || '').toLowerCase();
    const paymentStatus = (order.paymentStatus || order.payment_status || '').toLowerCase();
    return order.paymentVerified === true ||
           !!order.paymentVerifiedAt ||
           status === 'delivered' ||
           status === 'completed' ||
           status === 'paid' ||
           paymentStatus === 'paid';
}

function getMenuItemOrderCount(menuItem) {
    if (!menuItem || !Array.isArray(ordersState) || !ordersState.length) {
        return 0;
    }
    
    // Count ALL orders in database EXCEPT cancelled/failed ones
    // This reserves quantity as soon as order is created (even if pending)
    // Cart items are NOT in orders database, so they don't affect quantity
    // Quantity is automatically released when order is cancelled
    const activeOrders = ordersState.filter(order => {
        if (!order) return false;
        const status = (order.status || '').toLowerCase().trim();
        const isCancelled = status === 'cancelled' || status === 'canceled' || status === 'failed';
        return !isCancelled; // Include: pending, preparing, ready, delivered, completed, etc.
    });
    
    if (!activeOrders.length) return 0;
    
    const idCandidates = [
        (menuItem.menuId || '').toLowerCase(),
        (menuItem.id || '').toLowerCase(),
        (menuItem.name || '').toLowerCase()
    ].filter(Boolean);
    if (!idCandidates.length) return 0;

    let count = 0;
    activeOrders.forEach(order => {
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
    const priceInput = document.getElementById('menuDetailPriceInput');
    const availabilityInput = document.getElementById('menuDetailAvailabilityInput');
    const categoryInput = document.getElementById('menuDetailCategoryInput');
    const descriptionInput = document.getElementById('menuDetailDescriptionInput');
    const caloriesEl = document.getElementById('menuDetailCalories');
    const caloriesInput = document.getElementById('menuDetailCaloriesInput');

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
                <div class="menu-detail-image-overlay">
                    <div class="menu-detail-image-caption" id="menuDetailName">${displayName || 'Menu item'}</div>
                    <div class="menu-detail-category-badge" id="menuDetailCategoryBadge">${item.category || 'Uncategorized'}</div>
                </div>
            `;
            
            // Get the new image element and add handlers
            const newImageEl = document.getElementById('menuDetailImage');
            if (newImageEl) {
                newImageEl.onerror = function() {
                    console.warn('Product Detail - Failed to load image:', item.imageDataUrl);
                    imageContainer.innerHTML = `
                        <div class="menu-detail-image-placeholder">${(displayName || '?').charAt(0).toUpperCase()}</div>
                        <div class="menu-detail-image-overlay">
                            <div class="menu-detail-image-caption" id="menuDetailName">${displayName || 'Menu item'}</div>
                            <div class="menu-detail-category-badge" id="menuDetailCategoryBadge">${item.category || 'Uncategorized'}</div>
                        </div>
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
                <div class="menu-detail-image-overlay">
                    <div class="menu-detail-image-caption" id="menuDetailName">${displayName || 'Menu item'}</div>
                    <div class="menu-detail-category-badge" id="menuDetailCategoryBadge">${item.category || 'Uncategorized'}</div>
                </div>
            `;
        }
    }

    // Update image caption and category badge (if not already set in image container)
    const categoryBadge = document.getElementById('menuDetailCategoryBadge');
    
    // Update name and displayName fields
    const nameEl = document.getElementById('menuDetailName');
    const nameInput = document.getElementById('menuDetailNameInput');
    const displayNameEl = document.getElementById('menuDetailDisplayName');
    const displayNameInput = document.getElementById('menuDetailDisplayNameInput');
    
    if (nameEl) nameEl.textContent = item.name || '—';
    if (nameInput) nameInput.value = item.name || '';
    if (displayNameEl) displayNameEl.textContent = item.displayName || '—';
    if (displayNameInput) displayNameInput.value = item.displayName || '';
    
    if (captionEl) {
        captionEl.textContent = item.displayName || item.name || 'Menu item';
    }
    
    if (categoryBadge) {
        categoryBadge.textContent = item.category || 'Uncategorized';
    }
    
    if (priceEl) priceEl.textContent = `PHP ${getMenuItemDisplayPrice(item).toFixed(2)}`;
    if (availabilityEl) availabilityEl.textContent = statusInfo.label || '—';
    if (categoryEl) categoryEl.textContent = item.category || 'Uncategorized';
    if (menuIdEl) menuIdEl.textContent = item.menuId || item.id || '—';
    if (ordersCountEl) ordersCountEl.textContent = String(ordersCount || 0);
    if (descriptionEl) descriptionEl.textContent = item.description || '—';
    if (caloriesEl) caloriesEl.textContent = item.calories ? `${item.calories} kcal` : '—';
    if (caloriesInput) caloriesInput.value = item.calories || '';
    
    // Show/hide edit button in Menu Variation tab based on active status
    const menuVariationEditActions = document.getElementById('menuVariationEditActions');
    const menuVariationEditBtn = document.getElementById('menuVariationEditBtn');
    const menuVariationDiscardBtn = document.getElementById('menuVariationDiscardBtn');
    if (menuVariationEditActions && menuVariationEditBtn) {
        const isActive = item.isActive !== false;
        menuVariationEditActions.style.display = isActive ? 'block' : 'none';
        if (menuVariationEditBtn) {
            menuVariationEditBtn.textContent = menuDetailEditing ? 'Save' : 'Edit';
        }
        if (menuVariationDiscardBtn) {
            menuVariationDiscardBtn.style.display = menuDetailEditing ? 'inline-block' : 'none';
        }
    }
    
    const allergensEl = document.getElementById('menuDetailAllergens');
    const allergensInput = document.getElementById('menuDetailAllergensInput');
    if (allergensEl) allergensEl.textContent = item.allergens || '—';
    if (allergensInput) allergensInput.value = item.allergens || '';

    if (priceInput) priceInput.value = Number(item.price || 0).toFixed(2);
    if (availabilityInput) availabilityInput.value = String(item.isActive !== false);
    if (categoryInput) {
        const categoryValue = item.category || 'Popular';
        categoryInput.value = categoryValue;
    }
    if (descriptionInput) descriptionInput.value = item.description || '';
    if (allergensInput) allergensInput.value = item.allergens || '';

    // Update Link Sauces checkboxes
    const includedSaucesContainer = document.getElementById('menuDetailIncludedSaucesContainer');
    if (includedSaucesContainer) {
        updateMenuDetailIncludedSaucesCheckboxes(item);
    }

    // Ensure the Product Info tab is selected by default whenever we render
    if (typeof setMenuDetailTab === 'function') {
        setMenuDetailTab('info');
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
                    
                    // Get variation size - use size field or name, default to 'default'
                    const variationSize = variation.size || (variation.name && variation.name !== 'Default' ? variation.name : 'default');
                    const sizeValue = (variationSize && variationSize !== 'Default') ? variationSize : 'default';
                    
                    // Get quantity (Default Daily Serving Limit)
                    const quantityValue = (variation.quantity !== undefined && variation.quantity !== null) ? Number(variation.quantity) : 0;
                    
                    // Get calories
                    const kcalValue = (variation.kcal != null && variation.kcal !== '' && !isNaN(Number(variation.kcal))) ? Number(variation.kcal) : '';
                    
                    // Get variation ID for preserving existing variations
                    const existingVariationId = variation.variationId || variation.id || generateVariationId();
                    
                    return `
                    <div class="menu-detail-variation-item menu-detail-variation-item-editable" id="${variationId}" data-variation-id="${existingVariationId}">
                        <div class="variation-item-content">
                            <div class="form-group">
                                <label>Variation Size</label>
                                <select class="form-control menu-detail-variation-size-input">
                                    <option value="default" ${sizeValue === 'default' || !sizeValue ? 'selected' : ''}>Default</option>
                                    <option value="Small" ${sizeValue === 'Small' ? 'selected' : ''}>Small</option>
                                    <option value="Medium" ${sizeValue === 'Medium' ? 'selected' : ''}>Medium</option>
                                    <option value="Large" ${sizeValue === 'Large' ? 'selected' : ''}>Large</option>
                                    <option value="Whole" ${sizeValue === 'Whole' ? 'selected' : ''}>Whole</option>
                                    <option value="Half" ${sizeValue === 'Half' ? 'selected' : ''}>Half</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Price (PHP) <span style="color: #ff8c00; font-weight: bold;">*</span></label>
                                <input type="number" class="form-control menu-detail-variation-price-input" placeholder="0.00" value="${variation.price || 0}" min="0" step="0.01" required>
                            </div>
                            <div class="form-group">
                                <label>Default Daily Serving Limit <span style="color: #ff8c00; font-weight: bold;">*</span></label>
                                <input type="number" class="form-control menu-detail-variation-quantity-input" placeholder="0" value="${quantityValue}" min="0" step="1" required>
                            </div>
                            <div class="form-group">
                                <label>Calories (kcal)</label>
                                <input type="number" class="form-control menu-detail-variation-kcal-input" placeholder="0" value="${kcalValue}" min="0" step="1">
                            </div>
                            <button type="button" class="btn btn-danger btn-sm" onclick="removeMenuDetailVariation('${variationId}')" style="flex: 0 0 auto; align-self: flex-end;">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                `;
                }).join('');
                
                // Recipe-based: ingredients are free-form text inputs, no special handlers needed
                // Unit select is always enabled and allows all unit types
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
                    const variationId = variation.variationId || variation.id || '—';
                    const variationSize = variation.size || variation.name || 'Default';
                    const quantity = (variation.quantity !== undefined && variation.quantity !== null) ? Number(variation.quantity) : 0;
                    const kcal = (variation.kcal != null && variation.kcal !== '' && !isNaN(Number(variation.kcal))) ? Number(variation.kcal) : null;
                    return `
                    <div class="menu-detail-variation-item">
                        <div class="menu-detail-variation-header">
                            <span class="menu-detail-variation-name">${variationSize}</span>
                            <span class="menu-detail-variation-price">PHP ${Number(variation.price || 0).toFixed(2)}</span>
                        </div>
                        <div class="menu-detail-variation-id" style="font-size: 0.875rem; color: #6c757d; margin-top: 4px;">ID: ${escapeHtml(variationId)}</div>
                        <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 4px; font-size: 0.875rem; color: #555;">
                            <div><strong>Daily Serving Limit:</strong> ${quantity > 0 ? quantity : 'Unlimited'}</div>
                            ${kcal !== null ? `<div><strong>Calories:</strong> ${kcal} kcal</div>` : ''}
                        </div>
                    </div>
                `;
                }).join('');
            }
        }
    }
}

// Toggle between Product Info and Menu Variation tabs in the product detail section
function setMenuDetailTab(tab) {
    const infoBtn = document.getElementById('menuDetailTabInfo');
    const variationBtn = document.getElementById('menuDetailTabMenuVariation');
    const infoContent = document.getElementById('menuDetailTabContentInfo');
    const variationContent = document.getElementById('menuDetailTabContentMenuVariation');

    if (!infoBtn || !variationBtn || !infoContent || !variationContent) {
        return;
    }

    const showMenuVariation = tab === 'menu-variation';

    infoBtn.classList.toggle('active', !showMenuVariation);
    variationBtn.classList.toggle('active', showMenuVariation);
    infoContent.style.display = showMenuVariation ? 'none' : 'block';
    variationContent.style.display = showMenuVariation ? 'block' : 'none';
    
    // Update edit button visibility when switching tabs
    if (menuState && menuState.length && currentMenuDetailIndex >= 0) {
        const item = menuState[currentMenuDetailIndex];
        const menuVariationEditActions = document.getElementById('menuVariationEditActions');
        const menuVariationEditBtn = document.getElementById('menuVariationEditBtn');
        const menuVariationDiscardBtn = document.getElementById('menuVariationDiscardBtn');
        if (menuVariationEditActions && menuVariationEditBtn && showMenuVariation) {
            const isActive = item.isActive !== false;
            menuVariationEditActions.style.display = isActive ? 'block' : 'none';
            if (menuVariationEditBtn) {
                menuVariationEditBtn.textContent = menuDetailEditing ? 'Save' : 'Edit';
            }
            if (menuVariationDiscardBtn) {
                menuVariationDiscardBtn.style.display = menuDetailEditing ? 'inline-block' : 'none';
            }
        }
    }
}

function toggleMenuVariationEdit() {
    // Use the same edit function as Product Info
    toggleMenuDetailEdit();
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

    const nameInput = document.getElementById('menuDetailNameInput');
    const displayNameInput = document.getElementById('menuDetailDisplayNameInput');
    const priceInput = document.getElementById('menuDetailPriceInput');
    const availabilityInput = document.getElementById('menuDetailAvailabilityInput');
    const categoryInput = document.getElementById('menuDetailCategoryInput');
    const descriptionInput = document.getElementById('menuDetailDescriptionInput');
    const allergensInput = document.getElementById('menuDetailAllergensInput');
    const caloriesInput = document.getElementById('menuDetailCaloriesInput');
    const caloriesEl = document.getElementById('menuDetailCalories');

    const nameValue = (nameInput?.value || '').trim();
    const displayNameValue = (displayNameInput?.value || '').trim() || null;
    const priceValue = parseFloat(priceInput?.value || '0');
    const availabilityValue = availabilityInput?.value === 'true';
    // Get category from select
    const categoryValue = (categoryInput?.value || currentItem.category || 'Popular').trim();
    const descriptionValue = (descriptionInput?.value || '').trim();
    const allergensValue = (allergensInput?.value || '').trim() || null;
    const caloriesRaw = caloriesInput?.value || '';
    const caloriesValue = caloriesRaw === '' ? null : parseInt(caloriesRaw, 10);

    if (!nameValue) {
        showNotification('Dish name is required.', 'error');
        return false;
    }

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
        
        // Ingredients section removed from Product Detail - keep existing ingredients
        const ingredients = currentItem.ingredients || [];
        
        // Gather included sauces from checkboxes - same logic as Add Product form
        const includedSaucesContainer = document.getElementById('menuDetailIncludedSaucesContainer');
        const includedSauces = [];
        if (includedSaucesContainer) {
            const checkedBoxes = includedSaucesContainer.querySelectorAll('input[type="checkbox"]:checked');
            checkedBoxes.forEach(checkbox => {
                if (checkbox.value && checkbox.value.trim()) {
                    const sauceItem = menuState.find(item => item.id === checkbox.value);
                    if (sauceItem) {
                        includedSauces.push({
                            sauceId: sauceItem.id,
                            sauceName: sauceItem.displayName || sauceItem.name,
                            menuId: sauceItem.menuId || sauceItem.id
                        });
                    }
                }
            });
        }
        
        // If variations exist, set base price to the smallest variation price
        let finalBasePrice = +Number(priceValue).toFixed(2);
        if (variations && variations.length > 0) {
            const variationPrices = variations
                .map(v => parseMoney(v.price || v.sellingPrice || v.regularPrice || v.displayPrice || 0))
                .filter(p => p > 0);
            if (variationPrices.length > 0) {
                finalBasePrice = Math.min(...variationPrices);
            }
        }
        
        const payload = {
            name: nameValue,
            displayName: displayNameValue,
            price: finalBasePrice, // Set to smallest variation price if variations exist
            isActive: availabilityValue,
            category: categoryValue,
            deliveryCharge: 0, // Set to 0 since delivery charge field is removed
            description: descriptionValue,
            allergens: allergensValue,
            kcalUnit: caloriesValue,
            variations: variations,
            ingredients: ingredients,
            includedSauces: includedSauces.length > 0 ? includedSauces : null,
            imageDataUrl: newImageUrl
        };
        
        console.log('Product Detail - Saving changes with payload:', {
            name: payload.name,
            displayName: payload.displayName,
            includedSauces: payload.includedSauces,
            includedSaucesCount: includedSauces.length
        });
        
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
    const promotionSection = document.getElementById('promotionDashboard');
    const bannerCatalogueSection = document.getElementById('bannerCatalogue');
    const tableNumbersSection = document.getElementById('tableNumbers');
    const ingredientLogsSection = document.getElementById('ingredient-logs');
    const ingredientLogsTableWrapper = document.getElementById('ingredient-logs-table-wrapper');
    const catalogueGrid = document.getElementById('menu-catalogue-grid');
    const menuListTable = document.getElementById('menu-list');
    if (foodSection) foodSection.style.display = 'block';
    if (bannerCatalogueSection) bannerCatalogueSection.style.display = 'none';
    if (tableNumbersSection) tableNumbersSection.style.display = 'none';
    if (ingredientLogsSection) ingredientLogsSection.style.display = 'none';
    if (ingredientLogsTableWrapper) ingredientLogsTableWrapper.style.display = 'none';
    if (catalogueGrid) {
        catalogueGrid.style.display = 'block';
        catalogueGrid.style.visibility = 'visible';
    }
    if (menuListTable) {
        menuListTable.style.display = 'none';
        menuListTable.style.visibility = 'hidden';
        // Stop reset time countdown when menu list is hidden
        stopResetTimeCountdown();
        // Also hide the detail panel if it's open
        const detailPanel = document.getElementById('menuListDetailPanel');
        if (detailPanel) {
            detailPanel.style.display = 'none';
            detailPanel.style.visibility = 'hidden';
        }
    }
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (productDetailSection) productDetailSection.style.display = 'none';
    if (promotionSection) promotionSection.style.display = 'none';
    menuDetailVisible = false;
    menuDetailEditing = false;
    renderMenuDetailsCarousel();
    // Render catalogue items
    renderMenuItemsTable(menuState);
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

async function showMenuList() {
    // Update category filter when showing menu list
    updateMenuListCategoryFilter();
    // Show list table (active items only), hide catalogue cards, add product + product detail
    const foodSection = document.getElementById('foodSection');
    const addFoodSection = document.getElementById('addFoodDashboard');
    const productDetailSection = document.getElementById('menu-product-detail');
    const promotionSection = document.getElementById('promotionDashboard');
    const bannerCatalogueSection = document.getElementById('bannerCatalogue');
    const tableNumbersSection = document.getElementById('tableNumbers');
    const ingredientLogsSection = document.getElementById('ingredient-logs');
    const ingredientLogsTableWrapper = document.getElementById('ingredient-logs-table-wrapper');
    const catalogueGrid = document.getElementById('menu-catalogue-grid');
    const menuListTable = document.getElementById('menu-list');
    if (foodSection) foodSection.style.display = 'block';
    if (bannerCatalogueSection) bannerCatalogueSection.style.display = 'none';
    if (tableNumbersSection) tableNumbersSection.style.display = 'none';
    if (ingredientLogsSection) ingredientLogsSection.style.display = 'none';
    if (ingredientLogsTableWrapper) ingredientLogsTableWrapper.style.display = 'none';
    if (catalogueGrid) {
        catalogueGrid.style.display = 'none';
        catalogueGrid.style.visibility = 'hidden';
    }
    if (menuListTable) {
        menuListTable.style.display = 'flex';
        menuListTable.style.visibility = 'visible';
        // Start reset time countdown when menu list is shown
        // (renderMenuListTable will also start it, but this ensures it's started)
    }
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (productDetailSection) productDetailSection.style.display = 'none';
    if (promotionSection) promotionSection.style.display = 'none';
    menuDetailVisible = false;
    menuDetailEditing = false;
    renderMenuDetailsCarousel();
    
    // Initialize quantity mode toggle
    await renderMenuListTable();
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
    const promotionSection = document.getElementById('promotionDashboard');
    const bannerCatalogueSection = document.getElementById('bannerCatalogue');
    const tableNumbersSection = document.getElementById('tableNumbers');
    const ingredientLogsSection = document.getElementById('ingredient-logs');
    const ingredientLogsTableWrapper = document.getElementById('ingredient-logs-table-wrapper');
    if (foodSection) foodSection.style.display = 'none';
    if (addFoodSection) addFoodSection.style.display = 'block';
    if (productDetailSection) productDetailSection.style.display = 'none';
    if (promotionSection) promotionSection.style.display = 'none';
    if (bannerCatalogueSection) bannerCatalogueSection.style.display = 'none';
    if (tableNumbersSection) tableNumbersSection.style.display = 'none';
    if (ingredientLogsSection) ingredientLogsSection.style.display = 'none';
    if (ingredientLogsTableWrapper) ingredientLogsTableWrapper.style.display = 'none';
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
    const promotionSection = document.getElementById('promotionDashboard');
    const bannerCatalogueSection = document.getElementById('bannerCatalogue');
    const tableNumbersSection = document.getElementById('tableNumbers');
    const ingredientLogsSection = document.getElementById('ingredient-logs');
    const ingredientLogsTableWrapper = document.getElementById('ingredient-logs-table-wrapper');
    if (foodSection) foodSection.style.display = 'none';
    if (promotionSection) promotionSection.style.display = 'none';
    if (bannerCatalogueSection) bannerCatalogueSection.style.display = 'none';
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (tableNumbersSection) tableNumbersSection.style.display = 'none';
    if (ingredientLogsSection) ingredientLogsSection.style.display = 'none';
    if (ingredientLogsTableWrapper) ingredientLogsTableWrapper.style.display = 'none';
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
        ['menuDetailName', 'menuDetailNameInput'],
        ['menuDetailDisplayName', 'menuDetailDisplayNameInput'],
        ['menuDetailPrice', 'menuDetailPriceInput'],
        ['menuDetailAvailability', 'menuDetailAvailabilityInput'],
        ['menuDetailCategory', 'menuDetailCategoryInputWrapper'],
        ['menuDetailDescription', 'menuDetailDescriptionInput'],
        ['menuDetailAllergens', 'menuDetailAllergensInput'],
        ['menuDetailCalories', 'menuDetailCaloriesInput']
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
    const saveBtn = document.getElementById('menuDetailSaveBtn');
    const saveBottomBtn = document.getElementById('menuDetailSaveBottomBtn');
    
    if (discardBtn) {
        discardBtn.style.display = isEditing ? 'inline-block' : 'none';
    }
    if (saveBtn) {
        saveBtn.style.display = isEditing ? 'inline-block' : 'none';
    }
    if (saveBottomBtn) {
        saveBottomBtn.style.display = isEditing ? 'inline-block' : 'none';
    }
    // Update Menu Variation tab edit button
    const menuVariationEditBtn = document.getElementById('menuVariationEditBtn');
    const menuVariationDiscardBtn = document.getElementById('menuVariationDiscardBtn');
    if (menuVariationEditBtn) {
        menuVariationEditBtn.textContent = isEditing ? 'Save' : 'Edit';
    }
    if (menuVariationDiscardBtn) {
        menuVariationDiscardBtn.style.display = isEditing ? 'inline-block' : 'none';
    }
    // Show/hide change image button
    const changeImageRow = document.getElementById('menuDetailChangeImageRow');
    if (changeImageRow) {
        changeImageRow.style.display = isEditing ? 'block' : 'none';
    }
    // Show/hide Link Sauces section (only in edit mode)
    const linkSaucesRow = document.getElementById('menuDetailLinkSaucesRow');
    if (linkSaucesRow) {
        linkSaucesRow.style.display = isEditing ? 'block' : 'none';
        // If entering edit mode, update the Link Sauces checkboxes with current selections
        if (isEditing && menuState && menuState.length && currentMenuDetailIndex >= 0) {
            const currentItem = menuState[currentMenuDetailIndex];
            if (currentItem && typeof updateMenuDetailIncludedSaucesCheckboxes === 'function') {
                // Small delay to ensure the container is visible before updating
                setTimeout(() => {
                    updateMenuDetailIncludedSaucesCheckboxes(currentItem);
                }, 50);
            }
        }
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
        // Update Link Sauces checkboxes when entering edit mode
        if (typeof updateMenuDetailIncludedSaucesCheckboxes === 'function') {
            updateMenuDetailIncludedSaucesCheckboxes(currentItem);
        }
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

// Recipe-based system: ingredients are informational only, no missing ingredients check needed
function getMissingIngredientsForDish(menuItem) {
    // Always return empty - ingredients are just recipe information
    return [];
}

// Recipe-based: ingredients are free-form, no need to populate from inventory
function updateMenuIngredientsOptions(items) {
    // In recipe-based system, ingredients can be entered freely
    // This function is kept for compatibility but does nothing
    const datalist = document.getElementById('menuIngredientsOptions');
    if (!datalist) return;
    // Optionally, we could populate from existing menu items' ingredients
    // For now, leave empty to allow free-form entry
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
    // Recipe-based: allow free-form ingredient entry
    const amountInput = row.querySelector('.dish-ingredient-amount');
    const unitSelect = row.querySelector('.dish-ingredient-unit');

    if (ingredientName && ingredientName.trim()) {
        // Create a basic ingredient object for the row
        const slug = ingredientName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        row.dataset.ingredientId = slug;
        
        // Default to weight units, but allow user to change
        if (unitSelect) {
            unitSelect.innerHTML = `
                <option value="g">Grams (g)</option>
                <option value="kg">Kilograms (kg)</option>
                <option value="pcs">Pieces (pcs)</option>
            `;
            unitSelect.value = 'g';
            unitSelect.disabled = false;
        }
        if (amountInput) {
            amountInput.step = '0.01';
            amountInput.placeholder = '0.00';
        }
    } else {
        row.dataset.ingredientId = '';
        if (unitSelect) {
            unitSelect.innerHTML = '<option value="g">Grams (g)</option><option value="kg">Kilograms (kg)</option><option value="pcs">Pieces (pcs)</option>';
            unitSelect.value = 'g';
            unitSelect.disabled = false;
        }
    }
}

// Add ingredient row in product details
function addMenuDetailIngredientRow(prefill = {}) {
    const container = document.getElementById('menuDetailIngredientsList');
    if (!container) return;
    
    const rowId = `menuDetailIngredient_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const row = document.createElement('tr');
    row.className = 'menu-detail-ingredient-row';
    row.id = rowId;
    
    // Parse unit value - normalize from existing data
    let unitValue = prefill.unit || 'kg';
    // Normalize unit values from existing data
    if (unitValue === 'g' || unitValue === 'grams' || unitValue === 'gram') {
        unitValue = 'kg'; // Convert grams to kg for consistency
    } else if (unitValue === 'pieces' || unitValue === 'piece') {
        unitValue = 'pcs';
    }
    
    const unitOptions = `
        <option value="kg" ${unitValue === 'kg' ? 'selected' : ''}>Kilograms (kg)</option>
        <option value="pcs" ${unitValue === 'pcs' ? 'selected' : ''}>Pieces (pcs)</option>
    `;
    
    row.innerHTML = `
        <td style="padding: 8px;">
            <input type="text" class="form-control menu-detail-ingredient-name" placeholder="e.g., Chicken" value="${prefill.name || ''}" list="menuIngredientsOptions" style="width: 100%;">
        </td>
        <td style="padding: 8px;">
            <input type="number" class="form-control menu-detail-ingredient-amount" min="0" step="0.01" placeholder="0.00" value="${prefill.amount || ''}" style="width: 100%;">
        </td>
        <td style="padding: 8px;">
            <select class="form-control menu-detail-ingredient-unit" style="width: 100%;">
                ${unitOptions}
            </select>
        </td>
        <td style="padding: 8px; width: 50px;">
            <button type="button" class="btn btn-danger btn-sm" onclick="removeMenuDetailIngredientRow('${rowId}')" style="width: 100%;">
                <i class="fas fa-trash"></i>
            </button>
        </td>
    `;
    
    container.appendChild(row);
    
    // Show table if it was hidden
    const ingredientsTable = document.getElementById('menuDetailIngredientsTable');
    if (ingredientsTable) {
        ingredientsTable.style.display = 'table';
    }
}

// Remove ingredient row from product details
function removeMenuDetailIngredientRow(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;
    
    const container = document.getElementById('menuDetailIngredientsList');
    if (!container) return;
    
    // If it's the last row, just clear it instead of removing
    if (container.children.length <= 1) {
        const nameInput = row.querySelector('.menu-detail-ingredient-name');
        const amountInput = row.querySelector('.menu-detail-ingredient-amount');
        const unitSelect = row.querySelector('.menu-detail-ingredient-unit');
        if (nameInput) nameInput.value = '';
        if (amountInput) amountInput.value = '';
        if (unitSelect) unitSelect.value = 'kg';
    } else {
        row.remove();
    }
}

// Gather ingredients from product details edit form
function gatherMenuDetailIngredients() {
    const container = document.getElementById('menuDetailIngredientsList');
    if (!container) return [];
    
    const ingredientRows = container.querySelectorAll('.menu-detail-ingredient-row');
    const ingredients = [];
    
    ingredientRows.forEach(row => {
        const nameInput = row.querySelector('.menu-detail-ingredient-name');
        const amountInput = row.querySelector('.menu-detail-ingredient-amount');
        const unitSelect = row.querySelector('.menu-detail-ingredient-unit');
        
        const ingredientName = (nameInput?.value || '').trim();
        const amountValue = parseFloat(amountInput?.value || '0');
        const unit = (unitSelect?.value || 'kg').trim();
        
        // Only add ingredients that have a name
        if (ingredientName) {
            const slug = ingredientName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const unitType = (unit === 'pcs') ? 'count' : 'weight';
            
            // Create display amount
            let displayAmount = '';
            if (amountValue > 0) {
                if (unit === 'pcs') {
                    displayAmount = `${Math.round(amountValue)} pcs`;
                } else if (unit === 'kg') {
                    displayAmount = `${amountValue.toFixed(2)} kg`;
                }
            }
            
            ingredients.push({
                ingredientId: slug,
                ingredientName: ingredientName,
                amount: amountValue,
                unit: unit,
                unitType: unitType,
                displayAmount: displayAmount
            });
        }
    });
    
    return ingredients;
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

        // Recipe-based: ingredients are free-form, no inventory validation needed
        if (ingredientName) {
            // Amount must be greater than zero if ingredient is specified
            if (!amountValue || amountValue <= 0) {
                throw new Error(`Amount for ${ingredientName} must be greater than zero.`);
            }

            // Determine unit type from unit select or default to weight
            const unit = unitSelect?.value || 'g';
            const unitType = (unit === 'pcs') ? 'count' : 'weight';
            
            // Get or create ingredient object
            const ingredient = findIngredientInStateByName(ingredientName);
            const finalIngredient = ingredient || {
                id: ingredientName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                name: ingredientName,
                unitType: unitType,
                baseUnit: unitType === 'count' ? 'pcs' : 'g'
            };
            
            const baseAmount = convertToBaseUnits(amountValue, unitType, unit);
            const displayAmount = unitType === 'count'
                ? `${formatQuantityValue(amountValue, 0)} pcs`
                : `${formatQuantityValue(amountValue, unit === 'kg' ? 2 : 0)} ${unit}`;
            
            collected.push({
                ingredient: finalIngredient,
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

    console.log('[Date Debug] Form submit started');
    const form = document.getElementById('menuItemForm');
    if (!form) {
        console.warn('[Date Debug] Form not found');
        return;
    }

    // Get category from select
    const categorySelect = form.querySelector('#category');
    const category = (categorySelect?.value || 'Popular').trim();
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
    const priceValue = parseFloat(form.querySelector('#price')?.value || '0');
    const quantityRaw = form.querySelector('#quantity')?.value || '';
    const quantityValue = quantityRaw === '' ? 0 : parseInt(quantityRaw, 10);
    const caloriesRaw = form.querySelector('#calories')?.value || '';
    const caloriesValue = caloriesRaw === '' ? null : parseInt(caloriesRaw, 10);
    const description = (form.querySelector('#description')?.value || '').trim();

    const hasFormVariations = addFormVariations.length > 0;
    const hasVariation = !!document.getElementById('hasVariation')?.checked;

    if (hasVariation && addFormVariations.length === 0) {
        showNotification('Add at least one variation.', 'error');
        return;
    }

    if (!foodName && !hasFormVariations) {
        showNotification('Please enter a product name.', 'error');
        return;
    }

    if ((!priceValue || priceValue <= 0) && !hasFormVariations) {
        showNotification('Please enter a price greater than zero.', 'error');
        return;
    }

    if (Number.isNaN(quantityValue) || quantityValue < 0) {
        showNotification('Default daily serving limit must be zero or a positive whole number.', 'error');
        return;
    }

    if (!description && !hasFormVariations) {
        showNotification('Please enter a description.', 'error');
        return;
    }

    // When product has variations, use sum of variation quantities and first variation's kcal for top-level
    let quantityValueFinal = quantityValue;
    let caloriesValueFinal = caloriesValue;
    if (hasFormVariations) {
        quantityValueFinal = addFormVariations.reduce(function (s, v) {
            return s + (typeof v.quantity === 'number' && !Number.isNaN(v.quantity) ? v.quantity : 0);
        }, 0);
        const firstV = addFormVariations[0];
        caloriesValueFinal = (firstV && firstV.kcal != null && firstV.kcal !== '' && !isNaN(Number(firstV.kcal)))
            ? parseInt(Number(firstV.kcal), 10) : null;
    }

    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }

        // Recipe-based: no inventory needed

        const slugSource = foodId || foodName || (hasFormVariations ? (addFormVariations[0]?.name || '') : '');
        const slugify = MenuStore.slugifyName || ((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        const slug = slugify(slugSource);
        let baseNameForFormatting = foodName || (hasFormVariations ? (addFormVariations[0]?.name || '') : '');
        if (!baseNameForFormatting) {
            baseNameForFormatting = 'New Menu Item';
        }
        const formattedName = formatIngredientLabel(baseNameForFormatting);
        
        // Extract included sauces from checkboxes
        const includedSaucesContainer = document.getElementById('includedSaucesContainer');
        const includedSauces = [];
        if (includedSaucesContainer) {
            const checkedBoxes = includedSaucesContainer.querySelectorAll('input[type="checkbox"]:checked');
            checkedBoxes.forEach(checkbox => {
                if (checkbox.value && checkbox.value.trim()) {
                    const sauceItem = menuState.find(item => item.id === checkbox.value);
                    if (sauceItem) {
                        includedSauces.push({
                            sauceId: sauceItem.id,
                            sauceName: sauceItem.displayName || sauceItem.name,
                            menuId: sauceItem.menuId || sauceItem.id
                        });
                    }
                }
            });
        }
        
        // Convert datetime-local strings to Firestore Timestamps
        // Read from availabilityStartDate/availabilityEndDate (UI fields)
        // But save as limitedStartDate/limitedEndDate (Firebase field names)
        const availabilityStartDateInput = document.getElementById('availabilityStartDate');
        const availabilityEndDateInput = document.getElementById('availabilityEndDate');
        
        // Read values from the UI fields
        const availabilityStartDateValue = availabilityStartDateInput?.value || '';
        const availabilityEndDateValue = availabilityEndDateInput?.value || '';
        
        console.log('[Date Debug] Date inputs found:', {
            availabilityStartDateInput: !!availabilityStartDateInput,
            availabilityEndDateInput: !!availabilityEndDateInput,
            availabilityStartDateValue: availabilityStartDateValue,
            availabilityEndDateValue: availabilityEndDateValue,
            startInputInForm: form.contains(availabilityStartDateInput),
            endInputInForm: form.contains(availabilityEndDateInput),
            allFormInputs: Array.from(form.querySelectorAll('input[type="datetime-local"]')).map(inp => ({
                id: inp.id,
                value: inp.value
            }))
        });
        
        // Convert to Firestore Timestamps (will be saved as limitedStartDate/limitedEndDate)
        let limitedStartDate = null;
        let limitedEndDate = null;
        
        // Ensure Firebase is ready before converting
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !fns.Timestamp) {
            console.warn('[Date Debug] Firebase Timestamp not available');
        }
        
        if (availabilityStartDateValue && availabilityStartDateValue.trim()) {
            try {
                const date = new Date(availabilityStartDateValue.trim());
                if (!isNaN(date.getTime())) {
                    limitedStartDate = fns.Timestamp.fromDate(date);
                    console.log('[Date Debug] Converted start date:', limitedStartDate);
                } else {
                    console.warn('[Date Debug] Invalid start date:', availabilityStartDateValue);
                }
            } catch (e) {
                console.error('[Date Debug] Error converting start date:', e);
            }
        }
        
        if (availabilityEndDateValue && availabilityEndDateValue.trim()) {
            try {
                const date = new Date(availabilityEndDateValue.trim());
                if (!isNaN(date.getTime())) {
                    limitedEndDate = fns.Timestamp.fromDate(date);
                    console.log('[Date Debug] Converted end date:', limitedEndDate);
                } else {
                    console.warn('[Date Debug] Invalid end date:', availabilityEndDateValue);
                }
            } catch (e) {
                console.error('[Date Debug] Error converting end date:', e);
            }
        }
        
        console.log('[Date Debug] Final date values (to be saved as limitedStartDate/limitedEndDate):', {
            limitedStartDate,
            limitedEndDate
        });
        
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
        
        let variations;
        const hasFormVariations = addFormVariations.length > 0;

        if (hasFormVariations) {
            variations = addFormVariations.map((v, index) => {
                const q = (typeof v.quantity === 'number' && !Number.isNaN(v.quantity)) ? v.quantity : 0;
                return {
                    variationId: v.variationId || v.id || generateVariationId(),
                    id: v.variationId || v.id || generateVariationId(),
                    name: v.name || (v.size || 'Default'),
                    price: parseMoney(
                        v.price ?? v.sellingPrice ?? v.regularPrice ?? v.displayPrice ?? v.amount ?? v.cost ?? 0
                    ),
                    quantity: q,
                    maxServingsPerDay: (q > 0) ? q : null,
                    kcal: (v.kcal != null && v.kcal !== '' && !isNaN(Number(v.kcal))) ? parseInt(Number(v.kcal), 10) : null,
                    allergens: v.allergens || '',
                    description: v.description || '',
                    ingredientId: v.ingredientId || null,
                    ingredientName: v.ingredientName || null,
                    amount: typeof v.amount === 'number' ? v.amount : null,
                    displayAmount: v.displayAmount || '',
                    size: v.size || null,
                    kgUsage: null
                };
            });
        }
        // When there is no variation: do not add a variations array to Firebase; top-level price, quantity, maxServingsPerDay, kcalUnit are the default product.

        // If variations exist, set base price to the smallest variation price
        let finalBasePrice = +Number(priceValue).toFixed(2);
        if (hasFormVariations && variations && variations.length > 0) {
            const variationPrices = variations
                .map(v => parseMoney(v.price || v.sellingPrice || v.regularPrice || v.displayPrice || 0))
                .filter(p => p > 0);
            if (variationPrices.length > 0) {
                finalBasePrice = Math.min(...variationPrices);
            }
        }
        
        const menuPayload = {
            slug,
            data: {
                menuId: foodId || slug.toUpperCase(),
                name: formattedName,
                displayName: formattedName,
                category,
                price: finalBasePrice,
                quantity: quantityValueFinal,
                maxServingsPerDay: quantityValueFinal,
                kcalUnit: caloriesValueFinal,
                deliveryCharge: 0,
                description,
                allergens: (document.getElementById('allergens')?.value || '').trim() || null,
                imageDataUrl: imageUrl,
                isActive: true,
                includedSauces: includedSauces.length > 0 ? includedSauces : null,
                ...(limitedStartDate !== null ? { limitedStartDate } : {}),
                ...(limitedEndDate !== null ? { limitedEndDate } : {}),
                ...(hasFormVariations ? { variations } : {}),
                ingredients: []
            }
        };
        
        console.log('[Date Debug] Payload being sent to Firebase:', {
            limitedStartDate: menuPayload.data.limitedStartDate,
            limitedEndDate: menuPayload.data.limitedEndDate,
            limitedStartDateType: typeof menuPayload.data.limitedStartDate,
            limitedEndDateType: typeof menuPayload.data.limitedEndDate
        });

        menuState = await MenuStore.createItem(menuPayload);
        renderMenuState();
        showNotification(`${formattedName} added to the menu!`, 'success');
        // Clear collected form variations after successful save
        addFormVariations = [];
        updateFoodVariationsListUI();
        resetMenuForm();
        // Redirect to menu list after successful product addition
        await showMenuList();
        // Ensure the menu dropdown is expanded
        const menuSubmenu = document.getElementById('menuTabDropdown');
        if (menuSubmenu && !menuSubmenu.classList.contains('show')) {
            if (typeof toggleMenuTabDropdown === 'function') {
                toggleMenuTabDropdown();
            }
        }
        // Ensure the sidebar menu highlights Menu List as active
        if (typeof highlightActiveMenuItem === 'function') {
            highlightActiveMenuItem();
        }
    } catch (error) {
        console.error('Add menu item failed:', error);
        showNotification(error.message || 'Unable to add menu item.', 'error');
    }
}

// Variation management functions
let variationCounter = 0;

// Variations collected via "Add Variation" button in the Add Product form
let addFormVariations = [];
let currentFormVariationIndex = null;

function toggleHasVariation() {
    const has = !!document.getElementById('hasVariation')?.checked;
    const priceSection = document.getElementById('priceAndStockSection');
    const variationSection = document.getElementById('variationSection');
    if (priceSection) priceSection.style.display = has ? 'none' : 'block';
    if (variationSection) variationSection.style.display = has ? 'block' : 'none';
    if (!has) {
        addFormVariations = [];
        updateFoodVariationsListUI();
    }
}

function updateFoodVariationsListUI() {
    const listEl = document.getElementById('foodVariationsList');
    if (!listEl) return;

    if (!addFormVariations.length) {
        listEl.innerHTML = '<div class="empty-state">No variations added yet. Click "Add Variation" to create one.</div>';
        return;
    }

    listEl.innerHTML = addFormVariations.map((v, index) => {
        const label = v.label || `Variation ${index + 1}`;
        const nameVal = v.name || '—';
        const sizeVal = v.size || 'Default';
        const priceVal = (typeof v.price === 'number' && !isNaN(v.price)) ? `PHP ${Number(v.price).toFixed(2)}` : '—';
        const qtyVal = typeof v.quantity === 'number' && !isNaN(v.quantity) ? v.quantity : '—';
        const kcalVal = (v.kcal != null && v.kcal !== '' && !isNaN(Number(v.kcal))) ? v.kcal : '—';
        return `
            <div class="food-variation-item">
                <div class="food-variation-header">
                    <span class="food-variation-label">${label}</span>
                    <button type="button" class="variation-menu-btn" title="View & edit details" onclick="openFormVariationModal(${index})">
                        &#8942;
                    </button>
                </div>
                <div class="food-variation-fields" style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px;">
                    <div><strong>Name</strong> ${nameVal}</div>
                    <div><strong>Size</strong> ${sizeVal}</div>
                    <div><strong>Price</strong> ${priceVal}</div>
                    <div><strong>Daily Limit</strong> ${qtyVal}</div>
                    <div><strong>Kcal</strong> ${kcalVal}</div>
                </div>
            </div>
        `;
    }).join('');
}

function openFormVariationModal(index) {
    const modal = document.getElementById('formVariationModal');
    if (!modal) return;

    const titleEl = document.getElementById('formVariationModalTitle');
    const priceInput = document.getElementById('variationModalPrice');
    const qtyInput = document.getElementById('variationModalQuantity');
    const sizeSelect = document.getElementById('variationModalSize');
    const kcalInput = document.getElementById('variationModalKcal');
    const submitBtn = document.getElementById('variationModalSubmitBtn');

    if (index == null) {
        // Create mode
        currentFormVariationIndex = null;
        if (titleEl) titleEl.textContent = 'Add Variation';
        if (submitBtn) submitBtn.textContent = 'Add Variation';
        if (sizeSelect) sizeSelect.value = 'default';
        if (priceInput) priceInput.value = '';
        if (qtyInput) qtyInput.value = '';
        if (kcalInput) kcalInput.value = '';
    } else {
        // Edit mode
        if (!addFormVariations[index]) return;
        currentFormVariationIndex = index;
        const v = addFormVariations[index];
        if (titleEl) titleEl.textContent = v.label || `Variation ${index + 1}`;
        if (submitBtn) submitBtn.textContent = 'Save Changes';
        if (sizeSelect) sizeSelect.value = (v.size && v.size !== 'Default') ? v.size : 'default';
        if (priceInput) priceInput.value = (typeof v.price === 'number' && !isNaN(v.price)) ? Number(v.price).toFixed(2) : '';
        if (qtyInput) qtyInput.value = typeof v.quantity === 'number' && !isNaN(v.quantity) ? v.quantity : '';
        if (kcalInput) kcalInput.value = (v.kcal != null && v.kcal !== '' && !isNaN(Number(v.kcal))) ? v.kcal : '';
    }

    modal.style.display = 'block';
    modal.setAttribute('aria-hidden', 'false');
}

function closeFormVariationModal() {
    const modal = document.getElementById('formVariationModal');
    if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }
    currentFormVariationIndex = null;
}

function saveFormVariationModal() {
    const sizeSelect = document.getElementById('variationModalSize');
    const priceInput = document.getElementById('variationModalPrice');
    const qtyInput = document.getElementById('variationModalQuantity');
    const kcalInput = document.getElementById('variationModalKcal');

    const rawSize = (sizeSelect?.value || 'default').trim();
    const sizeLabel = (!rawSize || rawSize.toLowerCase() === 'default') ? null : rawSize;
    const price = parseFloat(priceInput?.value || '0');
    const qty = parseInt(qtyInput?.value || '0', 10);
    const kcalRaw = kcalInput?.value;
    const kcal = (kcalRaw !== '' && kcalRaw != null && !isNaN(Number(kcalRaw))) ? parseInt(kcalRaw, 10) : null;

    if (currentFormVariationIndex === null) {
        // Create: validate and push
        const form = document.getElementById('menuItemForm');
        const foodName = (form?.querySelector('#foodName')?.value || '').trim();
        if (!foodName) {
            showNotification('Please enter a product name before adding a variation.', 'error');
            return;
        }
        if (!price || price <= 0) {
            showNotification('Please enter a price greater than zero.', 'error');
            return;
        }
        if (isNaN(qty) || qty < 0) {
            showNotification('Default daily serving limit must be zero or a positive whole number.', 'error');
            return;
        }
        const variationName = sizeLabel || 'Default';

        addFormVariations.push({
            label: `Variation ${addFormVariations.length + 1}`,
            variationId: generateVariationId(),
            name: variationName,
            size: sizeLabel,
            price: +Number(price).toFixed(2),
            quantity: isNaN(qty) ? 0 : qty,
            kcal: kcal,
            description: '',
            allergens: '',
            ingredientId: null,
            ingredientName: null,
            unitType: null,
            amount: null,
            displayAmount: ''
        });
    } else {
        // Edit: update existing
        const v = addFormVariations[currentFormVariationIndex];
        if (!v) {
            closeFormVariationModal();
            return;
        }
        v.name = sizeLabel || 'Default';
        v.size = sizeLabel;
        v.price = isNaN(price) ? 0 : price;
        v.quantity = isNaN(qty) ? 0 : qty;
        v.kcal = kcal;
        v.description = '';
        v.allergens = '';
    }

    updateFoodVariationsListUI();
    closeFormVariationModal();
}

function handleAddVariationClick() {
    const hasVariation = !!document.getElementById('hasVariation')?.checked;
    if (!hasVariation) return;

    const form = document.getElementById('menuItemForm');
    if (!form) return;

    const foodName = (form.querySelector('#foodName')?.value || '').trim();
    if (!foodName) {
        showNotification('Please enter a product name before adding a variation.', 'error');
        return;
    }

    openFormVariationModal(null);
}

function addVariation() {
    const variationsList = document.getElementById('variationsList');
    if (!variationsList) return;
    
    // Get already used ingredients from existing variations
    const existingVariations = variationsList.querySelectorAll('.variation-item');
    const usedIngredientIds = new Set();
    
    existingVariations.forEach(variation => {
        // Recipe-based: ingredients are free-form, no need to track
    });
    
    // Recipe-based: ingredients are free-form, no need to check availability
    
    const variationId = `variation_${variationCounter++}`;
    const variationItem = document.createElement('div');
    variationItem.className = 'variation-item';
    variationItem.id = variationId;
    
    // Recipe-based: ingredients are free-form
    
    variationItem.innerHTML = `
        <div class="variation-item-content">
            <div class="form-group">
                <input type="text" class="form-control variation-name" placeholder="Variation name (e.g., Medium, Large)" required>
            </div>
            <div class="form-group">
                <input type="number" class="form-control variation-price" placeholder="Price (PHP)" min="0" step="0.01" required>
            </div>
            <div class="form-group">
                <input type="text" class="form-control variation-ingredient" placeholder="Ingredient name" required>
            </div>
            <div class="form-group">
                <input type="number" class="form-control variation-amount" placeholder="Amount" min="0" step="0.01">
            </div>
            <div class="form-group">
                <select class="form-control variation-unit">
                    <option value="g">Grams (g)</option>
                    <option value="kg">Kilograms (kg)</option>
                    <option value="pcs">Pieces (pcs)</option>
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
    
    // Recipe-based: ingredients are free-form, no special handlers needed
    // Unit select is always enabled
    
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
        const sizeSelect = item.querySelector('.menu-detail-variation-size-input');
        const priceInput = item.querySelector('.menu-detail-variation-price-input');
        const quantityInput = item.querySelector('.menu-detail-variation-quantity-input');
        const kcalInput = item.querySelector('.menu-detail-variation-kcal-input');
        
        const rawSize = (sizeSelect?.value || 'default').trim();
        const sizeLabel = (!rawSize || rawSize.toLowerCase() === 'default') ? null : rawSize;
        const variationName = sizeLabel || 'Default';
        const price = parseFloat(priceInput?.value || '0');
        const quantity = parseInt(quantityInput?.value || '0', 10);
        const kcalRaw = kcalInput?.value;
        const kcal = (kcalRaw !== '' && kcalRaw != null && !isNaN(Number(kcalRaw))) ? parseInt(kcalRaw, 10) : null;
        
        // Only process variations that have at least a price
        if (!isNaN(price) && price >= 0) {
            // Get variation ID if it exists (for existing variations)
            const variationId = item.dataset.variationId || generateVariationId();
            
            variations.push({
                variationId: variationId,
                id: variationId,
                name: variationName,
                size: sizeLabel,
                price: Number(price.toFixed(2)),
                quantity: isNaN(quantity) ? 0 : quantity,
                maxServingsPerDay: isNaN(quantity) ? null : (quantity > 0 ? quantity : null),
                kcal: kcal,
                description: '',
                allergens: '',
                ingredientId: null,
                ingredientName: null,
                amount: null,
                displayAmount: ''
            });
        }
    });
    
    return variations;
}

function addMenuDetailVariation() {
    const variationsListEl = document.getElementById('menuDetailVariations');
    if (!variationsListEl) return;
    
    // Recipe-based: ingredients are free-form, no need to track used ingredients
    
    // Recipe-based: ingredients are free-form, no need to check availability
    
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
    
    // Recipe-based: ingredients are free-form
    
    variationItem.innerHTML = `
        <div class="variation-item-content">
            <div class="form-group">
                <label>Variation Size</label>
                <select class="form-control menu-detail-variation-size-input">
                    <option value="default" selected>Default</option>
                    <option value="Small">Small</option>
                    <option value="Medium">Medium</option>
                    <option value="Large">Large</option>
                    <option value="Whole">Whole</option>
                    <option value="Half">Half</option>
                </select>
            </div>
            <div class="form-group">
                <label>Price (PHP) <span style="color: #ff8c00; font-weight: bold;">*</span></label>
                <input type="number" class="form-control menu-detail-variation-price-input" placeholder="0.00" value="0" min="0" step="0.01" required>
            </div>
            <div class="form-group">
                <label>Default Daily Serving Limit <span style="color: #ff8c00; font-weight: bold;">*</span></label>
                <input type="number" class="form-control menu-detail-variation-quantity-input" placeholder="0" value="0" min="0" step="1" required>
            </div>
            <div class="form-group">
                <label>Calories (kcal)</label>
                <input type="number" class="form-control menu-detail-variation-kcal-input" placeholder="0" value="" min="0" step="1">
            </div>
            <button type="button" class="btn btn-danger btn-sm" onclick="removeMenuDetailVariation('${variationId}')" style="flex: 0 0 auto; align-self: flex-end;">
                <i class="fas fa-trash"></i>
            </button>
        </div>
    `;
    
    // Recipe-based: ingredients are free-form, no special handlers needed
    // Unit select is always enabled
    
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
        const ingredientInput = item.querySelector('.variation-ingredient');
        const amountInput = item.querySelector('.variation-amount');
        const unitSelect = item.querySelector('.variation-unit');
        
        const name = (nameInput?.value || '').trim();
        const price = parseFloat(priceInput?.value || '0');
        const description = (descriptionInput?.value || '').trim();
        const ingredientName = (ingredientInput?.value || '').trim();
        const amountValue = parseFloat(amountInput?.value || '0');
        const unit = (unitSelect?.value || 'g').trim();
        
        if (name && !isNaN(price) && price >= 0 && ingredientName) {
            // Recipe-based: ingredients are free-form
            const slug = ingredientName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const unitType = (unit === 'pcs') ? 'count' : 'weight';
            
            // Amount is required for variations
            if (!amountInput || !amountInput.value || isNaN(amountValue) || amountValue <= 0) {
                throw new Error(`Amount for variation "${name}" must be greater than zero.`);
            }
            
            // Get unit or use default
            const finalUnit = unit || 'g';
            const baseAmount = convertToBaseUnits(amountValue, unitType, finalUnit);
            
            variations.push({
                name: name,
                price: Number(price.toFixed(2)),
                description: description || '',
                ingredientId: slug,
                ingredientName: ingredientName,
                amount: baseAmount,
                displayAmount: unitType === 'count'
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
    
    // Reset included sauces checkboxes
    const includedSaucesContainer = document.getElementById('includedSaucesContainer');
    if (includedSaucesContainer) {
        // Uncheck all checkboxes
        includedSaucesContainer.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.checked = false;
        });
    }
    
    // Reset "Has variation" and show/hide Price and Stock vs Variation sections
    const hasVarEl = document.getElementById('hasVariation');
    if (hasVarEl) hasVarEl.checked = false;
    if (typeof toggleHasVariation === 'function') toggleHasVariation();
    
    // Reset old variations UI (if still present)
    const variationsList = document.getElementById('variationsList');
    if (variationsList) {
        variationsList.innerHTML = '';
    }
    variationCounter = 0;

    // Reset new form-collected variations
    addFormVariations = [];
    updateFoodVariationsListUI();
    
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

// Subscribe to dailyServings collection for real-time updates
async function subscribeToDailyServings() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns || !window.db) {
        return;
    }
    
    const today = DailyServingsStore.getTodayDateString();
    const dailyServingsQuery = fns.query(
        fns.collection(window.db, 'dailyServings'),
        fns.where('date', '==', today)
    );
    
    if (typeof fns.onSnapshot === 'function') {
        if (typeof dailyServingsUnsubscribe === 'function') {
            dailyServingsUnsubscribe();
        }
        
        dailyServingsUnsubscribe = fns.onSnapshot(
            dailyServingsQuery,
            async (snapshot) => {
                // Update cache with latest serving counts
                const today = DailyServingsStore.getTodayDateString();
                if (todayServingsCacheDate !== today) {
                    todayServingsCache = {};
                    todayServingsCacheDate = today;
                }
                
                snapshot.docs.forEach(doc => {
                    const data = doc.data();
                    if (data.menuItemId) {
                        todayServingsCache[data.menuItemId] = data.count || 0;
                    }
                });
                
                // Refresh menu list table if it's visible
                const menuListTable = document.getElementById('menuListTableBody');
                if (menuListTable && menuState && menuState.length > 0) {
                    await renderMenuListTable();
                }
            },
            (error) => {
                console.error('Daily servings listener error:', error);
            }
        );
    }
}

async function subscribeToMenuCollection() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns || !window.db) {
        throw new Error('Firestore is not ready yet. Please refresh the page.');
    }

    const menuQuery = fns.collection(window.db, 'menu');

    if (typeof fns.onSnapshot === 'function') {
        if (typeof menuUnsubscribe === 'function') {
            menuUnsubscribe();
        }
        menuUnsubscribe = fns.onSnapshot(
            menuQuery,
            async (snapshot) => {
                // Update menu state when menu items change - refresh from MenuStore to ensure proper normalization
                try {
                    menuState = await MenuStore.getItems();
                    // Check and deactivate expired menu items
                    await checkAndDeactivateExpiredMenuItems();
                    // Re-render menu views with updated quantities
                    renderMenuState();
                } catch (error) {
                    console.error('Failed to refresh menu state in listener:', error);
                }
            },
            (error) => {
                console.error('Menu listener error:', error);
                showNotification('Live menu updates failed. Showing last known data.', 'error');
            }
        );
    } else {
        // Fallback: just refresh once if onSnapshot is not available
        await refreshMenuState();
    }
}

async function initMenuManagement() {
    const menuForm = document.getElementById('menuItemForm');
    if (!menuForm) return;

    try {
        await waitForFirebaseReady();
        // Recipe-based: no inventory needed
        updateMenuIngredientsOptions([]);
        await refreshMenuState();
        updateIncludedSaucesCheckboxes();
        // Subscribe to real-time menu updates
        await subscribeToMenuCollection();
        // Subscribe to daily servings to auto-update menu list
        await subscribeToDailyServings();
        menuSubscriptionInitialized = true;
    } catch (error) {
        console.error('Unable to initialize menu management:', error);
        showNotification(error.message || 'Menu data could not be loaded.', 'error');
    }

    ensureDishIngredientBuilderInitialized();

    if (!menuForm.dataset.bound) {
        menuForm.addEventListener('submit', handleMenuFormSubmit);
        menuForm.dataset.bound = 'true';
    }
    
    // Set initial visibility of Price and Stock vs Variation sections
    if (typeof toggleHasVariation === 'function') toggleHasVariation();
    
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
    updateIncludedSaucesCheckboxes();
    
    // Initialize categories from existing menu items (for backward compatibility)
    // This ensures categories from existing menu items are available even if not in Firebase yet
    if (menuState && menuState.length) {
        menuState.forEach(item => {
            if (item.category && !allCategories.includes(item.category)) {
                allCategories.push(item.category);
            }
        });
        updateFilterCategories();
    }
}

// initSalesInventoryAlerts removed - no longer needed in recipe-based system
async function initSalesInventoryAlerts() {
    // Recipe-based system: no inventory alerts needed
    // This function is kept for compatibility but does nothing
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

function formatOrderStatusBadge(status, order = null) {
    const normalized = (status || 'pending').toString().toLowerCase().trim();
    let className = 'process';
    let label = 'NEW ORDER';
    
    if (['completed', 'delivered'].includes(normalized)) {
        className = 'delivered';
        label = 'Done';
    } else if (normalized === 'declined') {
        className = 'cancelled';
        label = 'Declined';
    } else if (['cancelled', 'canceled', 'failed'].includes(normalized)) {
        className = 'cancelled';
        label = 'Cancelled';
    } else if (normalized === 'preparing' || ['being-cooked', 'being_cooked', 'cooking', 'being cooked'].includes(normalized)) {
        className = 'process';
        label = 'In Kitchen';
    } else if (normalized === 'ready for delivery' || normalized === 'ready_for_delivery' || 
               normalized === 'for delivery' || normalized === 'for_delivery') {
        className = 'process';
        label = 'Awaiting Driver';
    } else if (normalized === 'ready for pick-up' || normalized === 'ready_for_pickup' || normalized === 'ready for pickup') {
        className = 'process';
        label = 'Ready for Pick-up';
    } else if (normalized === 'ready') {
        className = 'process';
        label = 'Ready';
    } else if (normalized === 'out for delivery' || normalized === 'out_for_delivery' || normalized === 'out-for-delivery' || 
               normalized === 'in-transit' || normalized === 'in_transit') {
        className = 'process';
        label = 'On the Way';
    } else if (normalized === 'pending' || normalized === 'new') {
        // Check if this is a resubmitted order
        if (order && order.paymentProofVersion && order.paymentProofVersion > 1) {
            className = 'pending';
            label = 'Resubmitted';
        } else if (order) {
            // Check if this is an unverified GCash order that needs verification
            const paymentModeLower = (order.paymentMode || '').toLowerCase();
            const isGCashOrder = paymentModeLower === 'gcash' || paymentModeLower === 'g-cash';
            const isPaymentVerified = order.paymentVerified === true;
            
            if (isGCashOrder && !isPaymentVerified) {
                className = 'pending';
                label = 'Verify';
            } else {
                className = 'pending';
                label = 'NEW ORDER';
            }
        } else {
            className = 'pending';
            label = 'NEW ORDER';
        }
    } else {
        // Format other statuses nicely
        label = normalized
        ? normalized.replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
        : 'NEW ORDER';
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

// Recipe-based: ingredients are free-form, no inventory lookup needed
function findIngredientInStateByName(name) {
    // Return a simple object structure for compatibility
    // In recipe-based system, ingredients don't need to exist in inventory
    if (!name) return null;
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    
    // Return a basic ingredient object for unit type detection
    // Default to weight, but allow manual selection
    return {
        id: trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: trimmedName,
        unitType: 'weight', // Default, can be changed by user
        baseUnit: 'g'
    };
}

function formatIngredientLabel(value) {
    return value
        .toString()
        .trim()
        .replace(/(^|\s|-)\S/g, letter => letter.toUpperCase());
}

async function populateIngredientIdPreview() {
    const idInput = document.getElementById('registerIngredientId');
    if (!idInput) return;
    try {
        const newId = await generateUnique8DigitId();
        idInput.value = newId;
    } catch (e) {
        console.warn('Could not generate preview ingredient ID:', e);
        idInput.value = 'Auto-generated on save';
    }
}

// handleIngredientRegisterSubmit removed - system is now recipe-based
// Ingredients are entered directly when creating menu items, no registration needed
async function handleIngredientRegisterSubmit(event) {
    event.preventDefault();
    showNotification('Ingredient registration is not needed in recipe-based system. Add ingredients directly when creating menu items.', 'info');
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
    const detailsPanel = document.querySelector('.customer-details-panel');
    
    if (!customerProfile) return; // Not on customer page
    
    if (customerProfile) customerProfile.style.display = 'flex';
    if (reviewsSection) reviewsSection.style.display = 'none';
    if (mostOrderedSection) mostOrderedSection.style.display = 'none';
    if (detailsPanel) detailsPanel.style.display = 'none';
    selectedCustomerId = null;
    
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

function updateCategoryFilters() {
    // Get unique categories from menu items
    const categories = new Set();
    if (menuState && menuState.length) {
        menuState.forEach(item => {
            if (item.category) {
                categories.add(item.category);
            }
        });
    }
    
    const sortedCategories = Array.from(categories).sort();
    
    // Update reviews filter
    const reviewsFilter = document.getElementById('reviewsCategoryFilter');
    if (reviewsFilter) {
        const currentValue = reviewsFilter.value || 'all';
        reviewsFilter.innerHTML = '<option value="all">All Categories</option>' +
            sortedCategories.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('');
        reviewsFilter.value = currentValue;
    }
    
    // Update most ordered filter
    const mostOrderedFilter = document.getElementById('mostOrderedCategoryFilter');
    if (mostOrderedFilter) {
        const currentValue = mostOrderedFilter.value || 'all';
        mostOrderedFilter.innerHTML = '<option value="all">All Categories</option>' +
            sortedCategories.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('');
        mostOrderedFilter.value = currentValue;
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
    
    // Ensure menu state is loaded for category filters
    if (!menuState || !menuState.length) {
        refreshMenuState().then(() => {
            updateCategoryFilters();
            loadAllCustomerReviews();
        });
    } else {
        updateCategoryFilters();
        loadAllCustomerReviews();
    }
    
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
    
    // Ensure menu state is loaded for category filters
    if (!menuState || !menuState.length) {
        refreshMenuState().then(() => {
            updateCategoryFilters();
            loadAllCustomerMostOrdered();
        });
    } else {
        updateCategoryFilters();
        loadAllCustomerMostOrdered();
    }
    
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
        // Ensure menu state is loaded
        if (!menuState || !menuState.length) {
            await refreshMenuState();
        }
        
        // Get all orders with reviews
        let reviewedOrders = ordersState.filter(order => 
            order.rating || order.review || order.feedback
        );
        
        // Apply category filter
        if (reviewsCategoryFilter !== 'all') {
            reviewedOrders = reviewedOrders.filter(order => {
                if (!order.items || !order.items.length) return false;
                const firstItem = order.items[0];
                const itemId = firstItem?.itemId || firstItem?.id || '';
                const itemName = firstItem?.name || firstItem?.itemName || '';
                
                const menuItem = menuState.find(m => 
                    (m.id === itemId || m.menuId === itemId) ||
                    (m.name && m.name.toLowerCase() === itemName.toLowerCase()) ||
                    (m.displayName && m.displayName.toLowerCase() === itemName.toLowerCase())
                );
                
                const category = menuItem?.category || 'Uncategorized';
                return category.toLowerCase() === reviewsCategoryFilter.toLowerCase();
            });
        }
        
        reviewedOrders = reviewedOrders.slice(0, 50); // Show last 50 reviews
        
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
            const itemId = firstItem?.itemId || firstItem?.id || '';
            const itemName = firstItem?.name || firstItem?.itemName || 'Order Items';
            
            // Find matching menu item
            const menuItem = menuState.find(m => 
                (m.id === itemId || m.menuId === itemId) ||
                (m.name && m.name.toLowerCase() === itemName.toLowerCase()) ||
                (m.displayName && m.displayName.toLowerCase() === itemName.toLowerCase())
            );
            
            const itemImage = menuItem?.imageDataUrl || firstItem?.image || firstItem?.imageUrl || '';
            const itemPrice = menuItem ? getMenuItemDisplayPrice(menuItem) : parseFloat(firstItem?.price || firstItem?.itemPrice || 0);
            const menuLink = menuItem?.id ? `onclick="if(window.location.pathname.includes('menu.html')) { window.location.hash='#menu-product-detail'; showMenuDetailForItem('${menuItem.id}'); } else { window.location.href='menu.html#menu-product-detail'; }" style="cursor: pointer;"` : '';
            
            const imageHtml = itemImage 
                ? `<img src="${escapeHtml(itemImage)}" alt="${escapeHtml(itemName)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
                : '';
            const placeholderHtml = !itemImage ? '<div class="food-image-placeholder">' + (itemName.charAt(0).toUpperCase()) + '</div>' : '';
            
            return `
                <div class="review-item" ${menuLink}>
                    <div class="review-header">
                        <span class="order-id">${escapeHtml(customerName)} - Order #${order.trackingId || order.id}</span>
                        <span class="restaurant">${itemPrice > 0 ? '₱' + itemPrice.toFixed(2) : 'Pablo\'s Peri Peri'}</span>
                    </div>
                    <div class="review-content">
                        <div class="food-image">
                            ${imageHtml}
                            ${placeholderHtml}
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

// Category filter state for reviews and most ordered
let reviewsCategoryFilter = 'all';
let mostOrderedCategoryFilter = 'all';

async function loadAllCustomerMostOrdered() {
    const mostOrderedList = document.getElementById('mostOrderedList');
    if (!mostOrderedList) return;
    
    try {
        await loadCustomerOrders(null); // Load all orders
        // Ensure menu state is loaded
        if (!menuState || !menuState.length) {
            await refreshMenuState();
        }
        
        // Calculate most ordered items across all customers
        // Count all paid orders (same logic as menu catalogue) to ensure consistency
        const itemCounts = {};
        const processedOrderIds = new Set(); // Track processed orders to prevent duplication
        
        // Filter to only paid orders (same as menu catalogue)
        const paidOrders = ordersState.filter(isOrderPaid);
        
        paidOrders.forEach(order => {
            // Skip if order doesn't have an ID (needed for deduplication)
            if (!order.id) return;
            
            // Skip if this order has already been processed (prevent duplication)
            if (processedOrderIds.has(order.id)) {
                return;
            }
            
            // Mark this order as processed
            processedOrderIds.add(order.id);
            
            // Process items in this order
            if (order.items && Array.isArray(order.items)) {
                order.items.forEach(item => {
                    const itemName = item.name || item.itemName || 'Unknown';
                    const itemId = item.itemId || item.id || '';
                    
                    // Find matching menu item
                    const menuItem = menuState.find(m => 
                        (m.id === itemId || m.menuId === itemId) ||
                        (m.name && m.name.toLowerCase() === itemName.toLowerCase()) ||
                        (m.displayName && m.displayName.toLowerCase() === itemName.toLowerCase())
                    );
                    
                    const category = menuItem?.category || 'Uncategorized';
                    
                    // Apply category filter
                    if (mostOrderedCategoryFilter !== 'all' && category.toLowerCase() !== mostOrderedCategoryFilter.toLowerCase()) {
                        return;
                    }
                    
                    if (!itemCounts[itemName]) {
                        itemCounts[itemName] = {
                            name: itemName,
                            count: 0,
                            totalPrice: 0,
                            image: menuItem?.imageDataUrl || item.image || item.imageUrl || '',
                            price: menuItem ? getMenuItemDisplayPrice(menuItem) : parseFloat(item.price || item.itemPrice || 0),
                            category: category,
                            menuId: menuItem?.id || menuItem?.menuId || ''
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
                ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
                : '';
            const placeholderHtml = !item.image ? '<div class="food-image-placeholder">' + (item.name.charAt(0).toUpperCase()) + '</div>' : '';
            
            const priceDisplay = item.price ? `₱${item.price.toFixed(2)}` : `₱${Number(item.totalPrice / item.count).toFixed(2)}`;
            const menuLink = item.menuId ? `onclick="if(window.location.pathname.includes('menu.html')) { window.location.hash='#menu-product-detail'; showMenuDetailForItem('${item.menuId}'); } else { window.location.href='menu.html#menu-product-detail'; }" style="cursor: pointer;"` : '';
            
            return `
                <div class="review-item" ${menuLink}>
                    <div class="review-header">
                        <span class="order-id">${escapeHtml(item.name)}</span>
                        <span class="restaurant">${priceDisplay}</span>
                    </div>
                    <div class="review-content">
                        <div class="food-image">
                            ${imageHtml}
                            ${placeholderHtml}
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
        const hasPendingIdVerification = lastPendingIdCustomerIds && lastPendingIdCustomerIds.has(customer.id);
        
        const displayName = customer.displayName || 'Customer';
        const email = customer.email || '';
        const phoneNumber = customer.phoneNumber || '';
        
        const pendingBadgeHtml = hasPendingIdVerification
            ? `<span class="pending-id-badge" title="Pending Senior/PWD ID verification" style="display:inline-flex;align-items:center;justify-content:center;margin-left:8px;min-width:18px;height:18px;padding:0 6px;border-radius:999px;background:#dc3545;color:#fff;font-size:10px;font-weight:700;line-height:1;box-shadow:0 2px 4px rgba(0,0,0,0.15);">ID</span>`
            : '';
        
        return `
            <div class="customer-item ${isSelected}" onclick="selectCustomer('${customer.id}')" data-customer-id="${customer.id}">
                <div class="customer-avatar">${initials}</div>
                <div class="customer-info">
                    <div class="customer-name">${escapeHtml(displayName)}${pendingBadgeHtml}</div>
                    <div class="customer-email">${email ? escapeHtml(email) : (phoneNumber ? escapeHtml(phoneNumber) : 'No contact info')}</div>
                </div>
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
    
    const detailsPanel = document.querySelector('.customer-details-panel');
    if (detailsPanel) detailsPanel.style.display = 'block';
    
    showCustomerDetails(customerId);
}

async function showCustomerDetails(customerId) {
    const customer = customersState.find(c => c.id === customerId);
    if (!customer) {
        console.warn('Customer not found:', customerId);
        return;
    }
    
    // Load customer orders to calculate stats
    await loadCustomerOrders(customerId, true);
    
    // Calculate loyalty points and most ordered items
    // Match orders by userId - customer.id should match order.userId
    // Also check for customer.userId in case customer object has different ID field
    const customerUserId = customer.userId || customer.id;
    const customerOrders = ordersState.filter(order => {
        if (!order) return false;
        const orderUserId = order.userId || order.customerId;
        return orderUserId === customerId || orderUserId === customerUserId;
    });
    
    console.log(`Found ${customerOrders.length} orders for customer ${customerId} (${customer.displayName})`);
    
    const stats = calculateCustomerStats(customerOrders);
    
    // Update rewards tab
    updateRewardsTab(customer, stats);
    
    // Update reviews tab
    await updateReviewsTab(customer, customerOrders);
    
    // Update ID verification tab
    updateIdVerificationTab(customerId);
}

async function loadCustomerOrders(customerId, forceReload = false) {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    
    // Always refresh if requested or if we have no orders cached
    if (forceReload || ordersState.length === 0) {
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
    if (!orders || !Array.isArray(orders)) {
        orders = [];
    }
    
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
        
        // Count most ordered items and collect ratings
        if (order.items && Array.isArray(order.items)) {
            const orderRating = order.rating || 0;
            order.items.forEach(item => {
                const itemName = item.name || item.itemName || 'Unknown';
                if (!stats.mostOrderedItems[itemName]) {
                    stats.mostOrderedItems[itemName] = {
                        name: itemName,
                        count: 0,
                        totalPrice: 0,
                        image: item.image || item.imageUrl || '',
                        ratings: [],
                        averageRating: 0
                    };
                }
                stats.mostOrderedItems[itemName].count++;
                stats.mostOrderedItems[itemName].totalPrice += parseFloat(item.price || item.itemPrice || 0);
                // Collect rating if order has one
                if (orderRating > 0) {
                    stats.mostOrderedItems[itemName].ratings.push(orderRating);
                }
            });
        }
    });
    
    // Convert most ordered items to array, calculate average ratings, and sort
    stats.mostOrderedItems = Object.values(stats.mostOrderedItems)
        .map(item => {
            // Calculate average rating
            if (item.ratings && item.ratings.length > 0) {
                const sum = item.ratings.reduce((acc, rating) => acc + rating, 0);
                item.averageRating = sum / item.ratings.length;
            } else {
                item.averageRating = 0;
            }
            return item;
        })
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
            
            // Format rating display
            const rating = item.averageRating || 0;
            const stars = '★'.repeat(Math.floor(rating)) + '☆'.repeat(5 - Math.floor(rating));
            const ratingDisplay = rating > 0 
                ? `<div class="rating" style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
                    <span class="stars">${stars}</span>
                    <span class="rating-text">${rating.toFixed(1)}</span>
                </div>`
                : '<p style="color: #999; margin-top: 8px;">No ratings yet</p>';
            
            return `
                <div class="review-item">
                    <div class="review-header">
                        <span class="order-id">${escapeHtml(item.name)}</span>
                        <span class="restaurant">${rating > 0 ? rating.toFixed(1) + ' ⭐' : '—'}</span>
                    </div>
                    <div class="review-content">
                        <div class="food-image">
                            ${imageHtml}
                        </div>
                        <div class="review-details">
                            <h5>Ordered ${item.count}x</h5>
                            ${ratingDisplay}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } else if (reviewsList) {
        reviewsList.innerHTML = '<div class="empty-state">No orders yet</div>';
    }
}

async function updateReviewsTab(customer, orders) {
    const reviewsTab = document.getElementById('reviewsTab');
    if (!reviewsTab) return;
    
    const reviewsList = reviewsTab.querySelector('.reviews-list');
    if (!reviewsList) return;
    
    // Show loading state
    reviewsList.innerHTML = '<div class="empty-state">Loading reviews...</div>';
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firestore not ready');
        }
        
        const customerId = customer.id || customer.userId;
        console.log('updateReviewsTab called for customer:', customer, 'customerId:', customerId);
        const allReviews = [];
        
        // 1. Get reviews from orders
        const reviewedOrders = orders.filter(order => 
            order.rating || order.review || order.feedback
        );
        
        reviewedOrders.forEach(order => {
            const orderDate = order.createdAt 
                ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt))
                : new Date();
            
            const rating = order.rating || 0;
            const reviewText = order.review || order.feedback || 'No review text';
            const firstItem = order.items && order.items.length > 0 ? order.items[0] : null;
            const itemImage = firstItem?.image || firstItem?.imageUrl || '';
            const itemName = firstItem?.name || firstItem?.itemName || 'Order Items';
            
            allReviews.push({
                type: 'order',
                orderId: order.trackingId || order.id,
                itemName: itemName,
                itemImage: itemImage,
                rating: rating,
                text: reviewText,
                date: orderDate,
                createdAt: order.createdAt
            });
        });
        
        // 2. Fetch reviews from customer's reviews subcollection
        if (customerId) {
            try {
                console.log(`Fetching reviews for customer ID: ${customerId}`);
                
                // Ensure menu state is loaded for item details
                if (!menuState || !menuState.length) {
                    await refreshMenuState();
                }
                
                // Fetch reviews from customers/{customerId}/reviews subcollection
                const reviewsRef = fns.collection(window.db, 'customers', customerId, 'reviews');
                const reviewsSnapshot = await fns.getDocs(reviewsRef);
                
                console.log(`Found ${reviewsSnapshot.docs.length} reviews in subcollection for customer ${customerId}`);
                
                reviewsSnapshot.docs.forEach(doc => {
                    const reviewData = doc.data();
                    console.log('Review data:', reviewData);
                    
                    const reviewDate = reviewData.createdAt 
                        ? (reviewData.createdAt.toDate ? reviewData.createdAt.toDate() : new Date(reviewData.createdAt))
                        : new Date();
                    
                    // Get item details from menu state if itemId/itemName is available
                    const itemId = reviewData.itemId || reviewData.menuItemId || '';
                    const itemName = reviewData.itemName || '';
                    let menuItem = null;
                    let itemImage = '';
                    
                    if (itemId && menuState) {
                        menuItem = menuState.find(m => 
                            m.id === itemId || 
                            m.menuId === itemId ||
                            (itemName && m.name && m.name.toLowerCase() === itemName.toLowerCase()) ||
                            (itemName && m.displayName && m.displayName.toLowerCase() === itemName.toLowerCase())
                        );
                        if (menuItem) {
                            itemImage = menuItem.imageDataUrl || '';
                        }
                    }
                    
                    allReviews.push({
                        type: 'customer',
                        reviewId: doc.id,
                        itemId: itemId,
                        itemName: itemName || menuItem?.name || menuItem?.displayName || 'Menu Item',
                        itemImage: itemImage || reviewData.itemImage || '',
                        rating: reviewData.rating || 0,
                        text: reviewData.text || reviewData.review || 'No review text',
                        date: reviewDate,
                        createdAt: reviewData.createdAt,
                        anonymous: reviewData.anonymous || false,
                        displayName: reviewData.displayName || customer.displayName,
                        orderId: reviewData.orderId || null
                    });
                });
                
                console.log(`Total reviews after fetching: ${allReviews.length}`);
            } catch (error) {
                console.error(`Error fetching reviews from customer subcollection:`, error);
                // Continue even if reviews subcollection doesn't exist or fails
            }
        } else {
            console.warn('No customerId provided for fetching reviews');
        }
        
        // Sort reviews by date (newest first)
        allReviews.sort((a, b) => {
            const dateA = a.date instanceof Date ? a.date.getTime() : new Date(a.date).getTime();
            const dateB = b.date instanceof Date ? b.date.getTime() : new Date(b.date).getTime();
            return dateB - dateA;
        });
        
        // Show last 50 reviews
        const displayReviews = allReviews.slice(0, 50);
        
        console.log(`Total reviews found: ${allReviews.length}, displaying: ${displayReviews.length}`);
        
        if (displayReviews.length === 0) {
            reviewsList.innerHTML = '<div class="empty-state">No reviews yet</div>';
            console.log('No reviews to display');
            return;
        }
        
        reviewsList.innerHTML = displayReviews.map(review => {
            const reviewDate = review.date instanceof Date ? review.date : new Date(review.date);
            const daysAgo = Math.floor((Date.now() - reviewDate.getTime()) / (1000 * 60 * 60 * 24));
            const dateText = daysAgo === 0 ? 'Today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
            
            const stars = '★'.repeat(Math.floor(review.rating)) + '☆'.repeat(5 - Math.floor(review.rating));
            
            const imageHtml = review.itemImage 
                ? `<img src="${escapeHtml(review.itemImage)}" alt="${escapeHtml(review.itemName)}" onerror="this.style.display='none'">`
                : '<div class="food-image-placeholder">🍽️</div>';
            
            const orderIdText = review.orderId 
                ? `Order #${review.orderId}` 
                : (review.type === 'order' ? `Order #${review.orderId || 'N/A'}` : review.itemName);
            
            return `
                <div class="review-item">
                    <div class="review-header">
                        <span class="order-id">${escapeHtml(orderIdText)}</span>
                        <span class="restaurant">Pablo's Peri Peri</span>
                    </div>
                    <div class="review-content">
                        <div class="food-image">
                            ${imageHtml}
                        </div>
                        <div class="review-details">
                            <h5>${escapeHtml(review.itemName)}</h5>
                            <p>${escapeHtml(review.text)}</p>
                            <div class="review-meta">
                                <span class="date">${dateText}</span>
                                <div class="rating">
                                    <span class="stars">${stars}</span>
                                    <span class="rating-text">${review.rating.toFixed(1)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
    } catch (error) {
        console.error('Error loading customer reviews:', error);
        reviewsList.innerHTML = `
            <div class="empty-state" style="color: #dc3545;">
                <i class="fas fa-exclamation-triangle" style="font-size: 48px; margin-bottom: 16px;"></i>
                <p>Error loading reviews: ${escapeHtml(error.message)}</p>
            </div>
        `;
    }
}

// ID Verification functions
let currentDeclineCustomerId = null;
let currentDeclineImageUrl = null;

async function updateIdVerificationTab(customerId) {
    const idVerificationContent = document.getElementById('idVerificationContent');
    if (!idVerificationContent) return;
    
    const customer = customersState.find(c => c.id === customerId);
    if (!customer) {
        idVerificationContent.innerHTML = '<div class="empty-state">Customer not found</div>';
        return;
    }
    
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    
    try {
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firestore not ready');
        }
        
        // Fetch latest customer data from Firestore
        const customerDocRef = fns.doc(window.db, 'customers', customerId);
        const customerSnapshot = await fns.getDoc(customerDocRef);
        
        if (!customerSnapshot.exists()) {
            idVerificationContent.innerHTML = '<div class="empty-state">Customer data not found</div>';
            return;
        }
        
        const customerData = customerSnapshot.data();
        
        // Check discountInfo object for ID image (proofUrl or proofPath) and selfie (selfieUrl)
        let foundImageUrl = '';
        let foundImagePath = '';
        let foundSelfieUrl = '';
        let foundSelfiePath = '';
        let discountInfo = customerData.discountInfo || {};
        
        if (discountInfo && typeof discountInfo === 'object') {
            // Check for proofUrl first (full URL) - ID picture
            foundImageUrl = discountInfo.proofUrl || discountInfo.proofURL || '';
            // Also get the path for deletion purposes
            foundImagePath = discountInfo.proofPath || discountInfo.proofPATH || '';
            
            // Check for selfieUrl - selfie picture
            foundSelfieUrl = discountInfo.selfieUrl || discountInfo.selfieURL || discountInfo.selfie || '';
            foundSelfiePath = discountInfo.selfiePath || discountInfo.selfiePATH || '';
        }
        
        // Fallback: Check other possible field names for ID image
        if (!foundImageUrl) {
            foundImageUrl = customerData.idImage || 
                          customerData.idImageUrl || 
                          customerData.verificationIdImage ||
                          customerData.idPhoto ||
                          customerData.idPhotoUrl ||
                          customerData.photoId ||
                          customerData.photoIdUrl ||
                          customerData.verificationPhoto ||
                          customerData.verificationPhotoUrl ||
                          customerData.identityImage ||
                          customerData.identityImageUrl ||
                          customerData.documentImage ||
                          customerData.documentImageUrl ||
                          '';
        }
        
        // Fallback: Check other possible field names for selfie
        if (!foundSelfieUrl) {
            foundSelfieUrl = customerData.selfie || 
                           customerData.selfieImage || 
                           customerData.selfieImageUrl ||
                           customerData.selfiePhoto ||
                           customerData.selfiePhotoUrl ||
                           '';
        }
        
        // Get verification status from discountInfo or fallback fields
        let verificationStatus = 'pending';
        if (discountInfo && typeof discountInfo === 'object') {
            // Check discountInfo.IDverification (boolean)
            if (discountInfo.IDverification === true) {
                verificationStatus = 'verified';
            } else if (discountInfo.IDverification === false) {
                verificationStatus = 'pending';
            }
            // Also check for string values
            if (discountInfo.IDverificationStatus) {
                verificationStatus = discountInfo.IDverificationStatus;
            }
        }
        
        // Fallback to other verification status fields
        if (verificationStatus === 'pending') {
            verificationStatus = customerData.idVerificationStatus || 
                               customerData.verificationStatus || 
                               'pending';
        }
        
        const verificationReason = discountInfo?.idVerificationReason || 
                                 customerData.idVerificationReason || 
                                 '';
        const verifiedAt = discountInfo?.idVerifiedAt || 
                         customerData.idVerifiedAt || 
                         customerData.verificationDate || 
                         null;
        const verifiedBy = discountInfo?.idVerifiedBy || 
                         customerData.idVerifiedBy || 
                         customerData.verifiedBy || '';
        
        if (!foundImageUrl && !foundSelfieUrl) {
            idVerificationContent.innerHTML = `
                <div class="empty-state" style="text-align: center; padding: 40px;">
                    <i class="fas fa-id-card" style="font-size: 48px; color: #ccc; margin-bottom: 16px;"></i>
                    <p>No ID verification images uploaded</p>
                    <p style="font-size: 12px; color: #999; margin-top: 10px;">This customer has not uploaded ID verification images yet.</p>
                </div>
            `;
            return;
        }
        
        // Format verification date
        let verifiedDateText = '';
        if (verifiedAt) {
            const date = verifiedAt.toDate ? verifiedAt.toDate() : new Date(verifiedAt);
            verifiedDateText = date.toLocaleDateString('en-US', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }
        
        // Status badge - handle both boolean and string values
        let statusBadge = '';
        let statusClass = '';
        
        // Check discountInfo.IDverification if verificationStatus is still pending
        // IMPORTANT: a previous decline should NOT block a new upload.
        const hasCurrentUpload = Boolean(foundImageUrl || foundSelfieUrl);
        if (verificationStatus === 'pending' && discountInfo && typeof discountInfo === 'object') {
            // If there is NO current upload but we have a decline reason, treat as declined.
            if (!hasCurrentUpload && (discountInfo.idVerificationReason || verificationReason)) {
                verificationStatus = 'declined';
            } else if (discountInfo.IDverification === true) {
                verificationStatus = 'verified';
            } else if (discountInfo.IDverification === false) {
                verificationStatus = 'pending';
            }
        }
        // If there IS a current upload and status is not verified/confirmed,
        // always treat it as pending so admin can verify/decline again.
        if (
            hasCurrentUpload &&
            verificationStatus !== 'verified' &&
            verificationStatus !== 'confirmed'
        ) {
            verificationStatus = 'pending';
        }
        
        if (verificationStatus === 'verified' || verificationStatus === true) {
            statusBadge = '<span class="badge badge-success">✓ Verified</span>';
            statusClass = 'verified';
        } else if (verificationStatus === 'confirmed') {
            statusBadge = '<span class="badge badge-success">✓ Confirmed</span>';
            statusClass = 'confirmed';
        } else if (verificationStatus === 'declined' || (verificationReason && verificationStatus !== 'verified')) {
            statusBadge = '<span class="badge badge-danger">✗ Declined</span>';
            statusClass = 'declined';
        } else {
            statusBadge = '<span class="badge badge-warning">⏳ Pending</span>';
            statusClass = 'pending';
        }
        
        idVerificationContent.innerHTML = `
            <div class="id-verification-container" style="max-width: 1000px; margin: 0 auto; padding: 24px; width: 100%; box-sizing: border-box;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; padding: 24px; margin-bottom: 32px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <h4 style="margin: 0 0 8px 0; color: #fff; font-weight: 600; font-size: 20px;">ID Verification</h4>
                            ${verifiedDateText ? `
                                <p style="margin: 0; color: rgba(255,255,255,0.9); font-size: 14px;">
                                    ${verificationStatus === 'declined' ? 'Declined' : verificationStatus === 'verified' ? 'Verified' : 'Pending'} on ${verifiedDateText}
                                    ${verifiedBy ? ` by ${escapeHtml(verifiedBy)}` : ''}
                                </p>
                            ` : '<p style="margin: 0; color: rgba(255,255,255,0.9); font-size: 14px;">Verification pending review</p>'}
                        </div>
                        <div style="background: rgba(255,255,255,0.2); backdrop-filter: blur(10px); padding: 8px 16px; border-radius: 20px;">
                            ${statusBadge}
                        </div>
                    </div>
                </div>
                
                ${verificationStatus === 'declined' && verificationReason ? `
                    <div class="alert alert-warning" style="margin-bottom: 24px; padding: 16px 20px; background: #fff3cd; border-left: 4px solid #ffc107; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                        <div style="display: flex; align-items: start; gap: 12px;">
                            <i class="fas fa-exclamation-triangle" style="color: #ffc107; font-size: 20px; margin-top: 2px;"></i>
                            <div>
                                <strong style="color: #856404; display: block; margin-bottom: 4px;">Decline Reason</strong>
                                <p style="margin: 0; color: #856404; line-height: 1.5;">${escapeHtml(verificationReason)}</p>
                            </div>
                        </div>
                    </div>
                ` : ''}
                
                <div class="id-image-container" style="margin-bottom: 32px;">
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px;">
                        ${foundImageUrl ? `
                            <div style="background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s, box-shadow 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(0,0,0,0.12)'" onmouseout="this.style.transform=''; this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'">
                                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px solid #f0f0f0;">
                                    <div style="width: 40px; height: 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                                        <i class="fas fa-id-card" style="color: #fff; font-size: 18px;"></i>
                                    </div>
                                    <h6 style="margin: 0; color: #333; font-weight: 600; font-size: 16px;">ID Picture</h6>
                                </div>
                                <div style="border-radius: 8px; overflow: hidden; background: #f8f9fa; padding: 12px;">
                                    <img src="${escapeHtml(foundImageUrl)}" 
                                         alt="Customer ID" 
                                         style="width: 100%; max-height: 500px; object-fit: contain; border-radius: 6px; display: block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"
                                         onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'400\\' height=\\'300\\'%3E%3Crect fill=\\'%23ddd\\' width=\\'400\\' height=\\'300\\'/%3E%3Ctext fill=\\'%23999\\' font-family=\\'sans-serif\\' font-size=\\'18\\' x=\\'50%25\\' y=\\'50%25\\' text-anchor=\\'middle\\' dominant-baseline=\\'middle\\'%3EImage not available%3C/text%3E%3C/svg%3E';">
                                </div>
                            </div>
                        ` : ''}
                        ${foundSelfieUrl ? `
                            <div style="background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s, box-shadow 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(0,0,0,0.12)'" onmouseout="this.style.transform=''; this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'">
                                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px solid #f0f0f0;">
                                    <div style="width: 40px; height: 40px; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                                        <i class="fas fa-user-circle" style="color: #fff; font-size: 18px;"></i>
                                    </div>
                                    <h6 style="margin: 0; color: #333; font-weight: 600; font-size: 16px;">Selfie</h6>
                                </div>
                                <div style="border-radius: 8px; overflow: hidden; background: #f8f9fa; padding: 12px;">
                                    <img src="${escapeHtml(foundSelfieUrl)}" 
                                         alt="Customer Selfie" 
                                         style="width: 100%; max-height: 500px; object-fit: contain; border-radius: 6px; display: block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"
                                         onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'400\\' height=\\'300\\'%3E%3Crect fill=\\'%23ddd\\' width=\\'400\\' height=\\'300\\'/%3E%3Ctext fill=\\'%23999\\' font-family=\\'sans-serif\\' font-size=\\'18\\' x=\\'50%25\\' y=\\'50%25\\' text-anchor=\\'middle\\' dominant-baseline=\\'middle\\'%3EImage not available%3C/text%3E%3C/svg%3E';">
                                </div>
                            </div>
                        ` : ''}
                    </div>
                </div>
                
                ${verificationStatus !== 'verified' && verificationStatus !== 'confirmed' && verificationStatus !== 'declined' ? `
                    <div class="id-verification-actions" style="display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; padding-top: 24px; border-top: 1px solid #e9ecef; position: relative; z-index: 10; pointer-events: auto;">
                        <button class="btn btn-success" onclick="verifyId('${customerId}', '${escapeHtml(foundImageUrl)}')" style="min-width: 140px; padding: 12px 24px; font-size: 15px; font-weight: 600; border-radius: 8px; border: none; box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.2s; background: linear-gradient(135deg, #28a745 0%, #20c997 100%); cursor: pointer; position: relative; z-index: 11; pointer-events: auto;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)'" onmouseout="this.style.transform=''; this.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'">
                            <i class="fas fa-check" style="margin-right: 8px;"></i> Verify ID
                        </button>
                        <button class="btn btn-danger" onclick="declineId('${customerId}', '${escapeHtml(foundImageUrl)}')" style="min-width: 140px; padding: 12px 24px; font-size: 15px; font-weight: 600; border-radius: 8px; border: none; box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.2s; background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); cursor: pointer; position: relative; z-index: 11; pointer-events: auto;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)'" onmouseout="this.style.transform=''; this.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'">
                            <i class="fas fa-times" style="margin-right: 8px;"></i> Decline
                        </button>
                    </div>
                ` : verificationStatus === 'declined' ? `
                    <div class="id-verification-actions" style="display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; padding-top: 24px; border-top: 1px solid #e9ecef; position: relative; z-index: 10; pointer-events: auto;">
                        <button class="btn btn-success" onclick="verifyId('${customerId}', '${escapeHtml(foundImageUrl)}')" style="min-width: 140px; padding: 12px 24px; font-size: 15px; font-weight: 600; border-radius: 8px; border: none; box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.2s; background: linear-gradient(135deg, #28a745 0%, #20c997 100%); cursor: pointer; position: relative; z-index: 11; pointer-events: auto;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)'" onmouseout="this.style.transform=''; this.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'">
                            <i class="fas fa-check" style="margin-right: 8px;"></i> Verify ID
                        </button>
                    </div>
                ` : `
                    <div class="id-verification-actions" style="text-align: center; padding: 32px; background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                        <div style="display: inline-flex; align-items: center; gap: 12px; color: #155724;">
                            <i class="fas fa-check-circle" style="font-size: 32px;"></i>
                            <div style="text-align: left;">
                                <div style="font-size: 18px; font-weight: 600; margin-bottom: 4px;">ID Verification Complete</div>
                                <div style="font-size: 14px; opacity: 0.8;">This ID has been ${verificationStatus === 'verified' ? 'verified' : verificationStatus}</div>
                            </div>
                        </div>
                    </div>
                `}
            </div>
        `;
    } catch (error) {
        console.error('Error loading ID verification:', error);
        idVerificationContent.innerHTML = `
            <div class="empty-state" style="color: #dc3545;">
                <i class="fas fa-exclamation-triangle" style="font-size: 48px; margin-bottom: 16px;"></i>
                <p>Error loading ID verification: ${escapeHtml(error.message)}</p>
            </div>
        `;
    }
}

async function verifyId(customerId, imageUrl) {
    if (!confirm('Are you sure you want to verify this ID?')) {
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firestore not ready');
        }
        
        // Get current user info for verifiedBy
        const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
        let verifiedBy = 'Admin';
        if (session) {
            try {
                const staffSession = JSON.parse(session);
                if (staffSession.firstName && staffSession.lastName) {
                    verifiedBy = `${staffSession.firstName} ${staffSession.lastName}`;
                } else if (staffSession.email) {
                    verifiedBy = staffSession.email;
                }
            } catch (e) {
                console.warn('Could not parse staff session:', e);
            }
        }
        
        const customerDocRef = fns.doc(window.db, 'customers', customerId);
        
        // Get current customer data to update discountInfo
        const customerSnapshot = await fns.getDoc(customerDocRef);
        const customerData = customerSnapshot.exists() ? customerSnapshot.data() : {};
        const currentDiscountInfo = customerData.discountInfo || {};
        
        // Update discountInfo with verification status
        await fns.updateDoc(customerDocRef, {
            'discountInfo.IDverification': true,
            'discountInfo.idVerifiedAt': fns.serverTimestamp(),
            'discountInfo.idVerifiedBy': verifiedBy,
            // Also update top-level fields for compatibility
            idVerificationStatus: 'verified',
            idVerifiedAt: fns.serverTimestamp(),
            idVerifiedBy: verifiedBy
        });
        
        showNotification('ID verified successfully', 'success');
        
        // Refresh the customer data and update the tab/list so badges update
        await loadCustomers();
        if (typeof renderCustomersList === 'function') {
            renderCustomersList();
        }
        await updateIdVerificationTab(customerId);
    } catch (error) {
        console.error('Error verifying ID:', error);
        showNotification('Failed to verify ID: ' + error.message, 'error');
    }
}

async function confirmId(customerId, imageUrl) {
    if (!confirm('Are you sure you want to confirm this ID?')) {
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firestore not ready');
        }
        
        // Get current user info for verifiedBy
        const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
        let verifiedBy = 'Admin';
        if (session) {
            try {
                const staffSession = JSON.parse(session);
                if (staffSession.firstName && staffSession.lastName) {
                    verifiedBy = `${staffSession.firstName} ${staffSession.lastName}`;
                } else if (staffSession.email) {
                    verifiedBy = staffSession.email;
                }
            } catch (e) {
                console.warn('Could not parse staff session:', e);
            }
        }
        
        const customerDocRef = fns.doc(window.db, 'customers', customerId);
        
        // Get current customer data to update discountInfo
        const customerSnapshot = await fns.getDoc(customerDocRef);
        const customerData = customerSnapshot.exists() ? customerSnapshot.data() : {};
        const currentDiscountInfo = customerData.discountInfo || {};
        
        // Update discountInfo with confirmation status
        await fns.updateDoc(customerDocRef, {
            'discountInfo.IDverification': true,
            'discountInfo.idVerifiedAt': fns.serverTimestamp(),
            'discountInfo.idVerifiedBy': verifiedBy,
            // Also update top-level fields for compatibility
            idVerificationStatus: 'confirmed',
            idVerifiedAt: fns.serverTimestamp(),
            idVerifiedBy: verifiedBy
        });
        
        showNotification('ID confirmed successfully', 'success');
        
        // Refresh the customer data and update the tab/list so badges update
        await loadCustomers();
        if (typeof renderCustomersList === 'function') {
            renderCustomersList();
        }
        await updateIdVerificationTab(customerId);
    } catch (error) {
        console.error('Error confirming ID:', error);
        showNotification('Failed to confirm ID: ' + error.message, 'error');
    }
}

function declineId(customerId, imageUrl) {
    currentDeclineCustomerId = customerId;
    currentDeclineImageUrl = imageUrl;
    
    const modal = document.getElementById('idDeclineModal');
    if (modal) {
        modal.style.display = 'block';
        document.getElementById('declineReasonSelect').value = '';
        document.getElementById('declineReasonText').value = '';
        document.getElementById('declineReasonText').style.display = 'none';
        
        // Show textarea if "Other" is selected
        const reasonSelect = document.getElementById('declineReasonSelect');
        const reasonText = document.getElementById('declineReasonText');
        
        // Remove existing listeners and add new one
        const newSelect = reasonSelect.cloneNode(true);
        reasonSelect.parentNode.replaceChild(newSelect, reasonSelect);
        document.getElementById('declineReasonSelect').addEventListener('change', function() {
            if (this.value === 'other') {
                document.getElementById('declineReasonText').style.display = 'block';
            } else {
                document.getElementById('declineReasonText').style.display = 'none';
            }
        });
        
        // Close modal when clicking outside
        modal.onclick = function(event) {
            if (event.target === modal) {
                closeIdDeclineModal();
            }
        };
    }
}

function closeIdDeclineModal() {
    const modal = document.getElementById('idDeclineModal');
    if (modal) {
        modal.style.display = 'none';
        modal.onclick = null; // Remove click handler
        currentDeclineCustomerId = null;
        currentDeclineImageUrl = null;
    }
}

async function confirmIdDecline() {
    const reasonSelect = document.getElementById('declineReasonSelect');
    const reasonText = document.getElementById('declineReasonText');
    
    if (!reasonSelect || !reasonSelect.value) {
        showNotification('Please select a reason for declining', 'error');
        return;
    }
    
    let declineReason = reasonSelect.options[reasonSelect.selectedIndex].text;
    if (reasonSelect.value === 'other' && reasonText && reasonText.value.trim()) {
        declineReason = reasonText.value.trim();
    }
    
    if (!currentDeclineCustomerId) {
        showNotification('Error: Customer ID not found', 'error');
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const storageFns = window.storageFunctions;
        if (!fns || !window.db || !storageFns || !window.storage) {
            throw new Error('Firebase not ready');
        }
        
        // Get current user info for verifiedBy
        const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
        let verifiedBy = 'Admin';
        if (session) {
            try {
                const staffSession = JSON.parse(session);
                if (staffSession.firstName && staffSession.lastName) {
                    verifiedBy = `${staffSession.firstName} ${staffSession.lastName}`;
                } else if (staffSession.email) {
                    verifiedBy = staffSession.email;
                }
            } catch (e) {
                console.warn('Could not parse staff session:', e);
            }
        }
        
        // Get current customer data to access discountInfo
        const customerDocRef = fns.doc(window.db, 'customers', currentDeclineCustomerId);
        const customerSnapshot = await fns.getDoc(customerDocRef);
        const customerData = customerSnapshot.exists() ? customerSnapshot.data() : {};
        const discountInfo = customerData.discountInfo || {};
        
        // Delete the images from Firebase Storage (ID + selfie)
        // Try to get path from discountInfo first, then from URL
        let imagePathToDelete = discountInfo.proofPath || discountInfo.proofPATH || '';
        let selfiePathToDelete = discountInfo.selfiePath || discountInfo.selfiePATH || '';
        
        if (!imagePathToDelete && currentDeclineImageUrl) {
            // Extract the path from the URL
            // Firebase Storage URLs typically look like: https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?alt=media
            const urlMatch = currentDeclineImageUrl.match(/\/o\/([^?]+)/);
            if (urlMatch) {
                imagePathToDelete = decodeURIComponent(urlMatch[1]);
            }
        }

        // Fallback: try extracting selfie path from stored fields (if available)
        if (!selfiePathToDelete) {
            const selfieUrl = discountInfo.selfieUrl || discountInfo.selfieURL || discountInfo.selfie || '';
            if (selfieUrl) {
                const urlMatch = String(selfieUrl).match(/\/o\/([^?]+)/);
                if (urlMatch) {
                    selfiePathToDelete = decodeURIComponent(urlMatch[1]);
                }
            }
        }
        
        if (imagePathToDelete) {
            try {
                const imageRef = storageFns.ref(window.storage, imagePathToDelete);
                await storageFns.deleteObject(imageRef);
                console.log('ID image deleted from Storage:', imagePathToDelete);
            } catch (storageError) {
                console.warn('Could not delete image from Storage (may not exist):', storageError);
                // Continue with the decline even if image deletion fails
            }
        }

        if (selfiePathToDelete) {
            try {
                const selfieRef = storageFns.ref(window.storage, selfiePathToDelete);
                await storageFns.deleteObject(selfieRef);
                console.log('Selfie image deleted from Storage:', selfiePathToDelete);
            } catch (storageError) {
                console.warn('Could not delete selfie from Storage (may not exist):', storageError);
                // Continue with the decline even if selfie deletion fails
            }
        }
        
        // Update customer document - update discountInfo and remove image references
        const updateData = {
            'discountInfo.IDverification': false,
            'discountInfo.idVerificationReason': declineReason,
            'discountInfo.idVerifiedAt': fns.serverTimestamp(),
            'discountInfo.idVerifiedBy': verifiedBy,
            'discountInfo.proofUrl': fns.deleteField(),
            'discountInfo.proofPath': fns.deleteField(),
            'discountInfo.proofURL': fns.deleteField(),
            'discountInfo.proofPATH': fns.deleteField(),
            'discountInfo.selfieUrl': fns.deleteField(),
            'discountInfo.selfieURL': fns.deleteField(),
            'discountInfo.selfie': fns.deleteField(),
            'discountInfo.selfiePath': fns.deleteField(),
            'discountInfo.selfiePATH': fns.deleteField(),
            // Also update top-level fields for compatibility
            idVerificationStatus: 'declined',
            idVerificationReason: declineReason,
            idVerifiedAt: fns.serverTimestamp(),
            idVerifiedBy: verifiedBy
        };
        
        await fns.updateDoc(customerDocRef, updateData);
        
        showNotification('ID declined and image deleted', 'success');
        closeIdDeclineModal();
        
        // Refresh the customer data and update the tab/list so badges update
        await loadCustomers();
        if (typeof renderCustomersList === 'function') {
            renderCustomersList();
        }
        await updateIdVerificationTab(currentDeclineCustomerId);
        
        currentDeclineCustomerId = null;
        currentDeclineImageUrl = null;
    } catch (error) {
        console.error('Error declining ID:', error);
        showNotification('Failed to decline ID: ' + error.message, 'error');
    }
}

// Make functions globally available
window.verifyId = verifyId;
window.confirmId = confirmId;
window.declineId = declineId;
window.closeIdDeclineModal = closeIdDeclineModal;
window.confirmIdDecline = confirmIdDecline;

// ============================================================================
// GLOBAL ALERTS: New Reviews & Senior/PWD ID Verification
// ============================================================================

async function subscribeToOrderReviewAlerts() {
    // Listen for any orders that gain a rating / review / feedback
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns || !window.db || typeof fns.onSnapshot !== 'function') {
        return;
    }

    const ordersCol = fns.collection(window.db, 'orders');

    // Avoid multiple active listeners
    if (typeof orderReviewAlertUnsubscribe === 'function') {
        orderReviewAlertUnsubscribe();
    }

    orderReviewAlertUnsubscribe = fns.onSnapshot(
        ordersCol,
        (snapshot) => {
            const currentReviewed = new Set();

            snapshot.docs.forEach(docSnap => {
                const data = docSnap.data() || {};
                const hasReview = Boolean(
                    data.rating ||
                    data.review ||
                    data.feedback
                );
                if (hasReview) {
                    currentReviewed.add(docSnap.id);
                }
            });

            if (reviewAlertsInitialized) {
                const newlyReviewed = [];
                currentReviewed.forEach(id => {
                    if (!lastReviewedOrderIds.has(id)) {
                        newlyReviewed.push(id);
                    }
                });

                if (newlyReviewed.length > 0) {
                    const plural = newlyReviewed.length > 1 ? 's' : '';
                    showNotification(
                        `New customer review${plural} received. Open Customer → Reviews to view.`,
                        'info'
                    );
                }
            }

            lastReviewedOrderIds = currentReviewed;
            reviewAlertsInitialized = true;
        },
        (error) => {
            console.error('Order review alerts listener error:', error);
        }
    );
}

async function subscribeToIdVerificationAlerts() {
    // Listen for customers with uploaded Senior/PWD ID awaiting verification
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns || !window.db || typeof fns.onSnapshot !== 'function') {
        return;
    }

    const customersCol = fns.collection(window.db, 'customers');

    if (typeof idVerificationAlertUnsubscribe === 'function') {
        idVerificationAlertUnsubscribe();
    }

    idVerificationAlertUnsubscribe = fns.onSnapshot(
        customersCol,
        (snapshot) => {
            const pendingNow = new Set();
            const pendingDetails = [];

            snapshot.docs.forEach(docSnap => {
                const data = docSnap.data() || {};
                const discountInfo = data.discountInfo || {};

                // Detect if customer has uploaded any ID / selfie related to discount
                const hasIdImage =
                    discountInfo.proofUrl ||
                    discountInfo.proofURL ||
                    discountInfo.proofPath ||
                    discountInfo.proofPATH ||
                    data.idImage ||
                    data.idImageUrl ||
                    data.verificationIdImage ||
                    data.idPhoto ||
                    data.idPhotoUrl ||
                    data.photoId ||
                    data.photoIdUrl ||
                    data.verificationPhoto ||
                    data.verificationPhotoUrl ||
                    data.identityImage ||
                    data.identityImageUrl ||
                    data.documentImage ||
                    data.documentImageUrl;

                // Determine verification status, following same rules as ID tab
                let verificationStatus = 'pending';
                if (discountInfo && typeof discountInfo === 'object') {
                    if (discountInfo.IDverification === true) {
                        verificationStatus = 'verified';
                    } else if (discountInfo.IDverification === false) {
                        verificationStatus = 'pending';
                    }
                    if (discountInfo.IDverificationStatus) {
                        verificationStatus = discountInfo.IDverificationStatus;
                    }
                }
                if (verificationStatus === 'pending') {
                    verificationStatus =
                        data.idVerificationStatus ||
                        data.verificationStatus ||
                        'pending';
                }

                // NOTE: Don't block alerts just because there's a previous decline reason.
                // If the customer uploads again, we want it to show as pending again.

                const isPending =
                    Boolean(hasIdImage) &&
                    verificationStatus !== 'verified' &&
                    verificationStatus !== 'confirmed';

                if (isPending) {
                    pendingNow.add(docSnap.id);

                    // Build a human-readable customer name for the badge tooltip
                    let displayName = data.displayName || '';
                    if (!displayName) {
                        const first = (data.firstName || '').trim();
                        const last = (data.lastName || '').trim();
                        if (first || last) {
                            displayName = `${first} ${last}`.trim();
                        }
                    }
                    if (!displayName && data.fullName) {
                        displayName = data.fullName;
                    }
                    if (!displayName && data.email) {
                        const emailName = data.email.split('@')[0].replace(/[._]/g, ' ');
                        displayName = emailName
                            .split(' ')
                            .filter(Boolean)
                            .map(n => n.charAt(0).toUpperCase() + n.slice(1))
                            .join(' ');
                    }
                    if (!displayName) {
                        displayName = 'Customer';
                    }

                    pendingDetails.push({
                        id: docSnap.id,
                        name: displayName
                    });
                }
            });

            // Update global state and badge every time snapshot updates
            pendingIdCustomerDetails = pendingDetails;
            updateCustomerIdBadge(pendingDetails);

            if (idVerificationAlertInitialized) {
                const newlyPending = [];
                pendingNow.forEach(id => {
                    if (!lastPendingIdCustomerIds.has(id)) {
                        newlyPending.push(id);
                    }
                });

                if (newlyPending.length > 0) {
                    const count = newlyPending.length;
                    const newlyPendingNames = newlyPending
                        .map(id => (pendingDetails.find(p => p.id === id)?.name || 'Customer'))
                        .slice(0, 3);
                    const message =
                        count === 1
                            ? `New Senior/PWD ID submitted by ${newlyPendingNames[0]}. Please verify in Customer → ID Verification.`
                            : `${count} new Senior/PWD IDs submitted (${newlyPendingNames.join(', ')}${count > 3 ? ', …' : ''}). Please verify in Customer → ID Verification.`;
                    showNotification(message, 'info');
                }
            }

            lastPendingIdCustomerIds = pendingNow;
            idVerificationAlertInitialized = true;
        },
        (error) => {
            console.error('ID verification alerts listener error:', error);
        }
    );
}

function updateCustomerIdBadge(pendingList) {
    // Find the "Customer" nav link in the sidebar
    const navLinks = document.querySelectorAll('.nav-list .nav-item .nav-link');
    let customerLink = null;
    let customerIcon = null;

    navLinks.forEach(link => {
        const textSpan = link.querySelector('span');
        if (textSpan && textSpan.textContent.trim().toLowerCase() === 'customer') {
            customerLink = link;
            // Find the icon element (first <i> tag)
            customerIcon = link.querySelector('i:first-of-type, i:first-child');
        }
    });

    if (!customerLink || !customerIcon) {
        return;
    }

    // Make the nav link position relative so badge can be absolutely positioned
    if (customerLink.style.position !== 'relative') {
        customerLink.style.position = 'relative';
    }

    // Ensure badge element exists
    let badge = customerLink.querySelector('.customer-id-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'customer-id-badge';
        badge.style.position = 'absolute';
        // Position badge hovering on the left side of the icon area
        badge.style.top = '-4px';
        badge.style.left = '4px';
        badge.style.minWidth = '18px';
        badge.style.height = '18px';
        badge.style.borderRadius = '999px';
        badge.style.backgroundColor = '#dc3545';
        badge.style.color = '#fff';
        badge.style.fontSize = '10px';
        badge.style.fontWeight = '700';
        badge.style.display = 'flex';
        badge.style.alignItems = 'center';
        badge.style.justifyContent = 'center';
        badge.style.padding = '0 4px';
        badge.style.boxSizing = 'border-box';
        badge.style.zIndex = '10';
        badge.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
        badge.style.border = '2px solid #3d2817';

        customerLink.appendChild(badge);
    }

    const count = Array.isArray(pendingList) ? pendingList.length : 0;

    if (!count) {
        badge.style.display = 'none';
        badge.textContent = '';
        badge.title = '';
        return;
    }

    badge.style.display = 'flex';
    badge.textContent = String(count);

    // Build tooltip text listing which customers are pending
    const maxNames = 5;
    const names = pendingList.slice(0, maxNames).map(c => c.name);
    let tooltip = 'Pending Senior/PWD ID verification:\n' + names.join('\n');
    if (pendingList.length > maxNames) {
        tooltip += `\n+ ${pendingList.length - maxNames} more…`;
    }
    badge.title = tooltip;
}

async function initGlobalAlerts() {
    try {
        await Promise.all([
            subscribeToOrderReviewAlerts(),
            subscribeToIdVerificationAlerts()
        ]);
    } catch (error) {
        console.error('Failed to initialize global alerts:', error);
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
    const idVerificationTab = document.getElementById('idVerificationTab');
    
    if (tabName === 'reviews') {
        if (reviewsTab) reviewsTab.style.display = 'block';
        if (rewardsTab) rewardsTab.style.display = 'none';
        if (idVerificationTab) idVerificationTab.style.display = 'none';
    } else if (tabName === 'rewards') {
        if (reviewsTab) reviewsTab.style.display = 'none';
        if (rewardsTab) rewardsTab.style.display = 'block';
        if (idVerificationTab) idVerificationTab.style.display = 'none';
    } else if (tabName === 'idVerification') {
        if (reviewsTab) reviewsTab.style.display = 'none';
        if (rewardsTab) rewardsTab.style.display = 'none';
        if (idVerificationTab) idVerificationTab.style.display = 'block';
        // Update ID verification tab when switching to it
        if (selectedCustomerId) {
            updateIdVerificationTab(selectedCustomerId);
        }
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
    const caloriesInput = form.querySelector('#menuEditCalories');
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
    if (caloriesInput) caloriesInput.value = menuItem.calories != null ? Number(menuItem.calories) : '';
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
        if (!menuItem.ingredients || !menuItem.ingredients.length) {
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

    // Populate included sauces checkboxes
    const menuEditIncludedSaucesContainer = document.getElementById('menuEditIncludedSaucesContainer');
    if (menuEditIncludedSaucesContainer) {
        // First, ensure the checkboxes are populated with sauce options
        updateIncludedSaucesCheckboxes();
        
        // Wait a moment for checkboxes to be created, then check the appropriate ones
        setTimeout(() => {
            if (menuItem.includedSauces && Array.isArray(menuItem.includedSauces) && menuItem.includedSauces.length > 0) {
                menuItem.includedSauces.forEach(includedSauce => {
                    const sauceId = includedSauce.sauceId || includedSauce.menuId || includedSauce.id;
                    const checkbox = menuEditIncludedSaucesContainer.querySelector(`input[type="checkbox"][value="${sauceId}"]`);
                    if (checkbox) {
                        checkbox.checked = true;
                    }
                });
            }
        }, 50);
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
    const caloriesRaw = form.querySelector('#menuEditCalories')?.value || '';
    const caloriesValue = caloriesRaw === '' ? null : parseInt(caloriesRaw, 10);
    const descriptionValue = (form.querySelector('#menuEditDescription')?.value || '').trim();
    const allergensValue = (form.querySelector('#menuEditAllergens')?.value || '').trim() || null;
    
    // Extract included sauces from checkboxes
    const menuEditIncludedSaucesContainer = document.getElementById('menuEditIncludedSaucesContainer');
    const includedSauces = [];
    if (menuEditIncludedSaucesContainer) {
        const checkedBoxes = menuEditIncludedSaucesContainer.querySelectorAll('input[type="checkbox"]:checked');
        checkedBoxes.forEach(checkbox => {
            if (checkbox.value && checkbox.value.trim()) {
                const sauceItem = menuState.find(item => item.id === checkbox.value);
                if (sauceItem) {
                    includedSauces.push({
                        sauceId: sauceItem.id,
                        sauceName: sauceItem.displayName || sauceItem.name,
                        menuId: sauceItem.menuId || sauceItem.id
                    });
                }
            }
        });
    }

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
            kcalUnit: caloriesValue,
            deliveryCharge: 0, // Set to 0 since delivery charge field is removed
            description: descriptionValue,
            allergens: allergensValue,
            includedSauces: includedSauces.length > 0 ? includedSauces : null
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
async function loadAndRenderActivityLogs() {
    const container = document.getElementById('activityLogsContainer');
    const loadingEl = document.getElementById('activityLogsLoading');
    const emptyEl = document.getElementById('activityLogsEmpty');
    
    if (!container || !loadingEl || !emptyEl) return;
    
    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    
    // Clear existing log groups (except loading/empty states)
    const existingGroups = container.querySelectorAll('.log-group');
    existingGroups.forEach(group => group.remove());
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const db = window.db;
        const logsRef = fns.collection(db, 'logsStaff');
        
        // Try to get logs ordered by startTime desc, fallback if index missing
        let logsSnapshot;
        try {
            logsSnapshot = await fns.getDocs(fns.query(
                logsRef,
                fns.orderBy('startTime', 'desc')
            ));
        } catch (orderError) {
            console.warn('Could not order by startTime (index may be missing), getting all logs:', orderError);
            logsSnapshot = await fns.getDocs(logsRef);
        }
        
        const logs = [];
        logsSnapshot.forEach(doc => {
            const logData = doc.data();
            logs.push({
                id: doc.id,
                ...logData
            });
        });
        
        // Sort by startTime if not already sorted
        logs.sort((a, b) => {
            const aTime = a.startTime?.toDate?.() || new Date(0);
            const bTime = b.startTime?.toDate?.() || new Date(0);
            return bTime - aTime; // Most recent first
        });
        
        loadingEl.style.display = 'none';
        
        if (logs.length === 0) {
            emptyEl.style.display = 'block';
            return;
        }
        
        // Group logs by date
        const logsByDate = {};
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        logs.forEach(log => {
            const startTime = log.startTime?.toDate?.() || null;
            const endTime = log.endTime?.toDate?.() || null;
            
            // Process startTime log
            if (startTime) {
                const dateKey = startTime.toDateString();
                if (!logsByDate[dateKey]) {
                    logsByDate[dateKey] = [];
                }
                logsByDate[dateKey].push({
                    type: 'login',
                    time: startTime,
                    driverName: log.driverName || 'Unknown',
                    driverId: log.driverId || ''
                });
            }
            
            // Process endTime log
            if (endTime) {
                const dateKey = endTime.toDateString();
                if (!logsByDate[dateKey]) {
                    logsByDate[dateKey] = [];
                }
                logsByDate[dateKey].push({
                    type: 'logout',
                    time: endTime,
                    driverName: log.driverName || 'Unknown',
                    driverId: log.driverId || ''
                });
            }
        });
        
        // Sort logs within each date group by time (most recent first)
        Object.keys(logsByDate).forEach(dateKey => {
            logsByDate[dateKey].sort((a, b) => b.time - a.time);
        });
        
        // Render log groups
        const dateKeys = Object.keys(logsByDate).sort((a, b) => {
            return new Date(b) - new Date(a); // Most recent dates first
        });
        
        dateKeys.forEach(dateKey => {
            const date = new Date(dateKey);
            const dateLogs = logsByDate[dateKey];
            
            // Determine date label
            const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            
            let dateLabel = '';
            const dateTime = date.getTime();
            if (dateTime === today.getTime()) {
                dateLabel = 'Today';
            } else if (dateTime === yesterday.getTime()) {
                dateLabel = 'Yesterday';
            } else {
                dateLabel = dayNames[date.getDay()];
            }
            
            // Format full date
            const fullDate = `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
            
            const logGroup = document.createElement('div');
            logGroup.className = 'log-group';
            logGroup.innerHTML = `
                <h3>${dateLabel}</h3>
                <p class="log-date">${fullDate}</p>
            `;
            
            dateLogs.forEach(log => {
                const timeStr = log.time.toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true
                });
                
                const actionText = log.type === 'login' ? 'Logged in' : 'Logged out';
                const avatar = log.driverName.toLowerCase().includes('owner') || log.driverName.toLowerCase().includes('admin') ? '👩' : '👨';
                
                const logItem = document.createElement('div');
                logItem.className = 'log-item';
                logItem.innerHTML = `
                    <div class="log-avatar">${avatar}</div>
                    <div class="log-content">
                        <span class="log-action">${actionText} ${timeStr}</span>
                        <span class="log-user">@${escapeHtml(log.driverName)}</span>
                    </div>
                `;
                logGroup.appendChild(logItem);
            });
            
            container.appendChild(logGroup);
        });
        
    } catch (error) {
        console.error('Error loading activity logs:', error);
        loadingEl.style.display = 'none';
        container.innerHTML = `<div style="text-align: center; padding: 40px; color: #dc3545;">
            <i class="fas fa-exclamation-triangle" style="font-size: 2em; margin-bottom: 16px;"></i>
            <p>Error loading activity logs: ${error.message}</p>
        </div>`;
        showNotification('Failed to load activity logs.', 'error');
    }
}

function toggleReviewOptions(reviewId) {
    alert(`Review options for review ${reviewId}`);
}

// Initialize page-specific functionality
document.addEventListener('DOMContentLoaded', function() {
    // Initialize payment decline modal
    initPaymentDeclineModal();
    
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

    // Global alerts should run on every admin page so staff
    // see new reviews and Senior/PWD ID verification requests
    initGlobalAlerts();

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
        initSalesPage(); // Sales report initialization
        initSalesInventoryAlerts(); // Inventory alerts initialization
        console.log('Sales report page loaded');
    } else if (currentPage === 'activity-logs.html') {
        // Initialize activity logs
        loadAndRenderActivityLogs();
        console.log('Activity logs page loaded');
    } else if (currentPage === 'menu.html') {
        // Initialize menu management specific functionality
        initMenuManagement();
        const menuEditForm = document.getElementById('menuItemEditForm');
        if (menuEditForm && !menuEditForm.dataset.bound) {
            menuEditForm.addEventListener('submit', handleMenuEditSubmit);
            menuEditForm.dataset.bound = 'true';
        }
        // Initialize promotion form
        const promotionForm = document.getElementById('promotionForm');
        if (promotionForm && !promotionForm.dataset.bound) {
            promotionForm.addEventListener('submit', handlePromotionFormSubmit);
            promotionForm.dataset.bound = 'true';
        }
        // Table number modal click-outside-to-close
        const tableNumberModal = document.getElementById('tableNumberModal');
        if (tableNumberModal && !tableNumberModal.dataset.bound) {
            tableNumberModal.addEventListener('click', event => {
                if (event.target === tableNumberModal) {
                    closeTableNumberModal();
                }
            });
            tableNumberModal.dataset.bound = 'true';
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
                await showMenuList();
            } else if (hash === '#addFoodDashboard' || hash === '#add-product') {
                showAddProduct();
            } else if (hash === '#promotionDashboard' || hash === '#createBanner') {
                showCreateBanner();
            } else if (hash === '#bannerCatalogue') {
                showBannerCatalogue();
            } else if (hash === '#tableNumbers') {
                showTableNumbers();
            } else if (hash === '#ingredient-logs') {
                showIngredientLogs();
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
                    const promotionSection = document.getElementById('promotionDashboard');
                    const ingredientLogsSection = document.getElementById('ingredient-logs');
                    if (foodSection) foodSection.style.display = 'none';
                    if (addFoodSection) addFoodSection.style.display = 'none';
                    if (productDetailSection) productDetailSection.style.display = 'none';
                    if (promotionSection) promotionSection.style.display = 'none';
                    if (ingredientLogsSection) ingredientLogsSection.style.display = 'none';
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
        
        // Handle clicks on dropdown links - don't close dropdowns on navigation
        const menuSubLinks = document.querySelectorAll('.menu-nav-submenu a');
        if (menuSubLinks.length) {
            menuSubLinks.forEach(link => {
                if (!link.dataset.bound) {
                    link.addEventListener('click', (e) => {
                        // Prevent dropdown from closing during navigation
                        e.stopPropagation();
                        
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
                                    (targetHash === '#menu-product-detail' && currentHash === '#product-detail') ||
                                    (targetHash === '#promotionDashboard' && currentHash === '#createBanner') ||
                                    (targetHash === '#createBanner' && currentHash === '#promotionDashboard')) {
                                    // Same hash, manually trigger
                                    e.preventDefault();
                                    // Use requestAnimationFrame to prevent UI glitch
                                    requestAnimationFrame(() => {
                                        handleHashNavigation();
                                    });
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
    } else if (currentPage === 'index.html' || window.location.pathname.includes('index.html')) {
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
                        // Firebase availability "off" → always Off
                        if (driver.availabilityFromFirebase === 'off') {
                            driver.availability = 'off';
                            driver.status = 'off';
                            return;
                        }
                        // Recalculate driver status based on current orders (when availability is "on")
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
window.togglePromotionTabDropdown = togglePromotionTabDropdown;
window.toggleAnalyticsTabDropdown = toggleAnalyticsTabDropdown;
window.acceptOrder = acceptOrder;
window.viewOrderDetails = viewOrderDetails;
window.viewKitchenReceipt = viewKitchenReceipt;
window.viewCustomerReceipt = viewCustomerReceipt;
window.closeReceiptPreviewModal = closeReceiptPreviewModal;
window.zoomReceiptPreview = zoomReceiptPreview;
window.printReceiptFromPreview = printReceiptFromPreview;
window.copyReceiptText = copyReceiptText;
window.downloadReceipt = downloadReceipt;
window.quickPrintCustomerReceipt = quickPrintCustomerReceipt;
window.closeOrderDetailsModal = closeOrderDetailsModal;
window.verifyPayment = verifyPayment;
window.closePaymentReceiptModal = closePaymentReceiptModal;
window.verifyPaymentConfirm = verifyPaymentConfirm;
window.DailyServingsStore = DailyServingsStore;
window.updateMenuServingLimit = updateMenuServingLimit;
window.updateMenuQuantity = updateMenuQuantity;
window.updateMenuVariationStock = updateMenuVariationStock;
window.getMenuServingInfo = getMenuServingInfo;
window.reopenOrder = reopenOrder;
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
window.refreshSalesReport = refreshSalesReport;
// window.switchAnalyticsTab removed - ingredient logs moved to menu page
window.switchTime = switchTime;
window.changePage = changePage;
window.exportReport = exportReport;
window.exportReportAsPDF = exportReportAsPDF;
// window.exportInventoryReport removed - system is now recipe-based
window.selectCustomer = selectCustomer;
window.updateDailySalesReport = updateDailySalesReport;
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
window.applyMenuListFilter = applyMenuListFilter;
window.applyMenuListSort = applyMenuListSort;
window.showMenuListDetail = showMenuListDetail;
window.closeMenuListDetail = closeMenuListDetail;
window.updateMenuQuantity = updateMenuQuantity;
window.updateMenuVariationQuantity = updateMenuVariationQuantity;

function showCreateBanner() {
    // Show create banner form, hide other sections
    const foodSection = document.getElementById('foodSection');
    const addFoodSection = document.getElementById('addFoodDashboard');
    const productDetailSection = document.getElementById('menu-product-detail');
    const promotionSection = document.getElementById('promotionDashboard');
    const bannerCatalogueSection = document.getElementById('bannerCatalogue');
    
    if (foodSection) foodSection.style.display = 'none';
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (productDetailSection) productDetailSection.style.display = 'none';
    if (bannerCatalogueSection) bannerCatalogueSection.style.display = 'none';
    if (promotionSection) promotionSection.style.display = 'block';
    
    menuDetailVisible = false;
    menuDetailEditing = false;
    renderMenuDetailsCarousel();
    updatePageTitle('Promotion', 'Create Banner');
    
    const currentHash = window.location.hash;
    if (currentHash !== '#promotionDashboard' && currentHash !== '#createBanner') {
        if (history.replaceState) {
            history.replaceState(null, null, '#promotionDashboard');
        } else {
            window.location.hash = '#promotionDashboard';
        }
    }
}

function showBannerCatalogue() {
    // Show banner catalogue, hide other sections
    const foodSection = document.getElementById('foodSection');
    const addFoodSection = document.getElementById('addFoodDashboard');
    const productDetailSection = document.getElementById('menu-product-detail');
    const promotionSection = document.getElementById('promotionDashboard');
    const bannerCatalogueSection = document.getElementById('bannerCatalogue');
    
    if (foodSection) foodSection.style.display = 'none';
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (productDetailSection) productDetailSection.style.display = 'none';
    if (promotionSection) promotionSection.style.display = 'none';
    if (bannerCatalogueSection) bannerCatalogueSection.style.display = 'block';
    
    menuDetailVisible = false;
    menuDetailEditing = false;
    renderMenuDetailsCarousel();
    updatePageTitle('Promotion', 'Banner Catalogue');
    
    // Load and render banners
    renderBannerCatalogue();
    
    const currentHash = window.location.hash;
    if (currentHash !== '#bannerCatalogue') {
        if (history.replaceState) {
            history.replaceState(null, null, '#bannerCatalogue');
        } else {
            window.location.hash = '#bannerCatalogue';
        }
    }
}

// Render banner catalogue
async function renderBannerCatalogue() {
    const loadingEl = document.getElementById('bannerCatalogueLoading');
    const emptyEl = document.getElementById('bannerCatalogueEmpty');
    const gridEl = document.getElementById('bannerCatalogueGrid');
    
    if (!loadingEl || !emptyEl || !gridEl) return;
    
    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    gridEl.style.display = 'none';
    gridEl.innerHTML = '';
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const db = window.db;
        const promotionsRef = fns.collection(db, 'promotionList');
        const snapshot = await fns.getDocs(promotionsRef);
        
        const banners = [];
        snapshot.forEach(doc => {
            banners.push({
                id: doc.id,
                ...doc.data()
            });
        });
        
        loadingEl.style.display = 'none';
        
        if (banners.length === 0) {
            emptyEl.style.display = 'block';
            return;
        }
        
        gridEl.style.display = 'grid';
        
        // Sort by creation date (newest first)
        banners.sort((a, b) => {
            const aDate = a.createdAt?.toDate?.() || new Date(0);
            const bDate = b.createdAt?.toDate?.() || new Date(0);
            return bDate - aDate;
        });
        
        banners.forEach(banner => {
            const bannerCard = document.createElement('div');
            bannerCard.className = 'banner-card';
            bannerCard.style.cssText = 'background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);';
            
            // Format dates
            const startDate = banner.startDate?.toDate?.() || null;
            const endDate = banner.endDate?.toDate?.() || null;
            const startDateStr = startDate ? startDate.toLocaleDateString() + ' ' + startDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '—';
            const endDateStr = endDate ? endDate.toLocaleDateString() + ' ' + endDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '—';
            
            // Check if active
            const now = new Date();
            const isActive = startDate && endDate && now >= startDate && now <= endDate;
            
            bannerCard.innerHTML = `
                <div class="banner-image" style="width: 100%; height: 150px; overflow: hidden; background: #f5f5f5;">
                    <img src="${banner.imageUrl || ''}" alt="${banner.title || 'Banner'}" style="width: 100%; height: 100%; object-fit: cover;">
                </div>
                <div class="banner-content" style="padding: 16px;">
                    <h3 style="margin: 0 0 8px 0; font-size: 18px; color: #333;">${escapeHtml(banner.title || 'Untitled Banner')}</h3>
                    <p style="margin: 0 0 12px 0; color: #666; font-size: 14px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${escapeHtml(banner.description || '')}</p>
                    <div style="margin-bottom: 12px;">
                        <span style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; background: ${isActive ? '#d4edda' : '#f8d7da'}; color: ${isActive ? '#155724' : '#721c24'};">
                            ${isActive ? 'Active' : 'Inactive'}
                        </span>
                        <span style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; background: #e7f3ff; color: #004085; margin-left: 8px;">
                            ${escapeHtml(banner.placement || 'banner')}
                        </span>
                    </div>
                    <div style="font-size: 12px; color: #6c757d; margin-bottom: 12px;">
                        <div><strong>Start:</strong> ${startDateStr}</div>
                        <div><strong>End:</strong> ${endDateStr}</div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-secondary" style="flex: 1; padding: 8px;" onclick="editBanner('${banner.id}')">
                            <i class="fas fa-edit"></i> Edit
                        </button>
                        <button class="btn btn-danger" style="flex: 1; padding: 8px;" onclick="deleteBanner('${banner.id}', '${escapeHtml(banner.title || 'Banner')}')">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            `;
            
            gridEl.appendChild(bannerCard);
        });
        
    } catch (error) {
        console.error('Error loading banners:', error);
        loadingEl.style.display = 'none';
        gridEl.innerHTML = `<div style="text-align: center; padding: 40px; color: #dc3545;">
            <i class="fas fa-exclamation-triangle" style="font-size: 2em; margin-bottom: 16px;"></i>
            <p>Error loading banners: ${error.message}</p>
        </div>`;
        showNotification('Failed to load banners.', 'error');
    }
}

// Placeholder functions for edit/delete (you can implement these later)
function editBanner(bannerId) {
    showNotification('Edit banner functionality coming soon.', 'info');
}

async function deleteBanner(bannerId, bannerTitle) {
    if (!confirm(`Are you sure you want to delete "${bannerTitle}"?`)) {
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const db = window.db;
        const bannerRef = fns.doc(db, 'promotionList', bannerId);
        await fns.deleteDoc(bannerRef);
        
        showNotification('Banner deleted successfully.', 'success');
        renderBannerCatalogue(); // Refresh the list
    } catch (error) {
        console.error('Error deleting banner:', error);
        showNotification('Failed to delete banner.', 'error');
    }
}

// ========== TABLE NUMBER MANAGEMENT FUNCTIONS ==========

// Generate UUID v4
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Show table numbers section
function showIngredientLogs() {
    // Hide other sections
    const foodSection = document.getElementById('foodSection');
    const addFoodSection = document.getElementById('addFoodDashboard');
    const productDetailSection = document.getElementById('menu-product-detail');
    const promotionSection = document.getElementById('promotionDashboard');
    const bannerCatalogueSection = document.getElementById('bannerCatalogue');
    const menuListWrapper = document.getElementById('menu-list');
    const menuCatalogueGrid = document.getElementById('menu-catalogue-grid');
    const tableNumbersSection = document.getElementById('tableNumbers');
    const ingredientLogsSection = document.getElementById('ingredient-logs');
    const ingredientLogsTableWrapper = document.getElementById('ingredient-logs-table-wrapper');
    
    if (foodSection) foodSection.style.display = 'none';
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (productDetailSection) productDetailSection.style.display = 'none';
    if (promotionSection) promotionSection.style.display = 'none';
    if (bannerCatalogueSection) bannerCatalogueSection.style.display = 'none';
    if (menuListWrapper) menuListWrapper.style.display = 'none';
    if (menuCatalogueGrid) menuCatalogueGrid.style.display = 'none';
    if (tableNumbersSection) tableNumbersSection.style.display = 'none';
    if (ingredientLogsSection) ingredientLogsSection.style.display = 'block';
    if (ingredientLogsTableWrapper) ingredientLogsTableWrapper.style.display = 'block';
    
    menuDetailVisible = false;
    menuDetailEditing = false;
    updatePageTitle('Menu', 'Ingredient Logs');
    
    // Scroll to top of main content to show the table
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
        mainContent.scrollTop = 0;
    }
    
    // Initialize ingredient logs when section is shown
    if (typeof initIngredientLogs === 'function') {
        setTimeout(() => initIngredientLogs(), 100);
    }
    
    // Update hash
    const currentHash = window.location.hash;
    if (currentHash !== '#ingredient-logs') {
        if (history.replaceState) {
            history.replaceState(null, null, '#ingredient-logs');
        } else {
            window.location.hash = '#ingredient-logs';
        }
    }
    
    // Highlight the Ingredient Logs dropdown item
    setTimeout(() => {
        if (window.highlightActiveMenuItem) {
            window.highlightActiveMenuItem();
        }
    }, 50);
}

function showTableNumbers() {
    // Hide other sections
    const foodSection = document.getElementById('foodSection');
    const addFoodSection = document.getElementById('addFoodDashboard');
    const productDetailSection = document.getElementById('menu-product-detail');
    const promotionSection = document.getElementById('promotionDashboard');
    const bannerCatalogueSection = document.getElementById('bannerCatalogue');
    const menuListWrapper = document.getElementById('menu-list');
    const menuCatalogueGrid = document.getElementById('menu-catalogue-grid');
    const tableNumbersSection = document.getElementById('tableNumbers');
    const ingredientLogsSection = document.getElementById('ingredient-logs');
    
    if (foodSection) foodSection.style.display = 'none';
    if (addFoodSection) addFoodSection.style.display = 'none';
    if (productDetailSection) productDetailSection.style.display = 'none';
    if (promotionSection) promotionSection.style.display = 'none';
    if (bannerCatalogueSection) bannerCatalogueSection.style.display = 'none';
    if (menuListWrapper) menuListWrapper.style.display = 'none';
    if (menuCatalogueGrid) menuCatalogueGrid.style.display = 'none';
    if (ingredientLogsSection) ingredientLogsSection.style.display = 'none';
    if (tableNumbersSection) tableNumbersSection.style.display = 'block';
    
    menuDetailVisible = false;
    menuDetailEditing = false;
    renderMenuDetailsCarousel();
    updatePageTitle('Menu', 'Table Number');
    
    // Load and render table numbers
    renderTableNumbers();
    
    const currentHash = window.location.hash;
    if (currentHash !== '#tableNumbers') {
        if (history.replaceState) {
            history.replaceState(null, null, '#tableNumbers');
        } else {
            window.location.hash = '#tableNumbers';
        }
    }
}

// Render table numbers
async function renderTableNumbers() {
    const loadingEl = document.getElementById('tableNumberLoading');
    const emptyEl = document.getElementById('tableNumberEmpty');
    const gridEl = document.getElementById('tableNumberGrid');
    
    if (!loadingEl || !emptyEl || !gridEl) return;
    
    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    gridEl.style.display = 'none';
    gridEl.innerHTML = '';
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const db = window.db;
        const tableNumbersRef = fns.collection(db, 'TableNumber');
        const snapshot = await fns.getDocs(tableNumbersRef);
        
        const tableNumbers = [];
        snapshot.forEach(doc => {
            tableNumbers.push({
                id: doc.id,
                ...doc.data()
            });
        });
        
        loadingEl.style.display = 'none';
        
        if (tableNumbers.length === 0) {
            emptyEl.style.display = 'block';
            return;
        }
        
        gridEl.style.display = 'grid';
        
        // Sort by creation date (newest first)
        tableNumbers.sort((a, b) => {
            const aDate = a.createdAt?.toDate?.() || new Date(0);
            const bDate = b.createdAt?.toDate?.() || new Date(0);
            return bDate - aDate;
        });
        
        tableNumbers.forEach(table => {
            const tableCard = document.createElement('div');
            tableCard.className = 'table-number-card';
            tableCard.style.cssText = 'background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 2px solid ' + (table.isActive !== false ? '#7E2021' : '#ccc') + ';';
            
            const createdAt = table.createdAt?.toDate?.() || null;
            const createdAtStr = createdAt ? createdAt.toLocaleDateString() + ' ' + createdAt.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '—';
            
            tableCard.innerHTML = `
                <div class="table-number-header" style="padding: 16px; background: ${table.isActive !== false ? '#7E2021' : '#6c757d'}; color: white;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <h3 style="margin: 0; font-size: 20px; font-weight: 600;">
                            <i class="fas fa-table" style="margin-right: 8px;"></i>
                            ${escapeHtml(table.name || 'Unnamed Table')}
                        </h3>
                        <span style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; background: ${table.isActive !== false ? '#d4edda' : '#f8d7da'}; color: ${table.isActive !== false ? '#155724' : '#721c24'};">
                            ${table.isActive !== false ? 'Active' : 'Inactive'}
                        </span>
                    </div>
                </div>
                <div class="table-number-content" style="padding: 16px;">
                    <div style="margin-bottom: 12px;">
                        <div style="font-size: 12px; color: #6c757d; margin-bottom: 4px;">Unique Code:</div>
                        <div style="font-family: monospace; font-size: 13px; color: #333; background: #f8f9fa; padding: 8px; border-radius: 4px; word-break: break-all;">
                            ${escapeHtml(table.code || '—')}
                        </div>
                    </div>
                    ${table.description ? `
                        <div style="margin-bottom: 12px;">
                            <div style="font-size: 12px; color: #6c757d; margin-bottom: 4px;">Description:</div>
                            <div style="font-size: 14px; color: #333; line-height: 1.4;">
                                ${escapeHtml(table.description)}
                            </div>
                        </div>
                    ` : ''}
                    <div style="font-size: 12px; color: #6c757d; margin-bottom: 12px;">
                        <div><strong>Created:</strong> ${createdAtStr}</div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-secondary" style="flex: 1; padding: 8px; background-color: #3d2817; color: #f6c056; border-color: #3d2817;" onclick="editTableNumber('${table.id}')">
                            <i class="fas fa-edit"></i> Edit
                        </button>
                        <button class="btn btn-danger" style="flex: 1; padding: 8px;" onclick="deleteTableNumber('${table.id}', '${escapeHtml(table.name || 'Table')}')">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            `;
            
            gridEl.appendChild(tableCard);
        });
        
    } catch (error) {
        console.error('Error loading table numbers:', error);
        loadingEl.style.display = 'none';
        gridEl.innerHTML = `<div style="text-align: center; padding: 40px; color: #dc3545;">
            <i class="fas fa-exclamation-triangle" style="font-size: 2em; margin-bottom: 16px;"></i>
            <p>Error loading table numbers: ${error.message}</p>
        </div>`;
        showNotification('Failed to load table numbers.', 'error');
    }
}

// Show create table number form
function showCreateTableNumberForm() {
    const modal = document.getElementById('tableNumberModal');
    const form = document.getElementById('tableNumberForm');
    const title = document.getElementById('tableNumberModalTitle');
    const nameInput = document.getElementById('tableNumberName');
    const codeInput = document.getElementById('tableNumberCode');
    const descriptionInput = document.getElementById('tableNumberDescription');
    const isActiveInput = document.getElementById('tableNumberIsActive');
    const idInput = document.getElementById('tableNumberId');
    
    if (!modal || !form) return;
    
    // Reset form
    form.reset();
    if (title) title.textContent = 'Create Table Number';
    if (nameInput) nameInput.value = '';
    if (codeInput) {
        codeInput.value = generateUUID();
    }
    if (descriptionInput) descriptionInput.value = '';
    if (isActiveInput) isActiveInput.checked = true;
    if (idInput) idInput.value = '';
    
    modal.style.display = 'block';
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
}

// Close table number modal
function closeTableNumberModal() {
    const modal = document.getElementById('tableNumberModal');
    if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('modal-open');
    
    // Reset form
    const form = document.getElementById('tableNumberForm');
    if (form) form.reset();
    const idInput = document.getElementById('tableNumberId');
    if (idInput) idInput.value = '';
}

// Generate new table code
function generateNewTableCode() {
    const codeInput = document.getElementById('tableNumberCode');
    if (codeInput) {
        codeInput.value = generateUUID();
    }
}

// Handle table number form submit
async function handleTableNumberSubmit(event) {
    event.preventDefault();
    
    const form = document.getElementById('tableNumberForm');
    const nameInput = document.getElementById('tableNumberName');
    const codeInput = document.getElementById('tableNumberCode');
    const descriptionInput = document.getElementById('tableNumberDescription');
    const isActiveInput = document.getElementById('tableNumberIsActive');
    const idInput = document.getElementById('tableNumberId');
    
    if (!form || !nameInput || !codeInput) return;
    
    const name = nameInput.value.trim();
    const code = codeInput.value.trim();
    const description = descriptionInput ? descriptionInput.value.trim() : '';
    const isActive = isActiveInput ? isActiveInput.checked : true;
    const tableId = idInput ? idInput.value : '';
    
    if (!name) {
        showNotification('Please enter a table name.', 'error');
        return;
    }
    
    if (!code) {
        showNotification('Please generate a unique code.', 'error');
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const db = window.db;
        const tableNumbersRef = fns.collection(db, 'TableNumber');
        
        const tableData = {
            name: name,
            code: code,
            description: description || null,
            isActive: isActive,
            updatedAt: fns.serverTimestamp()
        };
        
        if (tableId) {
            // Update existing table
            const tableRef = fns.doc(db, 'TableNumber', tableId);
            await fns.updateDoc(tableRef, tableData);
            showNotification('Table number updated successfully!', 'success');
        } else {
            // Create new table
            tableData.createdAt = fns.serverTimestamp();
            await fns.addDoc(tableNumbersRef, tableData);
            showNotification('Table number created successfully!', 'success');
        }
        
        closeTableNumberModal();
        renderTableNumbers();
        
    } catch (error) {
        console.error('Error saving table number:', error);
        showNotification('Failed to save table number: ' + error.message, 'error');
    }
}

// Edit table number
async function editTableNumber(tableId) {
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const db = window.db;
        const tableRef = fns.doc(db, 'TableNumber', tableId);
        const tableSnap = await fns.getDoc(tableRef);
        
        if (!tableSnap.exists()) {
            showNotification('Table number not found.', 'error');
            return;
        }
        
        const tableData = tableSnap.data();
        const modal = document.getElementById('tableNumberModal');
        const form = document.getElementById('tableNumberForm');
        const title = document.getElementById('tableNumberModalTitle');
        const nameInput = document.getElementById('tableNumberName');
        const codeInput = document.getElementById('tableNumberCode');
        const descriptionInput = document.getElementById('tableNumberDescription');
        const isActiveInput = document.getElementById('tableNumberIsActive');
        const idInput = document.getElementById('tableNumberId');
        
        if (!modal || !form) return;
        
        if (title) title.textContent = 'Edit Table Number';
        if (nameInput) nameInput.value = tableData.name || '';
        if (codeInput) codeInput.value = tableData.code || generateUUID();
        if (descriptionInput) descriptionInput.value = tableData.description || '';
        if (isActiveInput) isActiveInput.checked = tableData.isActive !== false;
        if (idInput) idInput.value = tableId;
        
        modal.style.display = 'block';
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
        
    } catch (error) {
        console.error('Error loading table number:', error);
        showNotification('Failed to load table number: ' + error.message, 'error');
    }
}

// Delete table number
async function deleteTableNumber(tableId, tableName) {
    if (!confirm(`Are you sure you want to delete "${tableName}"?`)) {
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const db = window.db;
        const tableRef = fns.doc(db, 'TableNumber', tableId);
        await fns.deleteDoc(tableRef);
        
        showNotification('Table number deleted successfully!', 'success');
        renderTableNumbers();
        
    } catch (error) {
        console.error('Error deleting table number:', error);
        showNotification('Failed to delete table number: ' + error.message, 'error');
    }
}

window.togglePromotionTabDropdown = togglePromotionTabDropdown;
window.showCreateBanner = showCreateBanner;
window.showBannerCatalogue = showBannerCatalogue;
window.renderBannerCatalogue = renderBannerCatalogue;
window.editBanner = editBanner;
window.deleteBanner = deleteBanner;
window.showTableNumbers = showTableNumbers;
window.renderTableNumbers = renderTableNumbers;
window.showCreateTableNumberForm = showCreateTableNumberForm;
window.closeTableNumberModal = closeTableNumberModal;
window.generateNewTableCode = generateNewTableCode;
window.handleTableNumberSubmit = handleTableNumberSubmit;
window.editTableNumber = editTableNumber;
window.deleteTableNumber = deleteTableNumber;
window.toggleMenuDetailEdit = toggleMenuDetailEdit;
window.toggleMenuVariationEdit = toggleMenuVariationEdit;
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
            imagePreview.innerHTML = `<img src="${e.target.result}" alt="Preview" style="width: 100%; height: 100%; object-fit: contain; border-radius: 8px; cursor: pointer; display: block;" onclick="document.getElementById('imageFileInput').click()">`;
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
        imagePreview.innerHTML = `<img src="${imageUrl}" alt="${imageName}" style="width: 100%; height: 100%; object-fit: contain; border-radius: 8px; cursor: pointer; display: block;" onclick="openImageGallery(event)">`;
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

// Promotion Image Handling
let uploadedPromoImageFile = null;
let uploadedPromoImageDataUrl = null;

function handlePromoImageFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
        showNotification('Please select a valid image file.', 'error');
        return;
    }
    
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
        showNotification('Image size must be less than 5MB.', 'error');
        return;
    }
    
    const imagePreview = document.getElementById('promoImagePreview');
    const progressContainer = document.getElementById('promoImageUploadProgress');
    const fileInput = document.getElementById('promoImageFileInput');
    
    if (progressContainer) {
        progressContainer.style.display = 'none';
    }
    
    const reader = new FileReader();
    reader.onload = function(e) {
        // Create an image to check dimensions
        const img = new Image();
        img.onload = function() {
            const width = img.width;
            const height = img.height;
            
            // Validate dimensions: must be exactly 1920 x 1080
            if (width !== 1920 || height !== 1080) {
                showNotification(`Image dimensions must be exactly 1920 x 1080 pixels. Current dimensions: ${width} x ${height}`, 'error');
                // Reset file input
                if (fileInput) {
                    fileInput.value = '';
                }
                // Reset preview
                if (imagePreview) {
                    imagePreview.innerHTML = `
                        <div class="upload-placeholder">
                            <i class="fas fa-image"></i>
                            <span>Click to Select Promo Image</span>
                        </div>
                    `;
                }
                uploadedPromoImageFile = null;
                uploadedPromoImageDataUrl = null;
                return;
            }
            
            // Dimensions are correct, proceed with preview
            uploadedPromoImageFile = file;
            uploadedPromoImageDataUrl = e.target.result;
            
            if (imagePreview) {
                imagePreview.innerHTML = `<img src="${e.target.result}" alt="Preview" style="width: 100%; height: 100%; object-fit: contain; border-radius: 8px; cursor: pointer; background: #f8f9fa;" onclick="document.getElementById('promoImageFileInput').click()">`;
                imagePreview.setAttribute('onclick', 'document.getElementById("promoImageFileInput").click()');
                imagePreview.style.cursor = 'pointer';
                imagePreview.setAttribute('title', 'Click to change image');
            }
            
            showNotification('Promo image selected. It will be uploaded to storage when you click Save Promotion.', 'success');
        };
        img.onerror = function() {
            showNotification('Failed to load image for validation.', 'error');
            uploadedPromoImageFile = null;
            uploadedPromoImageDataUrl = null;
            if (fileInput) {
                fileInput.value = '';
            }
        };
        img.src = e.target.result;
    };
    reader.onerror = function() {
        showNotification('Failed to read image file.', 'error');
        uploadedPromoImageFile = null;
        uploadedPromoImageDataUrl = null;
    };
    reader.readAsDataURL(file);
}

function removePromoImage() {
    const imagePreview = document.getElementById('promoImagePreview');
    if (imagePreview) {
        imagePreview.innerHTML = `
            <div class="upload-placeholder">
                <i class="fas fa-image"></i>
                <span>Click to Select Promo Image</span>
            </div>
        `;
        imagePreview.setAttribute('onclick', 'document.getElementById("promoImageFileInput").click()');
        imagePreview.style.cursor = 'pointer';
        imagePreview.setAttribute('title', 'Click to select image');
    }
    
    const fileInput = document.getElementById('promoImageFileInput');
    if (fileInput) {
        fileInput.value = '';
    }
    
    const progressContainer = document.getElementById('promoImageUploadProgress');
    if (progressContainer) {
        progressContainer.style.display = 'none';
    }
    
    uploadedPromoImageFile = null;
    uploadedPromoImageDataUrl = null;
}

// Upload promotion image to Firebase Storage
async function uploadPromoImageToStorage(file) {
    if (!file) {
        return null;
    }
    
    const progressContainer = document.getElementById('promoImageUploadProgress');
    const progressBar = document.getElementById('promoImageUploadProgressBar');
    const progressStatus = document.getElementById('promoImageUploadStatus');
    
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
        const fileName = `promo_${timestamp}.${fileExtension}`;
        const storagePath = `promotionImages/${fileName}`;
        
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
        console.error('Error uploading promotion image:', error);
        
        // Hide progress on error
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
        
        throw error;
    }
}

// Handle promotion form submission
async function handlePromotionFormSubmit(event) {
    if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
    }

    const form = event?.target || document.getElementById('promotionForm');
    if (!form) return;

    // Get form values
    const promoTitle = (form.querySelector('#promoTitle')?.value || '').trim();
    const promoDescription = (form.querySelector('#promoDescription')?.value || '').trim();
    const promoPlacement = (form.querySelector('#promoPlacement')?.value || 'banner').trim();
    const promoStartDateInput = form.querySelector('#promoStartDate');
    const promoEndDateInput = form.querySelector('#promoEndDate');
    
    // Validation
    if (!promoTitle) {
        showNotification('Promotion title is required.', 'error');
        return;
    }
    
    if (!promoDescription) {
        showNotification('Promotion description is required.', 'error');
        return;
    }
    
    if (!uploadedPromoImageFile) {
        showNotification('Please select a promotion image.', 'error');
        return;
    }
    
    const promoStartDateValue = promoStartDateInput?.value || '';
    const promoEndDateValue = promoEndDateInput?.value || '';
    
    if (!promoStartDateValue || !promoEndDateValue) {
        showNotification('Both start date and end date are required.', 'error');
        return;
    }
    
    // Ensure Firebase is ready
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    
    const fns = window.firestoreFunctions;
    if (!fns || !fns.Timestamp) {
        showNotification('Firebase is not ready. Please try again.', 'error');
        return;
    }
    
    // Convert datetime-local strings to Firestore Timestamps
    let startDateTimestamp = null;
    let endDateTimestamp = null;
    
    // Convert start date
    if (promoStartDateValue && promoStartDateValue.trim()) {
        try {
            const date = new Date(promoStartDateValue.trim());
            if (!isNaN(date.getTime())) {
                startDateTimestamp = fns.Timestamp.fromDate(date);
                console.log('[Promotion] Converted start date:', startDateTimestamp);
            } else {
                showNotification('Invalid start date format.', 'error');
                return;
            }
        } catch (e) {
            console.error('[Promotion] Error converting start date:', e);
            showNotification('Error processing start date.', 'error');
            return;
        }
    }
    
    // Convert end date
    if (promoEndDateValue && promoEndDateValue.trim()) {
        try {
            const date = new Date(promoEndDateValue.trim());
            if (!isNaN(date.getTime())) {
                endDateTimestamp = fns.Timestamp.fromDate(date);
                console.log('[Promotion] Converted end date:', endDateTimestamp);
            } else {
                showNotification('Invalid end date format.', 'error');
                return;
            }
        } catch (e) {
            console.error('[Promotion] Error converting end date:', e);
            showNotification('Error processing end date.', 'error');
            return;
        }
    }
    
    // Validate that end date is after start date
    if (startDateTimestamp && endDateTimestamp) {
        if (endDateTimestamp.toMillis() <= startDateTimestamp.toMillis()) {
            showNotification('End date must be after start date.', 'error');
            return;
        }
    }
    
    try {
        // Upload image to Firebase Storage first
        const imageUrl = await uploadPromoImageToStorage(uploadedPromoImageFile);
        
        if (!imageUrl) {
            showNotification('Failed to upload promotion image.', 'error');
            return;
        }
        
        // Save promotion data to Firestore
        const db = window.db;
        const promotionData = {
            title: promoTitle,
            description: promoDescription,
            placement: promoPlacement,
            imageUrl: imageUrl,
            startDate: startDateTimestamp,  // Firestore Timestamp (not null)
            endDate: endDateTimestamp,      // Firestore Timestamp (not null)
            createdAt: fns.serverTimestamp(),
            updatedAt: fns.serverTimestamp()
        };
        
        console.log('[Promotion] Saving promotion data:', {
            ...promotionData,
            startDate: startDateTimestamp ? 'Firestore Timestamp' : 'null',
            endDate: endDateTimestamp ? 'Firestore Timestamp' : 'null'
        });
        
        const promotionRef = fns.collection(db, 'promotionList');
        await fns.addDoc(promotionRef, promotionData);
        
        showNotification('Promotion saved successfully!', 'success');
        
        // Reset form
        form.reset();
        removePromoImage();
        
        // Refresh banner catalogue if it's visible
        const bannerCatalogueSection = document.getElementById('bannerCatalogue');
        if (bannerCatalogueSection && bannerCatalogueSection.style.display !== 'none') {
            renderBannerCatalogue();
        }
        
    } catch (error) {
        console.error('Error saving promotion:', error);
        showNotification(error.message || 'Failed to save promotion.', 'error');
    }
}

window.handlePromoImageFileSelect = handlePromoImageFileSelect;
window.removePromoImage = removePromoImage;
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
                        <i class="fas fa-check-circle"></i> Mark as Done
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
    if (confirm(`Mark order #${orderId} as done?`)) {
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
            const order = orderIndex !== -1 ? ordersState[orderIndex] : ordersState.find(o => o.id === orderId);
            if (orderIndex !== -1) {
                ordersState[orderIndex].status = 'delivered';
            }
            
            // Move driver to bottom of queue (first-come-first-serve)
            if (order && order.driverId) {
                const driverId = order.driverId;
                const driverIndex = driversState.findIndex(d => 
                    (d.driverId === driverId || d.id === driverId) && d.availability === 'busy'
                );
                
                if (driverIndex !== -1) {
                    // Mark driver as available
                    driversState[driverIndex].availability = 'available';
                    driversState[driverIndex].status = 'available';
                    
                    // Move driver to bottom of the list (maintain queue order)
                    const driver = driversState.splice(driverIndex, 1)[0];
                    driversState.push(driver);
                    
                    // Refresh drivers list
                    renderDriversList();
                }
            }
            
            // Refresh the orders table
            renderOrdersTable(ordersState);
            
            // Update the delivery status in UI
            const deliveryCard = document.querySelector(`[onclick*="markDelivered('${orderId}')"]`)?.closest('.delivery-card');
        if (deliveryCard) {
            const statusElement = deliveryCard.querySelector('.delivery-status');
            const actionsElement = deliveryCard.querySelector('.delivery-actions');
            
            if (statusElement) {
                statusElement.textContent = 'Done';
                statusElement.className = 'delivery-status delivered';
            }
            
            if (actionsElement) {
                actionsElement.innerHTML = `
                    <button class="btn btn-success" disabled>
                        <i class="fas fa-check-circle"></i> Done
                    </button>
                `;
            }
        }
        
        showNotification(`Order #${orderId} marked as done!`, 'success');
        } catch (error) {
            console.error('Error marking order as delivered:', error);
            showNotification('Failed to mark order as done. Please try again.', 'error');
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

// Helper function to get active deliveries from for_delivery collection
async function getActiveDeliveries() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns?.getDocs || !fns?.collection) {
        return [];
    }
    
    try {
        const forDeliveryRef = fns.collection(window.db, 'for_delivery');
        const snapshot = await fns.getDocs(forDeliveryRef);
        
        const activeDeliveries = [];
        snapshot.forEach(doc => {
            const deliveryData = doc.data();
            const timeDelivered = deliveryData.timeDelivered;
            const driverId = deliveryData.driverId || '';
            
            // Active delivery = has driverId and timeDelivered is null/undefined
            if (driverId && (timeDelivered === null || timeDelivered === undefined)) {
                activeDeliveries.push({
                    id: doc.id,
                    orderId: deliveryData.orderId || doc.id,
                    driverId: driverId,
                    timeAssigned: deliveryData.timeAssigned,
                    deliveryId: deliveryData.deliveryId || doc.id
                });
            }
        });
        
        console.log('Active deliveries from for_delivery collection:', activeDeliveries.length, activeDeliveries);
        return activeDeliveries;
    } catch (error) {
        console.error('Error loading active deliveries from for_delivery collection:', error);
        return [];
    }
}

// Helper function to check if drivers have started shifts (have startTime in logsStaff)
async function getDriversWithStartedShifts() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns?.getDocs || !fns?.collection || !fns?.query || !fns?.orderBy) {
        return new Set();
    }
    
    try {
        const logsRef = fns.collection(window.db, 'logsStaff');
        let allShiftsSnapshot;
        
        // Try to get shifts ordered by startTime desc, fallback to unordered if index missing
        try {
            allShiftsSnapshot = await fns.getDocs(fns.query(
                logsRef,
                fns.orderBy('startTime', 'desc')
            ));
        } catch (orderError) {
            console.warn('Could not order by startTime (index may be missing), getting all shifts:', orderError);
            // Fallback: get all shifts without ordering
            allShiftsSnapshot = await fns.getDocs(logsRef);
        }
        
        const driversWithShifts = new Set();
        
        console.log('Total shifts found in logsStaff:', allShiftsSnapshot.size);
        
        allShiftsSnapshot.forEach(doc => {
            const shiftData = doc.data();
            const driverId = shiftData.driverId || '';
            const hasStartTime = shiftData.startTime !== null && shiftData.startTime !== undefined;
            
            const hasEndTime = shiftData.endTime !== null && shiftData.endTime !== undefined;
            const isActiveShift = hasStartTime && !hasEndTime;
            
            console.log('Processing shift:', {
                docId: doc.id,
                driverId: driverId,
                driverName: shiftData.driverName,
                hasStartTime: hasStartTime,
                hasEndTime: hasEndTime,
                isActiveShift: isActiveShift,
                startTime: shiftData.startTime,
                endTime: shiftData.endTime
            });
            
            // If this is an active shift (has startTime but no endTime), mark the driver as available
            // We only add each driver once (most recent shift wins since we order by startTime desc)
            // This means if their most recent shift is active, they are on shift
            // Convert to string for consistent matching
            const driverIdStr = String(driverId);
            if (isActiveShift && driverId && !driversWithShifts.has(driverIdStr)) {
                driversWithShifts.add(driverIdStr);
                // Also add the numeric version if it's a number, for backwards compatibility
                const driverIdNum = Number(driverId);
                if (!isNaN(driverIdNum) && driverIdNum.toString() === driverIdStr) {
                    driversWithShifts.add(driverIdNum);
                }
                console.log('✓ Added driver to active shifts set - driverId:', driverIdStr, 'driverName:', shiftData.driverName);
            }
        });
        
        console.log('Final drivers with started shifts:', Array.from(driversWithShifts));
        return driversWithShifts;
    } catch (error) {
        console.error('Error loading driver shifts:', error);
        return new Set();
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
        // Load drivers with started shifts
        const driversWithShifts = await getDriversWithStartedShifts();
        
        // Try to load from 'drivers' collection first
        let snapshot;
        let useStaffCollection = false;
        try {
            snapshot = await fns.getDocs(fns.collection(window.db, 'drivers'));
            // If drivers collection exists but is empty, fall back to staff collection
            const driversCount = snapshot.docs ? snapshot.docs.length : 0;
            const isEmpty = snapshot.empty !== undefined ? snapshot.empty : (driversCount === 0);
            console.log('Drivers collection query result - empty:', isEmpty, 'docs.length:', driversCount);
            if (isEmpty || driversCount === 0) {
                console.log('Drivers collection is empty, trying staff collection...');
                useStaffCollection = true;
            }
        } catch (error) {
            // If 'drivers' collection doesn't exist, try 'staff' collection with role filter
            console.log('Drivers collection not found, trying staff collection...', error);
            useStaffCollection = true;
        }
        
        if (useStaffCollection) {
            const staffSnapshot = await fns.getDocs(fns.collection(window.db, 'staff'));
            const staffDocs = staffSnapshot.docs.filter(doc => {
                const data = doc.data();
                const role = (data.role || '').toLowerCase();
                return role === 'driver';
            });
            console.log('Found', staffDocs.length, 'drivers in staff collection');
            console.log('Raw staff docs:', staffDocs.map(doc => ({
                id: doc.id,
                data: doc.data()
            })));
            driversState = staffDocs.map(docSnap => normalizeDriverDoc(docSnap, driversWithShifts));
            console.log('Normalized drivers:', driversState.map(d => ({
                name: d.name,
                driverId: d.driverId,
                staffId: d.staffId,
                id: d.id,
                availability: d.availability
            })));
            await updateDriverStatusesWithOrders();
            renderDriversList();
            return;
        }
        
        driversState = snapshot.docs
            .map(docSnap => normalizeDriverDoc(docSnap, driversWithShifts))
            .filter(Boolean);
        console.log('Loaded drivers from drivers collection:', driversState.length);
        
        // If no drivers found in drivers collection, try staff collection as fallback
        if (driversState.length === 0) {
            console.log('No drivers found in drivers collection, trying staff collection as fallback...');
            const staffSnapshot = await fns.getDocs(fns.collection(window.db, 'staff'));
            const staffDocs = staffSnapshot.docs.filter(doc => {
                const data = doc.data();
                const role = (data.role || '').toLowerCase();
                return role === 'driver';
            });
            console.log('Found', staffDocs.length, 'drivers in staff collection');
            console.log('Raw staff docs:', staffDocs.map(doc => ({
                id: doc.id,
                data: doc.data()
            })));
            driversState = staffDocs.map(docSnap => normalizeDriverDoc(docSnap, driversWithShifts));
            console.log('Normalized drivers:', driversState.map(d => ({
                name: d.name,
                driverId: d.driverId,
                staffId: d.staffId,
                id: d.id,
                availability: d.availability
            })));
        }
        
        await updateDriverStatusesWithOrders();
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
        // Subscribe to logsStaff to detect shift changes
        const logsRef = fns.collection(window.db, 'logsStaff');
        if (typeof fns.onSnapshot === 'function') {
            fns.onSnapshot(
                logsRef,
                async (snapshot) => {
                    // Reload drivers when shift status changes
                    await loadDrivers();
                },
                (error) => {
                    console.error('Shift logs listener error:', error);
                }
            );
        }
        
        // Subscribe to for_delivery collection to detect delivery assignments
        const forDeliveryRef = fns.collection(window.db, 'for_delivery');
        if (typeof fns.onSnapshot === 'function') {
            fns.onSnapshot(
                forDeliveryRef,
                async (snapshot) => {
                    // Update driver statuses when deliveries change
                    if (driversState.length > 0) {
                        await updateDriverStatusesWithOrders();
                    }
                },
                (error) => {
                    console.error('for_delivery listener error:', error);
                }
            );
        }
        
        // Also subscribe to drivers/staff collection
        try {
            const driversQuery = fns.collection(window.db, 'drivers');
            if (typeof fns.onSnapshot === 'function') {
                fns.onSnapshot(
                    driversQuery,
                    async (snapshot) => {
                        if (snapshot.empty || !snapshot.docs || snapshot.docs.length === 0) {
                            await loadDrivers();
                            return;
                        }
                        const driversWithShifts = await getDriversWithStartedShifts();
                        driversState = snapshot.docs
                            .map(docSnap => normalizeDriverDoc(docSnap, driversWithShifts))
                            .filter(Boolean);
                        await updateDriverStatusesWithOrders();
                    },
                    (error) => {
                        console.error('Drivers listener error:', error);
                    }
                );
            }
        } catch (error) {
            // If drivers collection doesn't exist, subscribe to staff and filter by role: Driver
            console.log('Could not subscribe to drivers collection, using staff with role Driver:', error);
            try {
                const staffRef = fns.collection(window.db, 'staff');
                if (typeof fns.onSnapshot === 'function') {
                    fns.onSnapshot(
                        staffRef,
                        async (snapshot) => {
                            const driversWithShifts = await getDriversWithStartedShifts();
                            const staffDocs = (snapshot.docs || []).filter(doc => {
                                const d = doc.data() || {};
                                return ((d.role || '').toLowerCase() === 'driver');
                            });
                            driversState = staffDocs.map(doc => normalizeDriverDoc(doc, driversWithShifts)).filter(Boolean);
                            await updateDriverStatusesWithOrders();
                        },
                        (err) => console.error('Staff (Driver) listener error:', err)
                    );
                }
            } catch (staffErr) {
                console.warn('Could not subscribe to staff for drivers:', staffErr);
            }
        }
    } catch (error) {
        console.error('Error setting up driver subscriptions:', error);
    }
}

// Update driver statuses based on started shifts and assigned orders
async function updateDriverStatusesWithOrders() {
    if (driversState.length === 0) {
        console.log('updateDriverStatusesWithOrders: No drivers in driversState, skipping');
        return;
    }
    
    console.log('updateDriverStatusesWithOrders: Processing', driversState.length, 'drivers');
    
    // Get drivers with started shifts
    const driversWithShifts = await getDriversWithStartedShifts();
    
    console.log('updateDriverStatusesWithOrders: Drivers with shifts set:', Array.from(driversWithShifts));
    
    // Get active deliveries from for_delivery collection (where timeDelivered is null)
    const activeDeliveries = await getActiveDeliveries();
    console.log('updateDriverStatusesWithOrders: Active deliveries from for_delivery collection:', activeDeliveries);
    
    // Track drivers that need to be moved to bottom of queue
    const driversToMoveToBottom = [];
    
    // Update each driver's status
    driversState.forEach((driver, index) => {
        // Firebase availability: "off" → always Off; "on" → Available or Busy based on shift/orders
        if (driver.availabilityFromFirebase === 'off') {
            driver.availability = 'off';
            driver.status = 'off';
            return;
        }

        const driverId = driver.driverId || driver.id;
        const driverStaffId = driver.staffId || driverId;
        const driverDocId = driver.id; // Document ID from staff collection
        
        // Collect all possible driver identifiers (remove duplicates)
        const driverIdentifiers = [
            driverId,
            driverStaffId,
            driverDocId,
            driver.staffId,
            driver.driverId,
            driver.id
        ].filter((id, index, arr) => id && arr.indexOf(id) === index); // Remove duplicates and nulls
        
        console.log('Checking driver:', {
            name: driver.name,
            driverId: driverId,
            staffId: driver.staffId,
            docId: driverDocId,
            allIdentifiers: driverIdentifiers
        });
        
        // Check if driver has started a shift by matching any of the identifiers
        // A driver has started a shift if they have ANY shift with a startTime in logsStaff
        // Also check string/number conversions since IDs might be stored differently
        let hasStartedShift = false;
        for (const identifier of driverIdentifiers) {
            // Check exact match
            if (driversWithShifts.has(identifier)) {
                hasStartedShift = true;
                console.log('✓ Driver', driver.name, 'has started shift (matched identifier:', identifier, ')');
                break;
            }
            // Check string/number conversion matches
            const identifierStr = String(identifier);
            const identifierNum = Number(identifier);
            if (driversWithShifts.has(identifierStr) || driversWithShifts.has(identifierNum)) {
                hasStartedShift = true;
                console.log('✓ Driver', driver.name, 'has started shift (matched identifier with type conversion:', identifier, ')');
                break;
            }
            // Also check if any shift driverId matches this identifier (bidirectional)
            for (const shiftDriverId of driversWithShifts) {
                const shiftIdStr = String(shiftDriverId);
                const shiftIdNum = Number(shiftDriverId);
                if (shiftIdStr === identifierStr || shiftIdNum === identifierNum || 
                    shiftIdStr === String(identifier) || shiftIdNum === Number(identifier)) {
                    hasStartedShift = true;
                    console.log('✓ Driver', driver.name, 'has started shift (matched via bidirectional check:', identifier, '==', shiftDriverId, ')');
                    break;
                }
            }
            if (hasStartedShift) break;
        }
        
        if (!hasStartedShift) {
            console.log('✗ Driver', driver.name, 'has NOT started shift. Checked identifiers:', driverIdentifiers, 'against shifts set:', Array.from(driversWithShifts));
            // No started shift = off
            driver.availability = 'off';
            driver.status = 'off';
        } else {
            // Has started shift, check for assigned deliveries in for_delivery collection
            let hasActiveDelivery = false;
            
            // Check for_delivery collection first (primary source)
            if (activeDeliveries && activeDeliveries.length > 0) {
                hasActiveDelivery = activeDeliveries.some(delivery => {
                    const deliveryDriverId = delivery.driverId || '';
                    // Match against all possible driver identifiers
                    return driverIdentifiers.some(identifier => {
                        const identifierStr = String(identifier);
                        const deliveryIdStr = String(deliveryDriverId);
                        return identifierStr === deliveryIdStr || 
                               String(identifier) === deliveryIdStr ||
                               identifier === deliveryDriverId;
                    });
                });
                
                if (hasActiveDelivery) {
                    console.log('→ Driver', driver.name, 'has active delivery in for_delivery collection');
                }
            }
            
            // Fallback: Also check ordersState if for_delivery check didn't find anything
            if (!hasActiveDelivery && ordersState && ordersState.length > 0) {
                hasActiveDelivery = ordersState.some(order => {
                    const orderDriverId = order.driverId || '';
                    const orderStatus = (order.status || '').toLowerCase().trim();
                    return (orderDriverId === driverId || orderDriverId === driverStaffId || orderDriverId === driver.id) &&
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
                    console.log('→ Driver', driver.name, 'has active delivery in ordersState (fallback)');
                }
            }
            
            if (hasActiveDelivery) {
                // Started shift + assigned orders = busy
                const wasAvailable = driver.availability === 'available';
                driver.availability = 'busy';
                driver.status = 'busy';
                console.log('→ Driver', driver.name, 'status set to BUSY (has active delivery)');
            } else {
                // Started shift + no assigned orders = available
                const wasAvailable = driver.availability === 'available';
                const wasBusy = driver.availability === 'busy';
                const wasOff = driver.availability === 'off';
                
                driver.availability = 'available';
                driver.status = 'available';
                console.log('→ Driver', driver.name, 'status set to AVAILABLE (shift started, no active delivery)');
                
                // First-come-first-serve: If driver just became available (from busy or off), mark for moving to bottom
                if ((wasBusy || wasOff) && !wasAvailable) {
                    driversToMoveToBottom.push(driver);
                    console.log('→ Driver', driver.name, 'will be moved to bottom of queue (first-come-first-serve)');
                }
            }
        }
        
        console.log('Final status for driver', driver.name + ':', driver.availability);
    });
    
    // Move drivers that just became available to bottom of queue (maintain first-come-first-serve order)
    driversToMoveToBottom.forEach(driverToMove => {
        const driverIndex = driversState.findIndex(d => 
            (d.id === driverToMove.id || d.driverId === driverToMove.driverId) && d.availability === 'available'
        );
        
        if (driverIndex !== -1 && driverIndex < driversState.length - 1) {
            // Move to bottom of list
            const movedDriver = driversState.splice(driverIndex, 1)[0];
            driversState.push(movedDriver);
            console.log('→ Driver', movedDriver.name, 'moved to bottom of queue (first-come-first-serve)');
        }
    });
    
    console.log('All drivers after status update:', driversState.map(d => ({
        name: d.name,
        driverId: d.driverId,
        staffId: d.staffId,
        availability: d.availability,
        status: d.status
    })));
    
    renderDriversList();
}

function normalizeDriverDoc(docSnap, driversWithShifts = new Set()) {
    if (!docSnap) return null;
    const data = docSnap.data() || {};
    
    // Get driver name - format: "Driver X - FirstName LastName" or just the name
    const firstName = data.firstName || data.first_name || '';
    const lastName = data.lastName || data.last_name || '';
    const nameParts = [firstName, lastName].filter(Boolean);
    const baseName = nameParts.length ? nameParts.join(' ') : (data.name || data.displayName || 'Unknown Driver');
    
    // Get driver ID
    const driverId = data.driverId || data.driver_id || data.staffId || data.id || docSnap.id;
    const driverStaffId = data.staffId || driverId;
    
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
    
    // Firebase availability: "on" → Active, "off" (or missing) → Inactive (shown in Driver Availability tab)
    const rawAvailability = data.availability;
    const availabilityFromFirebase = (rawAvailability === 'on' || rawAvailability === 'ON' || rawAvailability === true || rawAvailability === 'true' || rawAvailability === '1') ? 'on' : 'off';
    
    // Determine status: will be updated by updateDriverStatusesWithOrders() based on shifts and orders
    // Default to 'off' - will be updated when updateDriverStatusesWithOrders() runs
    let driverStatus = 'off';
    
    return {
        id: docSnap.id,
        driverId: driverId,
        staffId: driverStaffId,
        name: displayName,
        firstName: firstName,
        lastName: lastName,
        phoneNumber: phoneNumber,
        availability: driverStatus,
        status: driverStatus,
        availabilityFromFirebase: availabilityFromFirebase,
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
    
    // Apply availability filter (only when not "all")
    if (driverFilter === 'available') {
        filteredDrivers = filteredDrivers.filter(driver => driver.availability === 'available');
    } else if (driverFilter === 'busy') {
        filteredDrivers = filteredDrivers.filter(driver => driver.availability === 'busy');
    } else if (driverFilter === 'off') {
        filteredDrivers = filteredDrivers.filter(driver => driver.availability === 'off');
    }
    // driverFilter === 'all' → no filter, show everyone

    driversList.innerHTML = '';

    if (!filteredDrivers.length) {
        const msg = driversState.length === 0
            ? 'No drivers found. Add staff with role: Driver in the staff collection.'
            : 'No drivers found matching the current filters.';
        driversList.innerHTML = '<div class="empty-message">' + msg + '</div>';
        return;
    }

    filteredDrivers.forEach(driver => {
        const driverCard = document.createElement('div');
        driverCard.className = 'driver-card';
        
        // Status from driver.availability: Available (availability:on + no delivery), Busy (on + delivery), Off (availability:off)
        const status = driver.availability || 'off';
        const availabilityClass = status === 'available' ? 'available' : status === 'busy' ? 'busy' : 'off';
        const availabilityText = status === 'available' ? 'Available' : status === 'busy' ? 'Busy' : 'Off';
        
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
    document.getElementById('filterAll')?.classList.toggle('active', filter === 'all');
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

// ============================================================================
// DELIVERY BATCHING FUNCTIONS - Group nearby deliveries by barangay
// ============================================================================

/**
 * Extract barangay name from address string
 * Handles various Philippine address formats
 */
function extractBarangayFromAddress(address) {
    if (!address || typeof address !== 'string') return '';
    
    const addressLower = address.toLowerCase();
    
    // Look for explicit barangay markers
    const barangayPatterns = [
        /barangay\s+([^,]+)/i,
        /brgy\.?\s+([^,]+)/i,
        /bgy\.?\s+([^,]+)/i,
        /brg\.\s+([^,]+)/i
    ];
    
    for (const pattern of barangayPatterns) {
        const match = address.match(pattern);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    
    // If no explicit marker, try to extract from comma-separated parts
    // Common format: "Street, Barangay, City" or "Barangay, City"
    const parts = address.split(',').map(p => p.trim()).filter(p => p);
    if (parts.length >= 2) {
        // Second-to-last part might be barangay (before city)
        const potentialBarangay = parts[parts.length - 2];
        // Check if it's not a city name
        if (!potentialBarangay.match(/^(quezon city|caloocan|manila|metro manila)$/i)) {
            return potentialBarangay;
        }
    }
    
    return '';
}

/**
 * Extract city name from address string
 */
function extractCityFromAddress(address) {
    if (!address || typeof address !== 'string') return '';
    
    const parts = address.split(',').map(p => p.trim()).filter(p => p);
    if (parts.length === 0) return '';
    
    const lastPart = parts[parts.length - 1].toLowerCase();
    
    // Check for known cities
    if (lastPart.includes('quezon city')) {
        return 'Quezon City';
    }
    if (lastPart.includes('caloocan')) {
        return 'Caloocan City';
    }
    
    // Return last part as city
    return parts[parts.length - 1];
}

/**
 * Find nearby orders ready for delivery in the same barangay
 * Respects FIFO ordering - only includes orders older than or equal to primary order
 */
function findNearbyOrdersForBatching(primaryOrder, allReadyOrders, options = {}) {
    const {
        maxBatchSize = 3,
        sameBarangayOnly = true
    } = options;
    
    // Get primary order address info
    const primaryAddress = primaryOrder.address || primaryOrder.deliveryInfo?.address || '';
    if (!primaryAddress) {
        return []; // No address, can't batch
    }
    
    const primaryBarangay = extractBarangayFromAddress(primaryAddress);
    const primaryCity = extractCityFromAddress(primaryAddress);
    
    if (!primaryBarangay) {
        return []; // Can't determine barangay, can't batch
    }
    
    // Get primary order timestamp for FIFO comparison
    const primaryOrderTime = primaryOrder.createdAt?.toMillis?.() || 
                            primaryOrder.createdAt || 
                            primaryOrder.timestamp?.toMillis?.() ||
                            primaryOrder.timestamp ||
                            0;
    
    // Filter ready orders in same barangay and city
    const sameBarangayOrders = allReadyOrders.filter(order => {
        // Skip if same order
        if (order.id === primaryOrder.id) return false;
        
        // Skip if already assigned
        if (order.driverId) return false;
        
        // Skip if not delivery type
        const serviceType = (order.deliveryInfo?.serviceType || order.serviceType || '').toLowerCase();
        if (serviceType !== 'delivery') return false;
        
        // Skip if not ready for delivery
        const orderStatus = (order.status || '').toLowerCase().trim();
        if (orderStatus !== 'ready for delivery' && 
            orderStatus !== 'ready_for_delivery' &&
            orderStatus !== 'for delivery' &&
            orderStatus !== 'for_delivery') {
            return false;
        }
        
        // Check barangay and city match
        const orderAddress = order.address || order.deliveryInfo?.address || '';
        if (!orderAddress) return false;
        
        const orderBarangay = extractBarangayFromAddress(orderAddress);
        const orderCity = extractCityFromAddress(orderAddress);
        
        if (orderBarangay !== primaryBarangay || orderCity !== primaryCity) {
            return false;
        }
        
        // FIFO: Only include orders that are older than or equal to primary order
        const orderTime = order.createdAt?.toMillis?.() || 
                         order.createdAt || 
                         order.timestamp?.toMillis?.() ||
                         order.timestamp ||
                         0;
        
        // Include orders that are older (smaller timestamp) or same age
        return orderTime <= primaryOrderTime;
    });
    
    // Sort by creation time (oldest first) to maintain FIFO
    const sortedOrders = sameBarangayOrders.sort((a, b) => {
        const timeA = a.createdAt?.toMillis?.() || a.createdAt || a.timestamp?.toMillis?.() || a.timestamp || 0;
        const timeB = b.createdAt?.toMillis?.() || b.createdAt || b.timestamp?.toMillis?.() || b.timestamp || 0;
        return timeA - timeB; // Oldest first
    });
    
    // Limit batch size (excluding primary order)
    return sortedOrders.slice(0, maxBatchSize - 1);
}

/**
 * Assign driver to multiple orders (batch assignment)
 */
async function assignDriverToBatch(driverId, orders) {
    if (!driverId || !orders || !Array.isArray(orders) || orders.length === 0) {
        showNotification('Invalid batch assignment parameters.', 'error');
        return;
    }
    
    const driver = driversState.find(d => d.id === driverId || d.driverId === driverId);
    if (!driver) {
        showNotification('Driver not found.', 'error');
        return;
    }
    
    if (driver.availability !== 'available') {
        showNotification('Selected driver is not available.', 'error');
        return;
    }
    
    // Check FIFO constraint - only first available driver can be assigned
    const availableDrivers = driversState.filter(d => d.availability === 'available');
    const firstAvailableDriver = availableDrivers[0];
    
    if (!firstAvailableDriver || 
        (firstAvailableDriver.id !== driverId && firstAvailableDriver.driverId !== driverId && 
         firstAvailableDriver.id !== driver.id && firstAvailableDriver.driverId !== driver.driverId)) {
        showNotification('You can only assign the first available driver in the queue.', 'error');
        return;
    }
    
    try {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }
        
        const fns = window.firestoreFunctions;
        const batch = fns.writeBatch ? fns.writeBatch(window.db) : null;
        
        // Create route ID for batch
        const routeId = `route_${Date.now()}_${driverId}`;
        const timestamp = fns.serverTimestamp ? fns.serverTimestamp() : new Date();
        
        // Update all orders in batch
        for (let i = 0; i < orders.length; i++) {
            const order = orders[i];
            const orderRef = fns.doc(window.db, 'orders', order.id);
            
            const updateData = {
                driverId: driver.driverId || driver.id,
                routeId: routeId,
                routeSequence: i + 1,
                status: 'out_for_delivery',
                assignedAt: timestamp,
                updatedAt: timestamp
            };
            
            if (batch) {
                batch.update(orderRef, updateData);
            } else {
                await fns.updateDoc(orderRef, updateData);
            }
            
            // Update for_delivery collection
            const deliveryRef = fns.doc(window.db, 'for_delivery', order.id);
            const deliveryData = {
                deliveryId: order.id,
                orderId: order.id,
                driverId: driver.driverId || driver.id,
                routeId: routeId,
                routeSequence: i + 1,
                timeAssigned: timestamp,
                timeDelivered: null,
                updatedAt: timestamp
            };
            
            if (batch) {
                batch.set(deliveryRef, deliveryData, { merge: true });
            } else {
                await fns.setDoc(deliveryRef, deliveryData, { merge: true });
            }
            
            // Update local state
            const orderIndex = ordersState.findIndex(o => o.id === order.id);
            if (orderIndex !== -1) {
                ordersState[orderIndex].driverId = driver.driverId || driver.id;
                ordersState[orderIndex].status = 'out_for_delivery';
                ordersState[orderIndex].routeId = routeId;
                ordersState[orderIndex].routeSequence = i + 1;
            }
        }
        
        // Commit batch if using batch writes
        if (batch) {
            await batch.commit();
        }
        
        // Update driver status
        const driverIndex = driversState.findIndex(d => (d.id === driverId || d.driverId === driverId || d.id === driver.id || d.driverId === driver.driverId));
        if (driverIndex !== -1) {
            driversState[driverIndex].availability = 'busy';
            driversState[driverIndex].status = 'busy';
        }
        
        // Refresh UI
        renderOrdersTable(ordersState);
        renderDriversList();
        
        const orderIds = orders.map(o => o.trackingId || o.id).join(', ');
        showNotification(`Driver ${driver.name} assigned to ${orders.length} orders: ${orderIds}`, 'success');
        closeDriverSelectionModal();
    } catch (error) {
        console.error('Error assigning driver to batch:', error);
        showNotification('Failed to assign driver to batch. Please try again.', 'error');
    }
}

async function assignDriverToOrder(driverId, orderId) {
    console.log('assignDriverToOrder called:', { driverId, orderId });
    
    if (!driverId || !orderId) {
        console.error('assignDriverToOrder: Missing parameters', { driverId, orderId });
        showNotification('Driver ID or Order ID is missing.', 'error');
        return;
    }
    
    const driver = driversState.find(d => 
        d.id === driverId || 
        d.driverId === driverId || 
        String(d.id) === String(driverId) || 
        String(d.driverId) === String(driverId)
    );
    const order = ordersState.find(o => o.id === orderId);
    
    console.log('assignDriverToOrder: Found driver:', driver ? driver.name : 'NOT FOUND');
    console.log('assignDriverToOrder: Found order:', order ? order.id : 'NOT FOUND');
    console.log('assignDriverToOrder: driversState:', driversState.map(d => ({ id: d.id, driverId: d.driverId, name: d.name })));
    
    if (!driver) {
        console.error('assignDriverToOrder: Driver not found. Looking for:', driverId);
        console.error('assignDriverToOrder: Available drivers:', driversState.map(d => ({ id: d.id, driverId: d.driverId })));
        showNotification('Driver not found.', 'error');
        return;
    }
    
    if (!order) {
        console.error('assignDriverToOrder: Order not found. Looking for:', orderId);
        showNotification('Order not found.', 'error');
        return;
    }
    
    if (driver.availability !== 'available') {
        console.warn('assignDriverToOrder: Driver not available:', driver.availability);
        showNotification('Selected driver is not available.', 'error');
        return;
    }
    
    // First-come-first-serve: Only allow assigning the first available driver
    const availableDrivers = driversState.filter(d => d.availability === 'available');
    const firstAvailableDriver = availableDrivers[0];
    
    console.log('assignDriverToOrder: First available driver:', firstAvailableDriver ? firstAvailableDriver.name : 'NONE');
    console.log('assignDriverToOrder: Checking FIFO constraint...');
    
    if (!firstAvailableDriver) {
        showNotification('No available drivers.', 'error');
        return;
    }
    
    // Check if the selected driver is the first available driver
    const isFirstDriver = (
        firstAvailableDriver.id === driverId || 
        firstAvailableDriver.driverId === driverId ||
        firstAvailableDriver.id === driver.id ||
        firstAvailableDriver.driverId === driver.driverId ||
        String(firstAvailableDriver.id) === String(driverId) ||
        String(firstAvailableDriver.driverId) === String(driverId)
    );
    
    if (!isFirstDriver) {
        console.warn('assignDriverToOrder: FIFO violation - not first driver');
        showNotification('You can only assign the first available driver in the queue. Please select the driver at the top of the list.', 'error');
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
        
        // Print customer receipt (order is now On The Way)
        if (typeof printCustomerReceipt === 'function') {
            printCustomerReceipt(order);
        }
        
        // Free up previous driver if one was assigned
        const previousDriverId = order.driverId;
        if (previousDriverId && previousDriverId !== (driver.driverId || driver.id)) {
            const previousDriverIndex = driversState.findIndex(d => 
                (d.driverId === previousDriverId || d.id === previousDriverId)
            );
            if (previousDriverIndex !== -1) {
                // Check if previous driver has other active deliveries
                const otherActiveDeliveries = ordersState.filter(o => 
                    o.driverId === previousDriverId && 
                    o.id !== orderId &&
                    (o.status === 'out_for_delivery' || o.status === 'out-for-delivery' || 
                     o.status === 'in-transit' || o.status === 'in_transit')
                );
                
                // Only free up if no other active deliveries
                if (otherActiveDeliveries.length === 0) {
                    driversState[previousDriverIndex].availability = 'available';
                    driversState[previousDriverIndex].status = 'available';
                    console.log(`Freed up previous driver: ${driversState[previousDriverIndex].name}`);
                }
            }
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
window.assignDriverToBatch = assignDriverToBatch;
window.assignBatchToDriver = assignBatchToDriver;
window.assignSingleOrderOnly = assignSingleOrderOnly;
window.checkForNearbyOrders = checkForNearbyOrders;
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

// Order meatball menu functions
function toggleOrderMeatballMenu(orderId, event) {
    event = event || window.event;
    const menuId = `orderMeatballMenu_${orderId}`;
    const dropdown = document.getElementById(menuId);
    if (!dropdown) {
        console.error('Dropdown not found:', menuId);
        return;
    }
    
    // Close all other order meatball menus
    document.querySelectorAll('.meatball-menu-dropdown').forEach(menu => {
        if (menu.id !== menuId && menu.id.startsWith('orderMeatballMenu_')) {
            menu.style.display = 'none';
        }
    });
    
    // Toggle current menu
    const isVisible = dropdown.style.display === 'block';
    if (!isVisible) {
        // Get the button that triggered this menu
        const button = event?.target?.closest('.meatball-menu-btn') || 
                      dropdown.parentElement?.querySelector('.meatball-menu-btn');
        
        // Store original parent to restore later
        const originalParent = dropdown.parentElement;
        dropdown._originalParent = originalParent;
        
        // Move dropdown to body to break out of table stacking context
        if (dropdown.parentElement !== document.body) {
            document.body.appendChild(dropdown);
        }
        
        // Use fixed positioning to break out of table stacking context
        dropdown.style.display = 'block';
        dropdown.style.position = 'fixed';
        dropdown.style.overflow = 'visible';
        dropdown.style.pointerEvents = 'auto';
        dropdown.style.zIndex = '999999';
        
        // Calculate position relative to the button
        if (button) {
            const rect = button.getBoundingClientRect();
            const dropdownWidth = dropdown.offsetWidth || 180; // fallback width
            
            // Position to the left of the button
            dropdown.style.left = `${rect.left - dropdownWidth - 8}px`;
            dropdown.style.top = `${rect.top}px`;
            dropdown.style.right = 'auto';
            dropdown.style.bottom = 'auto';
        } else {
            // Fallback to absolute positioning if button not found
            dropdown.style.position = 'absolute';
            dropdown.style.top = '0';
            dropdown.style.right = 'calc(100% + 8px)';
            dropdown.style.bottom = 'auto';
            dropdown.style.left = 'auto';
        }
        
        // Ensure all buttons inside are clickable
        const allButtons = dropdown.querySelectorAll('button');
        allButtons.forEach(btn => {
            btn.style.pointerEvents = 'auto';
            btn.style.cursor = 'pointer';
            btn.style.position = 'relative';
            btn.style.zIndex = '1000000';
        });
        
        // Ensure dropdown container is also clickable
        dropdown.style.isolation = 'auto';
        
        // Store button reference for repositioning on scroll
        const updatePosition = () => {
            if (button && dropdown.style.display === 'block') {
                const rect = button.getBoundingClientRect();
                const dropdownWidth = dropdown.offsetWidth || 180;
                dropdown.style.left = `${rect.left - dropdownWidth - 8}px`;
                dropdown.style.top = `${rect.top}px`;
            }
        };
        
        // Update position on scroll/resize
        const scrollHandler = () => updatePosition();
        const resizeHandler = () => updatePosition();
        window.addEventListener('scroll', scrollHandler, true);
        window.addEventListener('resize', resizeHandler);
        
        // Store handlers for cleanup
        dropdown._scrollHandler = scrollHandler;
        dropdown._resizeHandler = resizeHandler;
        
        // Close on outside click
        const closeOnOutsideClick = (e) => {
            // Don't close if clicking inside the dropdown, on menu items, or the button
            if (dropdown.contains(e.target) || 
                e.target.closest('.meatball-menu-item') || 
                e.target.closest('.meatball-menu-btn')) {
                return;
            }
            dropdown.style.display = 'none';
            // Restore dropdown to original parent
            if (dropdown._originalParent && dropdown.parentElement === document.body) {
                dropdown._originalParent.appendChild(dropdown);
            }
            // Clean up event listeners
            if (dropdown._scrollHandler) {
                window.removeEventListener('scroll', dropdown._scrollHandler, true);
            }
            if (dropdown._resizeHandler) {
                window.removeEventListener('resize', dropdown._resizeHandler);
            }
            document.removeEventListener('click', closeOnOutsideClick);
        };
        setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 0);
    } else {
        dropdown.style.display = 'none';
        // Restore dropdown to original parent
        if (dropdown._originalParent && dropdown.parentElement === document.body) {
            dropdown._originalParent.appendChild(dropdown);
        }
        // Clean up event listeners
        if (dropdown._scrollHandler) {
            window.removeEventListener('scroll', dropdown._scrollHandler, true);
        }
        if (dropdown._resizeHandler) {
            window.removeEventListener('resize', dropdown._resizeHandler);
        }
    }
}

function closeOrderMeatballMenu(orderId) {
    const menuId = `orderMeatballMenu_${orderId}`;
    const dropdown = document.getElementById(menuId);
    if (dropdown) {
        dropdown.style.display = 'none';
        // Restore dropdown to original parent
        if (dropdown._originalParent && dropdown.parentElement === document.body) {
            dropdown._originalParent.appendChild(dropdown);
        }
        // Clean up event listeners
        if (dropdown._scrollHandler) {
            window.removeEventListener('scroll', dropdown._scrollHandler, true);
        }
        if (dropdown._resizeHandler) {
            window.removeEventListener('resize', dropdown._resizeHandler);
        }
    }
}

// Make functions globally accessible
window.hideMenuItem = hideMenuItem;
window.toggleMeatballMenu = toggleMeatballMenu;
window.restoreMenuItem = restoreMenuItem;
window.discardMenuDetailEdit = discardMenuDetailEdit;
window.handleCategorySelect = handleCategorySelect;
window.handleCategoryCustomInput = handleCategoryCustomInput;
window.toggleOrderMeatballMenu = toggleOrderMeatballMenu;
window.closeOrderMeatballMenu = closeOrderMeatballMenu;

// ==================== CLOCK-IN SYSTEM FUNCTIONS ====================

// Global variables for clock-in system
let currentClockInCode = null;
let currentClockOutCode = null;
let clockInCodeInterval = null;
let clockOutCodeInterval = null;

// Switch between driver tabs
function switchDriverTab(tab) {
    const availabilityTab = document.getElementById('driverAvailabilityTab');
    const clockInTab = document.getElementById('clockInSystemTab');
    const tabButtons = document.querySelectorAll('.driver-tab-btn');
    
    // Remove active class from all tabs
    tabButtons.forEach(btn => btn.classList.remove('active'));
    
    // Hide all tab contents
    if (availabilityTab) availabilityTab.style.display = 'none';
    if (clockInTab) clockInTab.style.display = 'none';
    
    // Show selected tab
    if (tab === 'availability') {
        if (availabilityTab) availabilityTab.style.display = 'block';
        tabButtons[0]?.classList.add('active');
    } else if (tab === 'clockin') {
        if (clockInTab) clockInTab.style.display = 'block';
        tabButtons[1]?.classList.add('active');
        // Initialize clock-in system when tab is opened
        initClockInSystem();
    }
}

// Switch between QR code tabs (clock-in/clock-out)
function switchQRTab(type) {
    const clockInSection = document.getElementById('clockInQRSection');
    const clockOutSection = document.getElementById('clockOutQRSection');
    const qrTabButtons = document.querySelectorAll('.qr-tab-btn');
    
    // Remove active class from all QR tabs
    qrTabButtons.forEach(btn => btn.classList.remove('active'));
    
    // Hide all QR sections
    if (clockInSection) clockInSection.style.display = 'none';
    if (clockOutSection) clockOutSection.style.display = 'none';
    
    // Show selected QR section
    if (type === 'clockin') {
        if (clockInSection) clockInSection.style.display = 'block';
        qrTabButtons[0]?.classList.add('active');
    } else if (type === 'clockout') {
        if (clockOutSection) clockOutSection.style.display = 'block';
        qrTabButtons[1]?.classList.add('active');
    }
}

// Initialize clock-in system
async function initClockInSystem() {
    try {
        await waitForFirebaseReady();
        await loadActiveClockInCodes();
        await loadClockInLogs();
    } catch (error) {
        console.error('Error initializing clock-in system:', error);
        showNotification('Failed to initialize clock-in system', 'error');
    }
}

// Load active clock-in codes from Firestore
async function loadActiveClockInCodes() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns?.getDocs || !fns?.collection) {
        return;
    }
    
    try {
        const clockInCodesRef = fns.collection(window.db, 'clockInCodes');
        const snapshot = await fns.getDocs(clockInCodesRef);
        
        const now = new Date();
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const validUntil = data.validUntil?.toDate ? data.validUntil.toDate() : 
                              (data.validUntil instanceof Date ? data.validUntil : null);
            
            if (validUntil && validUntil > now && data.isActive === true) {
                if (data.type === 'clock_in' && !currentClockInCode) {
                    currentClockInCode = { id: doc.id, code: data.code, validUntil: validUntil };
                    displayClockInCode(data.code, validUntil);
                    startClockInCountdown(validUntil);
                } else if (data.type === 'clock_out' && !currentClockOutCode) {
                    currentClockOutCode = { id: doc.id, code: data.code, validUntil: validUntil };
                    displayClockOutCode(data.code, validUntil);
                    startClockOutCountdown(validUntil);
                }
            }
        });
    } catch (error) {
        console.error('Error loading active clock-in codes:', error);
    }
}

// Generate clock-in code
async function generateClockInCode() {
    const durationInput = document.getElementById('clockInDuration');
    const duration = parseInt(durationInput?.value || 60);
    
    if (duration < 1 || duration > 1440) {
        showNotification('Duration must be between 1 and 1440 minutes', 'error');
        return;
    }
    
    try {
        await waitForFirebaseReady();
        const fns = window.firestoreFunctions;
        
        // Generate unique code
        const code = generateUniqueCode();
        const now = new Date();
        const validUntil = new Date(now.getTime() + duration * 60000);
        
        // Get restaurant ID (use a default or from settings)
        const restaurantId = 'pablos_peri_peri'; // You may want to get this from settings
        
        // Deactivate existing clock-in codes
        if (currentClockInCode) {
            try {
                const oldCodeRef = fns.doc(window.db, 'clockInCodes', currentClockInCode.id);
                await fns.updateDoc(oldCodeRef, { isActive: false });
            } catch (e) {
                console.warn('Could not deactivate old code:', e);
            }
        }
        
        // Create new clock-in code document
        const codeData = {
            code: code,
            type: 'clock_in',
            restaurantId: restaurantId,
            validUntil: fns.Timestamp.fromDate(validUntil),
            isActive: true,
            createdAt: fns.serverTimestamp(),
            maxUses: null, // Unlimited uses
            currentUses: 0,
            usedBy: []
        };
        
        const codeId = `clock_in_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const codeRef = fns.doc(window.db, 'clockInCodes', codeId);
        await fns.setDoc(codeRef, codeData);
        
        currentClockInCode = { id: codeId, code: code, validUntil: validUntil };
        displayClockInCode(code, validUntil);
        
        // Start countdown timer
        startClockInCountdown(validUntil);
        
        showNotification('Clock-in code generated successfully', 'success');
    } catch (error) {
        console.error('Error generating clock-in code:', error);
        showNotification('Failed to generate clock-in code', 'error');
    }
}

// Generate clock-out code
async function generateClockOutCode() {
    const durationInput = document.getElementById('clockOutDuration');
    const duration = parseInt(durationInput?.value || 60);
    
    if (duration < 1 || duration > 1440) {
        showNotification('Duration must be between 1 and 1440 minutes', 'error');
        return;
    }
    
    try {
        await waitForFirebaseReady();
        const fns = window.firestoreFunctions;
        
        // Generate unique code
        const code = generateUniqueCode();
        const now = new Date();
        const validUntil = new Date(now.getTime() + duration * 60000);
        
        // Get restaurant ID
        const restaurantId = 'pablos_peri_peri';
        
        // Deactivate existing clock-out codes
        if (currentClockOutCode) {
            try {
                const oldCodeRef = fns.doc(window.db, 'clockInCodes', currentClockOutCode.id);
                await fns.updateDoc(oldCodeRef, { isActive: false });
            } catch (e) {
                console.warn('Could not deactivate old code:', e);
            }
        }
        
        // Create new clock-out code document
        const codeData = {
            code: code,
            type: 'clock_out',
            restaurantId: restaurantId,
            validUntil: fns.Timestamp.fromDate(validUntil),
            isActive: true,
            createdAt: fns.serverTimestamp(),
            maxUses: null,
            currentUses: 0,
            usedBy: []
        };
        
        const codeId = `clock_out_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const codeRef = fns.doc(window.db, 'clockInCodes', codeId);
        await fns.setDoc(codeRef, codeData);
        
        currentClockOutCode = { id: codeId, code: code, validUntil: validUntil };
        displayClockOutCode(code, validUntil);
        
        // Start countdown timer
        startClockOutCountdown(validUntil);
        
        showNotification('Clock-out code generated successfully', 'success');
    } catch (error) {
        console.error('Error generating clock-out code:', error);
        showNotification('Failed to generate clock-out code', 'error');
    }
}

// Generate unique code
function generateUniqueCode() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Display clock-in code and QR
function displayClockInCode(code, validUntil) {
    const codeDisplay = document.getElementById('clockInCodeDisplay');
    const validUntilDisplay = document.getElementById('clockInValidUntil');
    const statusBadge = document.getElementById('clockInStatus');
    const clearBtn = document.getElementById('clearClockInBtn');
    const canvas = document.getElementById('clockInQRCanvas');
    
    if (codeDisplay) codeDisplay.textContent = code;
    if (validUntilDisplay) {
        validUntilDisplay.textContent = validUntil.toLocaleString();
    }
    if (statusBadge) {
        statusBadge.textContent = 'Active';
        statusBadge.className = 'status-badge status-active';
    }
    if (clearBtn) clearBtn.style.display = 'inline-block';
    
    // Generate QR code
    if (canvas && typeof QRCode !== 'undefined') {
        canvas.innerHTML = '';
        new QRCode(canvas, {
            text: code,
            width: 320,
            height: 320,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });
    }
}

// Display clock-out code and QR
function displayClockOutCode(code, validUntil) {
    const codeDisplay = document.getElementById('clockOutCodeDisplay');
    const validUntilDisplay = document.getElementById('clockOutValidUntil');
    const statusBadge = document.getElementById('clockOutStatus');
    const clearBtn = document.getElementById('clearClockOutBtn');
    const canvas = document.getElementById('clockOutQRCanvas');
    
    if (codeDisplay) codeDisplay.textContent = code;
    if (validUntilDisplay) {
        validUntilDisplay.textContent = validUntil.toLocaleString();
    }
    if (statusBadge) {
        statusBadge.textContent = 'Active';
        statusBadge.className = 'status-badge status-active';
    }
    if (clearBtn) clearBtn.style.display = 'inline-block';
    
    // Generate QR code
    if (canvas && typeof QRCode !== 'undefined') {
        canvas.innerHTML = '';
        new QRCode(canvas, {
            text: code,
            width: 320,
            height: 320,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });
    }
}

// Start countdown timer for clock-in code
function startClockInCountdown(validUntil) {
    if (clockInCodeInterval) {
        clearInterval(clockInCodeInterval);
    }
    
    clockInCodeInterval = setInterval(() => {
        const now = new Date();
        const validUntilDisplay = document.getElementById('clockInValidUntil');
        const statusBadge = document.getElementById('clockInStatus');
        
        if (now >= validUntil) {
            // Code expired
            if (validUntilDisplay) validUntilDisplay.textContent = 'Expired';
            if (statusBadge) {
                statusBadge.textContent = 'Expired';
                statusBadge.className = 'status-badge status-inactive';
            }
            clearInterval(clockInCodeInterval);
            currentClockInCode = null;
        } else {
            // Update display
            if (validUntilDisplay) {
                const timeLeft = Math.floor((validUntil - now) / 1000 / 60);
                validUntilDisplay.textContent = `${validUntil.toLocaleString()} (${timeLeft} min left)`;
            }
        }
    }, 60000); // Update every minute
}

// Start countdown timer for clock-out code
function startClockOutCountdown(validUntil) {
    if (clockOutCodeInterval) {
        clearInterval(clockOutCodeInterval);
    }
    
    clockOutCodeInterval = setInterval(() => {
        const now = new Date();
        const validUntilDisplay = document.getElementById('clockOutValidUntil');
        const statusBadge = document.getElementById('clockOutStatus');
        
        if (now >= validUntil) {
            // Code expired
            if (validUntilDisplay) validUntilDisplay.textContent = 'Expired';
            if (statusBadge) {
                statusBadge.textContent = 'Expired';
                statusBadge.className = 'status-badge status-inactive';
            }
            clearInterval(clockOutCodeInterval);
            currentClockOutCode = null;
        } else {
            // Update display
            if (validUntilDisplay) {
                const timeLeft = Math.floor((validUntil - now) / 1000 / 60);
                validUntilDisplay.textContent = `${validUntil.toLocaleString()} (${timeLeft} min left)`;
            }
        }
    }, 60000); // Update every minute
}

// Clear clock-in code
async function clearClockInCode() {
    if (!currentClockInCode) return;
    
    try {
        await waitForFirebaseReady();
        const fns = window.firestoreFunctions;
        
        const codeRef = fns.doc(window.db, 'clockInCodes', currentClockInCode.id);
        await fns.updateDoc(codeRef, { isActive: false });
        
        // Clear display
        const codeDisplay = document.getElementById('clockInCodeDisplay');
        const validUntilDisplay = document.getElementById('clockInValidUntil');
        const statusBadge = document.getElementById('clockInStatus');
        const clearBtn = document.getElementById('clearClockInBtn');
        const canvas = document.getElementById('clockInQRCanvas');
        
        if (codeDisplay) codeDisplay.textContent = '—';
        if (validUntilDisplay) validUntilDisplay.textContent = '—';
        if (statusBadge) {
            statusBadge.textContent = 'Not Generated';
            statusBadge.className = 'status-badge status-inactive';
        }
    if (clearBtn) clearBtn.style.display = 'none';
    if (canvas) {
        canvas.innerHTML = '';
        // Also clear the parent box if it exists
        const box = canvas.closest('.qr-code-box');
        if (box && box.querySelector('canvas')) {
            box.querySelector('canvas').innerHTML = '';
        }
    }
        
        if (clockInCodeInterval) {
            clearInterval(clockInCodeInterval);
            clockInCodeInterval = null;
        }
        
        currentClockInCode = null;
        showNotification('Clock-in code cleared', 'success');
    } catch (error) {
        console.error('Error clearing clock-in code:', error);
        showNotification('Failed to clear clock-in code', 'error');
    }
}

// Clear clock-out code
async function clearClockOutCode() {
    if (!currentClockOutCode) return;
    
    try {
        await waitForFirebaseReady();
        const fns = window.firestoreFunctions;
        
        const codeRef = fns.doc(window.db, 'clockInCodes', currentClockOutCode.id);
        await fns.updateDoc(codeRef, { isActive: false });
        
        // Clear display
        const codeDisplay = document.getElementById('clockOutCodeDisplay');
        const validUntilDisplay = document.getElementById('clockOutValidUntil');
        const statusBadge = document.getElementById('clockOutStatus');
        const clearBtn = document.getElementById('clearClockOutBtn');
        const canvas = document.getElementById('clockOutQRCanvas');
        
        if (codeDisplay) codeDisplay.textContent = '—';
        if (validUntilDisplay) validUntilDisplay.textContent = '—';
        if (statusBadge) {
            statusBadge.textContent = 'Not Generated';
            statusBadge.className = 'status-badge status-inactive';
        }
    if (clearBtn) clearBtn.style.display = 'none';
    if (canvas) {
        canvas.innerHTML = '';
        // Also clear the parent box if it exists
        const box = canvas.closest('.qr-code-box');
        if (box && box.querySelector('canvas')) {
            box.querySelector('canvas').innerHTML = '';
        }
    }
        
        if (clockOutCodeInterval) {
            clearInterval(clockOutCodeInterval);
            clockOutCodeInterval = null;
        }
        
        currentClockOutCode = null;
        showNotification('Clock-out code cleared', 'success');
    } catch (error) {
        console.error('Error clearing clock-out code:', error);
        showNotification('Failed to clear clock-out code', 'error');
    }
}

// Load clock-in logs
async function loadClockInLogs() {
    if (!isFirestoreReady()) {
        await waitForFirebaseReady();
    }
    const fns = window.firestoreFunctions;
    if (!fns?.getDocs || !fns?.collection) {
        return;
    }
    
    const logsContainer = document.getElementById('clockInLogs');
    if (!logsContainer) return;
    
    try {
        logsContainer.innerHTML = '<div class="loading-message">Loading clock-in logs...</div>';
        
        const logsRef = fns.collection(window.db, 'logsStaff');
        let snapshot;
        
        try {
            snapshot = await fns.getDocs(fns.query(
                logsRef,
                fns.orderBy('startTime', 'desc')
            ));
        } catch (e) {
            // Fallback if index missing
            snapshot = await fns.getDocs(logsRef);
        }
        
        const logs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            logs.push({
                id: doc.id,
                driverId: data.driverId || '',
                driverName: data.driverName || 'Unknown',
                startTime: data.startTime?.toDate ? data.startTime.toDate() : 
                          (data.startTime instanceof Date ? data.startTime : null),
                endTime: data.endTime?.toDate ? data.endTime.toDate() : 
                        (data.endTime instanceof Date ? data.endTime : null)
            });
        });
        
        // Sort by startTime descending
        logs.sort((a, b) => {
            if (!a.startTime) return 1;
            if (!b.startTime) return -1;
            return b.startTime - a.startTime;
        });
        
        renderClockInLogs(logs);
    } catch (error) {
        console.error('Error loading clock-in logs:', error);
        logsContainer.innerHTML = '<div class="error-message">Failed to load clock-in logs</div>';
    }
}

// Render clock-in logs
function renderClockInLogs(logs) {
    const logsContainer = document.getElementById('clockInLogs');
    if (!logsContainer) return;
    
    if (logs.length === 0) {
        logsContainer.innerHTML = '<div class="empty-message">No clock-in logs found</div>';
        return;
    }
    
    logsContainer.innerHTML = logs.map(log => {
        const startTimeStr = log.startTime ? log.startTime.toLocaleString() : 'N/A';
        const endTimeStr = log.endTime ? log.endTime.toLocaleString() : '—';
        const duration = log.startTime && log.endTime ? 
            formatDuration(log.endTime - log.startTime) : 
            (log.startTime ? 'In Progress' : 'N/A');
        
        return `
            <div class="clockin-log-item">
                <div class="clockin-log-info">
                    <div class="clockin-log-driver">${escapeHtml(log.driverName)}</div>
                    <div class="clockin-log-time">
                        <strong>Start:</strong> ${startTimeStr}<br>
                        <strong>End:</strong> ${endTimeStr}<br>
                        <strong>Duration:</strong> ${duration}
                    </div>
                </div>
                <div class="clockin-log-type ${log.endTime ? 'clock-out' : 'clock-in'}">
                    ${log.endTime ? 'Clock-Out' : 'Clock-In'}
                </div>
            </div>
        `;
    }).join('');
}

// Format duration
function formatDuration(ms) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
}

// Refresh clock-in logs
async function refreshClockInLogs() {
    await loadClockInLogs();
    showNotification('Clock-in logs refreshed', 'success');
}

// Expose functions globally
window.switchDriverTab = switchDriverTab;
window.switchQRTab = switchQRTab;
window.generateClockInCode = generateClockInCode;
window.generateClockOutCode = generateClockOutCode;
window.clearClockInCode = clearClockInCode;
window.clearClockOutCode = clearClockOutCode;
window.refreshClockInLogs = refreshClockInLogs;



