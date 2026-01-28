// ============================================
// ACCOUNT PAGE FUNCTIONALITY
// All account management features (addresses, profile, security, loyalty, reviews)
// ============================================

(function() {
    'use strict';

    // Navigation functions are provided by utils.js
    function getProviderIds(user) {
        const list = Array.isArray(user?.providerData) ? user.providerData : [];
        const ids = list.map((p) => p?.providerId).filter(Boolean);
        return ids;
    }

    function isPasswordProviderUser(user) {
        return getProviderIds(user).includes('password');
    }

    function isGoogleProviderUser(user) {
        return getProviderIds(user).includes('google.com');
    }

    function normalizeString(value) {
        const v = String(value ?? '').trim();
        return v || '';
    }

    async function requireCompleteProfile(user) {
        // Ensure OAuth users (Google) still provide first/last name + phone like email/password users do.
        try {
            if (!user?.uid) return true;
            await window.utils?.waitForFirebaseReady?.();
            if (!window.firebaseDb || !window.doc || !window.getDoc) return true;

            const ref = window.doc(window.firebaseDb, 'customers', user.uid);
            const snap = await window.getDoc(ref);
            const data = snap.exists() ? (snap.data() || {}) : {};

            const firstName = normalizeString(data.firstName);
            const lastName = normalizeString(data.lastName);
            const phone = normalizeString(data.phone);
            const complete = Boolean(firstName && lastName && phone);

            if (!complete && isGoogleProviderUser(user)) {
                const current = (window.location.pathname.split('/').pop() || 'account.html').trim() || 'account.html';
                window.location.href = `complete-profile.html?redirect=${encodeURIComponent(current)}`;
                return false;
            }
            return true;
        } catch (e) {
            return true;
        }
    }

    // Addresses - will be initialized in initialize()
    let addressModal = null;
    let addressForm = null;
    let addressModalTitle = null;
    let addressSubmitText = null;
    let closeAddressModal = null;
    let editingAddressId = null;

    // ============================================
    // PSGC ADDRESS HELPERS (QC + North Caloocan only)
    // ============================================
    // Prefer a CORS-friendly source first; fallback to PSGC Cloud if available.
    const PSGC_SOURCES = [
        {
            name: 'psgc-gitlab',
            buildBarangaysUrl: (cityCode) => `https://psgc.gitlab.io/api/cities/${encodeURIComponent(cityCode)}/barangays/`
        },
        {
            name: 'psgc-cloud',
            buildBarangaysUrl: (cityCode) => `https://psgc.cloud/api/v1/cities-municipalities/${encodeURIComponent(cityCode)}/barangays`
        }
    ];
    const psgcBarangayCache = new Map(); // cityCode -> [{code,name,...}]

    function getAddressCityEl() {
        return document.getElementById('addressCity');
    }

    function getAddressBarangayEl() {
        return document.getElementById('addressBarangay');
    }

    function getAddressBarangayListEl() {
        return document.getElementById('addressBarangayList');
    }

    function getSelectedCityPsgcCode() {
        const cityEl = getAddressCityEl();
        if (!cityEl) return null;
        const opt = cityEl.options?.[cityEl.selectedIndex];
        return opt?.dataset?.psgcCityCode || null;
    }

    function parseBarangayNumber(name) {
        const raw = String(name || '');
        const match = raw.match(/(\d{1,3})/);
        if (!match) return null;
        const n = Number(match[1]);
        return Number.isFinite(n) ? n : null;
    }

    // Heuristic: Caloocan barangays are numbered 1..188; North is typically 77..188.
    function isNorthCaloocanBarangayName(name) {
        const n = parseBarangayNumber(name);
        if (n !== null) return n >= 77;

        // Fallback for non-numbered names (defensive)
        const upper = String(name || '').toUpperCase();
        const northHints = ['BAGONG SILANG', 'TALA', 'CAMARIN', 'DEPARO', 'LLANO'];
        return northHints.some((hint) => upper.includes(hint));
    }

    function setSelectOptions(selectEl, { placeholder, values }) {
        if (!selectEl) return;
        selectEl.innerHTML = '';

        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = placeholder;
        selectEl.appendChild(placeholderOpt);

        values.forEach(({ value, label, dataset }) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label ?? value;
            if (dataset) {
                Object.entries(dataset).forEach(([key, val]) => {
                    if (val !== undefined && val !== null) {
                        opt.dataset[key] = String(val);
                    }
                });
            }
            selectEl.appendChild(opt);
        });
    }

    function resetBarangaySelect() {
        const barangayEl = getAddressBarangayEl();
        const listEl = getAddressBarangayListEl();
        if (!barangayEl) return;
        // Barangay is an <input list="..."> (searchable). We clear the datalist.
        if (listEl) listEl.innerHTML = '';
        barangayEl.value = '';
        barangayEl.placeholder = 'Select a city first';
        barangayEl.disabled = true;
    }

    async function fetchPsgcBarangays(cityCode) {
        if (psgcBarangayCache.has(cityCode)) return psgcBarangayCache.get(cityCode);

        let lastError = null;

        for (const source of PSGC_SOURCES) {
            const url = source.buildBarangaysUrl(cityCode);
            try {
                const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!res.ok) {
                    lastError = new Error(`[${source.name}] PSGC request failed (${res.status})`);
                    continue;
                }

                const json = await res.json();
                // Handle a few common shapes:
                // - Array of barangays
                // - { data: [...] }
                // - { barangays: [...] }
                const list =
                    Array.isArray(json) ? json :
                    (Array.isArray(json?.data) ? json.data :
                    (Array.isArray(json?.barangays) ? json.barangays : []));

                if (Array.isArray(list) && list.length > 0) {
                    psgcBarangayCache.set(cityCode, list);
                    return list;
                }

                lastError = new Error(`[${source.name}] Unexpected PSGC response shape`);
            } catch (error) {
                lastError = error;
                continue;
            }
        }

        throw lastError || new Error('PSGC request failed');
    }

    async function refreshBarangayOptions(desiredBarangayValue = null) {
        const cityEl = getAddressCityEl();
        const barangayEl = getAddressBarangayEl();
        const listEl = getAddressBarangayListEl();
        if (!cityEl || !barangayEl) return;

        const cityValue = cityEl.value;
        const cityCode = getSelectedCityPsgcCode();

        if (!cityValue || !cityCode) {
            resetBarangaySelect();
            return;
        }

        if (listEl) listEl.innerHTML = '';
        barangayEl.value = '';
        barangayEl.placeholder = 'Loading barangays...';
        barangayEl.disabled = true;

        try {
            let barangays = await fetchPsgcBarangays(cityCode);
            barangays = barangays
                .map((b) => ({ code: b?.code, name: String(b?.name || '').trim() }))
                .filter((b) => b.name);

            if (cityValue === 'Caloocan City') {
                barangays = barangays.filter((b) => isNorthCaloocanBarangayName(b.name));
            }

            barangays.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

            if (listEl) {
                listEl.innerHTML = '';
                barangays.forEach((b) => {
                    const opt = document.createElement('option');
                    opt.value = b.name;
                    if (b.code) opt.dataset.psgcCode = String(b.code);
                    listEl.appendChild(opt);
                });
            }
            barangayEl.placeholder = 'Search barangay';
            barangayEl.disabled = false;

            if (desiredBarangayValue) {
                const hasOption = listEl ? Array.from(listEl.options).some((opt) => opt.value === desiredBarangayValue) : true;
                barangayEl.value = hasOption ? desiredBarangayValue : '';
                if (!hasOption) showToast('Please reselect barangay (previous selection is outside the supported area).', 'warning');
            }
        } catch (error) {
            console.warn('[PSGC] Failed to load barangays:', error);
            if (listEl) listEl.innerHTML = '';
            barangayEl.value = '';
            barangayEl.placeholder = 'Failed to load barangays. Try again.';
            barangayEl.disabled = true;
            showToast('Failed to load barangays. Please check your connection and try again.', 'error');
        }
    }

    // Add address modal
    function openAddAddressModal() {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            return;
        }

        editingAddressId = null;
        if (addressModalTitle) addressModalTitle.textContent = 'Add Address';
        if (addressSubmitText) addressSubmitText.textContent = 'Save Address';
        if (addressForm) addressForm.reset();
        resetBarangaySelect();
        
        // Clear all error messages
        document.querySelectorAll('#addressForm .error-message').forEach(el => {
            el.textContent = '';
        });

        if (addressModal) addressModal.style.display = 'flex';
    }

    // Edit address modal
    async function openEditAddressModal(addressId) {
        const user = window.firebaseAuth?.currentUser;
        if (!user) return;

        const addressItem = document.querySelector(`.address-item[data-id="${addressId}"]`);
        if (!addressItem) return;

        // Get address data from data attributes
        const addressData = {
            id: addressId,
            label: addressItem.dataset.label,
            street: addressItem.dataset.street,
            city: addressItem.dataset.city,
            barangay: addressItem.dataset.barangay,
            postal: addressItem.dataset.postal
        };

        editingAddressId = addressId;
        if (addressModalTitle) addressModalTitle.textContent = 'Edit Address';
        if (addressSubmitText) addressSubmitText.textContent = 'Update Address';

        // Populate form fields
        const addressLabelField = document.getElementById('addressLabel');
        const addressStreetField = document.getElementById('addressStreet');
        const addressCityField = document.getElementById('addressCity');
        const addressBarangayField = document.getElementById('addressBarangay');
        const addressPostalField = document.getElementById('addressPostal'); // legacy (removed from UI)

        if (addressLabelField) addressLabelField.value = addressData.label;
        if (addressStreetField) addressStreetField.value = addressData.street;
        if (addressCityField) {
            const hasCity = Array.from(addressCityField.options || []).some(opt => opt.value === addressData.city);
            addressCityField.value = hasCity ? addressData.city : '';
            if (!hasCity && addressData.city) {
                showToast('Only Quezon City and North Caloocan are supported for addresses. Please select a supported city.', 'warning');
            }
        }
        if (addressPostalField) addressPostalField.value = addressData.postal;

        // Load barangays for selected city, then select saved barangay if available
        resetBarangaySelect();
        await refreshBarangayOptions(addressData.barangay);

        // Clear error messages
        document.querySelectorAll('#addressForm .error-message').forEach(el => {
            el.textContent = '';
        });

        if (addressModal) addressModal.style.display = 'flex';
    }

    // Close address modal
    function closeAddressModalFunc() {
        if (addressModal) addressModal.style.display = 'none';
        editingAddressId = null;
        if (addressForm) addressForm.reset();
        resetBarangaySelect();
        
        // Clear error messages
        document.querySelectorAll('#addressForm .error-message').forEach(el => {
            el.textContent = '';
        });
    }

    // Save address
    async function saveAddress() {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            return;
        }

        const labelField = document.getElementById('addressLabel');
        const streetField = document.getElementById('addressStreet');
        const cityField = document.getElementById('addressCity');
        const barangayField = document.getElementById('addressBarangay');
        const postalField = document.getElementById('addressPostal'); // legacy (removed from UI)

        if (!labelField || !streetField || !cityField || !barangayField) return;

        const label = labelField.value.trim();
        const street = streetField.value.trim();
        const city = cityField.value.trim();
        const barangay = barangayField.value.trim();
        const postal = postalField ? postalField.value.trim() : '';

        // Check inputs
        let hasError = false;
        if (!label) {
            const errorEl = document.getElementById('addressLabelError');
            if (errorEl) errorEl.textContent = 'Please select a label';
            hasError = true;
        }
        if (!street) {
            const errorEl = document.getElementById('addressStreetError');
            if (errorEl) errorEl.textContent = 'Street address is required';
            hasError = true;
        }
        if (!city) {
            const errorEl = document.getElementById('addressCityError');
            if (errorEl) errorEl.textContent = 'City is required';
            hasError = true;
        }
        if (!barangay) {
            const errorEl = document.getElementById('addressBarangayError');
            if (errorEl) errorEl.textContent = 'Barangay is required';
            hasError = true;
        }

        // Delivery area validation
        const allowedCities = new Set(['Quezon City', 'Caloocan City']);
        if (city && !allowedCities.has(city)) {
            const errorEl = document.getElementById('addressCityError');
            if (errorEl) errorEl.textContent = 'We only deliver to Quezon City and North Caloocan';
            hasError = true;
        }
        // Ensure barangay matches the loaded PSGC list for the selected city (searchable input can be typed).
        const listEl = getAddressBarangayListEl();
        if (city && barangay && listEl) {
            const isInList = Array.from(listEl.options).some((opt) => opt.value === barangay);
            if (!isInList) {
                const errorEl = document.getElementById('addressBarangayError');
                if (errorEl) errorEl.textContent = 'Please select a barangay from the list';
                hasError = true;
            }
        }
        if (city === 'Caloocan City' && barangay && !isNorthCaloocanBarangayName(barangay)) {
            const errorEl = document.getElementById('addressBarangayError');
            if (errorEl) errorEl.textContent = 'We only deliver to North Caloocan barangays';
            hasError = true;
        }

        if (hasError) return;

        const submitBtn = addressForm?.querySelector('.modal-save-btn');
        const submitText = document.getElementById('addressSubmitText');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.classList.add('disabled');
            if (submitText) submitText.textContent = 'Saving...';
        }

        try {
            const userDocRef = window.doc(window.firebaseDb, 'customers', user.uid);
            const userDoc = await window.getDoc(userDocRef);
            
            const addressData = {
                id: editingAddressId || `addr-${Date.now()}`,
                label: label,
                street: street,
                city: city,
                barangay: barangay,
                ...(postal ? { postal } : {}),
                fullAddress: `${street}, ${city}, ${barangay}${postal ? ` ${postal}` : ''}`,
                updatedAt: new Date().toISOString()
            };
            
            // Remove isDefault and addressId fields if they exist (cleanup old data)
            delete addressData.isDefault;
            delete addressData.is_default;
            delete addressData.addressId;

            let addresses = [];
            if (userDoc.exists()) {
                addresses = userDoc.data().addresses || [];
            }

            if (editingAddressId) {
                // Update existing address
                const index = addresses.findIndex(addr => addr.id === editingAddressId);
                if (index !== -1) {
                    // Remove isDefault and addressId from existing address before updating
                    const existingAddress = { ...addresses[index] };
                    delete existingAddress.isDefault;
                    delete existingAddress.is_default;
                    delete existingAddress.addressId;
                    addresses[index] = { ...existingAddress, ...addressData };
                }
            } else {
                // Add new address
                addresses.push(addressData);
            }
            
            // Clean up any isDefault or addressId fields from all addresses before saving
            addresses = addresses.map(addr => {
                const cleaned = { ...addr };
                delete cleaned.isDefault;
                delete cleaned.is_default;
                delete cleaned.addressId;
                return cleaned;
            });

            // Save to database
            await window.setDoc(userDocRef, { addresses: addresses }, { merge: true });

            closeAddressModalFunc();
            showToast('Address saved', 'success');
        } catch (error) {
            console.error('Error saving address:', error);
            showToast('Failed to save address. Please try again.', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.classList.remove('disabled');
                if (submitText) submitText.textContent = editingAddressId ? 'Update Address' : 'Save Address';
            }
        }
    }

    // Delete address
    async function deleteAddress(addressId) {
        console.log('deleteAddress called with ID:', addressId);
        
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            console.warn('No user found, cannot delete address');
            showToast('You must be signed in to delete addresses', 'error');
            return;
        }

        // Show custom confirmation modal
        const confirmed = await showConfirmModal(
            'Are you sure you want to delete this address? This action cannot be undone.',
            'Delete Address',
            'Yes'
        );

        console.log('Confirmation result:', confirmed);

        if (!confirmed) {
            console.log('User cancelled deletion');
            return;
        }

        try {
            await window.utils.waitForFirebaseReady();
            
            const db = window.firebaseDb;
            if (!db || !window.doc || !window.getDoc || !window.setDoc) {
                throw new Error('Firebase not ready');
            }

            const userDocRef = window.doc(db, 'customers', user.uid);
            const userDoc = await window.getDoc(userDocRef);
            
            if (!userDoc.exists()) {
                console.warn('User document does not exist');
                showToast('User data not found', 'error');
                return;
            }

            let addresses = userDoc.data().addresses || [];
            console.log('Current addresses before deletion:', addresses);
            console.log('Looking for address with ID:', addressId);
            console.log('Address IDs in database:', addresses.map(a => a.id));
            
            // Try to find address by id (exact match first)
            let addressToDelete = addresses.find(addr => addr.id === addressId);
            
            // If not found, try to find by addressId field (for backwards compatibility)
            if (!addressToDelete) {
                addressToDelete = addresses.find(addr => addr.addressId === addressId);
            }
            
            if (!addressToDelete) {
                console.warn('Address not found with ID:', addressId);
                console.warn('Available address IDs:', addresses.map(a => ({ id: a.id, addressId: a.addressId })));
                showToast('Address not found', 'error');
                return;
            }

            console.log('Address found, deleting:', addressToDelete);

            // Filter out the address by both id and addressId (to handle both cases)
            addresses = addresses.filter(addr => {
                return addr.id !== addressId && addr.addressId !== addressId;
            });
            
            console.log('Addresses after filtering:', addresses);
            
            // Clean up any isDefault or addressId fields from remaining addresses
            addresses = addresses.map(addr => {
                const cleaned = { ...addr };
                delete cleaned.isDefault;
                delete cleaned.is_default;
                delete cleaned.addressId;
                return cleaned;
            });

            // Save to database
            await window.setDoc(userDocRef, { addresses: addresses }, { merge: true });
            
            console.log('Address deleted successfully from database');

            // Reload addresses to update UI (real-time listener should also handle this)
            const updatedDoc = await window.getDoc(userDocRef);
            if (updatedDoc.exists()) {
                const updatedAddresses = updatedDoc.data().addresses || [];
                console.log('Updated addresses:', updatedAddresses);
                renderAddresses(updatedAddresses);
            }

            showToast('Address deleted', 'success');
        } catch (error) {
            console.error('Error deleting address:', error);
            console.error('Error details:', {
                message: error.message,
                code: error.code,
                stack: error.stack
            });
            
            let errorMessage = 'An error occurred while deleting the address. Please try again.';
            
            if (error.code === 'network-request-failed' || error.message?.includes('network')) {
                errorMessage = 'Network error. Please check your internet connection and try again.';
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            showToast(errorMessage, 'error');
        }
    }

    // Simple toast helper - use centralized toast system
    function showToast(message, variant) {
        if (window.utils && window.utils.showToast) {
            const toastVariant = variant === 'error' ? 'error' : (variant === 'success' ? 'success' : 'info');
            window.utils.showToast(message, toastVariant);
        } else {
            // Fallback if utils not loaded yet
            console.log(`[${variant}] ${message}`);
        }
    }

    // Render addresses
    function renderAddresses(addresses) {
        const addressList = document.getElementById('addressList');
        if (!addressList) return;

        if (!addresses || addresses.length === 0) {
            addressList.innerHTML = `
                <div class="account-empty-card address-empty-state">
                    <i class="fas fa-location-dot empty-icon"></i>
                    <div class="empty-title">No saved addresses</div>
                    <p class="empty-subtitle">Add a delivery address to speed up checkout.</p>
                </div>
            `;
            return;
        }

        addressList.innerHTML = addresses.map(address => {
            const addressId = address.id || `addr-${Date.now()}`;
            const barangay = address.barangay || address.province || '';
            const fullAddr = address.fullAddress || `${address.street}, ${address.city}, ${barangay} ${address.postal}`;
            const lastUsed = address.lastUsedAt || null;
            const deliveryOnly = !!address.deliveryOnly;

            const chips = [];
            if (address.label) {
                chips.push(`<span class="address-chip">${address.label}</span>`);
            }
            if (lastUsed) {
                chips.push('<span class="address-chip address-chip-last">Used for last order</span>');
            }
            if (deliveryOnly) {
                chips.push('<span class="address-chip address-chip-delivery">Delivery only</span>');
            }

            return `
                <div class="address-item" 
                     data-id="${addressId}"
                     data-label="${address.label || 'Other'}"
                     data-street="${address.street || ''}"
                     data-city="${address.city || ''}"
                     data-barangay="${barangay}"
                     data-postal="${address.postal || ''}">
                    <div>
                        <div class="address-chip-row">
                            ${chips.join('')}
                        </div>
                        <div class="address-text">${fullAddr}</div>
                    </div>
                    <div class="address-actions">
                        <button class="write-review-toggle" type="button" onclick="window.account.openEditAddressModal('${addressId}')">
                            <i class="fas fa-pen"></i><span>Edit</span>
                        </button>
                        <button class="profile-item logout danger-action" type="button" onclick="window.account.deleteAddress('${addressId}')">
                            <i class="fas fa-trash"></i><span>Delete</span>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // Customer review quick menu
    let stopCustomerReviewsListener = null;

    function escapeHtml(str = '') {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatReviewDate(value) {
        if (!value) return '';
        let dateObj = null;
        if (value.toDate) {
            try {
                dateObj = value.toDate();
            } catch (e) {
                dateObj = null;
            }
        }
        if (!dateObj) {
            dateObj = new Date(value);
        }
        if (Number.isNaN(dateObj.getTime())) {
            return '';
        }
        return dateObj.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric'
        });
    }

    function truncateText(value = '', limit = 120) {
        const trimmed = value.trim();
        if (!trimmed) return '';
        if (trimmed.length <= limit) return trimmed;
        return `${trimmed.slice(0, limit - 1)}…`;
    }

    function resetAccountReviewsUI() {
        const section = document.getElementById('accountReviewsSection');
        const menu = document.getElementById('accountReviewMenu');
        const countEl = document.getElementById('accountReviewCount');
        const emptyState = document.getElementById('accountReviewEmpty');
        if (menu) menu.innerHTML = '';
        if (countEl) countEl.textContent = '0 reviews';
        if (section) section.style.display = 'none';
        if (emptyState) emptyState.style.display = 'block';
    }

    function renderAccountReviews(reviews = []) {
        const section = document.getElementById('accountReviewsSection');
        const menu = document.getElementById('accountReviewMenu');
        const countEl = document.getElementById('accountReviewCount');
        const emptyState = document.getElementById('accountReviewEmpty');
        
        console.log('[Account Reviews] renderAccountReviews called with:', reviews.length, 'reviews');
        console.log('[Account Reviews] Section element:', section);
        console.log('[Account Reviews] Menu element:', menu);
        
        if (!section || !menu || !countEl || !emptyState) {
            console.warn('[Account Reviews] Missing required elements:', {
                section: !!section,
                menu: !!menu,
                countEl: !!countEl,
                emptyState: !!emptyState
            });
            return;
        }

        const total = Array.isArray(reviews) ? reviews.length : 0;
        countEl.textContent = `${total} ${total === 1 ? 'review' : 'reviews'}`;

        console.log('[Account Reviews] Total reviews:', total);

        if (!total) {
            console.log('[Account Reviews] No reviews, showing empty state');
            section.style.display = 'none';
            emptyState.style.display = 'block';
            menu.innerHTML = '';
            return;
        }

        console.log('[Account Reviews] Has reviews, showing section');
        emptyState.style.display = 'none';
        section.style.display = 'block';

        const limited = reviews
            .slice()
            .sort((a, b) => (b.sortDate || 0) - (a.sortDate || 0));

        menu.innerHTML = limited
            .map((review) => {
                const rating = typeof review.rating === 'number' && review.rating > 0
                    ? review.rating.toFixed(1)
                    : '—';
                const displayText = truncateText(review.text || '');
                const safeText = displayText ? escapeHtml(displayText) : 'No written feedback';
                const safeName = escapeHtml(review.itemName || 'Menu item');
                const dateLabel = review.createdAtLabel || '';
                const itemIdAttr = review.itemId ? `data-item-id="${escapeHtml(review.itemId)}"` : '';
                const reviewId = escapeHtml(review.id || '');
                const fullText = escapeHtml(review.text || '');

                return `
                    <div class="account-review-menu-item-wrapper" data-review-id="${reviewId}" data-item-id="${escapeHtml(review.itemId || '')}" data-rating="${review.rating || 0}" data-text="${escapeHtml(fullText)}">
                        <div class="account-review-menu-item" ${itemIdAttr} data-review-id="${reviewId}">
                            <div class="account-review-display" id="review-display-${reviewId}">
                                <div class="account-review-menu-item-header">
                                    <span class="review-pill-rating">
                                        ${rating}
                                        <i class="fas fa-star"></i>
                                    </span>
                                    ${dateLabel ? `<span class="review-pill-date">${dateLabel}</span>` : ''}
                                </div>
                                <div class="account-review-item-name">${safeName}</div>
                                <p class="account-review-item-text">${safeText || 'No written feedback'}</p>
                                ${review.itemId ? `
                                <div class="account-review-actions mt-2">
                                    <button class="write-review-toggle btn btn-sm" type="button" onclick="window.account.editReviewInline('${reviewId}', '${escapeHtml(review.itemId)}')" title="Edit review">
                                        <i class="fas fa-pen"></i><span>Edit</span>
                                    </button>
                                </div>
                                ` : ''}
                            </div>
                            <div class="account-review-edit-form" id="review-edit-${reviewId}" style="display: none;">
                                <div class="account-review-item-name mb-2">${safeName}</div>
                                <div class="account-review-stars mb-3" data-review-id="${reviewId}">
                                    ${[1, 2, 3, 4, 5].map(i => `
                                        <span class="account-review-star" data-rating="${i}">
                                            <i class="${i <= review.rating ? 'fas' : 'far'} fa-star" style="color: ${i <= review.rating ? '#ffc107' : '#ddd'}"></i>
                                        </span>
                                    `).join('')}
                                </div>
                                <textarea 
                                    class="restaurant-form-input mb-3" 
                                    id="review-text-${reviewId}"
                                    rows="4" 
                                    placeholder="Share your experience..."
                                >${fullText}</textarea>
                                <div class="account-review-edit-actions d-flex gap-2">
                                    <button 
                                        class="restaurant-auth-button btn-sm" 
                                        type="button" 
                                        onclick="window.account.updateReviewInline('${reviewId}', '${escapeHtml(review.itemId)}')"
                                    >
                                        Update Review
                                    </button>
                                    <button 
                                        class="write-review-toggle btn-sm" 
                                        type="button" 
                                        onclick="window.account.cancelEditReview('${reviewId}')"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            })
            .join('');
    }

    function stopCustomerReviewsListenerFunc() {
        if (stopCustomerReviewsListener) {
            stopCustomerReviewsListener();
            stopCustomerReviewsListener = null;
        }
    }

    // Fetch all user reviews from menu items (fallback method)
    async function fetchUserReviewsFromMenuItems(user) {
        if (!user || !user.uid) return [];

        const db = window.firebaseDb;
        if (!db || !window.collection || !window.getDocs || !window.query || !window.where) {
            return [];
        }

        try {
            const allReviews = [];
            const menuCol = window.collection(db, 'menu');
            const menuSnap = await window.getDocs(menuCol);

            for (const menuDoc of menuSnap.docs) {
                const itemId = menuDoc.id;
                const itemData = menuDoc.data() || {};
                const itemName = itemData.displayName || itemData.name || itemData.title || 'Menu item';
                
                const reviewsCol = window.collection(menuDoc.ref, 'reviews');
                const userReviewsQuery = window.query(
                    reviewsCol,
                    window.where('userId', '==', user.uid)
                );
                
                const userReviewsSnap = await window.getDocs(userReviewsQuery);
                
                userReviewsSnap.forEach((reviewDoc) => {
                    const data = reviewDoc.data() || {};
                    const createdLabel = formatReviewDate(data.createdAt || data.updatedAt || null);
                    let sortValue = null;
                    if (data.createdAt?.toMillis) {
                        sortValue = data.createdAt.toMillis();
                    } else if (data.createdAt) {
                        const ts = new Date(data.createdAt).getTime();
                        sortValue = Number.isFinite(ts) ? ts : null;
                    }
                    if (!sortValue && data.updatedAt?.toMillis) {
                        sortValue = data.updatedAt.toMillis();
                    }
                    if (!sortValue) {
                        sortValue = Date.now();
                    }

                    allReviews.push({
                        id: reviewDoc.id,
                        itemId: itemId,
                        itemName: data.itemName || itemName,
                        rating: typeof data.rating === 'number' ? data.rating : Number(data.rating) || 0,
                        text: data.text || '',
                        createdAtLabel: createdLabel,
                        sortDate: sortValue
                    });
                });
            }

            // Sort by date (newest first)
            allReviews.sort((a, b) => (b.sortDate || 0) - (a.sortDate || 0));
            
            console.log(`[Account Reviews] Fetched ${allReviews.length} reviews from menu items for user ${user.uid}`);
            return allReviews;
        } catch (error) {
            console.error('Error fetching reviews from menu items:', error);
            return [];
        }
    }

    function startCustomerReviewsListener(user) {
        stopCustomerReviewsListenerFunc();
        if (!user || !user.uid) {
            resetAccountReviewsUI();
            return;
        }

        const db = window.firebaseDb;
        if (!db || !window.doc || !window.collection) {
            console.warn('Firebase not ready for customer reviews');
            resetAccountReviewsUI();
            return;
        }

        try {
            const customerRef = window.doc(db, 'customers', user.uid);
            const reviewsCol = window.collection(customerRef, 'reviews');
            let queryRef = reviewsCol;

            // Try to set up ordered query, but fallback to basic collection if it fails
            try {
                if (window.orderBy && window.query) {
                    queryRef = window.query(reviewsCol, window.orderBy('createdAt', 'desc'));
                }
            } catch (orderByError) {
                console.warn('Could not set up ordered query, using basic collection:', orderByError);
                queryRef = reviewsCol;
            }

            const handleSnapshot = async (snapshot) => {
                const reviews = [];
                let hasData = false;
                
                snapshot.forEach((docSnap) => {
                    hasData = true;
                    const data = docSnap.data() || {};
                    const createdLabel = formatReviewDate(data.createdAt || data.updatedAt || null);
                    let sortValue = null;
                    if (data.createdAt?.toMillis) {
                        sortValue = data.createdAt.toMillis();
                    } else if (data.createdAt) {
                        const ts = new Date(data.createdAt).getTime();
                        sortValue = Number.isFinite(ts) ? ts : null;
                    }
                    if (!sortValue && data.updatedAt?.toMillis) {
                        sortValue = data.updatedAt.toMillis();
                    }
                    if (!sortValue) {
                        sortValue = Date.now();
                    }

                    // Ensure itemId is set - if missing, try to find it from menu items
                    let itemId = data.itemId || null;
                    if (!itemId) {
                        console.warn(`[Account Reviews] Review ${docSnap.id} missing itemId in customer subcollection`);
                    }

                    reviews.push({
                        id: docSnap.id,
                        itemId: itemId,
                        itemName: data.itemName || data.displayName || 'Menu item',
                        rating: typeof data.rating === 'number' ? data.rating : Number(data.rating) || 0,
                        text: data.text || '',
                        createdAtLabel: createdLabel,
                        sortDate: sortValue
                    });
                });

                // Sort reviews by date (newest first) if not already sorted
                reviews.sort((a, b) => (b.sortDate || 0) - (a.sortDate || 0));

                console.log(`[Account Reviews] Loaded ${reviews.length} reviews from customers/${user.uid}/reviews`);

                // If no reviews in customer subcollection, fetch from menu items
                if (reviews.length === 0) {
                    console.log('[Account Reviews] No reviews in customer subcollection, fetching from menu items...');
                    const menuReviews = await fetchUserReviewsFromMenuItems(user);
                    if (menuReviews.length > 0) {
                        console.log(`[Account Reviews] Found ${menuReviews.length} reviews in menu items`);
                        renderAccountReviews(menuReviews);
                        return;
                    }
                }

                renderAccountReviews(reviews);
            };

            if (window.onSnapshot) {
                stopCustomerReviewsListener = window.onSnapshot(
                    queryRef,
                    handleSnapshot,
                    async (error) => {
                        console.error('Error listening to customer reviews:', error);
                        console.error('Error details:', {
                            code: error.code,
                            message: error.message,
                            stack: error.stack
                        });
                        // Try to load once without listener as fallback
                        if (window.getDocs) {
                            window.getDocs(reviewsCol)
                                .then(handleSnapshot)
                                .catch(async (e) => {
                                    console.error('Fallback load also failed:', e);
                                    // Last resort: fetch from menu items
                                    const menuReviews = await fetchUserReviewsFromMenuItems(user);
                                    renderAccountReviews(menuReviews);
                                });
                        } else {
                            // Last resort: fetch from menu items
                            const menuReviews = await fetchUserReviewsFromMenuItems(user);
                            renderAccountReviews(menuReviews);
                        }
                    }
                );
            } else if (window.getDocs) {
                window.getDocs(queryRef)
                    .then(handleSnapshot)
                    .catch(async (error) => {
                        console.error('Error loading customer reviews:', error);
                        // Try basic collection as fallback
                        window.getDocs(reviewsCol)
                            .then(handleSnapshot)
                            .catch(async (e) => {
                                console.error('Fallback load failed:', e);
                                // Last resort: fetch from menu items
                                const menuReviews = await fetchUserReviewsFromMenuItems(user);
                                renderAccountReviews(menuReviews);
                            });
                    });
            } else {
                console.warn('No Firebase query methods available');
                // Last resort: fetch from menu items
                fetchUserReviewsFromMenuItems(user).then(reviews => {
                    renderAccountReviews(reviews);
                });
            }
        } catch (error) {
            console.error('Failed to start customer reviews listener:', error);
            console.error('Error details:', {
                message: error.message,
                stack: error.stack
            });
            // Last resort: fetch from menu items
            fetchUserReviewsFromMenuItems(user).then(reviews => {
                renderAccountReviews(reviews);
            });
        }
    }

    // Confirmation modal - will be initialized in initialize()
    let confirmModal = null;
    let confirmModalTitle = null;
    let confirmModalMessage = null;
    let confirmModalYes = null;
    let confirmModalYesText = null;
    let confirmModalNo = null;
    let closeConfirmModal = null;
    let confirmCallback = null;

    // Show confirm dialog
    function showConfirmModal(message, title = 'Confirm Action', confirmText = 'Yes') {
        return new Promise((resolve) => {
            if (!confirmModal || !confirmModalTitle || !confirmModalMessage || !confirmModalYesText) {
                resolve(false);
                return;
            }
            confirmModalTitle.textContent = title;
            confirmModalMessage.textContent = message;
            confirmModalYesText.textContent = confirmText;
            confirmCallback = resolve;
            confirmModal.style.display = 'flex';
        });
    }

    // Close confirm dialog
    function closeConfirmModalFunc() {
        if (confirmModal) confirmModal.style.display = 'none';
        if (confirmCallback) {
            confirmCallback(false);
            confirmCallback = null;
        }
    }

    // Profile edit modal - will be initialized in initialize()
    let profileEditModal = null;
    let editProfileBtn = null;
    let closeProfileModal = null;
    let profileEditForm = null;
    let editFirstName = null;
    let editLastName = null;
    let editPhone = null;

    // Open profile edit modal
    async function openProfileEditModal() {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            return;
        }

        try {
            const userDoc = await window.getDoc(window.doc(window.firebaseDb, 'customers', user.uid));
            if (userDoc.exists()) {
                const userData = userDoc.data();
                if (editFirstName) editFirstName.value = userData.firstName || '';
                if (editLastName) editLastName.value = userData.lastName || '';
                if (editPhone) editPhone.value = userData.phone || '';
            } else {
                if (editFirstName) editFirstName.value = '';
                if (editLastName) editLastName.value = '';
                if (editPhone) editPhone.value = '';
            }
        } catch (error) {
            console.error('Error loading user data:', error);
            if (editFirstName) editFirstName.value = '';
            if (editLastName) editLastName.value = '';
            if (editPhone) editPhone.value = '';
        }

        if (profileEditModal) profileEditModal.style.display = 'flex';
    }

    // Close profile edit modal
    function closeProfileEditModal() {
        if (profileEditModal) profileEditModal.style.display = 'none';
        document.querySelectorAll('#profileEditForm .error-message').forEach(el => {
            el.textContent = '';
        });
    }

    // Save profile changes
    async function saveProfileChanges() {
        const user = window.firebaseAuth?.currentUser;
        if (!user || !editFirstName || !editLastName) {
            return;
        }

        const firstName = editFirstName.value.trim();
        const lastName = editLastName.value.trim();
        const phone = editPhone ? editPhone.value.trim() : '';

        // Check inputs
        if (!firstName) {
            const errorEl = document.getElementById('editFirstNameError');
            if (errorEl) errorEl.textContent = 'First name is required';
            return;
        }
        if (!lastName) {
            const errorEl = document.getElementById('editLastNameError');
            if (errorEl) errorEl.textContent = 'Last name is required';
            return;
        }

        try {
            await window.setDoc(
                window.doc(window.firebaseDb, 'customers', user.uid),
                {
                    firstName: firstName,
                    lastName: lastName,
                    phone: phone || '',
                    email: user.email || '',
                    updatedAt: new Date()
                },
                { merge: true }
            );

            closeProfileEditModal();
        } catch (error) {
            console.error('Error saving profile:', error);
        }
    }

    // Track user data changes
    let stopUserDataListener = null;

    // Update user display
    function updateUserDisplay(userData, authUser) {
        const nameLoading = document.getElementById('nameLoading');
        const nameContent = document.getElementById('nameContent');
        const emailLoading = document.getElementById('emailLoading');
        const emailContent = document.getElementById('emailContent');
        const pointsEl = document.getElementById('accountPoints');

        // Update name
        if (nameContent) {
            if (userData) {
                const firstName = userData.firstName || '';
                const lastName = userData.lastName || '';
                const fullName = `${firstName} ${lastName}`.trim() || authUser?.displayName || 'User';
                nameContent.textContent = fullName;
            } else {
                nameContent.textContent = authUser?.displayName || 'User';
            }
        }

        // Update email
        if (emailContent) {
            const email = userData?.email || authUser?.email || 'user@example.com';
            emailContent.textContent = email;
        }

        // Update loyalty points
        const loyaltyTotalEl = document.getElementById('loyaltyTotalPoints');
        const loyaltyLastEl = document.getElementById('loyaltyLastPoints');
        const loyaltyLastDateEl = document.getElementById('loyaltyLastEarnedDate');
        const loyaltyHistoryList = document.getElementById('loyaltyHistoryList');
        const loyaltyEmptyState = document.getElementById('loyaltyEmptyState');

        let pts = 0;
        if (userData && typeof userData.points !== 'undefined') {
            if (typeof userData.points === 'number') {
                pts = userData.points;
            } else {
                const parsed = parseInt(userData.points, 10);
                if (Number.isFinite(parsed) && parsed >= 0) pts = parsed;
            }
        } else {
            try {
                const raw = localStorage.getItem('ppp_points');
                const parsed = parseInt(raw || '0', 10);
                if (Number.isFinite(parsed) && parsed >= 0) pts = parsed;
            } catch (e) {
                pts = 0;
            }
        }

        if (pointsEl) pointsEl.textContent = `${pts} pts`;
        if (loyaltyTotalEl) loyaltyTotalEl.textContent = `${pts} pts`;

        try {
            if (userData && typeof userData.points !== 'undefined') {
                localStorage.setItem('ppp_points', String(pts));
            }
        } catch (e) {}

        // Last earned points and history
        if (userData) {
            const lastEarned = typeof userData.lastEarnedPoints === 'number'
                ? userData.lastEarnedPoints
                : Number(userData.lastEarnedPoints) || 0;
            const lastAtRaw = userData.lastEarnedAt || null;

            if (loyaltyLastEl) {
                loyaltyLastEl.textContent = lastEarned > 0 ? `${lastEarned} pts` : '0 pts';
            }

            if (loyaltyLastDateEl) {
                if (lastEarned > 0 && lastAtRaw) {
                    const d = new Date(lastAtRaw);
                    if (!Number.isNaN(d.getTime())) {
                        loyaltyLastDateEl.textContent = d.toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric'
                        });
                    } else {
                        loyaltyLastDateEl.textContent = '—';
                    }
                } else {
                    loyaltyLastDateEl.textContent = '—';
                }
            }

            if (loyaltyHistoryList) {
                const history = Array.isArray(userData.pointsHistory)
                    ? userData.pointsHistory.slice()
                    : [];

                if (!history.length) {
                    if (loyaltyEmptyState) loyaltyEmptyState.style.display = 'block';
                } else {
                    history.sort((a, b) => {
                        const ta = a.createdAt || '';
                        const tb = b.createdAt || '';
                        if (!ta && !tb) return 0;
                        if (!ta) return 1;
                        if (!tb) return -1;
                        return ta < tb ? 1 : -1;
                    });

                    const recent = history.slice(0, 5);
                    const rows = recent
                        .map((entry) => {
                            const p = typeof entry.points === 'number' ? entry.points : Number(entry.points) || 0;
                            const total = typeof entry.orderTotal === 'number' ? entry.orderTotal : Number(entry.orderTotal) || 0;
                            const orderId = entry.orderId || '';
                            const d = entry.createdAt ? new Date(entry.createdAt) : null;
                            const label = d && !Number.isNaN(d.getTime())
                                ? d.toLocaleDateString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                    year: 'numeric'
                                })
                                : '';

                            return `
                                <button class="loyalty-history-item" type="button" data-order-id="${orderId}">
                                    <div>
                                        <div>${p} pts earned</div>
                                        ${label ? `<div class="loyalty-meta">${label}</div>` : ''}
                                    </div>
                                    <span>₱${total.toFixed(2)}</span>
                                </button>
                            `;
                        })
                        .join('');

                    loyaltyHistoryList.innerHTML = rows;
                    if (loyaltyEmptyState) loyaltyEmptyState.style.display = 'none';
                }
            }
        }

        // Hide loading, show content
        if (nameLoading) nameLoading.style.display = 'none';
        if (nameContent) nameContent.style.display = '';
        if (emailLoading) emailLoading.style.display = 'none';
        if (emailContent) emailContent.style.display = '';
    }

    // Show error state
    function showErrorState(authUser) {
        const nameLoading = document.getElementById('nameLoading');
        const nameContent = document.getElementById('nameContent');
        const emailLoading = document.getElementById('emailLoading');
        const emailContent = document.getElementById('emailContent');
        const pointsEl = document.getElementById('accountPoints');
        const loyaltyTotalEl = document.getElementById('loyaltyTotalPoints');
        const loyaltyLastEl = document.getElementById('loyaltyLastPoints');
        const loyaltyLastDateEl = document.getElementById('loyaltyLastEarnedDate');
        const loyaltyHistoryList = document.getElementById('loyaltyHistoryList');
        const loyaltyEmptyState = document.getElementById('loyaltyEmptyState');

        if (nameContent) nameContent.textContent = authUser?.displayName || 'User';
        if (emailContent) emailContent.textContent = authUser?.email || 'user@example.com';

        let pts = 0;
        try {
            const raw = localStorage.getItem('ppp_points');
            const parsed = parseInt(raw || '0', 10);
            if (Number.isFinite(parsed) && parsed >= 0) pts = parsed;
        } catch (e) {
            pts = 0;
        }

        if (pointsEl) pointsEl.textContent = `${pts} pts`;
        if (loyaltyTotalEl) loyaltyTotalEl.textContent = `${pts} pts`;
        if (loyaltyLastEl) loyaltyLastEl.textContent = '0 pts';
        if (loyaltyLastDateEl) loyaltyLastDateEl.textContent = '—';
        if (loyaltyHistoryList && loyaltyEmptyState) {
            loyaltyHistoryList.innerHTML = '';
            loyaltyHistoryList.appendChild(loyaltyEmptyState);
            loyaltyEmptyState.style.display = 'block';
        }

        if (nameLoading) nameLoading.style.display = 'none';
        if (nameContent) nameContent.style.display = '';
        if (emailLoading) emailLoading.style.display = 'none';
        if (emailContent) emailContent.style.display = '';

        resetAccountReviewsUI();
    }

    // Track user data
    function setupUserDataListener(user) {
        if (!user || !user.uid) {
            showErrorState(null);
            renderAddresses([]);
            resetAccountReviewsUI();
            stopCustomerReviewsListenerFunc();
            return;
        }

        try {
            const userDocRef = window.doc(window.firebaseDb, 'customers', user.uid);
            
            // Ensure loyalty fields exist (points defaults to 0 for new users).
            // Fire-and-forget so the UI isn't blocked.
            try {
                window.utils?.ensureCustomerLoyaltyDefaults?.(user).catch?.(() => {});
            } catch (e) {}
            
            // Start listener immediately
            startCustomerReviewsListener(user);
            
            // Also try to ensure reviews are in customer subcollection (migrate if needed, but don't block)
            ensureReviewsInCustomerSubcollection(user).catch(err => {
                console.warn('[Account Reviews] Migration check failed:', err);
            });

            stopUserDataListener = window.onSnapshot(
                userDocRef,
                (snapshot) => {
                    if (snapshot.exists()) {
                        const userData = snapshot.data();
                        // Patch missing loyalty fields back into Firestore (keeps everything in sync).
                        try {
                            window.utils?.ensureCustomerLoyaltyDefaults?.(user).catch?.(() => {});
                        } catch (e) {}
                        updateUserDisplay(userData, user);
                        updateSecurityMeta(user);
                        const addresses = userData.addresses || [];
                        renderAddresses(addresses);
                        renderDiscountStatus(userData);
                    } else {
                        // If doc doesn't exist yet, create it with loyalty defaults so points is 0 everywhere.
                        try {
                            window.utils?.ensureCustomerLoyaltyDefaults?.(user).catch?.(() => {});
                        } catch (e) {}
                        updateUserDisplay(null, user);
                        updateSecurityMeta(user);
                        renderAddresses([]);
                        renderDiscountStatus(null);
                    }
                },
                (error) => {
                    console.error('Error listening to user data:', error);
                    showErrorState(user);
                    renderAddresses([]);
                    renderDiscountStatus(null);
                }
            );
        } catch (error) {
            console.error('Error setting up user data listener:', error);
            showErrorState(user);
            renderAddresses([]);
            renderDiscountStatus(null);
        }
    }

    // Stop tracking changes
    function stopUserDataListenerFunc() {
        if (stopUserDataListener) {
            stopUserDataListener();
            stopUserDataListener = null;
        }
        stopCustomerReviewsListenerFunc();
    }

    // Setup user data
    function initUserData() {
        if (!window.firebaseAuth || !window.firebaseReady) {
            setTimeout(initUserData, 100);
            return;
        }

        window.onAuthStateChanged(window.firebaseAuth, async (user) => {
            stopUserDataListenerFunc();

            if (user) {
                const ok = await requireCompleteProfile(user);
                if (!ok) return;
                setupUserDataListener(user);
                updateSecurityMeta(user);
            } else {
                showErrorState(null);
                renderAddresses([]);
                resetAccountReviewsUI();
                stopCustomerReviewsListenerFunc();
            }
        });
    }

    function applyPasswordUiForProvider(user) {
        // Always enforce provider-specific password UI, regardless of whether "last login" elements exist.
        try {
            const passwordSection = document.querySelector('.password-change-section');
            const passwordForm = document.getElementById('passwordChangeForm');
            const noteId = 'oauthPasswordNote';
            if (!passwordSection) return;

            const existingNote = document.getElementById(noteId);
            const shouldHidePasswordForm = user && !isPasswordProviderUser(user);

            if (shouldHidePasswordForm) {
                if (passwordForm) passwordForm.style.display = 'none';

                // Clear any visible validation error when hiding the form
                clearAllPasswordErrors();
                const currentPasswordInput = document.getElementById('currentPassword');
                if (currentPasswordInput) {
                    currentPasswordInput.value = '';
                    currentPasswordInput.classList.remove('error');
                }

                const successMessage = document.getElementById('passwordSuccessMessage');
                if (successMessage) {
                    successMessage.classList.add('d-none');
                    successMessage.style.display = 'none';
                }

                const noteHtml = isGoogleProviderUser(user)
                    ? 'You signed in with <strong>Google</strong>. Password changes are managed through your Google account.'
                    : 'Password changes are not available for this sign-in method.';

                if (!existingNote) {
                    const note = document.createElement('div');
                    note.id = noteId;
                    note.className = 'account-security-note';
                    note.style.marginTop = '10px';
                    note.style.color = '#666';
                    note.style.fontSize = '0.95rem';
                    note.style.lineHeight = '1.5';
                    note.innerHTML = noteHtml;
                    passwordSection.appendChild(note);
                } else {
                    existingNote.innerHTML = noteHtml;
                }
            } else {
                if (passwordForm) passwordForm.style.display = '';
                if (existingNote) existingNote.remove();
            }
        } catch (e) {}
    }

    // Security meta info
    function updateSecurityMeta(user) {
        const lastLoginInfo = document.getElementById('lastLoginInfo');
        const lastLoginDevice = document.getElementById('lastLoginDevice');
        // Provider-specific UI should always run (even if these elements are missing)
        applyPasswordUiForProvider(user);

        if (!user) {
            if (lastLoginInfo) lastLoginInfo.textContent = 'Not signed in';
            if (lastLoginDevice) lastLoginDevice.textContent = '—';
            return;
        }

        if (!lastLoginInfo || !lastLoginDevice) {
            // Nothing else to render; provider UI already applied above.
            return;
        }

        const meta = user.metadata || {};
        let last = meta.lastSignInTime || meta.creationTime || null;
        if (last) {
            const d = new Date(last);
            if (!Number.isNaN(d.getTime())) {
                lastLoginInfo.textContent = d.toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } else {
                lastLoginInfo.textContent = String(last);
            }
        } else {
            lastLoginInfo.textContent = '—';
        }

        const ua = navigator.userAgent || '';
        let device = 'Unknown device';
        if (/Windows/i.test(ua)) device = 'Windows device';
        else if (/Macintosh/i.test(ua)) device = 'macOS device';
        else if (/Android/i.test(ua)) device = 'Android device';
        else if (/iPhone|iPad/i.test(ua)) device = 'iOS device';

        if (/Chrome/i.test(ua)) device += ' · Chrome';
        else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) device += ' · Safari';
        else if (/Firefox/i.test(ua)) device += ' · Firefox';

        lastLoginDevice.textContent = device;
    }

    // Password change
    function setupPasswordToggle(toggleId, inputId) {
        const toggle = document.getElementById(toggleId);
        const input = document.getElementById(inputId);
        if (!toggle || !input) return;
        
        const icon = toggle.querySelector('i');
        if (!icon) return;

        toggle.addEventListener('click', function() {
            if (input.type === 'password') {
                input.type = 'text';
                icon.classList.remove('fa-eye');
                icon.classList.add('fa-eye-slash');
            } else {
                input.type = 'password';
                icon.classList.remove('fa-eye-slash');
                icon.classList.add('fa-eye');
            }
        });
    }

    function showPasswordError(fieldId, message) {
        const errorElement = document.getElementById(fieldId + 'Error');
        const inputElement = document.getElementById(fieldId);
        if (errorElement) errorElement.textContent = message;
        if (inputElement) inputElement.classList.add('error');
    }

    function clearPasswordError(fieldId) {
        const errorElement = document.getElementById(fieldId + 'Error');
        const inputElement = document.getElementById(fieldId);
        if (errorElement) errorElement.textContent = '';
        if (inputElement) inputElement.classList.remove('error');
    }

    function clearAllPasswordErrors() {
        clearPasswordError('currentPassword');
    }

    function validateCurrentPassword(value) {
        if (!value) {
            return 'Current password is required';
        }
        return '';
    }

    let isChangingPassword = false;

    function setPasswordFormState(submitting) {
        isChangingPassword = submitting;
        const saveBtn = document.getElementById('savePasswordBtn');
        const saveBtnText = document.getElementById('savePasswordBtnText');
        
        if (saveBtn) {
            if (submitting) {
                saveBtn.disabled = true;
                saveBtn.classList.add('disabled');
                if (saveBtnText) saveBtnText.textContent = 'Sending...';
            } else {
                saveBtn.disabled = false;
                saveBtn.classList.remove('disabled');
                if (saveBtnText) saveBtnText.textContent = 'Verify & Send Reset Email';
            }
        }
    }

    function hidePasswordSuccess() {
        const successMessage = document.getElementById('passwordSuccessMessage');
        if (successMessage) {
            successMessage.classList.add('d-none');
            successMessage.style.display = 'none';
        }
    }

    function showPasswordSuccess() {
        const successMessage = document.getElementById('passwordSuccessMessage');
        if (successMessage) {
            successMessage.style.display = 'flex';
            successMessage.classList.remove('d-none');
            setTimeout(() => {
                successMessage.classList.add('d-none');
                successMessage.style.display = 'none';
            }, 5000);
        }
    }

    async function changePassword(currentPassword) {
        const user = window.firebaseAuth?.currentUser;
        if (!user || !user.email) {
            showPasswordError('currentPassword', 'You must be logged in to change your password');
            return;
        }

        if (!isPasswordProviderUser(user)) {
            showPasswordError('currentPassword', 'You signed in with Google. Password changes are managed through your Google account.');
            return;
        }

        try {
            const credential = window.EmailAuthProvider.credential(user.email, currentPassword);
            await window.reauthenticateWithCredential(user, credential);
            await window.sendPasswordResetEmail(window.firebaseAuth, user.email);

            showPasswordSuccess();
            const form = document.getElementById('passwordChangeForm');
            if (form) form.reset();
            clearAllPasswordErrors();
        } catch (error) {
            console.error('Error changing password:', error);
            
            let errorMessage = 'An error occurred while changing your password. Please try again.';
            let errorField = 'currentPassword';

            switch (error.code) {
                case 'auth/wrong-password':
                    errorMessage = 'Current password is incorrect. Please try again.';
                    break;
                case 'auth/requires-recent-login':
                    errorMessage = 'For security, please log out and log back in before changing your password.';
                    break;
                case 'auth/network-request-failed':
                    errorMessage = 'Network error. Please check your internet connection and try again.';
                    break;
                default:
                    errorMessage = error.message || errorMessage;
            }

            showPasswordError(errorField, errorMessage);
            setPasswordFormState(false);
        }
    }

    // Account deletion - will be initialized in initialize()
    let deleteAccountPasswordModal = null;
    let deleteAccountPasswordForm = null;
    let deleteAccountPasswordInput = null;
    let deleteAccountPasswordError = null;
    let closeDeletePasswordModal = null;
    let cancelDeleteAccountBtn = null;
    let confirmDeleteAccountBtn = null;
    let confirmDeleteAccountBtnText = null;
    let isDeletingAccount = false;

    // Discount proof upload - will be initialized in initialize()
    let discountUploadForm = null;
    let discountTypeSelect = null;
    let discountProofInput = null;
    let discountSelfieInput = null;
    let discountIdNameInput = null;
    let discountIdNumberInput = null;
    let selfieUploadGroup = null;
    let idPictureGroup = null;
    let idNameGroup = null;
    let idNumberGroup = null;
    let uploadDiscountBtn = null;
    let uploadDiscountBtnText = null;
    let removeDiscountBtn = null;
    let discountPreview = null;
    let discountCurrentProof = null;
    let isUploadingDiscount = false;
    let discountToggleBtn = null;
    let discountContent = null;
    let discountToggleSubtitle = null;

    function closeDeletePasswordModalFunc() {
        if (deleteAccountPasswordModal) deleteAccountPasswordModal.style.display = 'none';
        if (deleteAccountPasswordForm) deleteAccountPasswordForm.reset();
        if (deleteAccountPasswordError) deleteAccountPasswordError.textContent = '';
        isDeletingAccount = false;
    }

    async function deleteAccountWithPassword(password) {
        const user = window.firebaseAuth?.currentUser;
        if (!user || !user.email) {
            throw new Error('User not found');
        }

        try {
            if (!isPasswordProviderUser(user)) {
                const err = new Error('Password re-authentication is not available for this account.');
                err.code = 'auth/operation-not-allowed';
                throw err;
            }

            const credential = window.EmailAuthProvider.credential(user.email, password);
            await window.reauthenticateWithCredential(user, credential);

            const userId = user.uid;
            const userDocRef = window.doc(window.firebaseDb, 'customers', userId);
            
            try {
                const userDoc = await window.getDoc(userDocRef);
                if (userDoc.exists()) {
                    await window.deleteDoc(userDocRef);
                }
            } catch (firestoreError) {
                console.error('Error deleting user data:', firestoreError);
            }

            await window.deleteUser(user);
            localStorage.removeItem('ppp_user');
            await window.signOut(window.firebaseAuth);
            closeDeletePasswordModalFunc();
            window.location.href = 'index.html';
        } catch (error) {
            console.error('Error deleting account:', error);
            throw error;
        }
    }

    async function deleteAccountWithGooglePopup() {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            throw new Error('User not found');
        }

        if (!isGoogleProviderUser(user)) {
            const err = new Error('Google re-authentication is not available for this account.');
            err.code = 'auth/operation-not-allowed';
            throw err;
        }

        if (!window.reauthenticateWithPopup || !window.GoogleAuthProvider) {
            const err = new Error('Re-authentication is not available right now. Please try again later.');
            err.code = 'auth/operation-not-allowed';
            throw err;
        }

        try {
            const provider = new window.GoogleAuthProvider();
            await window.reauthenticateWithPopup(user, provider);

            const userId = user.uid;
            const userDocRef = window.doc(window.firebaseDb, 'customers', userId);
            
            try {
                const userDoc = await window.getDoc(userDocRef);
                if (userDoc.exists()) {
                    await window.deleteDoc(userDocRef);
                }
            } catch (firestoreError) {
                console.error('Error deleting user data:', firestoreError);
            }

            await window.deleteUser(user);
            localStorage.removeItem('ppp_user');
            await window.signOut(window.firebaseAuth);
            window.location.href = 'index.html';
        } catch (error) {
            console.error('Error deleting Google account:', error);
            throw error;
        }
    }

    async function deleteUserAccount() {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            await showConfirmModal(
                'You must be logged in to delete your account.',
                'Error',
                'OK'
            );
            return;
        }

        const confirmed = await showConfirmModal(
            'Are you sure you want to delete your account? This will delete all your data forever and cannot be undone.',
            'Delete Account',
            'Yes, Delete Account'
        );

        if (!confirmed) {
            return;
        }

        // Password users: show password modal. Google users: reauth with popup then delete.
        if (isPasswordProviderUser(user)) {
            if (deleteAccountPasswordModal) deleteAccountPasswordModal.style.display = 'flex';
            if (deleteAccountPasswordInput) deleteAccountPasswordInput.focus();
            return;
        }

        if (isGoogleProviderUser(user)) {
            try {
                showToast('Re-authenticating with Google...', 'info');
                await deleteAccountWithGooglePopup();
            } catch (error) {
                let errorMessage = error?.message || 'An error occurred while deleting your account. Please try again.';
                if (error?.code === 'auth/popup-blocked') {
                    errorMessage = 'Popup was blocked. Please allow popups and try again.';
                } else if (error?.code === 'auth/popup-closed-by-user') {
                    errorMessage = 'Popup was closed before completing. Please try again.';
                } else if (error?.code === 'auth/requires-recent-login') {
                    errorMessage = 'For security, please sign out and sign in again, then retry deleting your account.';
                }
                showToast(errorMessage, 'error');
            }
            return;
        }

        // Fallback: show password modal
        if (deleteAccountPasswordModal) deleteAccountPasswordModal.style.display = 'flex';
        if (deleteAccountPasswordInput) deleteAccountPasswordInput.focus();
    }

    // Discount proof upload functions
    function formatFileSize(bytes) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    function showDiscountError(fieldId, message) {
        const errorElement = document.getElementById(fieldId + 'Error');
        if (errorElement) errorElement.textContent = message;
        
        // Add error class to the input field
        const inputElement = document.getElementById(fieldId);
        if (inputElement) {
            inputElement.classList.add('error');
        }
    }

    function clearDiscountError(fieldId) {
        const errorElement = document.getElementById(fieldId + 'Error');
        if (errorElement) errorElement.textContent = '';
        
        // Remove error class from the input field
        const inputElement = document.getElementById(fieldId);
        if (inputElement) {
            inputElement.classList.remove('error');
        }
    }

    function showDiscountSuccess() {
        const successMessage = document.getElementById('discountSuccessMessage');
        if (successMessage) {
            successMessage.style.display = 'flex';
            successMessage.classList.remove('d-none');
            setTimeout(() => {
                successMessage.style.display = 'none';
                successMessage.classList.add('d-none');
            }, 5000);
        }
    }

    function hideDiscountSuccess() {
        const successMessage = document.getElementById('discountSuccessMessage');
        if (successMessage) {
            successMessage.style.display = 'none';
            successMessage.classList.add('d-none');
        }
    }

    function updateDiscountPreview(idFile, selfieFile) {
        const previewEl = document.getElementById('discountPreview');
        const previewName = previewEl?.querySelector('.discount-preview-name');
        const previewSize = previewEl?.querySelector('.discount-preview-size');
        const selfiePreviewRow = document.getElementById('selfiePreviewRow');
        const selfiePreviewName = previewEl?.querySelector('.discount-preview-selfie-name');
        const selfiePreviewSize = previewEl?.querySelector('.discount-preview-selfie-size');

        if (!idFile && !selfieFile) {
            if (previewEl) previewEl.style.display = 'none';
            return;
        }

        if (previewEl) previewEl.style.display = 'block';
        
        if (idFile) {
            if (previewName) previewName.textContent = idFile.name;
            if (previewSize) previewSize.textContent = formatFileSize(idFile.size);
        }

        if (selfieFile) {
            if (selfiePreviewRow) selfiePreviewRow.style.display = 'flex';
            if (selfiePreviewName) selfiePreviewName.textContent = selfieFile.name;
            if (selfiePreviewSize) selfiePreviewSize.textContent = formatFileSize(selfieFile.size);
        } else {
            if (selfiePreviewRow) selfiePreviewRow.style.display = 'none';
        }
    }

    function renderDiscountStatus(userData) {
        const discountStatus = document.getElementById('discountStatus');
        const discountCurrentProofEl = document.getElementById('discountCurrentProof');
        const removeDiscountBtnEl = document.getElementById('removeDiscountBtn');
        const viewCurrentProofEl = document.getElementById('viewCurrentProof');
        const viewCurrentSelfieEl = document.getElementById('viewCurrentSelfie');
        const currentProofLabel = discountCurrentProofEl?.querySelector('.discount-current-proof-label');
        const currentProofDesc = discountCurrentProofEl?.querySelector('.discount-current-proof-desc');

        if (!discountStatus) return;

        const discountInfo = userData?.discountInfo || null;

        if (discountInfo && discountInfo.proofUrl) {
            // Show current proof
            if (discountCurrentProofEl) discountCurrentProofEl.style.display = 'block';
            if (removeDiscountBtnEl) removeDiscountBtnEl.style.display = 'inline-flex';
            
            const discountType = discountInfo.type === 'pwd' ? 'PWD' : 'Senior Citizen';
            const isVerified = discountInfo.IDverification === true;
            
            if (currentProofLabel) {
                currentProofLabel.textContent = isVerified 
                    ? `${discountType} discount active` 
                    : `${discountType} discount pending verification`;
            }
            if (currentProofDesc) {
                currentProofDesc.textContent = isVerified
                    ? 'Your discount proof has been verified and is active. You will receive 20% discount on all orders.'
                    : 'Your discount proof is pending admin verification. Once verified, you will receive 20% discount on all orders.';
            }
            if (viewCurrentProofEl && discountInfo.proofUrl) {
                viewCurrentProofEl.href = discountInfo.proofUrl;
            }
            
            // Show selfie link if it exists
            if (viewCurrentSelfieEl) {
                if (discountInfo.selfieUrl) {
                    viewCurrentSelfieEl.href = discountInfo.selfieUrl;
                    viewCurrentSelfieEl.style.display = 'inline-flex';
                } else {
                    viewCurrentSelfieEl.style.display = 'none';
                }
            }

            // Update status display based on verification status
            if (isVerified) {
                discountStatus.innerHTML = `
                    <div class="discount-status-content d-flex align-items-center gap-3 p-3 rounded" style="background: #e8f5e9; border: 1.5px solid #4caf50;">
                        <div class="discount-status-icon">
                            <i class="fas fa-check-circle" style="font-size: 1.5rem; color: #4caf50;"></i>
                        </div>
                        <div class="discount-status-text flex-grow-1">
                            <div class="discount-status-label" style="font-weight: 600; color: #222; margin-bottom: 4px;">${discountType} Discount Verified</div>
                            <div class="discount-status-desc" style="font-size: 0.9rem; color: #666;">Your discount proof has been verified. You will automatically receive 20% discount on all orders.</div>
                        </div>
                    </div>
                `;
            } else {
                discountStatus.innerHTML = `
                    <div class="discount-status-content d-flex align-items-center gap-3 p-3 rounded" style="background: #fff3cd; border: 1.5px solid #ffc107;">
                        <div class="discount-status-icon">
                            <i class="fas fa-clock" style="font-size: 1.5rem; color: #ffc107;"></i>
                        </div>
                        <div class="discount-status-text flex-grow-1">
                            <div class="discount-status-label" style="font-weight: 600; color: #222; margin-bottom: 4px;">${discountType} Discount Pending Verification</div>
                            <div class="discount-status-desc" style="font-size: 0.9rem; color: #666;">Your discount proof has been uploaded and is awaiting admin verification. Once verified, you will receive 20% discount on all orders.</div>
                        </div>
                    </div>
                `;
            }

            // Update toggle button subtitle
            if (discountToggleSubtitle) {
                discountToggleSubtitle.textContent = isVerified 
                    ? `${discountType} discount active (20% off)` 
                    : `${discountType} discount pending verification`;
            }
        } else {
            // Show no proof state
            if (discountCurrentProofEl) discountCurrentProofEl.style.display = 'none';
            if (removeDiscountBtnEl) removeDiscountBtnEl.style.display = 'none';

            discountStatus.innerHTML = `
                <div class="discount-status-content d-flex align-items-center gap-3 p-3 rounded" style="background: #f5f5f5; border: 1.5px solid var(--border);">
                    <div class="discount-status-icon">
                        <i class="fas fa-info-circle" style="font-size: 1.5rem; color: #666;"></i>
                    </div>
                    <div class="discount-status-text flex-grow-1">
                        <div class="discount-status-label" style="font-weight: 600; color: #222; margin-bottom: 4px;">No discount proof uploaded</div>
                        <div class="discount-status-desc" style="font-size: 0.9rem; color: #666;">Upload your PWD ID or Senior Citizen ID to apply discounts to your orders.</div>
                    </div>
                </div>
            `;

            // Update toggle button subtitle
            if (discountToggleSubtitle) {
                discountToggleSubtitle.textContent = 'Upload proof for PWD or Senior Citizen discount';
            }
        }
    }

    // Toggle discount section
    function toggleDiscountSection() {
        if (!discountToggleBtn || !discountContent) return;

        const isExpanded = discountToggleBtn.getAttribute('aria-expanded') === 'true';

        if (isExpanded) {
            discountContent.style.display = 'none';
            discountToggleBtn.setAttribute('aria-expanded', 'false');
        } else {
            discountContent.style.display = 'block';
            discountToggleBtn.setAttribute('aria-expanded', 'true');
        }
    }

    async function uploadDiscountProof() {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            showDiscountError('discountProof', 'You must be signed in to upload discount proof');
            return;
        }

        if (!discountTypeSelect || !discountProofInput) return;

        const discountType = discountTypeSelect.value.trim();
        const idFile = discountProofInput.files?.[0];
        const selfieFile = discountSelfieInput?.files?.[0];
        const idName = discountIdNameInput?.value.trim() || '';
        const idNumber = discountIdNumberInput?.value.trim() || '';

        // Validation
        let hasError = false;
        if (!discountType) {
            showDiscountError('discountType', 'Please select a discount type');
            hasError = true;
        }
        
        // Only validate ID fields if PWD or Senior Citizen is selected
        if (discountType === 'pwd' || discountType === 'senior') {
            if (!idFile) {
                showDiscountError('discountProof', 'Please select an ID picture to upload');
                hasError = true;
            } else {
                // Check file size (5MB max)
                const maxSize = 5 * 1024 * 1024; // 5MB
                if (idFile.size > maxSize) {
                    showDiscountError('discountProof', 'ID picture size must be less than 5MB');
                    hasError = true;
                }
                // Check file type
                const validTypes = ['image/jpeg', 'image/jpg', 'image/png'];
                if (!validTypes.includes(idFile.type)) {
                    showDiscountError('discountProof', 'Please upload a JPG or PNG file for ID picture');
                    hasError = true;
                }
            }
        }

        // Validate selfie if PWD or Senior Citizen type (required for both)
        if (discountType === 'pwd' || discountType === 'senior') {
            if (!selfieFile) {
                showDiscountError('discountSelfie', 'Please upload a selfie');
                hasError = true;
            } else {
                const maxSize = 5 * 1024 * 1024; // 5MB
                if (selfieFile.size > maxSize) {
                    showDiscountError('discountSelfie', 'Selfie size must be less than 5MB');
                    hasError = true;
                }
                const validTypes = ['image/jpeg', 'image/jpg', 'image/png'];
                if (!validTypes.includes(selfieFile.type)) {
                    showDiscountError('discountSelfie', 'Please upload a JPG or PNG file for selfie');
                    hasError = true;
                }
            }
        }

        if (hasError) return;

        // Set uploading state
        isUploadingDiscount = true;
        if (uploadDiscountBtn) {
            uploadDiscountBtn.disabled = true;
            uploadDiscountBtn.classList.add('disabled');
        }
        if (uploadDiscountBtnText) uploadDiscountBtnText.textContent = 'Uploading...';

        try {
            // Upload file to Firebase Storage
            const storage = window.firebaseStorage;
            if (!storage) {
                throw new Error('Firebase Storage not available');
            }

            const timestamp = Date.now();
            
            // Upload ID picture
            const idFileExtension = idFile.name.split('.').pop();
            const idFileName = `discount-proofs/${user.uid}/id-${timestamp}.${idFileExtension}`;
            const idStorageRef = window.storageRef(storage, idFileName);

            await window.uploadBytes(idStorageRef, idFile);
            const idDownloadURL = await window.getDownloadURL(idStorageRef);

            // Upload selfie if provided
            let selfieDownloadURL = null;
            let selfiePath = null;
            if (selfieFile) {
                const selfieFileExtension = selfieFile.name.split('.').pop();
                const selfieFileName = `discount-proofs/${user.uid}/selfie-${timestamp}.${selfieFileExtension}`;
                const selfieStorageRef = window.storageRef(storage, selfieFileName);

                await window.uploadBytes(selfieStorageRef, selfieFile);
                selfieDownloadURL = await window.getDownloadURL(selfieStorageRef);
                selfiePath = selfieFileName;
            }

            // Save discount info to user document
            const userDocRef = window.doc(window.firebaseDb, 'customers', user.uid);
            const discountInfoData = {
                type: discountType,
                proofUrl: idDownloadURL,
                proofPath: idFileName,
                uploadedAt: new Date().toISOString(),
                IDverification: false  // Set to false initially, admin will verify
            };

            // Add ID name and ID number if provided
            if (idName) {
                discountInfoData.idName = idName;
            }
            if (idNumber) {
                discountInfoData.idNumber = idNumber;
            }

            if (selfieDownloadURL) {
                discountInfoData.selfieUrl = selfieDownloadURL;
                discountInfoData.selfiePath = selfiePath;
            }

            await window.setDoc(
                userDocRef,
                {
                    discountInfo: discountInfoData,
                    updatedAt: new Date()
                },
                { merge: true }
            );

            // Reset form
            if (discountUploadForm) discountUploadForm.reset();
            updateDiscountPreview(null, null);
            if (selfieUploadGroup) selfieUploadGroup.style.display = 'none';
            if (idPictureGroup) idPictureGroup.style.display = 'none';
            if (idNameGroup) idNameGroup.style.display = 'none';
            if (idNumberGroup) idNumberGroup.style.display = 'none';
            clearDiscountError('discountType');
            clearDiscountError('discountProof');
            clearDiscountError('discountSelfie');
            clearDiscountError('discountIdName');
            clearDiscountError('discountIdNumber');
            showDiscountSuccess();

            // The real-time listener will update the UI automatically
        } catch (error) {
            console.error('Error uploading discount proof:', error);
            let errorMessage = 'Failed to upload discount proof. Please try again.';
            
            if (error.code === 'storage/unauthorized') {
                errorMessage = 'You do not have permission to upload files.';
            } else if (error.code === 'storage/canceled') {
                errorMessage = 'Upload was canceled.';
            } else if (error.code === 'storage/unknown') {
                errorMessage = 'An unknown error occurred. Please try again.';
            } else if (error.message) {
                errorMessage = error.message;
            }

            showDiscountError('discountProof', errorMessage);
        } finally {
            isUploadingDiscount = false;
            if (uploadDiscountBtn) {
                uploadDiscountBtn.disabled = false;
                uploadDiscountBtn.classList.remove('disabled');
            }
            if (uploadDiscountBtnText) uploadDiscountBtnText.textContent = 'Upload Proof';
        }
    }

    async function removeDiscountProof() {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            showToast('You must be signed in to remove discount proof', 'error');
            return;
        }

        const confirmed = await showConfirmModal(
            'Are you sure you want to remove your discount proof? You will need to upload it again to use discounts.',
            'Remove Discount Proof',
            'Yes, Remove'
        );

        if (!confirmed) return;

        try {
            const userDocRef = window.doc(window.firebaseDb, 'customers', user.uid);
            const userDoc = await window.getDoc(userDocRef);
            
            if (userDoc.exists()) {
                const userData = userDoc.data();
                const discountInfo = userData.discountInfo;

                // Note: We don't delete the file from storage to avoid needing deleteObject
                // The file will remain in storage but the reference will be removed from the user document

                // Remove discount info from user document by setting it to null
                await window.setDoc(
                    userDocRef,
                    { discountInfo: null },
                    { merge: true }
                );

                showToast('Discount proof removed', 'success');
            }
        } catch (error) {
            console.error('Error removing discount proof:', error);
            showToast('Failed to remove discount proof. Please try again.', 'error');
        }
    }

    // Edit and delete review functions
    let editReviewModal = null;
    let editReviewForm = null;
    let closeEditReviewModal = null;
    let cancelEditReviewBtn = null;
    let editReviewStars = null;
    let editReviewText = null;
    let editReviewItemName = null;
    let currentEditReviewId = null;
    let currentEditItemId = null;
    let currentEditRating = 0;
    let isUpdatingReview = false;

    // Inline edit review (like orders.html)
    async function editReviewInline(reviewId, itemId) {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            showToast('You must be signed in to edit reviews', 'error');
            return;
        }

        if (!reviewId || !itemId) {
            console.error('[Edit Review] Missing parameters:', { reviewId, itemId });
            showToast('Invalid review data. Missing review ID or item ID.', 'error');
            return;
        }

        try {
            // Get review data from the wrapper element (already rendered)
            const wrapperEl = document.querySelector(`.account-review-menu-item-wrapper[data-review-id="${reviewId}"]`);
            if (!wrapperEl) {
                // Fallback: try to fetch from Firestore
                console.log('[Edit Review] Wrapper not found, fetching from Firestore...');
                if (!window.firestore?.fetchReviewsForItem) {
                    showToast('Reviews are not available right now. Please try again later.', 'error');
                    return;
                }
                const reviews = await window.firestore.fetchReviewsForItem(itemId);
                const review = reviews.find(r => r.id === reviewId);
                
                if (!review) {
                    showToast('Review not found', 'error');
                    return;
                }

                // Store current rating for this review (initialize before showing edit form)
                if (!window.accountReviewRatings) {
                    window.accountReviewRatings = {};
                }
                window.accountReviewRatings[reviewId] = review.rating || 0;

                // Hide display, show edit form
                const displayEl = document.getElementById(`review-display-${reviewId}`);
                const editFormEl = document.getElementById(`review-edit-${reviewId}`);
                const textareaEl = document.getElementById(`review-text-${reviewId}`);
                const starsContainer = editFormEl?.querySelector('.account-review-stars');

                if (displayEl) displayEl.style.display = 'none';
                if (editFormEl) editFormEl.style.display = 'block';
                if (textareaEl) textareaEl.value = review.text || '';

                // Update stars display and ensure they're clickable
                if (starsContainer) {
                    const stars = starsContainer.querySelectorAll('.account-review-star');
                    stars.forEach((star, index) => {
                        const rating = index + 1;
                        const icon = star.querySelector('i');
                        if (rating <= review.rating) {
                            icon.classList.remove('far');
                            icon.classList.add('fas');
                            icon.style.color = '#ffc107';
                        } else {
                            icon.classList.remove('fas');
                            icon.classList.add('far');
                            icon.style.color = '#ddd';
                        }
                        // Ensure star is clickable
                        star.style.cursor = 'pointer';
                    });
                }
                return;
            }

            // Get data from data attributes
            const currentRating = parseFloat(wrapperEl.getAttribute('data-rating')) || 0;
            const currentText = wrapperEl.getAttribute('data-text') || '';

            // Store current rating for this review (initialize before showing edit form)
            if (!window.accountReviewRatings) {
                window.accountReviewRatings = {};
            }
            window.accountReviewRatings[reviewId] = currentRating;

            // Hide display, show edit form
            const displayEl = document.getElementById(`review-display-${reviewId}`);
            const editFormEl = document.getElementById(`review-edit-${reviewId}`);
            const textareaEl = document.getElementById(`review-text-${reviewId}`);
            const starsContainer = editFormEl?.querySelector('.account-review-stars');

            if (!displayEl || !editFormEl) {
                console.error('[Edit Review] Display or edit form elements not found');
                showToast('Review elements not found', 'error');
                return;
            }

            displayEl.style.display = 'none';
            editFormEl.style.display = 'block';
            // Textarea already contains the correct text from renderAccountReviews
            // If it's empty, try to decode from data attribute as fallback
            if (textareaEl && !textareaEl.value.trim()) {
                // Decode HTML entities properly (fallback only)
                const decodedText = currentText
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&#x27;/g, "'")
                    .replace(/&#x2F;/g, '/');
                textareaEl.value = decodedText;
            }

            // Update stars display and ensure they're clickable
            if (starsContainer) {
                const stars = starsContainer.querySelectorAll('.account-review-star');
                stars.forEach((star, index) => {
                    const rating = index + 1;
                    const icon = star.querySelector('i');
                    if (rating <= currentRating) {
                        icon.classList.remove('far');
                        icon.classList.add('fas');
                        icon.style.color = '#ffc107';
                    } else {
                        icon.classList.remove('fas');
                        icon.classList.add('far');
                        icon.style.color = '#ddd';
                    }
                    // Ensure star is clickable
                    star.style.cursor = 'pointer';
                });
            }
        } catch (error) {
            console.error('Error loading review for edit:', error);
            console.error('Error details:', {
                message: error.message,
                stack: error.stack,
                reviewId,
                itemId
            });
            showToast(`Failed to load review: ${error.message || 'Unknown error'}`, 'error');
        }
    }

    function cancelEditReview(reviewId) {
        const displayEl = document.getElementById(`review-display-${reviewId}`);
        const editFormEl = document.getElementById(`review-edit-${reviewId}`);
        
        if (displayEl) displayEl.style.display = 'block';
        if (editFormEl) editFormEl.style.display = 'none';
    }

    async function updateReviewInline(reviewId, itemId) {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            showToast('You must be signed in to update reviews', 'error');
            return;
        }

        if (!reviewId || !itemId) {
            showToast('Invalid review data', 'error');
            return;
        }

        // Check if firestore is available
        if (!window.firestore?.saveReviewForItem) {
            showToast('Reviews are not available right now. Please try again later.', 'error');
            return;
        }

        // Get rating
        const rating = window.accountReviewRatings?.[reviewId] || 0;
        if (rating === 0) {
            showToast('Please select a rating', 'error');
            return;
        }

        // Get text (optional, like in order_details.js)
        const textarea = document.getElementById(`review-text-${reviewId}`);
        const text = textarea?.value.trim() || '';

        try {
            await window.firestore.saveReviewForItem({
                itemId: itemId,
                rating: rating,
                text: text,
                anonymous: false,
                reviewId: reviewId
            });

            // Hide edit form, show display (will be updated by listener)
            cancelEditReview(reviewId);
            showToast('Review updated successfully!', 'success');
        } catch (error) {
            console.error('Error updating review:', error);
            showToast(error.message || 'Failed to update review. Please try again.', 'error');
        }
    }

    // Legacy modal-based edit (keeping for backwards compatibility, but not used)
    async function editReview(reviewId, itemId) {
        // Redirect to inline edit
        await editReviewInline(reviewId, itemId);
    }

    function closeEditReviewModalFunc() {
        if (editReviewModal) editReviewModal.style.display = 'none';
        if (editReviewForm) editReviewForm.reset();
        currentEditReviewId = null;
        currentEditItemId = null;
        currentEditRating = 0;
        
        // Clear errors
        const ratingError = document.getElementById('editReviewRatingError');
        const textError = document.getElementById('editReviewTextError');
        if (ratingError) ratingError.textContent = '';
        if (textError) textError.textContent = '';
    }

    async function updateReview() {
        if (isUpdatingReview) return;

        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            showToast('You must be signed in to update reviews', 'error');
            return;
        }

        if (!currentEditReviewId || !currentEditItemId) {
            showToast('Invalid review data', 'error');
            return;
        }

        if (currentEditRating === 0) {
            const ratingError = document.getElementById('editReviewRatingError');
            if (ratingError) ratingError.textContent = 'Please select a rating';
            return;
        }

        const text = editReviewText?.value.trim() || '';
        if (!text) {
            const textError = document.getElementById('editReviewTextError');
            if (textError) textError.textContent = 'Please enter a review';
            return;
        }

        isUpdatingReview = true;
        const updateBtn = document.getElementById('updateReviewBtnText');
        if (updateBtn) updateBtn.textContent = 'Updating...';

        try {
            console.log('[Update Review] Updating review:', {
                itemId: currentEditItemId,
                reviewId: currentEditReviewId,
                rating: currentEditRating
            });
            
            await window.firestore.saveReviewForItem({
                itemId: currentEditItemId,
                rating: currentEditRating,
                text: text,
                anonymous: false,
                reviewId: currentEditReviewId
            });

            closeEditReviewModalFunc();
            showToast('Review updated successfully!', 'success');
        } catch (error) {
            console.error('Error updating review:', error);
            console.error('Error details:', {
                code: error.code,
                message: error.message,
                itemId: currentEditItemId,
                reviewId: currentEditReviewId
            });
            const errorMsg = error.message || `Failed to update review. ${error.code || 'Unknown error'}`;
            showToast(errorMsg, 'error');
        } finally {
            isUpdatingReview = false;
            if (updateBtn) updateBtn.textContent = 'Update Review';
        }
    }

    async function deleteReview(reviewId, itemId) {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
            showToast('You must be signed in to delete reviews', 'error');
            return;
        }

        if (!reviewId || !itemId) {
            console.error('[Delete Review] Missing parameters:', { reviewId, itemId });
            showToast('Invalid review data. Missing review ID or item ID.', 'error');
            return;
        }

        const confirmed = await showConfirmModal(
            'Are you sure you want to delete this review? This action cannot be undone.',
            'Delete Review',
            'Yes, Delete'
        );

        if (!confirmed) return;

        try {
            console.log('[Delete Review] Deleting review:', { reviewId, itemId });
            
            // Delete from menu/{itemId}/reviews/{reviewId}
            await window.firestore.deleteReview(itemId, reviewId);
            
            // Also delete from customers/{uid}/reviews/{reviewId}
            try {
                const db = window.firebaseDb;
                if (db && window.doc && window.deleteDoc) {
                    const customerReviewRef = window.doc(db, 'customers', user.uid, 'reviews', reviewId);
                    await window.deleteDoc(customerReviewRef);
                }
            } catch (e) {
                console.warn('Failed to delete review from customer subcollection:', e);
                // Continue even if this fails, as the main deletion succeeded
            }
            
            showToast('Review deleted successfully', 'success');
        } catch (error) {
            console.error('Error deleting review:', error);
            console.error('Error details:', {
                code: error.code,
                message: error.message,
                reviewId,
                itemId
            });
            const errorMsg = error.message || `Failed to delete review. ${error.code || 'Unknown error'}`;
            showToast(errorMsg, 'error');
        }
    }

    // Helper function to ensure reviews are in customer subcollection
    async function ensureReviewsInCustomerSubcollection(user) {
        if (!user || !user.uid) return;

        try {
            const db = window.firebaseDb;
            if (!db || !window.collection || !window.query || !window.where || !window.getDocs) {
                return;
            }

            // Check if customer has any reviews in subcollection
            const customerRef = window.doc(db, 'customers', user.uid);
            const customerReviewsCol = window.collection(customerRef, 'reviews');
            const customerReviewsSnap = await window.getDocs(customerReviewsCol);
            
            // If no reviews in customer subcollection, try to find reviews from menu items
            if (customerReviewsSnap.empty) {
                console.log('[Account Reviews] No reviews in customer subcollection, checking menu items...');
                
                // Query all menu items to find user's reviews
                const menuCol = window.collection(db, 'menu');
                const menuSnap = await window.getDocs(menuCol);
                
                for (const menuDoc of menuSnap.docs) {
                    const menuId = menuDoc.id;
                    const reviewsCol = window.collection(menuDoc.ref, 'reviews');
                    const userReviewsQuery = window.query(reviewsCol, window.where('userId', '==', user.uid));
                    const userReviewsSnap = await window.getDocs(userReviewsQuery);
                    
                    for (const reviewDoc of userReviewsSnap.docs) {
                        const reviewData = reviewDoc.data();
                        // Copy to customer subcollection
                        const customerReviewRef = window.doc(customerReviewsCol, reviewDoc.id);
                        await window.setDoc(customerReviewRef, reviewData);
                        console.log(`[Account Reviews] Migrated review ${reviewDoc.id} to customer subcollection`);
                    }
                }
            }
        } catch (error) {
            console.warn('[Account Reviews] Error ensuring reviews in customer subcollection:', error);
        }
    }

    // Initialize on page load
    function initialize() {
        // Navigation functions are already exposed by utils.js

        // Initialize DOM element references
        addressModal = document.getElementById('addressModal');
        addressForm = document.getElementById('addressForm');
        addressModalTitle = document.getElementById('addressModalTitle');
        addressSubmitText = document.getElementById('addressSubmitText');
        closeAddressModal = document.getElementById('closeAddressModal');

        confirmModal = document.getElementById('confirmModal');
        confirmModalTitle = document.getElementById('confirmModalTitle');
        confirmModalMessage = document.getElementById('confirmModalMessage');
        confirmModalYes = document.getElementById('confirmModalYes');
        confirmModalYesText = document.getElementById('confirmModalYesText');
        confirmModalNo = document.getElementById('confirmModalNo');
        closeConfirmModal = document.getElementById('closeConfirmModal');

        profileEditModal = document.getElementById('profileEditModal');
        editProfileBtn = document.getElementById('editProfileBtn');
        closeProfileModal = document.getElementById('closeProfileModal');
        profileEditForm = document.getElementById('profileEditForm');
        editFirstName = document.getElementById('editFirstName');
        editLastName = document.getElementById('editLastName');
        editPhone = document.getElementById('editPhone');

        deleteAccountPasswordModal = document.getElementById('deleteAccountPasswordModal');
        deleteAccountPasswordForm = document.getElementById('deleteAccountPasswordForm');
        deleteAccountPasswordInput = document.getElementById('deleteAccountPassword');
        deleteAccountPasswordError = document.getElementById('deleteAccountPasswordError');
        closeDeletePasswordModal = document.getElementById('closeDeletePasswordModal');
        cancelDeleteAccountBtn = document.getElementById('cancelDeleteAccountBtn');
        confirmDeleteAccountBtn = document.getElementById('confirmDeleteAccountBtn');
        confirmDeleteAccountBtnText = document.getElementById('confirmDeleteAccountBtnText');

        // Address modal events
        if (closeAddressModal) {
            closeAddressModal.addEventListener('click', closeAddressModalFunc);
        }
        if (addressModal) {
            addressModal.addEventListener('click', function(e) {
                if (e.target === addressModal) {
                    closeAddressModalFunc();
                }
            });
        }
        if (addressForm) {
            addressForm.addEventListener('submit', function(e) {
                e.preventDefault();
                saveAddress();
            });
        }

        ['addressLabel', 'addressStreet', 'addressCity', 'addressBarangay'].forEach(id => {
            const field = document.getElementById(id);
            if (field) {
                const clearError = () => {
                    const errorEl = document.getElementById(id + 'Error');
                    if (errorEl) errorEl.textContent = '';
                };
                field.addEventListener('input', clearError);
                field.addEventListener('change', clearError);
            }
        });

        // PSGC address dropdown events
        const cityEl = getAddressCityEl();
        if (cityEl) {
            cityEl.addEventListener('change', () => {
                const barangayEl = getAddressBarangayEl();
                if (barangayEl) barangayEl.value = '';
                refreshBarangayOptions();
            });
        }

        // Confirmation modal event listeners
        if (confirmModalYes) {
            confirmModalYes.addEventListener('click', function() {
                if (confirmModal) confirmModal.style.display = 'none';
                if (confirmCallback) {
                    confirmCallback(true);
                    confirmCallback = null;
                }
            });
        }
        if (confirmModalNo) confirmModalNo.addEventListener('click', closeConfirmModalFunc);
        if (closeConfirmModal) closeConfirmModal.addEventListener('click', closeConfirmModalFunc);
        if (confirmModal) {
            confirmModal.addEventListener('click', function(e) {
                if (e.target === confirmModal) {
                    closeConfirmModalFunc();
                }
            });
        }

        // Expose functions to window for onclick handlers
        window.addAddress = openAddAddressModal;
        window.account = {
            openEditAddressModal,
            deleteAddress,
            editReview,
            editReviewInline,
            updateReviewInline,
            cancelEditReview
        };

        // Profile edit modal
        if (editProfileBtn) {
            editProfileBtn.addEventListener('click', openProfileEditModal);
        }
        if (closeProfileModal) {
            closeProfileModal.addEventListener('click', closeProfileEditModal);
        }
        if (profileEditModal) {
            profileEditModal.addEventListener('click', function(e) {
                if (e.target === profileEditModal) {
                    closeProfileEditModal();
                }
            });
        }
        if (profileEditForm) {
            profileEditForm.addEventListener('submit', function(e) {
                e.preventDefault();
                saveProfileChanges();
            });
        }

        if (editFirstName) {
            editFirstName.addEventListener('input', () => {
                const errorEl = document.getElementById('editFirstNameError');
                if (errorEl) errorEl.textContent = '';
            });
        }
        if (editLastName) {
            editLastName.addEventListener('input', () => {
                const errorEl = document.getElementById('editLastNameError');
                if (errorEl) errorEl.textContent = '';
            });
        }
        if (editPhone) {
            editPhone.addEventListener('input', () => {
                const errorEl = document.getElementById('editPhoneError');
                if (errorEl) errorEl.textContent = '';
            });
        }

        // Account review navigation (only navigate if clicking the card, not the buttons)
        const menu = document.getElementById('accountReviewMenu');
        if (menu) {
            menu.addEventListener('click', (event) => {
                // Don't navigate if clicking action buttons or edit forms
                if (event.target.closest('.account-review-actions')) return;
                if (event.target.closest('.account-review-edit-form')) return;
                if (event.target.closest('button[onclick*="editReview"]')) return;
                if (event.target.closest('button[onclick*="updateReview"]')) return;
                if (event.target.closest('button[onclick*="cancelEdit"]')) return;
                
                const item = event.target.closest('.account-review-menu-item');
                if (!item) return;
                const itemId = item.getAttribute('data-item-id');
                if (!itemId) return;
                window.location.href = `food_item.html?id=${encodeURIComponent(itemId)}`;
            });

            // Handle star rating clicks in edit forms
            menu.addEventListener('click', (event) => {
                const star = event.target.closest('.account-review-star');
                if (!star) return;
                
                const rating = parseInt(star.getAttribute('data-rating'), 10);
                const reviewId = star.closest('.account-review-stars')?.getAttribute('data-review-id');
                
                if (!reviewId || isNaN(rating)) return;

                // Store rating
                if (!window.accountReviewRatings) {
                    window.accountReviewRatings = {};
                }
                window.accountReviewRatings[reviewId] = rating;

                // Update all stars in this container
                const starsContainer = star.closest('.account-review-stars');
                const stars = starsContainer?.querySelectorAll('.account-review-star');
                if (stars) {
                    stars.forEach((s, index) => {
                        const r = index + 1;
                        const icon = s.querySelector('i');
                        if (r <= rating) {
                            icon.classList.remove('far');
                            icon.classList.add('fas');
                            icon.style.color = '#ffc107';
                        } else {
                            icon.classList.remove('fas');
                            icon.classList.add('far');
                            icon.style.color = '#ddd';
                        }
                    });
                }
            });
        }

        // Section nav scroll
        const nav = document.querySelector('.account-section-nav');
        if (nav) {
            nav.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-section]');
                if (!btn) return;
                const targetId = btn.getAttribute('data-section');
                if (!targetId) return;
                const el = document.getElementById(targetId);
                if (!el) return;
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }

        // Edit review modal
        editReviewModal = document.getElementById('editReviewModal');
        editReviewForm = document.getElementById('editReviewForm');
        closeEditReviewModal = document.getElementById('closeEditReviewModal');
        cancelEditReviewBtn = document.getElementById('cancelEditReviewBtn');
        editReviewStars = document.getElementById('editReviewStars');
        editReviewText = document.getElementById('editReviewText');
        editReviewItemName = document.getElementById('editReviewItemName');

        if (closeEditReviewModal) {
            closeEditReviewModal.addEventListener('click', closeEditReviewModalFunc);
        }
        if (cancelEditReviewBtn) {
            cancelEditReviewBtn.addEventListener('click', closeEditReviewModalFunc);
        }
        if (editReviewModal) {
            editReviewModal.addEventListener('click', function(e) {
                if (e.target === editReviewModal) {
                    closeEditReviewModalFunc();
                }
            });
        }
        if (editReviewForm) {
            editReviewForm.addEventListener('submit', async function(e) {
                e.preventDefault();
                await updateReview();
            });
        }

        // Star rating for edit review
        if (editReviewStars) {
            editReviewStars.addEventListener('click', function(e) {
                const star = e.target.closest('.review-star');
                if (!star) return;
                const rating = parseInt(star.getAttribute('data-rating'), 10);
                if (isNaN(rating)) return;

                currentEditRating = rating;
                const stars = editReviewStars.querySelectorAll('.review-star');
                stars.forEach((s, index) => {
                    const r = index + 1;
                    const icon = s.querySelector('i');
                    if (r <= rating) {
                        icon.classList.remove('far');
                        icon.classList.add('fas');
                        icon.style.color = '#ffc107';
                    } else {
                        icon.classList.remove('fas');
                        icon.classList.add('far');
                        icon.style.color = '#ddd';
                    }
                });

                // Clear rating error
                const ratingError = document.getElementById('editReviewRatingError');
                if (ratingError) ratingError.textContent = '';
            });
        }

        if (editReviewText) {
            editReviewText.addEventListener('input', function() {
                const textError = document.getElementById('editReviewTextError');
                if (textError) textError.textContent = '';
            });
        }

        // Keyboard shortcuts for modals (Esc to close)
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (profileEditModal && profileEditModal.style.display === 'flex') {
                closeProfileEditModal();
            } else if (addressModal && addressModal.style.display === 'flex') {
                closeAddressModalFunc();
            } else if (deleteAccountPasswordModal && deleteAccountPasswordModal.style.display === 'flex') {
                closeDeletePasswordModalFunc();
            } else if (confirmModal && confirmModal.style.display === 'flex') {
                closeConfirmModalFunc();
            } else if (editReviewModal && editReviewModal.style.display === 'flex') {
                closeEditReviewModalFunc();
            }
        });

        // Loyalty history click -> order details
        const list = document.getElementById('loyaltyHistoryList');
        if (list) {
            list.addEventListener('click', (e) => {
                const item = e.target.closest('.loyalty-history-item');
                if (!item) return;
                const orderId = item.getAttribute('data-order-id');
                if (!orderId) return;
                window.location.href = `order_details.html?orderId=${encodeURIComponent(orderId)}`;
            });
        }

        // Password change
        setupPasswordToggle('currentPasswordToggle', 'currentPassword');
        hidePasswordSuccess();

        const currentPasswordInput = document.getElementById('currentPassword');
        if (currentPasswordInput) {
            currentPasswordInput.addEventListener('input', () => clearPasswordError('currentPassword'));
            currentPasswordInput.addEventListener('blur', function() {
                const error = validateCurrentPassword(this.value);
                if (error) {
                    showPasswordError('currentPassword', error);
                }
            });
        }

        const passwordChangeForm = document.getElementById('passwordChangeForm');
        if (passwordChangeForm) {
            passwordChangeForm.addEventListener('submit', async function(e) {
                e.preventDefault();
                if (isChangingPassword) return;

                const user = window.firebaseAuth?.currentUser;
                if (!isPasswordProviderUser(user)) {
                    showToast('You signed in with Google. Password changes are managed through your Google account.', 'info');
                    return;
                }

                clearAllPasswordErrors();
                const currentPassword = currentPasswordInput?.value;
                if (!currentPassword) return;

                const currentPasswordError = validateCurrentPassword(currentPassword);
                if (currentPasswordError) {
                    showPasswordError('currentPassword', currentPasswordError);
                    return;
                }

                setPasswordFormState(true);
                await changePassword(currentPassword);
                setPasswordFormState(false);
            });
        }

        // Account deletion
        setupPasswordToggle('deleteAccountPasswordToggle', 'deleteAccountPassword');

        if (closeDeletePasswordModal) {
            closeDeletePasswordModal.addEventListener('click', closeDeletePasswordModalFunc);
        }
        if (cancelDeleteAccountBtn) {
            cancelDeleteAccountBtn.addEventListener('click', closeDeletePasswordModalFunc);
        }
        if (deleteAccountPasswordModal) {
            deleteAccountPasswordModal.addEventListener('click', function(e) {
                if (e.target === deleteAccountPasswordModal) {
                    closeDeletePasswordModalFunc();
                }
            });
        }
        if (deleteAccountPasswordInput) {
            deleteAccountPasswordInput.addEventListener('input', () => {
                if (deleteAccountPasswordError) deleteAccountPasswordError.textContent = '';
            });
        }
        if (deleteAccountPasswordForm) {
            deleteAccountPasswordForm.addEventListener('submit', async function(e) {
                e.preventDefault();
                if (isDeletingAccount) return;

                const password = deleteAccountPasswordInput?.value.trim();
                if (!password) {
                    if (deleteAccountPasswordError) deleteAccountPasswordError.textContent = 'Password is required';
                    return;
                }

                isDeletingAccount = true;
                if (confirmDeleteAccountBtn) confirmDeleteAccountBtn.disabled = true;
                if (confirmDeleteAccountBtnText) confirmDeleteAccountBtnText.textContent = 'Deleting...';

                try {
                    await deleteAccountWithPassword(password);
                } catch (error) {
                    isDeletingAccount = false;
                    if (confirmDeleteAccountBtn) confirmDeleteAccountBtn.disabled = false;
                    if (confirmDeleteAccountBtnText) confirmDeleteAccountBtnText.textContent = 'Delete Account';

                    let errorMessage = 'An error occurred while deleting your account. Please try again.';
                    
                    switch (error.code) {
                        case 'auth/wrong-password':
                            errorMessage = 'Incorrect password. Please try again.';
                            break;
                        case 'auth/invalid-credential':
                            errorMessage = 'Wrong password. Please try again.';
                            break;
                        case 'auth/network-request-failed':
                            errorMessage = 'Network error. Please check your internet connection and try again.';
                            break;
                        case 'auth/too-many-requests':
                            errorMessage = 'Too many failed attempts. Please try again later.';
                            break;
                        default:
                            errorMessage = error.message || errorMessage;
                    }

                    if (deleteAccountPasswordError) deleteAccountPasswordError.textContent = errorMessage;
                }
            });
        }

        const deleteAccountBtn = document.getElementById('deleteAccountBtn');
        if (deleteAccountBtn) {
            deleteAccountBtn.addEventListener('click', deleteUserAccount);
        }

        // Discount proof upload
        discountUploadForm = document.getElementById('discountUploadForm');
        discountTypeSelect = document.getElementById('discountType');
        discountProofInput = document.getElementById('discountProof');
        discountSelfieInput = document.getElementById('discountSelfie');
        discountIdNameInput = document.getElementById('discountIdName');
        discountIdNumberInput = document.getElementById('discountIdNumber');
        selfieUploadGroup = document.getElementById('selfieUploadGroup');
        idPictureGroup = document.getElementById('idPictureGroup');
        idNameGroup = document.getElementById('idNameGroup');
        idNumberGroup = document.getElementById('idNumberGroup');
        uploadDiscountBtn = document.getElementById('uploadDiscountBtn');
        uploadDiscountBtnText = document.getElementById('uploadDiscountBtnText');
        removeDiscountBtn = document.getElementById('removeDiscountBtn');
        discountPreview = document.getElementById('discountPreview');
        discountCurrentProof = document.getElementById('discountCurrentProof');
        discountToggleBtn = document.getElementById('discountToggleBtn');
        discountContent = document.getElementById('discountContent');
        discountToggleSubtitle = document.getElementById('discountToggleSubtitle');

        // Discount toggle button
        if (discountToggleBtn) {
            discountToggleBtn.addEventListener('click', toggleDiscountSection);
        }

        // Show/hide fields based on discount type
        if (discountTypeSelect) {
            discountTypeSelect.addEventListener('change', function() {
                clearDiscountError('discountType');
                // Remove error class when a valid value is selected
                if (this.value) {
                    this.classList.remove('error');
                }
                const selectedType = this.value;
                const isPwdOrSenior = selectedType === 'pwd' || selectedType === 'senior';
                
                // Show/hide ID picture, ID name, and ID number fields
                if (idPictureGroup) {
                    idPictureGroup.style.display = isPwdOrSenior ? 'block' : 'none';
                }
                if (idNameGroup) {
                    idNameGroup.style.display = isPwdOrSenior ? 'block' : 'none';
                }
                if (idNumberGroup) {
                    idNumberGroup.style.display = isPwdOrSenior ? 'block' : 'none';
                }
                
                // Show/hide selfie upload for both PWD and Senior Citizen
                if (selfieUploadGroup) {
                    if (isPwdOrSenior) {
                        selfieUploadGroup.style.display = 'block';
                        if (discountSelfieInput) {
                            discountSelfieInput.setAttribute('required', 'required');
                        }
                    } else {
                        selfieUploadGroup.style.display = 'none';
                        if (discountSelfieInput) {
                            discountSelfieInput.removeAttribute('required');
                            discountSelfieInput.value = '';
                        }
                        // Clear selfie preview if switching away
                        const selfiePreviewRow = document.getElementById('selfiePreviewRow');
                        if (selfiePreviewRow) selfiePreviewRow.style.display = 'none';
                    }
                }
                
                // Clear ID picture if switching away
                if (!isPwdOrSenior) {
                    if (discountProofInput) {
                        discountProofInput.value = '';
                        discountProofInput.removeAttribute('required');
                    }
                    if (discountIdNameInput) {
                        discountIdNameInput.value = '';
                    }
                    if (discountIdNumberInput) {
                        discountIdNumberInput.value = '';
                    }
                    // Clear preview
                    const discountPreviewEl = document.getElementById('discountPreview');
                    if (discountPreviewEl) discountPreviewEl.style.display = 'none';
                } else {
                    // Make ID picture required when PWD or Senior Citizen is selected
                    if (discountProofInput) {
                        discountProofInput.setAttribute('required', 'required');
                    }
                }
            });
        }

        if (discountProofInput) {
            discountProofInput.addEventListener('change', function(e) {
                clearDiscountError('discountProof');
                const idFile = e.target.files?.[0];
                const selfieFile = discountSelfieInput?.files?.[0];
                updateDiscountPreview(idFile, selfieFile);
            });
        }

        if (discountSelfieInput) {
            discountSelfieInput.addEventListener('change', function(e) {
                clearDiscountError('discountSelfie');
                const idFile = discountProofInput?.files?.[0];
                const selfieFile = e.target.files?.[0];
                updateDiscountPreview(idFile, selfieFile);
            });
        }

        const removeDiscountPreviewBtn = document.getElementById('removeDiscountPreview');
        if (removeDiscountPreviewBtn) {
            removeDiscountPreviewBtn.addEventListener('click', function() {
                if (discountProofInput) discountProofInput.value = '';
                const selfieFile = discountSelfieInput?.files?.[0];
                updateDiscountPreview(null, selfieFile);
            });
        }

        const removeSelfiePreviewBtn = document.getElementById('removeSelfiePreview');
        if (removeSelfiePreviewBtn) {
            removeSelfiePreviewBtn.addEventListener('click', function() {
                if (discountSelfieInput) discountSelfieInput.value = '';
                const idFile = discountProofInput?.files?.[0];
                updateDiscountPreview(idFile, null);
            });
        }

        if (discountUploadForm) {
            discountUploadForm.addEventListener('submit', async function(e) {
                e.preventDefault();
                if (isUploadingDiscount) return;
                hideDiscountSuccess();
                await uploadDiscountProof();
            });
        }

        if (removeDiscountBtn) {
            removeDiscountBtn.addEventListener('click', removeDiscountProof);
        }

        // Initialize user data
        initUserData();
        window.addEventListener('beforeunload', stopUserDataListenerFunc);
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
