// Settings Management for Admin Dashboard
// Handles payment method settings (GCash enable/disable)

(function() {
    'use strict';

    const SETTINGS_COLLECTION = 'settings';
    const PAYMENT_METHODS_DOC_ID = 'paymentMethods';
    const TERMS_AND_CONDITIONS_DOC_ID = 'termsAndConditions';
    let settingsUnsubscribe = null;
    let termsUnsubscribe = null;

    // Initialize settings page
    async function initSettings() {
        if (!isFirestoreReady()) {
            await waitForFirebaseReady();
        }

        // Load current GCash setting
        await loadGCashSetting();

        // Load QR code
        await loadQRCode();

        // Load Terms and Conditions
        await loadTermsAndConditions();

        // Subscribe to real-time updates
        subscribeToPaymentSettings();
        subscribeToTermsAndConditions();

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

        // Log admin activity for GCash enable/disable
        if (typeof logAdminActivity === 'function') {
            const staffCtx = getCurrentStaffContext ? getCurrentStaffContext() : null;
            const staffLabel = staffCtx?.name || updatedBy || 'Admin';
            logAdminActivity({
                action: enabled ? 'payment_gcash_enable' : 'payment_gcash_disable',
                entityType: 'payment_settings',
                entityId: 'gcash',
                entityName: 'GCash Payment',
                description: `GCash payment was ${enabled ? 'enabled' : 'disabled'} by ${staffLabel}.`,
                metadata: {
                    enabled,
                    updatedBy
                }
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

        // Log admin activity for QR code upload/update
        if (typeof logAdminActivity === 'function') {
            const ctx = getCurrentStaffContext ? getCurrentStaffContext() : null;
            const staffLabel = ctx?.name || updatedBy || 'Admin';
            logAdminActivity({
                action: 'payment_gcash_qr_update',
                entityType: 'payment_settings',
                entityId: 'gcash',
                entityName: 'GCash QR Code',
                description: `GCash QR code was updated by ${staffLabel}.`,
                metadata: {
                    storeName,
                    storeNum
                }
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

            // Log admin activity for account/store details change
            if (typeof logAdminActivity === 'function') {
                const ctx = getCurrentStaffContext ? getCurrentStaffContext() : null;
                const staffLabel = ctx?.name || 'Admin';
                logAdminActivity({
                    action: 'payment_gcash_account_update',
                    entityType: 'payment_settings',
                    entityId: 'gcash',
                    entityName: 'GCash Account Details',
                    description: `GCash account details were updated by ${staffLabel}.`,
                    metadata: {
                        storeName,
                        storeNum
                    }
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

            // Log admin activity for QR code removal
            if (typeof logAdminActivity === 'function') {
                const ctx = getCurrentStaffContext ? getCurrentStaffContext() : null;
                const staffLabel = ctx?.name || 'Admin';
                logAdminActivity({
                    action: 'payment_gcash_qr_remove',
                    entityType: 'payment_settings',
                    entityId: 'gcash',
                    entityName: 'GCash QR Code',
                    description: `GCash QR code was removed by ${staffLabel}.`,
                    metadata: {}
                });
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

    // ==================== TERMS AND CONDITIONS ====================

    // Load Terms and Conditions from Firestore
    async function loadTermsAndConditions() {
        try {
            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                console.error('Firebase not ready');
                return;
            }

            const termsRef = fns.doc(window.db, SETTINGS_COLLECTION, TERMS_AND_CONDITIONS_DOC_ID);
            const termsSnap = await fns.getDoc(termsRef);

            const statusBadge = document.getElementById('termsStatusBadge');
            const statusText = document.getElementById('termsStatusText');
            const currentVersion = document.getElementById('termsCurrentVersion');
            const lastUpdated = document.getElementById('termsLastUpdated');
            const uploadedBy = document.getElementById('termsUploadedBy');
            const meta = document.getElementById('termsMeta');
            const previewContainer = document.getElementById('termsPreviewContainer');
            const downloadLink = document.getElementById('termsDownloadLink');
            const fileName = document.getElementById('termsFileName');
            const uploadBtnText = document.getElementById('termsUploadBtnText');
            const versionsList = document.getElementById('termsVersionsList');
            const versionsContainer = document.getElementById('termsVersionsContainer');

            if (termsSnap.exists()) {
                const data = termsSnap.data();
                const versions = data.versions || [];
                const currentVersionData = versions.length > 0 ? versions[versions.length - 1] : null;

                if (currentVersionData) {
                    // Update status badge
                    if (statusBadge && statusText) {
                        statusBadge.className = 'status-badge status-active';
                        statusText.textContent = 'Active';
                    }

                    // Update version info
                    if (currentVersion) {
                        currentVersion.textContent = `v${currentVersionData.version}`;
                    }

                    // Update last updated
                    if (currentVersionData.uploadedAt) {
                        const uploadDate = currentVersionData.uploadedAt.toDate ? 
                            currentVersionData.uploadedAt.toDate() : 
                            new Date(currentVersionData.uploadedAt);
                        if (lastUpdated) {
                            lastUpdated.textContent = uploadDate.toLocaleString();
                        }
                    }

                    // Update uploaded by
                    if (uploadedBy) {
                        uploadedBy.textContent = currentVersionData.uploadedBy || 'Unknown';
                    }

                    // Show meta
                    if (meta) {
                        meta.style.display = 'block';
                    }

                    // Show preview
                    if (previewContainer) {
                        previewContainer.style.display = 'block';
                    }

                    // Update download link
                    if (downloadLink && currentVersionData.downloadUrl) {
                        downloadLink.href = currentVersionData.downloadUrl;
                    }

                    // Update file name
                    if (fileName) {
                        fileName.textContent = currentVersionData.fileName || 'terms.pdf';
                    }

                    // Update upload button text
                    if (uploadBtnText) {
                        uploadBtnText.textContent = 'Upload New Version';
                    }
                } else {
                    // No versions yet
                    if (statusBadge && statusText) {
                        statusBadge.className = 'status-badge status-inactive';
                        statusText.textContent = 'Not Uploaded';
                    }
                    if (previewContainer) {
                        previewContainer.style.display = 'none';
                    }
                    if (uploadBtnText) {
                        uploadBtnText.textContent = 'Upload Terms';
                    }
                }

                // Display version history
                if (versions.length > 0 && versionsContainer) {
                    versionsContainer.innerHTML = '';
                    // Display in reverse order (newest first)
                    [...versions].reverse().forEach((version, index) => {
                        const versionDiv = document.createElement('div');
                        versionDiv.style.cssText = 'padding: 8px; margin-bottom: 6px; background: #fff; border-radius: 4px; border: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center;';
                        
                        const uploadDate = version.uploadedAt?.toDate ? 
                            version.uploadedAt.toDate() : 
                            new Date(version.uploadedAt || Date.now());
                        
                        const isCurrent = index === 0; // First in reversed array is current
                        
                        versionDiv.innerHTML = `
                            <div style="flex: 1;">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <i class="fas fa-file-pdf" style="color: #dc3545;"></i>
                                    <span style="font-weight: ${isCurrent ? '600' : '400'}; color: ${isCurrent ? '#007bff' : '#333'};">
                                        Version ${version.version} ${isCurrent ? '(Current)' : ''}
                                    </span>
                                </div>
                                <small style="color: #666; display: block; margin-top: 4px;">
                                    <i class="fas fa-clock"></i> ${uploadDate.toLocaleString()} | 
                                    <i class="fas fa-user"></i> ${version.uploadedBy || 'Unknown'}
                                </small>
                            </div>
                            <a href="${version.downloadUrl}" target="_blank" class="btn btn-sm btn-secondary" style="text-decoration: none; padding: 4px 8px;">
                                <i class="fas fa-download"></i> Download
                            </a>
                        `;
                        versionsContainer.appendChild(versionDiv);
                    });
                    
                    if (versionsList) {
                        versionsList.style.display = 'block';
                    }
                } else {
                    if (versionsList) {
                        versionsList.style.display = 'none';
                    }
                }
            } else {
                // No terms uploaded yet
                if (statusBadge && statusText) {
                    statusBadge.className = 'status-badge status-inactive';
                    statusText.textContent = 'Not Uploaded';
                }
                if (previewContainer) {
                    previewContainer.style.display = 'none';
                }
                if (meta) {
                    meta.style.display = 'none';
                }
                if (uploadBtnText) {
                    uploadBtnText.textContent = 'Upload Terms';
                }
                if (versionsList) {
                    versionsList.style.display = 'none';
                }
            }
        } catch (error) {
            console.error('Error loading Terms and Conditions:', error);
            showNotification('Failed to load Terms and Conditions', 'error');
        }
    }

    // Handle Terms and Conditions upload
    async function handleTermsUpload(event) {
        const file = event.target.files[0];
        if (!file) {
            return;
        }

        // Validate file type
        if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
            const errorEl = document.getElementById('termsUploadError');
            if (errorEl) {
                errorEl.textContent = 'Please select a PDF file';
                errorEl.style.display = 'block';
            }
            event.target.value = ''; // Reset input
            return;
        }

        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
            const errorEl = document.getElementById('termsUploadError');
            if (errorEl) {
                errorEl.textContent = 'File size must be less than 10MB';
                errorEl.style.display = 'block';
            }
            event.target.value = ''; // Reset input
            return;
        }

        const errorEl = document.getElementById('termsUploadError');
        if (errorEl) {
            errorEl.style.display = 'none';
        }

        const uploadBtn = event.target.closest('.terms-upload')?.querySelector('button');
        const originalBtnText = uploadBtn?.textContent || 'Upload Terms';
        const progressContainer = document.getElementById('termsUploadProgress');
        const progressBar = document.getElementById('termsUploadProgressBar');
        const progressStatus = document.getElementById('termsUploadStatus');

        try {
            // Disable upload button
            if (uploadBtn) {
                uploadBtn.disabled = true;
                uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
            }

            // Show progress
            if (progressContainer) {
                progressContainer.style.display = 'block';
            }
            if (progressBar) progressBar.style.width = '0%';
            if (progressStatus) progressStatus.textContent = 'Preparing upload...';

            // Get current version number
            const nextVersion = await getNextTermsVersion();

            // Upload to Firebase Storage
            if (progressBar) progressBar.style.width = '30%';
            if (progressStatus) progressStatus.textContent = 'Uploading PDF to storage...';
            
            const downloadUrl = await uploadTermsToStorage(file, nextVersion);

            // Save to Firestore with versioning
            if (progressBar) progressBar.style.width = '70%';
            if (progressStatus) progressStatus.textContent = 'Saving version information...';
            
            await saveTermsVersion(downloadUrl, file.name, nextVersion);

            // Update UI
            if (progressBar) progressBar.style.width = '100%';
            if (progressStatus) progressStatus.textContent = 'Complete!';
            
            await loadTermsAndConditions();

            showNotification(`Terms and Conditions v${nextVersion} uploaded successfully`, 'success');
        } catch (error) {
            console.error('Error uploading Terms and Conditions:', error);
            showNotification('Failed to upload Terms and Conditions: ' + (error.message || 'Unknown error'), 'error');
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
            // Hide progress after delay
            setTimeout(() => {
                if (progressContainer) {
                    progressContainer.style.display = 'none';
                }
            }, 2000);
            event.target.value = ''; // Reset input
        }
    }

    // Get next version number for Terms and Conditions
    async function getNextTermsVersion() {
        try {
            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                return 1; // Start with version 1
            }

            const termsRef = fns.doc(window.db, SETTINGS_COLLECTION, TERMS_AND_CONDITIONS_DOC_ID);
            const termsSnap = await fns.getDoc(termsRef);

            if (termsSnap.exists()) {
                const data = termsSnap.data();
                const versions = data.versions || [];
                if (versions.length > 0) {
                    // Get the highest version number and increment
                    const maxVersion = Math.max(...versions.map(v => v.version || 0));
                    return maxVersion + 1;
                }
            }

            return 1; // First version
        } catch (error) {
            console.error('Error getting next version:', error);
            return 1; // Default to version 1 on error
        }
    }

    // Upload Terms PDF to Firebase Storage
    async function uploadTermsToStorage(file, version) {
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

        // Generate filename with version: terms_v1.pdf, terms_v2.pdf, etc.
        const timestamp = Date.now();
        const fileName = `terms_v${version}_${timestamp}.pdf`;
        const storagePath = `termsAndConditions/${fileName}`;

        // Create storage reference
        const termsRef = ref(storage, storagePath);

        // Upload file to Firebase Storage
        await uploadBytes(termsRef, file);

        // Get download URL
        const downloadURL = await getDownloadURL(termsRef);

        return downloadURL;
    }

    // Save Terms version information to Firestore
    async function saveTermsVersion(downloadUrl, fileName, version) {
        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            throw new Error('Firebase not ready');
        }

        // Get current staff session for uploadedBy
        let uploadedBy = 'System';
        try {
            const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
            if (session) {
                const staffSession = JSON.parse(session);
                uploadedBy = staffSession.staffId || staffSession.email || 
                    (staffSession.firstName && staffSession.lastName ? 
                        `${staffSession.firstName} ${staffSession.lastName}` : 'Unknown');
            }
        } catch (e) {
            console.warn('Could not get staff session:', e);
        }

        const termsRef = fns.doc(window.db, SETTINGS_COLLECTION, TERMS_AND_CONDITIONS_DOC_ID);
        const termsSnap = await fns.getDoc(termsRef);

        // Use regular Date() for array elements (serverTimestamp() cannot be used inside arrays)
        const newVersion = {
            version: version,
            downloadUrl: downloadUrl,
            fileName: fileName,
            uploadedAt: new Date(), // Use Date() instead of serverTimestamp() for array elements
            uploadedBy: uploadedBy
        };

        if (termsSnap.exists()) {
            const existingData = termsSnap.data();
            const existingVersions = existingData.versions || [];
            
            // Add new version to array (never delete old versions)
            await fns.updateDoc(termsRef, {
                versions: [...existingVersions, newVersion],
                currentVersion: version,
                currentVersionUrl: downloadUrl,
                updatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date()
            });
        } else {
            // Create new document
            await fns.setDoc(termsRef, {
                versions: [newVersion],
                currentVersion: version,
                currentVersionUrl: downloadUrl,
                createdAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date(),
                updatedAt: fns.serverTimestamp ? fns.serverTimestamp() : new Date()
            });
        }

        // Log admin activity for Terms upload
        if (typeof logAdminActivity === 'function') {
            const ctx = getCurrentStaffContext ? getCurrentStaffContext() : null;
            const staffLabel = ctx?.name || uploadedBy || 'Admin';
            logAdminActivity({
                action: 'terms_conditions_upload',
                entityType: 'terms_and_conditions',
                entityId: `v${version}`,
                entityName: `Terms and Conditions v${version}`,
                description: `Terms and Conditions version ${version} was uploaded by ${staffLabel}.`,
                metadata: {
                    version,
                    fileName
                }
            });
        }
    }

    // Subscribe to Terms and Conditions updates
    function subscribeToTermsAndConditions() {
        if (!isFirestoreReady()) {
            waitForFirebaseReady().then(() => subscribeToTermsAndConditions());
            return;
        }

        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            return;
        }

        // Unsubscribe from previous listener if exists
        if (termsUnsubscribe && typeof termsUnsubscribe === 'function') {
            termsUnsubscribe();
        }

        const termsRef = fns.doc(window.db, SETTINGS_COLLECTION, TERMS_AND_CONDITIONS_DOC_ID);

        if (typeof fns.onSnapshot === 'function') {
            termsUnsubscribe = fns.onSnapshot(
                termsRef,
                (snapshot) => {
                    // Reload terms when data changes
                    loadTermsAndConditions();
                },
                (error) => {
                    console.error('Error subscribing to Terms and Conditions:', error);
                }
            );
        }
    }

    // Get current Terms and Conditions URL (for use in customer-facing pages)
    async function getTermsAndConditionsUrl() {
        try {
            if (!isFirestoreReady()) {
                await waitForFirebaseReady();
            }

            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                return null;
            }

            const termsRef = fns.doc(window.db, SETTINGS_COLLECTION, TERMS_AND_CONDITIONS_DOC_ID);
            const termsSnap = await fns.getDoc(termsRef);

            if (termsSnap.exists()) {
                const data = termsSnap.data();
                return data.currentVersionUrl || null;
            }

            return null;
        } catch (error) {
            console.error('Error getting Terms and Conditions URL:', error);
            return null;
        }
    }

    // Get Terms and Conditions version info (for use in customer-facing pages)
    async function getTermsAndConditionsInfo() {
        try {
            if (!isFirestoreReady()) {
                await waitForFirebaseReady();
            }

            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                return null;
            }

            const termsRef = fns.doc(window.db, SETTINGS_COLLECTION, TERMS_AND_CONDITIONS_DOC_ID);
            const termsSnap = await fns.getDoc(termsRef);

            if (termsSnap.exists()) {
                const data = termsSnap.data();
                return {
                    currentVersion: data.currentVersion || null,
                    currentVersionUrl: data.currentVersionUrl || null,
                    versions: data.versions || []
                };
            }

            return null;
        } catch (error) {
            console.error('Error getting Terms and Conditions info:', error);
            return null;
        }
    }

    // Expose functions globally
    window.getGCashEnabled = getGCashEnabled;
    window.getGCashQRCodeUrl = getGCashQRCodeUrl;
    window.getGCashStoreName = getGCashStoreName;
    window.getGCashStoreNum = getGCashStoreNum;
    window.handleQRCodeUpload = handleQRCodeUpload;
    window.removeQRCode = removeQRCode;
    window.saveGCashStoreDetails = saveGCashStoreDetails;
    window.handleTermsUpload = handleTermsUpload;
    window.getTermsAndConditionsUrl = getTermsAndConditionsUrl;
    window.getTermsAndConditionsInfo = getTermsAndConditionsInfo;
    window.settingsModule = {
        getGCashEnabled: getGCashEnabled,
        updateGCashSetting: updateGCashSetting,
        getGCashQRCodeUrl: getGCashQRCodeUrl,
        getGCashStoreName: getGCashStoreName,
        getGCashStoreNum: getGCashStoreNum,
        getTermsAndConditionsUrl: getTermsAndConditionsUrl,
        getTermsAndConditionsInfo: getTermsAndConditionsInfo
    };
})();

