// Payment Settings Checker for Customer Side
// Checks GCash availability and updates UI accordingly
// Uses window.firebaseDb and window.doc/getDoc/onSnapshot from firebase-init.js

(function() {
    'use strict';

    const SETTINGS_COLLECTION = 'settings';
    const PAYMENT_METHODS_DOC_ID = 'paymentMethods';
    let paymentSettingsUnsubscribe = null;

    // Initialize payment settings check
    async function initPaymentSettings() {
        if (window.utils && typeof window.utils.waitForFirebaseReady === 'function') {
            await window.utils.waitForFirebaseReady();
        }

        // Load initial GCash setting
        await checkGCashAvailability();

        // Load QR code
        await loadQRCode();

        // Subscribe to real-time updates (no infinite retry)
        subscribeToPaymentSettings();
    }

    // Check GCash availability and update UI
    async function checkGCashAvailability() {
        try {
            const db = window.firebaseDb;
            const docFn = window.doc;
            const getDocFn = window.getDoc;
            if (!db || !docFn || !getDocFn) {
                console.warn('Firebase not ready for payment settings check');
                updateGCashUI(true);
                return;
            }

            const settingsRef = docFn(db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await getDocFn(settingsRef);

            let gcashEnabled = true; // Default to enabled
            if (settingsSnap.exists()) {
                const data = settingsSnap.data();
                gcashEnabled = data.gcash && data.gcash.enabled !== false;
            }

            updateGCashUI(gcashEnabled);
        } catch (error) {
            console.error('Error checking GCash availability:', error);
            // Default to enabled on error
            updateGCashUI(true);
        }
    }

    // Update GCash UI based on availability
    function updateGCashUI(enabled) {
        const gcashLabel = document.getElementById('gcash-option-label');
        const gcashRadio = document.getElementById('gcash-payment-radio');
        const gcashBadge = document.getElementById('gcash-unavailable-badge');
        const gcashMessage = document.getElementById('gcash-unavailable-message');
        const gcashDetails = document.getElementById('gcash-details');

        if (!gcashLabel || !gcashRadio) {
            return; // Elements not found yet
        }

        if (enabled) {
            // GCash is enabled - show normal state
            gcashLabel.classList.remove('disabled');
            if (gcashRadio) {
                gcashRadio.disabled = false;
            }
            if (gcashBadge) {
                gcashBadge.style.display = 'none';
            }
            if (gcashMessage) {
                gcashMessage.style.display = 'none';
            }
        } else {
            // GCash is disabled - show unavailable state
            gcashLabel.classList.add('disabled');
            if (gcashRadio) {
                gcashRadio.disabled = true;
                gcashRadio.checked = false; // Uncheck if it was selected
            }
            if (gcashBadge) {
                gcashBadge.style.display = 'inline-block';
            }
            if (gcashMessage) {
                gcashMessage.style.display = 'flex';
            }
            // Hide GCash details if they were shown
            if (gcashDetails) {
                gcashDetails.classList.remove('show');
            }
            // If GCash was selected, switch to cash if available
            if (gcashRadio && gcashRadio.checked) {
                const cashRadio = document.querySelector('input[name="payment"][value="cash"]');
                if (cashRadio && !cashRadio.disabled) {
                    cashRadio.checked = true;
                }
            }
        }
    }

    // Update GCash Number and Account Name from storeNum and storeName
    function updateGCashDisplayDetails(storeNum, storeName) {
        const numEl = document.getElementById('gcash-number-value');
        const nameEl = document.getElementById('gcash-store-name-value');
        if (numEl) {
            numEl.textContent = (storeNum != null && String(storeNum).trim() !== '') ? String(storeNum).trim() : '—';
        }
        if (nameEl) {
            nameEl.textContent = (storeName != null && String(storeName).trim() !== '') ? String(storeName).trim() : '—';
        }
    }

    // Load QR code and GCash display details (storeNum, storeName) from Firestore
    async function loadQRCode() {
        try {
            const db = window.firebaseDb;
            const docFn = window.doc;
            const getDocFn = window.getDoc;
            if (!db || !docFn || !getDocFn) {
                return;
            }

            const settingsRef = docFn(db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await getDocFn(settingsRef);

            const qrCodeContainer = document.getElementById('gcash-qr-code-container');
            const qrCodeImage = document.getElementById('gcash-qr-code-image');

            if (settingsSnap.exists()) {
                const data = settingsSnap.data();
                const gcash = data.gcash || {};
                const qrCodeUrl = gcash.qrCodeUrl;
                const storeNum = gcash.storeNum;
                const storeName = gcash.storeName;

                if (qrCodeUrl && qrCodeContainer && qrCodeImage) {
                    qrCodeImage.src = qrCodeUrl;
                    qrCodeContainer.style.display = 'block';
                } else if (qrCodeContainer) {
                    qrCodeContainer.style.display = 'none';
                }

                updateGCashDisplayDetails(storeNum, storeName);
            } else {
                if (qrCodeContainer) {
                    qrCodeContainer.style.display = 'none';
                }
                updateGCashDisplayDetails(null, null);
            }
        } catch (error) {
            console.error('Error loading QR code:', error);
            updateGCashDisplayDetails(null, null);
        }
    }

    // Subscribe to real-time updates for payment settings.
    // Uses window.firebaseDb, window.doc, window.onSnapshot. No infinite retry.
    function subscribeToPaymentSettings() {
        const db = window.firebaseDb;
        const docFn = window.doc;
        const onSnapshotFn = window.onSnapshot;
        if (!db || !docFn || typeof onSnapshotFn !== 'function') {
            return;
        }

        // Unsubscribe from previous listener if exists
        if (paymentSettingsUnsubscribe && typeof paymentSettingsUnsubscribe === 'function') {
            paymentSettingsUnsubscribe();
        }

        const settingsRef = docFn(db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);

        paymentSettingsUnsubscribe = onSnapshotFn(
            settingsRef,
            (snapshot) => {
                let gcashEnabled = true;
                let qrCodeUrl = null;
                let storeNum = null;
                let storeName = null;

                if (snapshot.exists()) {
                    const data = snapshot.data();
                    const gcash = data.gcash || {};
                    gcashEnabled = gcash.enabled !== false;
                    qrCodeUrl = gcash.qrCodeUrl;
                    storeNum = gcash.storeNum;
                    storeName = gcash.storeName;
                }
                updateGCashUI(gcashEnabled);
                updateGCashDisplayDetails(storeNum, storeName);

                const qrCodeContainer = document.getElementById('gcash-qr-code-container');
                const qrCodeImage = document.getElementById('gcash-qr-code-image');

                if (qrCodeUrl && qrCodeContainer && qrCodeImage) {
                    qrCodeImage.src = qrCodeUrl;
                    qrCodeContainer.style.display = 'block';
                } else if (qrCodeContainer) {
                    qrCodeContainer.style.display = 'none';
                }
            },
            (error) => {
                console.error('Error subscribing to payment settings:', error);
                updateGCashUI(true);
            }
        );
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (paymentSettingsUnsubscribe && typeof paymentSettingsUnsubscribe === 'function') {
            paymentSettingsUnsubscribe();
        }
    });

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPaymentSettings);
    } else {
        initPaymentSettings();
    }

    // Expose function globally for manual checks if needed
    window.checkGCashAvailability = checkGCashAvailability;
})();

