// Settings Management for Admin Dashboard
// Handles payment method settings (GCash enable/disable)

(function() {
    'use strict';

    const SETTINGS_COLLECTION = 'settings';
    const PAYMENT_METHODS_DOC_ID = 'paymentMethods';
    let settingsUnsubscribe = null;

    // Initialize settings page
    async function initSettings() {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }

        // Load current GCash setting
        await loadGCashSetting();

        // Load QR code
        await loadQRCode();

        // Subscribe to real-time updates
        subscribeToPaymentSettings();

        // Setup toggle event listener
        const toggle = document.getElementById('gcashEnabledToggle');
        if (toggle) {
            toggle.addEventListener('change', handleGCashToggleChange);
        }
    }

    // Load current GCash setting from Firestore
    async function loadGCashSetting() {
        try {
            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                console.error('Firebase not ready');
                return;
            }

            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await fns.getDoc(settingsRef);

            const toggle = document.getElementById('gcashEnabledToggle');
            const statusBadge = document.getElementById('gcashStatusBadge');
            const statusText = document.getElementById('gcashStatusText');
            const lastUpdated = document.getElementById('gcashLastUpdated');
            const meta = document.getElementById('gcashMeta');

            if (settingsSnap.exists()) {
                const data = settingsSnap.data();
                const gcashEnabled = data.gcash && data.gcash.enabled !== false; // Default to true if not set

                // Update toggle
                if (toggle) {
                    toggle.checked = gcashEnabled;
                }

                // Update status badge
                if (statusBadge && statusText) {
                    if (gcashEnabled) {
                        statusBadge.className = 'status-badge status-active';
                        statusText.textContent = 'Active';
                    } else {
                        statusBadge.className = 'status-badge status-inactive';
                        statusText.textContent = 'Temporarily Unavailable';
                    }
                }

                // Update last updated time
                if (data.gcash && data.gcash.updatedAt) {
                    const updatedDate = data.gcash.updatedAt.toDate ? data.gcash.updatedAt.toDate() : new Date(data.gcash.updatedAt);
                    if (lastUpdated) {
                        lastUpdated.textContent = updatedDate.toLocaleString();
                    }
                    if (meta) {
                        meta.style.display = 'block';
                    }
                }
            } else {
                // Default: GCash is enabled
                if (toggle) {
                    toggle.checked = true;
                }
                if (statusBadge && statusText) {
                    statusBadge.className = 'status-badge status-active';
                    statusText.textContent = 'Active';
                }
            }
        } catch (error) {
            console.error('Error loading GCash setting:', error);
            showNotification('Failed to load payment settings', 'error');
        }
    }

    // Handle GCash toggle change
    async function handleGCashToggleChange(event) {
        const enabled = event.target.checked;
        const toggle = event.target;

        // Disable toggle while saving
        toggle.disabled = true;

        try {
            await updateGCashSetting(enabled);
            showNotification(
                enabled ? 'GCash payment has been enabled' : 'GCash payment has been disabled',
                'success'
            );
        } catch (error) {
            console.error('Error updating GCash setting:', error);
            showNotification('Failed to update payment setting', 'error');
            // Revert toggle on error
            toggle.checked = !enabled;
        } finally {
            toggle.disabled = false;
        }
    }

    // Update GCash setting in Firestore
    async function updateGCashSetting(enabled) {
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firebase not ready');
        }

        // Get current staff session for updatedBy
        let updatedBy = 'System';
        try {
            const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
            if (session) {
                const staffSession = JSON.parse(session);
                updatedBy = staffSession.staffId || staffSession.email || 'Unknown';
            }
        } catch (e) {
            console.warn('Could not get staff session:', e);
        }

        const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
        const settingsSnap = await fns.getDoc(settingsRef);

        const updateData = {
            gcash: {
                enabled: enabled,
                updatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date(),
                updatedBy: updatedBy
            },
            updatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date()
        };

        if (settingsSnap.exists()) {
            // Update existing document
            await fns.updateDoc(settingsRef, updateData);
        } else {
            // Create new document
            await fns.setDoc(settingsRef, {
                ...updateData,
                createdAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date()
            });
        }
    }

    // Get GCash enabled status (for use in other scripts)
    async function getGCashEnabled() {
        try {
            if (!isFirestoreReady()) {
                await waitForFirebaseReady();
            }

            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                return true; // Default to enabled if can't check
            }

            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await fns.getDoc(settingsRef);

            if (settingsSnap.exists()) {
                const data = settingsSnap.data();
                return data.gcash && data.gcash.enabled !== false;
            }

            return true; // Default to enabled
        } catch (error) {
            console.error('Error getting GCash enabled status:', error);
            return true; // Default to enabled on error
        }
    }

    // Load QR code from Firestore
    async function loadQRCode() {
        try {
            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                console.error('Firebase not ready');
                return;
            }

            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await fns.getDoc(settingsRef);

            const previewContainer = document.getElementById('qrCodePreviewContainer');
            const previewImg = document.getElementById('qrCodePreview');
            const uploadBtnText = document.getElementById('qrCodeUploadBtnText');
            const storeNameEl = document.getElementById('gcashStoreName');
            const storeNumEl = document.getElementById('gcashStoreNum');

            if (settingsSnap.exists()) {
                const data = settingsSnap.data();
                const gcash = data.gcash || {};
                const qrCodeUrl = gcash.qrCodeUrl;

                if (storeNameEl) storeNameEl.value = gcash.storeName || '';
                if (storeNumEl) storeNumEl.value = gcash.storeNum || '';

                if (qrCodeUrl) {
                    if (previewContainer) {
                        previewContainer.style.display = 'block';
                    }
                    if (previewImg) {
                        previewImg.src = qrCodeUrl;
                    }
                    if (uploadBtnText) {
                        uploadBtnText.textContent = 'Change QR Code';
                    }
                } else {
                    if (previewContainer) {
                        previewContainer.style.display = 'none';
                    }
                    if (uploadBtnText) {
                        uploadBtnText.textContent = 'Upload QR Code';
                    }
                }
            } else {
                if (previewContainer) {
                    previewContainer.style.display = 'none';
                }
                if (uploadBtnText) {
                    uploadBtnText.textContent = 'Upload QR Code';
                }
                if (storeNameEl) storeNameEl.value = '';
                if (storeNumEl) storeNumEl.value = '';
            }
        } catch (error) {
            console.error('Error loading QR code:', error);
        }
    }

    // Handle QR code upload
    async function handleQRCodeUpload(event) {
        const file = event.target.files[0];
        if (!file) {
            return;
        }

        // Validate file type
        if (!file.type.startsWith('image/')) {
            const errorEl = document.getElementById('qrCodeUploadError');
            if (errorEl) {
                errorEl.textContent = 'Please select an image file';
                errorEl.style.display = 'block';
            }
            event.target.value = ''; // Reset input
            return;
        }

        // Validate file size (max 5MB)
        if (file.size > 5 * 1024 * 1024) {
            const errorEl = document.getElementById('qrCodeUploadError');
            if (errorEl) {
                errorEl.textContent = 'File size must be less than 5MB';
                errorEl.style.display = 'block';
            }
            event.target.value = ''; // Reset input
            return;
        }

        const errorEl = document.getElementById('qrCodeUploadError');
        if (errorEl) {
            errorEl.style.display = 'none';
        }

        const uploadBtn = event.target.closest('.qr-code-upload')?.querySelector('button');
        const originalBtnText = uploadBtn?.textContent || 'Upload QR Code';

        try {
            // Disable upload button
            if (uploadBtn) {
                uploadBtn.disabled = true;
                uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
            }

            // Upload to Firebase Storage
            const qrCodeUrl = await uploadQRCodeToStorage(file);

            // Save URL to Firestore
            await saveQRCodeUrl(qrCodeUrl);

            // Update UI
            await loadQRCode();

            showNotification('QR code uploaded successfully', 'success');
        } catch (error) {
            console.error('Error uploading QR code:', error);
            showNotification('Failed to upload QR code: ' + (error.message || 'Unknown error'), 'error');
            if (errorEl) {
                errorEl.textContent = error.message || 'Upload failed. Please try again.';
                errorEl.style.display = 'block';
            }
        } finally {
            // Re-enable upload button
            if (uploadBtn) {
                uploadBtn.disabled = false;
                uploadBtn.innerHTML = `<i class="fas fa-upload"></i> ${originalBtnText}`;
            }
            event.target.value = ''; // Reset input
        }
    }

    // Upload QR code to Firebase Storage
    async function uploadQRCodeToStorage(file) {
        if (!isStorageReady()) {
            await waitForFirebaseReady();
            if (!isStorageReady()) {
                throw new Error('Firebase Storage is not initialized. Please refresh the page.');
            }
        }

        const { ref, uploadBytes, getDownloadURL } = window.storageFunctions;
        const storage = window.storage;

        if (!storage || !ref || !uploadBytes || !getDownloadURL) {
            throw new Error('Firebase Storage functions are not available');
        }

        // Generate unique filename
        const timestamp = Date.now();
        const fileExtension = file.name.split('.').pop() || 'png';
        const fileName = `gcash_qr_${timestamp}.${fileExtension}`;
        const storagePath = `paymentSettings/${fileName}`;

        // Create storage reference
        const qrCodeRef = ref(storage, storagePath);

        // Upload file to Firebase Storage
        await uploadBytes(qrCodeRef, file);

        // Get download URL
        const downloadURL = await getDownloadURL(qrCodeRef);

        return downloadURL;
    }

    // Check if Storage is ready
    function isStorageReady() {
        return Boolean(window.storage && window.storageFunctions);
    }

    // Save QR code URL to Firestore (also saves current storeName and storeNum from form)
    async function saveQRCodeUrl(qrCodeUrl) {
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firebase not ready');
        }

        const storeName = (document.getElementById('gcashStoreName')?.value || '').trim() || null;
        const storeNum = (document.getElementById('gcashStoreNum')?.value || '').trim() || null;

        // Get current staff session for updatedBy
        let updatedBy = 'System';
        try {
            const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
            if (session) {
                const staffSession = JSON.parse(session);
                updatedBy = staffSession.staffId || staffSession.email || 'Unknown';
            }
        } catch (e) {
            console.warn('Could not get staff session:', e);
        }

        const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
        const settingsSnap = await fns.getDoc(settingsRef);

        if (settingsSnap.exists()) {
            const existingData = settingsSnap.data();
            const existingGCash = existingData.gcash || {};
            await fns.updateDoc(settingsRef, {
                gcash: {
                    ...existingGCash,
                    qrCodeUrl: qrCodeUrl,
                    qrCodeUpdatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date(),
                    qrCodeUpdatedBy: updatedBy,
                    storeName: storeName !== null ? storeName : (existingGCash.storeName || null),
                    storeNum: storeNum !== null ? storeNum : (existingGCash.storeNum || null)
                },
                updatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date()
            });
        } else {
            await fns.setDoc(settingsRef, {
                gcash: {
                    enabled: true,
                    qrCodeUrl: qrCodeUrl,
                    qrCodeUpdatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date(),
                    qrCodeUpdatedBy: updatedBy,
                    storeName: storeName,
                    storeNum: storeNum
                },
                createdAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date(),
                updatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date()
            });
        }
    }

    // Save store name and store number to Firestore (gcash.storeName, gcash.storeNum)
    async function saveGCashStoreDetails() {
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            showNotification('Firebase not ready', 'error');
            return;
        }

        const storeName = (document.getElementById('gcashStoreName')?.value || '').trim() || null;
        const storeNum = (document.getElementById('gcashStoreNum')?.value || '').trim() || null;
        const statusEl = document.getElementById('gcashDetailsSaveStatus');
        const btn = document.getElementById('gcashDetailsSaveBtn');

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        }
        if (statusEl) {
            statusEl.style.display = 'none';
        }

        try {
            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await fns.getDoc(settingsRef);
            const existingGCash = (settingsSnap.exists() && settingsSnap.data().gcash) ? settingsSnap.data().gcash : {};

            if (settingsSnap.exists()) {
                await fns.updateDoc(settingsRef, {
                    gcash: {
                        ...existingGCash,
                        storeName: storeName,
                        storeNum: storeNum
                    },
                    updatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date()
                });
            } else {
                await fns.setDoc(settingsRef, {
                    gcash: { ...existingGCash, storeName: storeName, storeNum: storeNum, enabled: true },
                    createdAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date(),
                    updatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date()
                });
            }

            showNotification('Account name and number saved', 'success');
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.color = '#28a745';
                statusEl.textContent = 'Saved.';
                setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
            }
        } catch (e) {
            console.error('Error saving GCash store details:', e);
            showNotification('Failed to save: ' + (e.message || 'Unknown error'), 'error');
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.color = '#dc3545';
                statusEl.textContent = e.message || 'Save failed.';
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-save"></i> Save';
            }
        }
    }

    // Remove QR code
    async function removeQRCode() {
        if (!confirm('Are you sure you want to remove the GCash QR code? Customers will no longer see it during checkout.')) {
            return;
        }

        try {
            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                throw new Error('Firebase not ready');
            }

            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await fns.getDoc(settingsRef);

            if (settingsSnap.exists()) {
                const existingData = settingsSnap.data();
                const existingGCash = existingData.gcash || {};
                const updateData = {
                    gcash: {
                        ...existingGCash,
                        qrCodeUrl: null,
                        qrCodeUpdatedAt: null,
                        qrCodeUpdatedBy: null
                    },
                    updatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date()
                };

                await fns.updateDoc(settingsRef, updateData);
            }

            // Update UI
            await loadQRCode();
            showNotification('QR code removed successfully', 'success');
        } catch (error) {
            console.error('Error removing QR code:', error);
            showNotification('Failed to remove QR code: ' + (error.message || 'Unknown error'), 'error');
        }
    }

    // Get QR code URL (for use in other scripts)
    async function getGCashQRCodeUrl() {
        try {
            if (!isFirestoreReady()) {
                await waitForFirebaseReady();
            }

            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                return null;
            }

            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await fns.getDoc(settingsRef);

            if (settingsSnap.exists()) {
                const data = settingsSnap.data();
                return data.gcash && data.gcash.qrCodeUrl ? data.gcash.qrCodeUrl : null;
            }

            return null;
        } catch (error) {
            console.error('Error getting GCash QR code URL:', error);
            return null;
        }
    }

    // Get store/account name (for use in customer-facing checkout, etc.)
    async function getGCashStoreName() {
        try {
            if (!isFirestoreReady()) {
                await waitForFirebaseReady();
            }
            const fns = window.firestoreFunctions;
            if (!fns || !window.db) return null;
            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const snap = await fns.getDoc(settingsRef);
            if (snap.exists() && snap.data().gcash && snap.data().gcash.storeName) {
                return snap.data().gcash.storeName;
            }
            return null;
        } catch (e) {
            console.error('Error getting GCash store name:', e);
            return null;
        }
    }

    // Get store/account number (for use in customer-facing checkout, etc.)
    async function getGCashStoreNum() {
        try {
            if (!isFirestoreReady()) {
                await waitForFirebaseReady();
            }
            const fns = window.firestoreFunctions;
            if (!fns || !window.db) return null;
            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const snap = await fns.getDoc(settingsRef);
            if (snap.exists() && snap.data().gcash && snap.data().gcash.storeNum) {
                return snap.data().gcash.storeNum;
            }
            return null;
        } catch (e) {
            console.error('Error getting GCash store number:', e);
            return null;
        }
    }

    // Update subscription to also handle QR code updates
    function subscribeToPaymentSettings() {
        if (!isFirestoreReady()) {
            waitForFirebaseReady().then(() => subscribeToPaymentSettings());
            return;
        }

        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            return;
        }

        // Unsubscribe from previous listener if exists
        if (settingsUnsubscribe && typeof settingsUnsubscribe === 'function') {
            settingsUnsubscribe();
        }

        const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);

        if (typeof fns.onSnapshot === 'function') {
            settingsUnsubscribe = fns.onSnapshot(
                settingsRef,
                (snapshot) => {
                    if (snapshot.exists()) {
                        const data = snapshot.data();
                        const gcashEnabled = data.gcash && data.gcash.enabled !== false;

                        const toggle = document.getElementById('gcashEnabledToggle');
                        const statusBadge = document.getElementById('gcashStatusBadge');
                        const statusText = document.getElementById('gcashStatusText');
                        const lastUpdated = document.getElementById('gcashLastUpdated');
                        const meta = document.getElementById('gcashMeta');

                        // Update UI without triggering change event
                        if (toggle && toggle.checked !== gcashEnabled) {
                            toggle.checked = gcashEnabled;
                        }

                        if (statusBadge && statusText) {
                            if (gcashEnabled) {
                                statusBadge.className = 'status-badge status-active';
                                statusText.textContent = 'Active';
                            } else {
                                statusBadge.className = 'status-badge status-inactive';
                                statusText.textContent = 'Temporarily Unavailable';
                            }
                        }

                        if (data.gcash && data.gcash.updatedAt) {
                            const updatedDate = data.gcash.updatedAt.toDate ? data.gcash.updatedAt.toDate() : new Date(data.gcash.updatedAt);
                            if (lastUpdated) {
                                lastUpdated.textContent = updatedDate.toLocaleString();
                            }
                            if (meta) {
                                meta.style.display = 'block';
                            }
                        }

                        // Update QR code display
                        const qrCodeUrl = data.gcash && data.gcash.qrCodeUrl;
                        const previewContainer = document.getElementById('qrCodePreviewContainer');
                        const previewImg = document.getElementById('qrCodePreview');
                        const uploadBtnText = document.getElementById('qrCodeUploadBtnText');
                        const storeNameEl = document.getElementById('gcashStoreName');
                        const storeNumEl = document.getElementById('gcashStoreNum');

                        if (storeNameEl) storeNameEl.value = (data.gcash && data.gcash.storeName) || '';
                        if (storeNumEl) storeNumEl.value = (data.gcash && data.gcash.storeNum) || '';

                        if (qrCodeUrl) {
                            if (previewContainer) {
                                previewContainer.style.display = 'block';
                            }
                            if (previewImg) {
                                previewImg.src = qrCodeUrl;
                            }
                            if (uploadBtnText) {
                                uploadBtnText.textContent = 'Change QR Code';
                            }
                        } else {
                            if (previewContainer) {
                                previewContainer.style.display = 'none';
                            }
                            if (uploadBtnText) {
                                uploadBtnText.textContent = 'Upload QR Code';
                            }
                        }
                    }
                },
                (error) => {
                    console.error('Error subscribing to payment settings:', error);
                }
            );
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSettings);
    } else {
        initSettings();
    }

    // Expose functions globally
    window.getGCashEnabled = getGCashEnabled;
    window.getGCashQRCodeUrl = getGCashQRCodeUrl;
    window.getGCashStoreName = getGCashStoreName;
    window.getGCashStoreNum = getGCashStoreNum;
    window.handleQRCodeUpload = handleQRCodeUpload;
    window.removeQRCode = removeQRCode;
    window.saveGCashStoreDetails = saveGCashStoreDetails;
    window.settingsModule = {
        getGCashEnabled: getGCashEnabled,
        updateGCashSetting: updateGCashSetting,
        getGCashQRCodeUrl: getGCashQRCodeUrl,
        getGCashStoreName: getGCashStoreName,
        getGCashStoreNum: getGCashStoreNum
    };
})();

