// Payment Settings Checker for Customer Side
// Checks GCash availability and updates UI accordingly

(function() {
    'use strict';

    const SETTINGS_COLLECTION = 'settings';
    const PAYMENT_METHODS_DOC_ID = 'paymentMethods';
    let paymentSettingsUnsubscribe = null;

    // Initialize payment settings check
    async function initPaymentSettings() {
        if (!window.firebaseDb || !window.firestoreFunctions) {
            await window.utils.waitForFirebaseReady();
        }

        // Load initial GCash setting
        await checkGCashAvailability();

        // Load QR code
        await loadQRCode();

        // Subscribe to real-time updates
        subscribeToPaymentSettings();
    }

    // Check GCash availability and update UI
    async function checkGCashAvailability() {
        try {
            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                console.warn('Firebase not ready for payment settings check');
                return;
            }

            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await fns.getDoc(settingsRef);

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

    // Load QR code from Firestore
    async function loadQRCode() {
        try {
            const fns = window.firestoreFunctions;
            if (!fns || !window.db) {
                console.warn('Firebase not ready for QR code check');
                return;
            }

            const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);
            const settingsSnap = await fns.getDoc(settingsRef);

            const qrCodeContainer = document.getElementById('gcash-qr-code-container');
            const qrCodeImage = document.getElementById('gcash-qr-code-image');

            if (settingsSnap.exists()) {
                const data = settingsSnap.data();
                const qrCodeUrl = data.gcash && data.gcash.qrCodeUrl;

                if (qrCodeUrl && qrCodeContainer && qrCodeImage) {
                    qrCodeImage.src = qrCodeUrl;
                    qrCodeContainer.style.display = 'block';
                } else if (qrCodeContainer) {
                    qrCodeContainer.style.display = 'none';
                }
            } else if (qrCodeContainer) {
                qrCodeContainer.style.display = 'none';
            }
        } catch (error) {
            console.error('Error loading QR code:', error);
        }
    }

    // Subscribe to real-time updates for payment settings
    function subscribeToPaymentSettings() {
        if (!window.firebaseDb || !window.firestoreFunctions) {
            window.utils.waitForFirebaseReady().then(() => subscribeToPaymentSettings());
            return;
        }

        const fns = window.firestoreFunctions;
        if (!fns || !window.db) {
            return;
        }

        // Unsubscribe from previous listener if exists
        if (paymentSettingsUnsubscribe && typeof paymentSettingsUnsubscribe === 'function') {
            paymentSettingsUnsubscribe();
        }

        const settingsRef = fns.doc(window.db, SETTINGS_COLLECTION, PAYMENT_METHODS_DOC_ID);

        if (typeof fns.onSnapshot === 'function') {
            paymentSettingsUnsubscribe = fns.onSnapshot(
                settingsRef,
                (snapshot) => {
                    let gcashEnabled = true; // Default to enabled
                    let qrCodeUrl = null;

                    if (snapshot.exists()) {
                        const data = snapshot.data();
                        gcashEnabled = data.gcash && data.gcash.enabled !== false;
                        qrCodeUrl = data.gcash && data.gcash.qrCodeUrl;
                    }
                    updateGCashUI(gcashEnabled);

                    // Update QR code display
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
                    // Default to enabled on error
                    updateGCashUI(true);
                }
            );
        }
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

