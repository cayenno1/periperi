// ============================================
// ACCOUNT PAGE FUNCTIONALITY
// All account management features (addresses, profile, security, loyalty, reviews)
// ============================================

(function() {
    'use strict';

    // Navigation functions are provided by utils.js

    // Addresses - will be initialized in initialize()
    let addressModal = null;
    let addressForm = null;
    let addressModalTitle = null;
    let addressSubmitText = null;
    let closeAddressModal = null;
    let editingAddressId = null;

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
        
        // Clear all error messages
        document.querySelectorAll('#addressForm .error-message').forEach(el => {
            el.textContent = '';
        });

        if (addressModal) addressModal.style.display = 'flex';
    }

    // Edit address modal
    function openEditAddressModal(addressId) {
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
        const addressPostalField = document.getElementById('addressPostal');

        if (addressLabelField) addressLabelField.value = addressData.label;
        if (addressStreetField) addressStreetField.value = addressData.street;
        if (addressCityField) addressCityField.value = addressData.city;
        if (addressBarangayField) addressBarangayField.value = addressData.barangay;
        if (addressPostalField) addressPostalField.value = addressData.postal;

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
        const postalField = document.getElementById('addressPostal');

        if (!labelField || !streetField || !cityField || !barangayField || !postalField) return;

        const label = labelField.value.trim();
        const street = streetField.value.trim();
        const city = cityField.value.trim();
        const barangay = barangayField.value.trim();
        const postal = postalField.value.trim();

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
        if (!postal) {
            const errorEl = document.getElementById('addressPostalError');
            if (errorEl) errorEl.textContent = 'Postal code is required';
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
                postal: postal,
                fullAddress: `${street}, ${city}, ${barangay} ${postal}`,
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
        if (countEl) countEl.textContent = '';
        if (section) section.hidden = true;
        if (emptyState) emptyState.hidden = true;
    }

    function renderAccountReviews(reviews = []) {
        const section = document.getElementById('accountReviewsSection');
        const menu = document.getElementById('accountReviewMenu');
        const countEl = document.getElementById('accountReviewCount');
        const emptyState = document.getElementById('accountReviewEmpty');
        if (!section || !menu || !countEl || !emptyState) {
            return;
        }

        const total = Array.isArray(reviews) ? reviews.length : 0;
        countEl.textContent = `${total} ${total === 1 ? 'review' : 'reviews'}`;

        if (!total) {
            section.hidden = true;
            emptyState.hidden = false;
            menu.innerHTML = '';
            return;
        }

        emptyState.hidden = true;
        section.hidden = false;

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

                return `
                    <button class="account-review-menu-item" type="button" ${itemIdAttr}>
                        <div class="account-review-menu-item-header">
                            <span class="review-pill-rating">
                                ${rating}
                                <i class="fas fa-star"></i>
                            </span>
                            ${dateLabel ? `<span class="review-pill-date">${dateLabel}</span>` : ''}
                        </div>
                        <div class="account-review-item-name">${safeName}</div>
                        <p class="account-review-item-text">${safeText || 'No written feedback'}</p>
                    </button>
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

            if (window.orderBy && window.query) {
                queryRef = window.query(reviewsCol, window.orderBy('createdAt', 'desc'));
            }

            const handleSnapshot = (snapshot) => {
                const reviews = [];
                snapshot.forEach((docSnap) => {
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

                    reviews.push({
                        id: docSnap.id,
                        itemId: data.itemId || null,
                        itemName: data.itemName || data.displayName || 'Menu item',
                        rating: typeof data.rating === 'number' ? data.rating : Number(data.rating) || 0,
                        text: data.text || '',
                        createdAtLabel: createdLabel,
                        sortDate: sortValue
                    });
                });

                renderAccountReviews(reviews);
            };

            if (window.onSnapshot) {
                stopCustomerReviewsListener = window.onSnapshot(
                    queryRef,
                    handleSnapshot,
                    (error) => {
                        console.error('Error listening to customer reviews:', error);
                        renderAccountReviews([]);
                    }
                );
            } else if (window.getDocs) {
                window.getDocs(queryRef)
                    .then(handleSnapshot)
                    .catch((error) => {
                        console.error('Error loading customer reviews:', error);
                        renderAccountReviews([]);
                    });
            }
        } catch (error) {
            console.error('Failed to start customer reviews listener:', error);
            resetAccountReviewsUI();
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
            startCustomerReviewsListener(user);

            stopUserDataListener = window.onSnapshot(
                userDocRef,
                (snapshot) => {
                    if (snapshot.exists()) {
                        const userData = snapshot.data();
                        updateUserDisplay(userData, user);
                        updateSecurityMeta(user);
                        const addresses = userData.addresses || [];
                        renderAddresses(addresses);
                        renderDiscountStatus(userData);
                    } else {
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

        window.onAuthStateChanged(window.firebaseAuth, (user) => {
            stopUserDataListenerFunc();

            if (user) {
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

    // Security meta info
    function updateSecurityMeta(user) {
        const lastLoginInfo = document.getElementById('lastLoginInfo');
        const lastLoginDevice = document.getElementById('lastLoginDevice');
        if (!lastLoginInfo || !lastLoginDevice) return;

        if (!user) {
            lastLoginInfo.textContent = 'Not signed in';
            lastLoginDevice.textContent = '—';
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

    async function deleteAccount(password) {
        const user = window.firebaseAuth?.currentUser;
        if (!user || !user.email) {
            throw new Error('User not found');
        }

        try {
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
    }

    function clearDiscountError(fieldId) {
        const errorElement = document.getElementById(fieldId + 'Error');
        if (errorElement) errorElement.textContent = '';
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

    function updateDiscountPreview(file) {
        if (!file) {
            const previewEl = document.getElementById('discountPreview');
            if (previewEl) previewEl.style.display = 'none';
            return;
        }

        const previewEl = document.getElementById('discountPreview');
        const previewName = previewEl?.querySelector('.discount-preview-name');
        const previewSize = previewEl?.querySelector('.discount-preview-size');

        if (previewEl) previewEl.style.display = 'block';
        if (previewName) previewName.textContent = file.name;
        if (previewSize) previewSize.textContent = formatFileSize(file.size);
    }

    function renderDiscountStatus(userData) {
        const discountStatus = document.getElementById('discountStatus');
        const discountCurrentProofEl = document.getElementById('discountCurrentProof');
        const removeDiscountBtnEl = document.getElementById('removeDiscountBtn');
        const viewCurrentProofEl = document.getElementById('viewCurrentProof');
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
        const file = discountProofInput.files?.[0];

        // Validation
        let hasError = false;
        if (!discountType) {
            showDiscountError('discountType', 'Please select a discount type');
            hasError = true;
        }
        if (!file) {
            showDiscountError('discountProof', 'Please select a file to upload');
            hasError = true;
        } else {
            // Check file size (5MB max)
            const maxSize = 5 * 1024 * 1024; // 5MB
            if (file.size > maxSize) {
                showDiscountError('discountProof', 'File size must be less than 5MB');
                hasError = true;
            }
            // Check file type
            const validTypes = ['image/jpeg', 'image/jpg', 'image/png'];
            if (!validTypes.includes(file.type)) {
                showDiscountError('discountProof', 'Please upload a JPG or PNG file');
                hasError = true;
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

            const fileExtension = file.name.split('.').pop();
            const fileName = `discount-proofs/${user.uid}/${Date.now()}.${fileExtension}`;
            const storageRef = window.storageRef(storage, fileName);

            await window.uploadBytes(storageRef, file);
            const downloadURL = await window.getDownloadURL(storageRef);

            // Save discount info to user document
            const userDocRef = window.doc(window.firebaseDb, 'customers', user.uid);
            await window.setDoc(
                userDocRef,
                {
                    discountInfo: {
                        type: discountType,
                        proofUrl: downloadURL,
                        proofPath: fileName,
                        uploadedAt: new Date().toISOString(),
                        IDverification: false  // Set to false initially, admin will verify
                    },
                    updatedAt: new Date()
                },
                { merge: true }
            );

            // Reset form
            if (discountUploadForm) discountUploadForm.reset();
            updateDiscountPreview(null);
            clearDiscountError('discountType');
            clearDiscountError('discountProof');
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

        ['addressLabel', 'addressStreet', 'addressCity', 'addressBarangay', 'addressPostal'].forEach(id => {
            const field = document.getElementById(id);
            if (field) {
                field.addEventListener('input', () => {
                    const errorEl = document.getElementById(id + 'Error');
                    if (errorEl) errorEl.textContent = '';
                });
            }
        });

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
            deleteAddress
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

        // Account review navigation
        const menu = document.getElementById('accountReviewMenu');
        if (menu) {
            menu.addEventListener('click', (event) => {
                const item = event.target.closest('.account-review-menu-item');
                if (!item) return;
                const itemId = item.getAttribute('data-item-id');
                if (!itemId) return;
                window.location.href = `food_item.html?id=${encodeURIComponent(itemId)}`;
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
                    await deleteAccount(password);
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

        if (discountTypeSelect) {
            discountTypeSelect.addEventListener('input', () => clearDiscountError('discountType'));
        }

        if (discountProofInput) {
            discountProofInput.addEventListener('change', function(e) {
                clearDiscountError('discountProof');
                const file = e.target.files?.[0];
                updateDiscountPreview(file);
            });
        }

        const removeDiscountPreviewBtn = document.getElementById('removeDiscountPreview');
        if (removeDiscountPreviewBtn) {
            removeDiscountPreviewBtn.addEventListener('click', function() {
                if (discountProofInput) discountProofInput.value = '';
                updateDiscountPreview(null);
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
