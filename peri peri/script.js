// Global variables
let activeDropdown = null;
let inventoryState = [];
let menuState = [];
let uploadedFoodImageDataUrl = null;
let ordersState = [];
let ordersUnsubscribe = null;
const customerDetailsCache = new Map();
const customerFetchInProgress = new Set();

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
    tableBody.innerHTML = '<tr><td colspan="9" class="empty-table">Loading customer orders...</td></tr>';

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
                renderOrdersTable(ordersState);
                hydrateOrderCustomers(ordersState);
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
    const statusValue = (data.status || 'pending').toString().toLowerCase();
    return {
        id: docSnap.id,
        trackingId: data.trackingId || `#${docSnap.id.slice(-6).toUpperCase()}`,
        userId: data.userId || data.customerId || '',
        driverId: data.driverId || data.driver?.id || '',
        items: Array.isArray(data.items) ? data.items : [],
        total: typeof data.total === 'number' ? data.total : Number(data.total) || 0,
        paymentMode: data.paymentMode || data.payment?.method || data.paymentMethod || 'Unspecified',
        status: statusValue,
        deliveryInfo: data.deliveryInfo || {},
        createdAt,
        createdLabel: createdAt ? formatDateLabel(createdAt) : (typeof data.timestamp === 'string' ? data.timestamp : '—')
    };
}

function renderOrdersTable(orders) {
    const tableBody = document.getElementById('ordersTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '';

    if (!orders || !orders.length) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="9" class="empty-table">No customer orders found yet.</td>';
        tableBody.appendChild(emptyRow);
        return;
    }

    const sortedOrders = [...orders].sort((a, b) => {
        const aTime = a?.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const bTime = b?.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return bTime - aTime;
    });

    sortedOrders.forEach(order => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${escapeHtml(order.driverId || '—')}</td>
            <td>${escapeHtml(order.trackingId || order.id)}</td>
            <td>${formatOrderItems(order.items)}</td>
            <td>${formatOrderCustomer(order)}</td>
            <td>${escapeHtml(order.createdLabel || '—')}</td>
            <td>${formatCurrency(order.total)}</td>
            <td>${escapeHtml(order.paymentMode || 'Unspecified')}</td>
            <td>${formatOrderStatusBadge(order.status)}</td>
            <td class="actions">
                <button class="action-btn edit" onclick="editOrder('${order.id}')"><i class="fas fa-edit"></i></button>
                <button class="action-btn delete" onclick="deleteOrder('${order.id}')"><i class="fas fa-trash"></i></button>
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

// Order management functions
function editOrder(orderId) {
    alert(`Edit order ${orderId} - This would open an edit form in a real application`);
}

function deleteOrder(orderId) {
    if (confirm(`Are you sure you want to delete order ${orderId}?`)) {
        alert(`Order ${orderId} deleted successfully`);
        // In a real application, this would make an API call to delete the order
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
    const normalized = (status || 'pending').toString().toLowerCase();
    let className = 'process';
    if (['completed', 'delivered', 'ready'].includes(normalized)) {
        className = 'delivered';
    } else if (['cancelled', 'canceled', 'failed'].includes(normalized)) {
        className = 'process cancelled';
    }
    const label = normalized
        ? normalized.replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
        : 'Pending';
    return `<span class="status ${className}">${label || 'Pending'}</span>`;
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
    }
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
window.editOrder = editOrder;
window.deleteOrder = deleteOrder;
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

function previewImage(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const imagePreview = document.getElementById('imagePreview');
            imagePreview.innerHTML = `<img src="${e.target.result}" alt="Food Preview">`;
            uploadedFoodImageDataUrl = e.target.result;
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function removeImage() {
    const imagePreview = document.getElementById('imagePreview');
    if (imagePreview) {
        imagePreview.innerHTML = `
            <div class="upload-placeholder">
                <i class="fas fa-plus"></i>
                <span>Add Photo</span>
            </div>
        `;
    }
    const imageInput = document.getElementById('imageInput');
    if (imageInput) {
        imageInput.value = '';
    }
    uploadedFoodImageDataUrl = null;
}

function submitFood(event) {
    return handleMenuFormSubmit(event);
}

// Update the existing addFood function
function addFood() {
    showAddFood();
}

window.showAddFood = showAddFood;
window.hideAddFood = hideAddFood;
window.previewImage = previewImage;
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

function markDelivered(orderId) {
    if (confirm(`Mark order #${orderId} as delivered?`)) {
        // Update the delivery status
        const deliveryCard = document.querySelector(`[onclick*="markDelivered('${orderId}')"]`).closest('.delivery-card');
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

window.addEventListener('beforeunload', () => {
    if (typeof ordersUnsubscribe === 'function') {
        ordersUnsubscribe();
        ordersUnsubscribe = null;
    }
});

