// Global variables
let activeDropdown = null;
let inventoryState = [];

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
    
    // Initialize any page-specific functionality
    if (currentPage === 'customer.html') {
        // Initialize customer management specific functionality
        console.log('Customer management page loaded');
    } else if (currentPage === 'sales.html') {
        // Initialize sales report specific functionality
        initInventoryManagement();
        console.log('Sales report page loaded');
    } else if (currentPage === 'menu.html') {
        // Initialize menu management specific functionality
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
    document.getElementById('addFoodDashboard').style.display = 'block';
    document.getElementById('foodSection').style.display = 'none';
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
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function removeImage() {
    const imagePreview = document.getElementById('imagePreview');
    imagePreview.innerHTML = `
        <div class="upload-placeholder">
            <i class="fas fa-plus"></i>
            <span>Add Photo</span>
        </div>
    `;
    document.getElementById('imageInput').value = '';
}

function submitFood() {
    const category = document.getElementById('category').value;
    const foodId = document.getElementById('foodId').value;
    const foodName = document.getElementById('foodName').value;
    const price = document.getElementById('price').value;
    const description = document.getElementById('description').value;
    
    if (!foodName || !price) {
        alert('Please fill in all required fields');
        return;
    }
    
    // Here you would typically send the data to a server
    console.log('Adding food:', { category, foodId, foodName, price, description });
    
    // Reset form
    document.getElementById('foodId').value = '';
    document.getElementById('foodName').value = '';
    document.getElementById('price').value = '';
    document.getElementById('description').value = '';
    removeImage();
    
    // Show success message and go back to menu
    alert('Food item added successfully!');
    hideAddFood();
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

