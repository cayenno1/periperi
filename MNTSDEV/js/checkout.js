

(function() {
    'use strict';

    let baseSubtotal = 0;
    const DELIVERY_FEE = 50;
    const POINT_VALUE = 1; // 1 point = ₱1
    const ID_DISCOUNT_RATE = 0.20; // 20% discount for verified ID
    let currentService = 'dinein';
    let checkoutAddresses = [];
    let loyaltyEnabled = false; // only for signed-in customers
    let pointsUsedInOrder = 0; // Track points used in current order
    let userDiscountInfo = null; // Store user's discount info
    const PENDING_RECEIPT_KEY = 'ppp_pending_receipt_url';

    const PROMOS = {
        // NOTE: Update these promo codes as needed.
        // Percent promo: 10% off, capped at ₱100, min subtotal ₱250
        PABLO10: { type: 'percent', value: 0.10, max: 100, minSubtotal: 250 },
        // Fixed promo: ₱50 off, min subtotal ₱300
        WELCOME50: { type: 'fixed', value: 50, minSubtotal: 300 },
        // Free shipping for delivery
        FREESHIP: { type: 'freeship' }
    };

    let promoState = {
        code: '',
        amount: 0,
        freeShipping: false
    };
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

    // Save-address confirm modal (checkout)
    let saveAddressResolve = null;

    function openSaveAddressConfirmModal() {
        const modal = document.getElementById('saveAddressConfirmModal');
        if (!modal) return;
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
    }

    function closeSaveAddressConfirmModal() {
        const modal = document.getElementById('saveAddressConfirmModal');
        if (!modal) return;
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }

    function confirmSaveAddress() {
        // Returns Promise<boolean>
        return new Promise((resolve) => {
            saveAddressResolve = resolve;
            openSaveAddressConfirmModal();
        });
    }

    async function saveNewAddressToFirestore(authUser, addressData) {
        if (!authUser || !addressData) return null;
        await window.utils.waitForFirebaseReady();

        const db = window.firebaseDb;
        if (!db || !window.doc || !window.getDoc || !window.setDoc) return null;

        const userDocRef = window.doc(db, 'customers', authUser.uid);
        const snap = await window.getDoc(userDocRef);
        const existing = snap.exists() ? (snap.data()?.addresses || []) : [];
        const addresses = Array.isArray(existing) ? existing.slice(0) : [];

        addresses.push(addressData);

        // Clean legacy fields like account.js does
        const cleaned = addresses.map((addr) => {
            const c = { ...(addr || {}) };
            delete c.isDefault;
            delete c.is_default;
            delete c.addressId;
            return c;
        });

        await window.setDoc(userDocRef, { addresses: cleaned }, { merge: true });
        return addressData.id || null;
    }

    function updateTotalChip(displayValue) {
        const chip = document.getElementById('summaryTotalChip');
        if (chip && displayValue) {
            chip.textContent = displayValue;
        } else if (chip && !displayValue) {
            chip.textContent = '₱0.00';
        }
    }

    function parseBarangayNumber(name) {
        const raw = String(name || '');
        const match = raw.match(/(\d{1,3})/);
        if (!match) return null;
        const n = Number(match[1]);
        return Number.isFinite(n) ? n : null;
    }

    function isNorthCaloocanBarangayName(name) {
        const n = parseBarangayNumber(name);
        if (n !== null) return n >= 77;
        const upper = String(name || '').toUpperCase();
        const northHints = ['BAGONG SILANG', 'TALA', 'CAMARIN', 'DEPARO', 'LLANO'];
        return northHints.some((hint) => upper.includes(hint));
    }

    function resetNewAddressErrors() {
        ['deliveryLabelError', 'streetAddressError', 'cityError', 'deliveryBarangayError'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = '';
        });
    }

    function getSelectedCityPsgcCode() {
        const cityEl = document.getElementById('city');
        if (!cityEl) return null;
        const opt = cityEl.options?.[cityEl.selectedIndex];
        return opt?.dataset?.psgcCityCode || null;
    }

    function resetBarangaySelect() {
        const barangayEl = document.getElementById('deliveryBarangay');
        const listEl = document.getElementById('deliveryBarangayList');
        if (!barangayEl) return;
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
                const res = await fetch(url, { headers: { Accept: 'application/json' } });
                if (!res.ok) {
                    lastError = new Error(`[${source.name}] PSGC request failed (${res.status})`);
                    continue;
                }
                const json = await res.json();
                const list = Array.isArray(json)
                    ? json
                    : Array.isArray(json?.data)
                    ? json.data
                    : Array.isArray(json?.barangays)
                    ? json.barangays
                    : [];
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
        const cityEl = document.getElementById('city');
        const barangayEl = document.getElementById('deliveryBarangay');
        const listEl = document.getElementById('deliveryBarangayList');
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

            if (listEl) {
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
            }
        } catch (error) {
            console.warn('[PSGC] Failed to load barangays:', error);
            if (listEl) listEl.innerHTML = '';
            barangayEl.value = '';
            barangayEl.placeholder = 'Failed to load barangays. Try again.';
            barangayEl.disabled = true;
        }
    }

    // Simple visual highlighting for missing/invalid fields on checkout
    function clearCheckoutErrors() {
        document.querySelectorAll('.checkout-error').forEach((el) => {
            el.classList.remove('checkout-error');
        });
    }

    function flagCheckoutError(el) {
        if (!el) return;
        el.classList.add('checkout-error');
    }

    function scrollToFirstCheckoutError() {
        const first = document.querySelector('.checkout-error');
        if (!first) return;
        try {
            first.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (typeof first.focus === 'function') first.focus({ preventScroll: true });
        } catch (e) {}
    }

    function normalizePromoCode(raw) {
        return String(raw || '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '');
    }

    function computePromo(base, serviceType, code) {
        const promo = PROMOS[code] || null;
        if (!promo) return { ok: false, message: 'That promo code is not valid.' };

        const subtotal = Number(base) || 0;
        if (promo.minSubtotal && subtotal < promo.minSubtotal) {
            return { ok: false, message: `Minimum subtotal is ₱${promo.minSubtotal.toFixed(2)} for this promo.` };
        }

        if (promo.type === 'freeship') {
            if (serviceType !== 'delivery') {
                return { ok: false, message: 'FREESHIP applies to delivery orders only.' };
            }
            return { ok: true, amount: 0, freeShipping: true, message: 'Free delivery applied.' };
        }

        if (promo.type === 'fixed') {
            const amt = Math.max(0, Math.min(subtotal, Number(promo.value) || 0));
            return { ok: true, amount: amt, freeShipping: false, message: `Promo applied: -₱${amt.toFixed(2)}` };
        }

        if (promo.type === 'percent') {
            const pct = Number(promo.value) || 0;
            const rawAmt = subtotal * pct;
            const capped = promo.max ? Math.min(rawAmt, Number(promo.max) || rawAmt) : rawAmt;
            const amt = Math.max(0, Math.min(subtotal, capped));
            return { ok: true, amount: amt, freeShipping: false, message: `Promo applied: -₱${amt.toFixed(2)}` };
        }

        return { ok: false, message: 'This promo is not supported.' };
    }

    function togglePromoPanel() {
        const panel = document.getElementById('promoPanel');
        if (!panel) return;
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }

    function setPromoMessage(msg, variant = 'info') {
        const el = document.getElementById('promoMessage');
        if (!el) return;
        el.textContent = msg || '';
        el.style.color = variant === 'error' ? '#e53935' : (variant === 'success' ? '#2e7d32' : '#666');
    }

    function applyPromoCode() {
        if (pointsUsedInOrder > 0) {
            setPromoMessage('Promo codes can’t be applied after points. (Refresh checkout to start over.)', 'error');
            return;
        }

        const input = document.getElementById('promoCode');
        const raw = input ? input.value : '';
        const code = normalizePromoCode(raw);
        if (!code) {
            promoState = { code: '', amount: 0, freeShipping: false };
            setPromoMessage('Enter a promo code to apply.', 'info');
            initPointsSummary();
            return;
        }

        const result = computePromo(baseSubtotal, currentService, code);
        if (!result.ok) {
            promoState = { code: '', amount: 0, freeShipping: false };
            setPromoMessage(result.message || 'Promo code not valid.', 'error');
            initPointsSummary();
            return;
        }

        promoState = { code, amount: Number(result.amount) || 0, freeShipping: !!result.freeShipping };
        setPromoMessage(result.message || 'Promo applied.', 'success');
        initPointsSummary();
    }

    // Lock / unlock contact details for logged-in customers
    function setContactFieldsLocked(isLocked) {
        const nameInput = document.getElementById('contactName');
        const phoneInput = document.getElementById('contactPhone');
        const emailInput = document.getElementById('contactEmail');

        [nameInput, phoneInput, emailInput].forEach((input) => {
            if (!input) return;
            input.readOnly = !!isLocked;
            input.classList.toggle('contact-readonly', !!isLocked);
        });
    }

    function getStoredPoints() {
        try {
            const raw = localStorage.getItem('ppp_points');
            const n = parseInt(raw, 10);
            return Number.isFinite(n) && n > 0 ? n : 0;
        } catch (e) {
            return 0;
        }
    }

    function saveStoredPoints(value) {
        try {
            localStorage.setItem('ppp_points', String(Math.max(0, value || 0)));
        } catch (e) {}
    }

    function getInitialServiceType() {
        const params = new URLSearchParams(window.location.search);
        const service = (params.get('service') || '').toLowerCase();

        if (['pickup', 'delivery'].includes(service)) {
            return service;
        }

        // Default service type when not specified.
        return 'pickup';
    }

    function setServiceType(type) {
        currentService = type;

        document.querySelectorAll('.service-pill').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.service === type);
        });

        document.querySelectorAll('.service-panel').forEach(panel => {
            panel.classList.add('hidden');
        });

        const activePanel = document.getElementById(`service-${type}`);
        if (activePanel) activePanel.classList.remove('hidden');

        // Show delivery fee row only for delivery
        const deliveryRow = document.getElementById('deliveryFeeRow');
        if (deliveryRow) {
            deliveryRow.style.display = type === 'delivery' ? 'flex' : 'none';
        }

        // Show/hide cash payment option based on service type
        const cashPaymentOption = document.getElementById('cash-payment-option');
        if (cashPaymentOption) {
            if (type === 'delivery') {
                cashPaymentOption.classList.remove('hidden');
            } else {
                cashPaymentOption.classList.add('hidden');
                // Uncheck cash payment if it was selected and user switches to pickup
                const cashRadio = document.querySelector('input[name="payment"][value="cash"]');
                if (cashRadio && cashRadio.checked) {
                    cashRadio.checked = false;
                    // Auto-select GCash if cash was selected
                    const gcashRadio = document.querySelector('input[name="payment"][value="gcash"]');
                    if (gcashRadio) {
                        gcashRadio.checked = true;
                        toggleGCashDetails();
                    }
                }
            }
        }

        initPointsSummary();
    }

    function initPointsSummary() {
        const remainingEl = document.getElementById('pointsRemaining');
        const subtotalEl = document.getElementById('summarySubtotal');
        const pointsEl = document.getElementById('summaryPoints');
        const promoRow = document.getElementById('promoRow');
        const promoEl = document.getElementById('summaryPromo');
        const feeEl = document.getElementById('summaryDeliveryFee');
        const totalEl = document.getElementById('summaryTotal');
        const pointsRow = pointsEl ? pointsEl.closest('.summary-row') : null;
        const earnedRow = document.getElementById('earnedPointsRow');
        const remainingRow = remainingEl ? remainingEl.closest('.summary-row') : null;
        const applyBtn = document.querySelector('.cart-summary .apply-points-btn');
        const isLoyaltyOn = loyaltyEnabled && !!(window.firebaseAuth && window.firebaseAuth.currentUser);

        const fee = (currentService === 'delivery' && !promoState.freeShipping) ? DELIVERY_FEE : 0;

        // Check for ID verification discount (20% off)
        const isIDVerified = userDiscountInfo && userDiscountInfo.IDverification === true;
        const idDiscountAmount = isIDVerified ? baseSubtotal * ID_DISCOUNT_RATE : 0;
        const pointsDiscount = pointsUsedInOrder * POINT_VALUE;
        const promoDiscount = Math.max(0, Number(promoState.amount) || 0);
        const totalDiscount = idDiscountAmount + pointsDiscount + promoDiscount;

        if (subtotalEl) subtotalEl.textContent = `₱${baseSubtotal.toFixed(2)}`;
        if (feeEl) feeEl.textContent = `₱${fee.toFixed(2)}`;
        
        // Update points display (shows both ID discount and points if applicable)
        if (pointsEl) {
            const idAndPoints = idDiscountAmount + pointsDiscount;
            if (idAndPoints > 0) {
                pointsEl.textContent = `-₱${idAndPoints.toFixed(2)}`;
                if (pointsRow) pointsRow.style.display = 'flex';
                // Update label to show what discount is applied
                const pointsLabel = pointsRow?.querySelector('.summary-label');
                if (pointsLabel) {
                    if (isIDVerified && pointsDiscount > 0) {
                        pointsLabel.innerHTML = '<i class="fas fa-gift"></i> Discount Applied (20% ID + Points)';
                    } else if (isIDVerified) {
                        pointsLabel.innerHTML = '<i class="fas fa-gift"></i> ID Discount (20% off)';
                    } else {
                        pointsLabel.innerHTML = '<i class="fas fa-gift"></i> Points Applied';
                    }
                }
            } else {
                pointsEl.textContent = '-₱0.00';
                if (pointsRow) pointsRow.style.display = 'none';
            }
        }

        if (promoRow && promoEl) {
            if (promoState.freeShipping) {
                promoRow.style.display = 'flex';
                promoEl.textContent = '-₱0.00';
            } else if (promoDiscount > 0) {
                promoRow.style.display = 'flex';
                promoEl.textContent = `-₱${promoDiscount.toFixed(2)}`;
            } else {
                promoRow.style.display = 'none';
                promoEl.textContent = '-₱0.00';
            }
        }

        // Calculate final total
        const finalTotal = Math.max(0, baseSubtotal + fee - totalDiscount);
        const finalDisplay = `₱${finalTotal.toFixed(2)}`;
        if (totalEl) totalEl.textContent = finalDisplay;
        updateTotalChip(finalDisplay);

        if (!isLoyaltyOn) {
            if (remainingEl) remainingEl.textContent = '0';
            if (remainingRow) remainingRow.style.display = 'none';
            if (earnedRow) earnedRow.style.display = 'none';
            if (applyBtn) {
                applyBtn.style.display = 'none';
                applyBtn.disabled = true;
            }
            return;
        }

        // Loyalty-enabled UI for signed-in users
        const stored = getStoredPoints();
        if (remainingEl) remainingEl.textContent = stored;
        if (remainingRow) remainingRow.style.display = 'flex';
        if (applyBtn) {
            applyBtn.style.display = '';
            applyBtn.disabled = stored <= 0 || baseSubtotal <= 0;
        }

        updateEarnedPointsVisual();
    }

    function applyPoints() {
        if (!loyaltyEnabled || !(window.firebaseAuth && window.firebaseAuth.currentUser)) {
            if (window.showAlert) {
                window.showAlert('Sign in to use loyalty points.', 'info');
            } else {
                alert('Sign in to use loyalty points.');
            }
            return;
        }

        const remaining = getStoredPoints();
        if (!remaining) {
            if (window.showAlert) {
                window.showAlert('No points available to apply.', 'info');
            } else {
                alert('No points available to apply.');
            }
            return;
        }

        const fee = (currentService === 'delivery' && !promoState.freeShipping) ? DELIVERY_FEE : 0;
        
        // Calculate ID discount first (20% off subtotal)
        const isIDVerified = userDiscountInfo && userDiscountInfo.IDverification === true;
        const idDiscountAmount = isIDVerified ? baseSubtotal * ID_DISCOUNT_RATE : 0;
        const promoDiscount = Math.max(0, Number(promoState.amount) || 0);
        const subtotalAfterIDDiscount = Math.max(0, baseSubtotal - idDiscountAmount - promoDiscount);

        // Points can be applied to the remaining amount after ID discount
        const maxDiscount = subtotalAfterIDDiscount;
        const pointsToUse = Math.min(remaining, maxDiscount);
        const pointsDiscountAmount = pointsToUse * POINT_VALUE;
        const totalDiscount = idDiscountAmount + promoDiscount + pointsDiscountAmount;
        const newTotal = baseSubtotal + fee - totalDiscount;
        const newRemaining = remaining - pointsToUse;

        // Track points used for this order
        pointsUsedInOrder = pointsToUse;

        const pointsEl = document.getElementById('summaryPoints');
        const totalEl = document.getElementById('summaryTotal');
        const remainingEl = document.getElementById('pointsRemaining');
        const pointsRow = pointsEl ? pointsEl.closest('.summary-row') : null;

        if (pointsEl) {
            const idAndPoints = idDiscountAmount + pointsDiscountAmount;
            pointsEl.textContent = `-₱${idAndPoints.toFixed(2)}`;
            // Update label
            const pointsLabel = pointsRow?.querySelector('.summary-label');
            if (pointsLabel) {
                if (isIDVerified && pointsDiscountAmount > 0) {
                    pointsLabel.innerHTML = '<i class="fas fa-gift"></i> Discount Applied (20% ID + Points)';
                } else if (isIDVerified) {
                    pointsLabel.innerHTML = '<i class="fas fa-gift"></i> ID Discount (20% off)';
                } else {
                    pointsLabel.innerHTML = '<i class="fas fa-gift"></i> Points Applied';
                }
            }
            if (pointsRow) pointsRow.style.display = 'flex';
        }
        const newDisplay = `₱${newTotal.toFixed(2)}`;
        if (totalEl) totalEl.textContent = newDisplay;
        updateTotalChip(newDisplay);
        if (remainingEl) remainingEl.textContent = newRemaining;

        saveStoredPoints(newRemaining);

        const btn = document.querySelector('.cart-summary .apply-points-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-check"></i><span>Points Applied</span>';
        }

        updateEarnedPointsVisual();
    }

    function toggleNewAddress() {
        const addressSelect = document.getElementById('delivery-address');
        const newAddressForm = document.getElementById('new-address-form');
        
        if (addressSelect.value === 'new') {
            newAddressForm.classList.remove('hidden');
            resetNewAddressErrors();
            resetBarangaySelect();
        } else {
            newAddressForm.classList.add('hidden');
        }
    }

    async function uploadPaymentProof(file) {
        await window.utils.waitForFirebaseReady();

        const storage = window.firebaseStorage;
        const storageRef = window.storageRef;
        const uploadBytes = window.uploadBytes;
        const getDownloadURL = window.getDownloadURL;

        if (!storage || !storageRef || !uploadBytes || !getDownloadURL) {
            throw new Error('File upload is not available right now. Please try again later.');
        }

        const auth = window.firebaseAuth;
        const userId = auth && auth.currentUser ? auth.currentUser.uid : null;
        if (!userId) {
            throw new Error('Please sign in before uploading payment proof.');
        }
        const timestamp = Date.now();
        const safeName = (file.name || 'proof').replace(/[^a-zA-Z0-9._-]/g, '_');
        const fullPath = `paymentProofs/${userId}/${timestamp}-${safeName}`;

        const ref = storageRef(storage, fullPath);
        const snapshot = await uploadBytes(ref, file);
        const url = await getDownloadURL(snapshot.ref);

        return { url, path: fullPath };
    }

    async function placeOrder() {
        const btn = document.querySelector('.proceed-btn');
        // Prevent double submission if already processing
        if (btn && btn.disabled) return;

        clearCheckoutErrors();

        // Check for recomply mode
        const urlParams = new URLSearchParams(window.location.search);
        const isRecomply = urlParams.get('recomply') === 'true';
        const recomplyOrderId = localStorage.getItem('ppp_recomply_order_id');
        const recomplyOrderDataStr = localStorage.getItem('ppp_recomply_order_data');
        
        if (isRecomply && recomplyOrderId && recomplyOrderDataStr) {
            // Handle recomply - update existing order instead of creating new one
            try {
                await handleRecomply(recomplyOrderId, recomplyOrderDataStr);
                return; // Exit early after recomply
            } catch (error) {
                console.error('Recomply failed:', error);
                const errorMessage = error.message || 'Unable to recomply. Please try again.';
                if (window.showAlert) {
                    window.showAlert(errorMessage, 'error');
                } else {
                    alert(errorMessage);
                }
                // Re-enable button
                if (btn) {
                    btn.disabled = false;
                    btn.classList.remove('is-processing');
                }
                // Don't continue to normal order flow - return early
                return;
            }
        }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            if (window.showAlert) {
                window.showAlert('You appear to be offline. Please reconnect and try again.', 'warning');
            } else {
                alert('You appear to be offline. Please reconnect and try again.');
            }
            return;
        }

        const authUser = window.firebaseAuth?.currentUser || null;
        if (!authUser) {
            if (window.showAlert) {
                window.showAlert('Please sign in or create an account to place an order.', 'info');
            } else {
                alert('Please sign in or create an account to place an order.');
            }
            const file = (window.location.pathname || '').split('/').pop() || 'checkout.html';
            const redirectTarget = `${file}${window.location.search || ''}`;
            window.location.href = `login.html?reason=order&redirect=${encodeURIComponent(redirectTarget)}`;
            return;
        }

        const paymentMethod = document.querySelector('input[name="payment"]:checked')?.value;
        if (!paymentMethod) {
            flagCheckoutError(document.querySelector('.delivery-options'));
            if (window.showAlert) {
                window.showAlert('Please select a payment method.', 'warning');
            } else {
                alert('Please select a payment method.');
            }
            scrollToFirstCheckoutError();
            return;
        }

        // Check if GCash is enabled (if GCash is selected)
        if (paymentMethod === 'gcash') {
            const gcashRadio = document.getElementById('gcash-payment-radio');
            if (gcashRadio && gcashRadio.disabled) {
                if (window.showAlert) {
                    window.showAlert('GCash payment is currently unavailable. Please select another payment method.', 'warning');
                } else {
                    alert('GCash payment is currently unavailable. Please select another payment method.');
                }
                flagCheckoutError(document.querySelector('.delivery-options'));
                scrollToFirstCheckoutError();
                return;
            }
        }

        // If GCash is selected, require screenshot, account name, and reference number
        // Cash payment doesn't require any proof
        let gcashFile = null;
        let gcashAccountName = '';
        let gcashRefNo = '';
        if (paymentMethod === 'gcash') {
            const fileInput = document.getElementById('payment-proof');
            const file = fileInput && fileInput.files && fileInput.files[0];
            const accountNameInput = document.getElementById('gcash-account-name');
            const refInput = document.getElementById('gcash-ref');

            if (!file) {
                flagCheckoutError(document.querySelector('.payment-proof'));
                if (window.showAlert) {
                    window.showAlert('Please upload your GCash payment screenshot before placing your order.', 'warning');
                } else {
                    alert('Please upload your GCash payment screenshot before placing your order.');
                }
                scrollToFirstCheckoutError();
                return;
            }
            gcashFile = file;

            gcashAccountName = (accountNameInput?.value || '').trim();
            if (!gcashAccountName) {
                flagCheckoutError(accountNameInput);
                if (window.showAlert) {
                    window.showAlert('Please enter your GCash account name.', 'warning');
                } else {
                    alert('Please enter your GCash account name.');
                }
                scrollToFirstCheckoutError();
                return;
            }

            gcashRefNo = (refInput?.value || '').trim();
            if (!gcashRefNo) {
                flagCheckoutError(refInput);
                if (window.showAlert) {
                    window.showAlert('Please enter your GCash reference number.', 'warning');
                } else {
                    alert('Please enter your GCash reference number.');
                }
                scrollToFirstCheckoutError();
                return;
            }
        }
        // Cash payment doesn't require any additional validation

        // Contact details (required for all)
        const nameInput = document.getElementById('contactName');
        const phoneInput = document.getElementById('contactPhone');
        const emailInput = document.getElementById('contactEmail');
        const notesInput = document.getElementById('orderNotes');

        const fullName = (nameInput?.value || '').trim();
        const phone = (phoneInput?.value || '').trim();
        const email = (emailInput?.value || '').trim();
        const notes = (notesInput?.value || '').trim();

        let hasContactError = false;
        if (!fullName) {
            flagCheckoutError(nameInput);
            hasContactError = true;
        }
        if (!phone) {
            flagCheckoutError(phoneInput);
            hasContactError = true;
        }

        // Signed-in users: email can be sourced from auth profile; keep optional on the form.

        if (hasContactError) {
            if (window.showAlert) {
                window.showAlert('Please provide your name and mobile number.', 'warning');
            } else {
                alert('Please provide your name and mobile number.');
            }
            scrollToFirstCheckoutError();
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('is-processing');
            }
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.classList.add('is-processing');
        }
        const paymentType = paymentMethod === 'cash' ? 'Cash' : 'GCash';

        const params = new URLSearchParams();
        params.set('payment', paymentType);
        params.set('service', currentService);

        if (currentService === 'pickup') {
            const storeText = (document.getElementById('store-location')?.textContent || '').trim();
            params.set('store', storeText);
        } else if (currentService === 'delivery') {
            const addressSelect = document.getElementById('delivery-address');
            const saved = addressSelect ? addressSelect.value : '';

            let addressText = '';
            if (saved && saved !== 'new') {
                // Use a saved address from Firestore
                const addr = checkoutAddresses.find(a => (a.id || '') === saved);
                if (addr) {
                    const barangay = addr.barangay || addr.province || '';
                    const fullAddr =
                        addr.fullAddress ||
                        `${addr.street || ''}, ${addr.city || ''}, ${barangay}`.trim();
                    addressText = fullAddr;
                }
            } else {
                // Use a newly entered address (PSGC-validated)
                const labelInput = document.getElementById('deliveryLabel');
                const streetInput = document.getElementById('street-address');
                const cityInput = document.getElementById('city');
                const barangayInput = document.getElementById('deliveryBarangay');
                const barangayList = document.getElementById('deliveryBarangayList');

                resetNewAddressErrors();

                const label = (labelInput?.value || '').trim();
                const streetAddress = (streetInput?.value || '').trim();
                const city = (cityInput?.value || '').trim();
                const barangay = (barangayInput?.value || '').trim();

                let hasAddrError = false;
                const allowedCities = new Set(['Quezon City', 'Caloocan City']);
                if (!label) {
                    const el = document.getElementById('deliveryLabelError');
                    if (el) el.textContent = 'Select a label';
                    flagCheckoutError(labelInput);
                    hasAddrError = true;
                }
                if (!streetAddress) {
                    const el = document.getElementById('streetAddressError');
                    if (el) el.textContent = 'Street address is required';
                    flagCheckoutError(streetInput);
                    hasAddrError = true;
                }
                if (!city || !allowedCities.has(city)) {
                    const el = document.getElementById('cityError');
                    if (el) el.textContent = 'We deliver to Quezon City or North Caloocan only';
                    flagCheckoutError(cityInput);
                    hasAddrError = true;
                }
                if (!barangay) {
                    const el = document.getElementById('deliveryBarangayError');
                    if (el) el.textContent = 'Barangay is required';
                    flagCheckoutError(barangayInput);
                    hasAddrError = true;
                }
                if (city && barangay && barangayList) {
                    const isInList = Array.from(barangayList.options).some((opt) => opt.value === barangay);
                    if (!isInList) {
                        const el = document.getElementById('deliveryBarangayError');
                        if (el) el.textContent = 'Please pick a barangay from the list';
                        flagCheckoutError(barangayInput);
                        hasAddrError = true;
                    }
                }
                if (city === 'Caloocan City' && barangay && !isNorthCaloocanBarangayName(barangay)) {
                    const el = document.getElementById('deliveryBarangayError');
                    if (el) el.textContent = 'We only deliver to North Caloocan barangays';
                    flagCheckoutError(barangayInput);
                    hasAddrError = true;
                }

                if (hasAddrError) {
                    scrollToFirstCheckoutError();
                    if (btn) {
                        btn.disabled = false;
                        btn.classList.remove('is-processing');
                    }
                    return;
                }

                addressText = `${streetAddress}, ${city}, ${barangay}`;

                // If signed-in, ask whether to save this new address
                if (authUser) {
                    const shouldSave = await confirmSaveAddress();
                    if (shouldSave) {
                        try {
                            const nowIso = new Date().toISOString();
                            const newAddress = {
                                id: `addr-${Date.now()}`,
                                label: label,
                                street: streetAddress,
                                city: city,
                                barangay: barangay,
                                fullAddress: addressText,
                                updatedAt: nowIso
                            };
                            const savedId = await saveNewAddressToFirestore(authUser, newAddress);
                            if (savedId) {
                                // Refresh saved addresses list and auto-select it
                                await loadAddressesForCheckout(authUser);
                                const sel = document.getElementById('delivery-address');
                                if (sel) sel.value = savedId;
                            }
                        } catch (e) {
                            console.warn('Failed to save new address from checkout:', e);
                        }
                    }
                }
            }

            params.set('address', addressText);
        }

        // Calculate final order total from summary (includes points and any delivery fee)
        const totalText = document.getElementById('summaryTotal')?.textContent || '₱0';
        const orderTotal = parseFloat(totalText.replace(/[^\d.]/g, '')) || 0;

        const deliveryInfo = {
            serviceType: currentService,
            tableNumber: null,
            storeLocation: currentService === 'pickup'
                ? (document.getElementById('store-location')?.textContent || '').trim()
                : undefined,
            address: currentService === 'delivery' ? params.get('address') || '' : undefined
        };

        const customerInfo = {
            name: fullName,
            phone: phone,
            email: email || (authUser?.email || ''),
            notes: notes || ''
        };

        // Upload GCash payment proof (if applicable) before creating the order
        // Cash payment doesn't require proof upload
        let paymentProof = null;
        if (paymentMethod === 'gcash' && gcashFile) {
            try {
                paymentProof = await uploadPaymentProof(gcashFile);
            } catch (error) {
                console.error('Payment proof upload failed:', error);
                console.error('Error code:', error.code);
                console.error('Error message:', error.message);
                const errorMsg = error.message || 'Unknown error';
                if (window.showAlert) {
                    window.showAlert(`Failed to upload your GCash payment screenshot: ${errorMsg}. Please check your connection and try again.`, 'error');
                } else {
                    alert(`Failed to upload your GCash payment screenshot: ${errorMsg}. Please check your connection and try again.`);
                }
                if (btn) {
                    btn.disabled = false;
                    btn.classList.remove('is-processing');
                }
                return;
            }
        }

        // Ensure orderId is available after the try/catch so we can use it
        // when awarding loyalty points and building the receipt URL.
        let orderId = null;

        try {
            const user = window.firebaseAuth?.currentUser || null;
            if (!user) {
                throw new Error('You must be signed in to place an order.');
            }

            // Build payment info object - only include GCash fields if GCash is selected
            const paymentInfo = {
                method: paymentType,
                gcashProofUrl: (paymentMethod === 'gcash' && paymentProof) ? paymentProof.url : null,
                gcashProofPath: (paymentMethod === 'gcash' && paymentProof) ? paymentProof.path : null,
                gcashAccountName: (paymentMethod === 'gcash' && gcashAccountName) ? gcashAccountName : null,
                gcashRefNo: (paymentMethod === 'gcash' && gcashRefNo) ? gcashRefNo : null
            };

            // Signed-in customer: use Firestore cart
            orderId = await createOrderWithInventoryCheck(
                deliveryInfo,
                customerInfo,
                orderTotal,
                paymentInfo
            );
            // Clear cart after a successful order
            await clearUserCart();

            if (orderId) {
                params.set('orderId', orderId);
            }

            // Handle loyalty points for authenticated users
            if (window.firebaseAuth && window.firebaseAuth.currentUser) {
                // Deduct used points from database first (if any were used)
                if (pointsUsedInOrder > 0) {
                    await deductPointsFromDatabase(pointsUsedInOrder, orderId);
                }
                // Then award new points for this order
                await awardPointsForOrder(orderTotal, orderId);
            }

            // Reset points used tracker
            pointsUsedInOrder = 0;
        } catch (error) {
            console.error('Checkout failed due to availability validation:', error);
            if (error && error.code === 'inventory/insufficient') {
                if (window.showAlert) {
                    window.showAlert(error.message || 'Sorry, one or more items are currently unavailable.', 'error');
                } else {
                    alert(error.message || 'Sorry, one or more items are currently unavailable.');
                }
            } else {
                if (window.showAlert) {
                    window.showAlert('Unable to complete checkout right now. Please try again.', 'error');
                } else {
                    alert('Unable to complete checkout right now. Please try again.');
                }
            }
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('is-processing');
            }
            // Reset points used tracker on error
            pointsUsedInOrder = 0;
            return;
        }

        const receiptUrl = `completion_receipt_page.html?${params.toString()}`;
        try {
            window.localStorage?.setItem(PENDING_RECEIPT_KEY, JSON.stringify({ url: receiptUrl, ts: Date.now() }));
        } catch (e) {}
        window.location.href = receiptUrl;
    }

    function goBackToCart() {
        window.location.href = 'cart_review.html';
    }

    function updateGCashDetailsVisibility() {
        const gcashRadio = document.getElementById('gcash-payment-radio');
        const gcashDetails = document.getElementById('gcash-details');
        const arrow = document.querySelector('input[name="payment"][value="gcash"]')?.closest('.delivery-option')?.querySelector('.option-arrow i');
        if (!gcashDetails) return;

        const checked = document.querySelector('input[name="payment"]:checked');
        const isGcash = checked && checked.value === 'gcash' && (!gcashRadio || !gcashRadio.disabled);

        if (isGcash) {
            gcashDetails.classList.add('show');
            if (arrow) {
                arrow.classList.remove('fa-chevron-down');
                arrow.classList.add('fa-chevron-up');
            }
        } else {
            gcashDetails.classList.remove('show');
            if (arrow) {
                arrow.classList.remove('fa-chevron-up');
                arrow.classList.add('fa-chevron-down');
            }
        }
    }

    function toggleGCashDetails() {
        updateGCashDetailsVisibility();
    }

    function handleFileUpload(input) {
        const file = input.files[0];
        const preview = document.getElementById('upload-preview');
        
        if (file) {
            if (!file.type.startsWith('image/')) {
                if (window.showAlert) {
                    window.showAlert('Please select an image file', 'warning');
                } else {
                    alert('Please select an image file');
                }
                return;
            }

            if (file.size > 5 * 1024 * 1024) {
                if (window.showAlert) {
                    window.showAlert('File size must be less than 5MB', 'warning');
                } else {
                    alert('File size must be less than 5MB');
                }
                return;
            }
            
            const reader = new FileReader();
            reader.onload = function(e) {
                preview.innerHTML = `
                    <div class="preview-item">
                        <img src="${e.target.result}" alt="Payment Proof" class="preview-image">
                        <div class="preview-info">
                            <span class="file-name">${file.name}</span>
                            <div class="preview-actions">
                                <button type="button" class="remove-btn" onclick="checkout.removeFile()" title="Remove file">
                                    <i class="fas fa-times"></i>
                                </button>
                                <button type="button" class="remove-text-btn" onclick="checkout.removeFile()">
                                    <i class="fas fa-trash"></i>
                                    Remove
                                </button>
                            </div>
                        </div>
                    </div>
                `;
            };
            reader.readAsDataURL(file);
        }
    }

    function removeFile() {
        const input = document.getElementById('payment-proof');
        const preview = document.getElementById('upload-preview');
        if (input) input.value = '';
        if (preview) preview.innerHTML = '';
    }

    function updateEarnedPointsVisual() {
        const row = document.getElementById('earnedPointsRow');
        const valueEl = document.getElementById('earnedPointsValue');
        const totalText = document.getElementById('summaryTotal')?.textContent || '₱0';
        if (!row || !valueEl) return;

        if (!loyaltyEnabled || !(window.firebaseAuth && window.firebaseAuth.currentUser)) {
            row.style.display = 'none';
            return;
        }

        const orderTotal = parseFloat(totalText.replace(/[^\d.]/g, '')) || 0;
        const pointsEarned = Math.floor(orderTotal / 99);

        if (pointsEarned > 0) {
            row.style.display = 'flex';
            valueEl.textContent = `+${pointsEarned} pts`;
        } else {
            row.style.display = 'none';
        }
    }

    // Deduct used points from customer's account in database
    async function deductPointsFromDatabase(pointsToDeduct, orderId) {
        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.getDoc || !window.updateDoc) {
                console.warn('Firebase not fully initialized for deducting points');
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                console.warn('No authenticated user; skipping points deduction');
                return;
            }

            // Ensure doc + loyalty fields exist so updateDoc won't fail.
            try {
                await window.utils?.ensureCustomerLoyaltyDefaults?.(user);
            } catch (e) {}

            const userDocRef = window.doc(db, 'customers', user.uid);

            // Get current points
            let currentPoints = 0;
            let history = [];
            try {
                const snap = await window.getDoc(userDocRef);
                if (snap.exists()) {
                    const data = snap.data() || {};
                    currentPoints =
                        typeof data.points === 'number'
                            ? data.points
                            : Number(data.points) || 0;
                    if (Array.isArray(data.pointsHistory)) {
                        history = data.pointsHistory.slice(0);
                    }
                }
            } catch (readError) {
                console.warn('Failed to read existing points for deduction:', readError);
                return;
            }

            // Calculate new points after deduction
            const newPoints = Math.max(0, currentPoints - pointsToDeduct);
            const nowIso = new Date().toISOString();

            // Add deduction to history
            history.push({
                points: -pointsToDeduct, // Negative to show deduction
                orderId: orderId || null,
                createdAt: nowIso,
                type: 'redeemed'
            });

            // Update points in database
            await window.updateDoc(userDocRef, {
                points: newPoints,
                pointsHistory: history,
                lastUpdated: window.serverTimestamp ? window.serverTimestamp() : new Date()
            });

            // Sync local cached points
            saveStoredPoints(newPoints);

            console.log(`Deducted ${pointsToDeduct} points. New balance: ${newPoints}`);
        } catch (error) {
            console.error('Error deducting loyalty points:', error);
        }
    }

    async function awardPointsForOrder(orderTotal, orderId) {
        try {
            if (!orderTotal || orderTotal < 99) return;

            const pointsToAdd = Math.floor(orderTotal / 99);
            if (pointsToAdd <= 0) return;

            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.getDoc || !window.setDoc) {
                console.warn('Firebase not fully initialized for awarding points');
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                console.warn('No authenticated user; skipping points award');
                return;
            }

            // Ensure doc + loyalty fields exist for first-time earners.
            try {
                await window.utils?.ensureCustomerLoyaltyDefaults?.(user);
            } catch (e) {}

            const userDocRef = window.doc(db, 'customers', user.uid);

            let currentPoints = 0;
            let history = [];
            try {
                const snap = await window.getDoc(userDocRef);
                if (snap.exists()) {
                    const data = snap.data() || {};
                    currentPoints =
                        typeof data.points === 'number'
                            ? data.points
                            : Number(data.points) || 0;
                    if (Array.isArray(data.pointsHistory)) {
                        history = data.pointsHistory.slice(0);
                    }
                }
            } catch (readError) {
                console.warn('Failed to read existing points, defaulting to 0:', readError);
            }

            const newPoints = currentPoints + pointsToAdd;
            const nowIso = new Date().toISOString();

            history.push({
                points: pointsToAdd,
                orderTotal: orderTotal,
                createdAt: nowIso,
                orderId: orderId || null
            });

            await window.setDoc(
                userDocRef,
                {
                    points: newPoints,
                    lastEarnedPoints: pointsToAdd,
                    lastEarnedAt: nowIso,
                    pointsHistory: history
                },
                { merge: true }
            );

            // Sync local cached points used by checkout
            saveStoredPoints(newPoints);
        } catch (error) {
            console.error('Error awarding loyalty points:', error);
        }
    }

    async function clearUserCart() {
        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.collection || !window.getDocs || !window.deleteDoc) {
                console.warn('Firebase not fully initialized for clearing cart');
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                console.warn('No authenticated user; skipping cart clear');
                return;
            }

            const cartCol = window.collection(db, 'customers', user.uid, 'cartItems');
            const snap = await window.getDocs(cartCol);

            const deletions = [];
            snap.forEach((docSnap) => {
                const ref = window.doc(db, 'customers', user.uid, 'cartItems', docSnap.id);
                deletions.push(window.deleteDoc(ref));
            });

            if (deletions.length) {
                await Promise.all(deletions);
            }

            // Reset local cart count and notify listeners
            try {
                window.localStorage?.setItem('ppp_cart_count', '0');
                document.dispatchEvent(new CustomEvent('cart:count-changed', {
                    detail: { count: 0 }
                }));
            } catch (e) {
                console.warn('Failed to sync cleared cart count to localStorage:', e);
            }
        } catch (error) {
            console.error('Error clearing user cart after order placement:', error);
        }
    }

    // Get next date-based sequential order number (resets daily)
    // Format: YYYYMMDD-XXX (e.g., 20250106-001, 20250106-002)
    async function getNextOrderNumber(db) {
        try {
            // Get current date in YYYYMMDD format
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const dateKey = `${year}${month}${day}`; // e.g., "20250106"
            
            // Counter document is date-specific: order_counter/orders_YYYYMMDD
            const counterRef = window.doc(db, 'order_counter', `orders_${dateKey}`);
            
            // First, try to get the current counter value for today
            const counterDoc = await window.getDoc(counterRef);
            
            let nextCount = 1;
            
            if (counterDoc.exists()) {
                // Counter exists for today - increment it
                const data = counterDoc.data();
                const currentCount = data.count || 0;
                nextCount = currentCount + 1;
                
                // Use increment for atomic update (more reliable than transaction for counters)
                if (window.increment) {
                    await window.updateDoc(counterRef, {
                        count: window.increment(1),
                        date: dateKey,
                        lastUpdated: window.serverTimestamp ? window.serverTimestamp() : new Date()
                    });
                } else {
                    // Fallback to regular update if increment not available
                    await window.updateDoc(counterRef, {
                        count: nextCount,
                        date: dateKey,
                        lastUpdated: window.serverTimestamp ? window.serverTimestamp() : new Date()
                    });
                }
            } else {
                // Counter doesn't exist for today - create it with count = 1
                // This happens at the start of each new day
                await window.setDoc(counterRef, {
                    count: 1,
                    date: dateKey,
                    lastUpdated: window.serverTimestamp ? window.serverTimestamp() : new Date()
                });
                nextCount = 1;
            }
            
            // Format as date-based sequential: YYYYMMDD-XXX
            // e.g., "20250106-001", "20250106-042"
            const sequence = String(nextCount).padStart(3, '0');
            return `${dateKey}-${sequence}`;
        } catch (error) {
            console.error('Error getting next order number:', error);
            console.error('Error details:', {
                message: error.message,
                code: error.code,
                stack: error.stack
            });
            // Fallback: use timestamp-based ID if counter fails
            // This happens if Firestore security rules block _counters collection
            return Date.now().toString();
        }
    }

    async function createOrderWithInventoryCheck(deliveryInfo, customerInfo, orderTotal, paymentInfo) {
        await window.utils.waitForFirebaseReady();

        const db = window.firebaseDb;
        const auth = window.firebaseAuth;

        if (!db || !auth || !window.doc || !window.collection || !window.getDocs || !window.runTransaction) {
            console.warn('Firebase not fully initialized for order transaction');
            throw new Error('Checkout is temporarily unavailable. Please try again later.');
        }

        const user = auth.currentUser;
        if (!user) {
            throw new Error('You must be signed in to place an order.');
        }

        const customerRef = window.doc(db, 'customers', user.uid);
        const cartItemsCol = window.collection(customerRef, 'cartItems');
        const cartSnap = await window.getDocs(cartItemsCol);

        const cartItems = [];
        cartSnap.forEach((docSnap) => {
            cartItems.push({ id: docSnap.id, ...(docSnap.data() || {}) });
        });

        if (!cartItems.length) {
            throw new Error('Your cart is empty.');
        }

        const MENU_COLLECTION = 'menu';

        // Get next sequential order number before starting the transaction
        const orderNumber = await getNextOrderNumber(db);

        return await window.runTransaction(db, async (transaction) => {
            const unavailableItems = [];
            const orderItems = [];
            // menuId -> { menuRef, menuData, baseQty, byVariation: { [variationId]: qty } }
            // Only menu.quantity and menu.variations[i].quantity are deducted. No dailyServings/maxServingsPerDay.
            const menuUpdates = {};
            const sauceTotals = {}; // sauceId -> total quantity from all cart lines
            const freeSauceUpdates = {}; // sauceId -> { menuRef, menuData, quantity }
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

            for (const cartItem of cartItems) {
                const qty =
                    typeof cartItem.quantity === 'number'
                        ? cartItem.quantity
                        : Number(cartItem.quantity) || 1;

                const linePrice =
                    typeof cartItem.price === 'number'
                        ? cartItem.price
                        : Number(cartItem.price) || 0;

                const unitPrice = qty > 0 ? linePrice / qty : linePrice;

                const sauce = cartItem.sauce || null;
                const variation = cartItem.variation || null;
                const note = typeof cartItem.note === 'string' ? cartItem.note : '';
                const isFreeSauce = cartItem.freeWithPeriRibs === true;

                // For items with variations: menuId is the parent menu item ID, itemId is the variation ID
                // For items without variations: menuId equals itemId
                // Always use menuId (or parentId) to fetch the parent menu item from Firebase
                const menuId = cartItem.menuId || cartItem.parentId || cartItem.itemId;
                if (!menuId) {
                    unavailableItems.push({ itemId: null, name: cartItem.name || 'Item', reason: 'Missing menu item ID' });
                    continue;
                }
                
                // Determine variationId from multiple sources
                let variationId = variation?.id || variation?.variationId || null;
                if (!variationId && cartItem.isVariation === true) {
                    // For customer-cart.js structure: itemId is the variation ID
                    variationId = cartItem.itemId || null;
                }

                // Handle free sauces separately
                if (isFreeSauce) {
                    const sauceMenuRef = window.doc(db, MENU_COLLECTION, menuId);
                    const sauceMenuSnap = await transaction.get(sauceMenuRef);
                    if (!sauceMenuSnap.exists()) {
                        unavailableItems.push({ itemId: menuId, name: cartItem.name || 'Sauce', reason: 'Free sauce no longer exists on menu' });
                        continue;
                    }

                    const sauceMenuData = sauceMenuSnap.data() || {};
                    if (!freeSauceUpdates[menuId]) {
                        freeSauceUpdates[menuId] = { menuRef: sauceMenuRef, menuData: sauceMenuData, quantity: 0 };
                    }
                    const freeSauceRec = freeSauceUpdates[menuId];
                    
                    // Check availability for free sauce
                    const currentQty = freeSauceRec.quantity + qty;
                    const availableQty = (sauceMenuData.quantity ?? 0) || 0;
                    if (availableQty < currentQty) {
                        unavailableItems.push({ itemId: menuId, name: cartItem.name || 'Free Sauce', reason: `Only ${availableQty} available, ${currentQty} requested` });
                        continue;
                    }
                    freeSauceRec.quantity = currentQty;

                    // Add free sauce to order items
                    orderItems.push({
                        itemId: menuId,
                        name: cartItem.name || 'Free Sauce',
                        quantity: qty,
                        unitPrice: 0,
                        lineTotal: 0,
                        note: note || null,
                        variationId: null,
                        variation: null,
                        sauce: null,
                        freeWithPeriRibs: true
                    });
                    continue;
                }

                // Handle main items (non-free sauces)
                const menuRef = window.doc(db, MENU_COLLECTION, menuId);
                const menuSnap = await transaction.get(menuRef);
                if (!menuSnap.exists()) {
                    unavailableItems.push({ itemId: menuId, name: cartItem.name || 'Item', reason: 'Item no longer exists on menu' });
                    continue;
                }

                const menuData = menuSnap.data() || {};
                const variations = Array.isArray(menuData.variations) ? menuData.variations : [];
                const hasVariations = variations.length > 0;

                if (!menuUpdates[menuId]) {
                    menuUpdates[menuId] = { menuRef, menuData, baseQty: 0, byVariation: {} };
                }
                const rec = menuUpdates[menuId];

                // Quantity-based availability: do NOT use maxServingsPerDay
                if (hasVariations) {
                    // Products WITH variations: use ONLY variation.quantity. Need variationId.
                    if (!variationId) {
                        unavailableItems.push({ itemId: menuId, name: cartItem.name || menuData.name || 'Item', reason: 'Variation required for this item' });
                        continue;
                    }
                    
                    // Find the variation in the menu's variations array
                    const v = variations.find((x) => {
                        const vid = x.variationId || x.id;
                        return vid === variationId;
                    });
                    
                    if (!v) {
                        unavailableItems.push({ itemId: menuId, name: cartItem.name || menuData.name || 'Item', reason: `Variation not found in menu (variationId: ${variationId})` });
                        continue;
                    }
                    
                    const cur = (rec.byVariation[variationId] || 0) + qty;
                    const avail = (v.quantity ?? 0) || 0;
                    if (avail < cur) {
                        unavailableItems.push({ itemId: menuId, name: cartItem.name || menuData.name || 'Item', reason: `Only ${avail} available for this variation, ${cur} requested` });
                        continue;
                    }
                    rec.byVariation[variationId] = cur;
                } else {
                    // Products WITHOUT variations: use data.quantity
                    const cur = rec.baseQty + qty;
                    const avail = (menuData.quantity ?? 0) || 0;
                    if (avail < cur) {
                        unavailableItems.push({ itemId: menuId, name: cartItem.name || menuData.name || 'Item', reason: `Only ${avail} available, ${cur} requested` });
                        continue;
                    }
                    rec.baseQty = cur;
                }

                // Build variation object - use existing variation or fetch from menu if we have variationId
                let finalVariation = variation;
                if (!finalVariation && variationId && hasVariations) {
                    const v = variations.find((x) => {
                        const vid = x.variationId || x.id;
                        return vid === variationId;
                    });
                    if (v) {
                        finalVariation = {
                            name: v.name || null,
                            price: typeof v.price === 'number' ? v.price : (typeof v.price === 'string' ? parseFloat(v.price) : 0),
                            id: variationId
                        };
                    }
                }
                
                // IMPORTANT:
                // Store the parent menu item's document ID in `itemId` so downstream
                // pages (order details, food item page reviews, reorder) can reference
                // `menu/{itemId}` consistently. Keep `variationId` separately.
                orderItems.push({
                    itemId: menuId,
                    name: cartItem.name || 'Item',
                    quantity: qty,
                    unitPrice: unitPrice,
                    lineTotal: linePrice || unitPrice * qty,
                    note: note || null,
                    variationId: variationId || null,
                    variation: finalVariation ? {
                        name: finalVariation.name || null,
                        price: typeof finalVariation.price === 'number' ? finalVariation.price : (typeof finalVariation.price === 'string' ? parseFloat(finalVariation.price) : 0),
                        id: variationId
                    } : null,
                    sauce: sauce ? { id: sauce.id || null, name: sauce.name || null, price: 0 } : null,
                    freeWithPeriRibs: false
                });

                if (sauce && sauce.id) {
                    sauceTotals[sauce.id] = (sauceTotals[sauce.id] || 0) + qty;
                }
            }

            // Validate sauce availability and prepare sauce dailyServings updates
            const sauceDailyData = {};
            for (const [sauceId, totalQty] of Object.entries(sauceTotals)) {
                const sauceMenuRef = window.doc(db, MENU_COLLECTION, sauceId);
                const sauceMenuSnap = await transaction.get(sauceMenuRef);
                if (!sauceMenuSnap.exists()) {
                    unavailableItems.push({
                        itemId: sauceId,
                        name: 'Sauce',
                        reason: 'Sauce no longer exists on menu'
                    });
                    continue;
                }
                const sauceData = sauceMenuSnap.data() || {};
                const maxSauce = typeof sauceData.maxServingsPerDay === 'number'
                    ? sauceData.maxServingsPerDay
                    : (typeof sauceData.maxServingsPerDay === 'string' ? parseFloat(sauceData.maxServingsPerDay) : null);
                if (maxSauce == null || maxSauce === undefined || isNaN(maxSauce) || maxSauce <= 0) {
                    unavailableItems.push({
                        itemId: sauceId,
                        name: sauceData.displayName || sauceData.name || 'Sauce',
                        reason: 'Sauce is currently unavailable (maxServingsPerDay is null or 0)'
                    });
                    continue;
                }
                const sauceDailyRef = window.doc(db, 'dailyServings', `${today}_${sauceId}`);
                const sauceDailySnap = await transaction.get(sauceDailyRef);
                const currentSauceCount = sauceDailySnap.exists() ? (sauceDailySnap.data().count || 0) : 0;
                if (maxSauce - currentSauceCount < totalQty) {
                    unavailableItems.push({
                        itemId: sauceId,
                        name: sauceData.displayName || sauceData.name || 'Sauce',
                        reason: `Only ${maxSauce - currentSauceCount} sauce serving(s) left, but ${totalQty} requested`
                    });
                    continue;
                }
                sauceDailyData[sauceId] = {
                    ref: sauceDailyRef,
                    exists: sauceDailySnap.exists(),
                    data: sauceDailySnap.exists() ? sauceDailySnap.data() : {},
                    quantity: totalQty,
                    maxSauce: maxSauce,
                    sauceName: sauceData.displayName || sauceData.name || 'Sauce'
                };
            }

            if (unavailableItems.length > 0) {
                const details = unavailableItems.map((i) => `${i.name} (${i.reason})`).join(', ');
                const error = new Error(`Unavailable items: ${details}`);
                error.code = 'inventory/insufficient';
                throw error;
            }

            // All reads are done. Now do writes: order + menu deductions (quantity / variations[].quantity only; no dailyServings for menu)
            // Create order document with sequential ID
            const ordersCol = window.collection(db, 'orders');
            const orderRef = window.doc(ordersCol, orderNumber);

            const now = new Date();
            const dateOnly = now.toISOString().split('T')[0];

            const orderDoc = {
                orderNumber: orderNumber, // Store the order number in the document as well
                userId: user.uid,
                items: orderItems,
                total: orderTotal,
                deliveryInfo: {
                    serviceType: deliveryInfo.serviceType,
                    tableNumber: deliveryInfo.tableNumber || null,
                    storeLocation: deliveryInfo.storeLocation || null,
                    address: deliveryInfo.address || null
                },
                customerInfo: {
                    name: customerInfo && customerInfo.name ? customerInfo.name : null,
                    phone: customerInfo && customerInfo.phone ? customerInfo.phone : null,
                    email: customerInfo && customerInfo.email ? customerInfo.email : null,
                    notes: customerInfo && customerInfo.notes ? customerInfo.notes : null
                },
                payment: {
                    method: paymentInfo && paymentInfo.method ? paymentInfo.method : null,
                    gcashProofUrl: paymentInfo && paymentInfo.gcashProofUrl ? paymentInfo.gcashProofUrl : null,
                    gcashProofPath: paymentInfo && paymentInfo.gcashProofPath ? paymentInfo.gcashProofPath : null,
                    gcashAccountName: paymentInfo && paymentInfo.gcashAccountName ? paymentInfo.gcashAccountName : null,
                    gcashRefNo: paymentInfo && paymentInfo.gcashRefNo ? paymentInfo.gcashRefNo : null
                },
                timestamp: dateOnly,
                status: 'pending',
                createdAt: window.serverTimestamp ? window.serverTimestamp() : now
            };

            transaction.set(orderRef, orderDoc);

            // Deduct menu.quantity and menu.variations[i].quantity. Do NOT update dailyServings or maxServingsPerDay.
            for (const [menuId, rec] of Object.entries(menuUpdates)) {
                const { menuRef, menuData, baseQty, byVariation } = rec;
                const updateDoc = {};
                if (baseQty > 0) {
                    updateDoc.quantity = Math.max(0, ((menuData.quantity ?? 0) || 0) - baseQty);
                }
                if (Array.isArray(menuData.variations) && menuData.variations.length > 0) {
                    const newVariations = menuData.variations.map((x) => {
                        const vid = x.variationId || x.id;
                        const d = vid != null ? (byVariation[vid] || 0) : 0;
                        if (d > 0) {
                            return { ...x, quantity: Math.max(0, ((x.quantity ?? 0) || 0) - d) };
                        }
                        return x;
                    });
                    updateDoc.variations = newVariations;
                }
                if (Object.keys(updateDoc).length > 0) {
                    transaction.update(menuRef, updateDoc);
                }
            }

            // Deduct quantities for free sauces (linked sauces)
            for (const [sauceId, rec] of Object.entries(freeSauceUpdates)) {
                const { menuRef, menuData, quantity } = rec;
                const updateDoc = {
                    quantity: Math.max(0, ((menuData.quantity ?? 0) || 0) - quantity)
                };
                transaction.update(menuRef, updateDoc);
            }

            // Update dailyServings for sauces (peri chicken/ribs). Menu items use quantity only, not dailyServings.
            for (const [sauceId, s] of Object.entries(sauceDailyData)) {
                if (s.exists) {
                    const currentCount = s.data.count || 0;
                    transaction.update(s.ref, {
                        count: currentCount + s.quantity,
                        updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date()
                    });
                } else {
                    transaction.set(s.ref, {
                        menuItemId: sauceId,
                        menuItemName: s.sauceName,
                        date: today,
                        count: s.quantity,
                        maxServings: s.maxSauce,
                        createdAt: window.serverTimestamp ? window.serverTimestamp() : new Date(),
                        updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date()
                    });
                }
            }

            return orderRef.id;
        });
    }

    async function loadCheckoutTotalsFromFirestore(authUser) {
        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.collection || !window.getDocs) {
                console.warn('Firebase not fully initialized for checkout summary');
                baseSubtotal = 0;
                initPointsSummary();
                return;
            }

            const user = authUser || auth.currentUser;
            if (!user) {
                console.warn('No authenticated user on checkout page; checkout requires login');
                baseSubtotal = 0;
                initPointsSummary();
                return;
            }

            const customerRef = window.doc(db, 'customers', user.uid);
            const cartItemsCol = window.collection(customerRef, 'cartItems');
            const snap = await window.getDocs(cartItemsCol);

            let subtotal = 0;
            let rowsHtml = '';

            snap.forEach((docSnap) => {
                const data = docSnap.data() || {};
                const name = data.name || 'Item';
                const quantity =
                    typeof data.quantity === 'number'
                        ? data.quantity
                        : Number(data.quantity) || 1;
                const numericPrice =
                    typeof data.price === 'number'
                        ? data.price
                        : Number(data.price) || 0;

                subtotal += numericPrice;

                rowsHtml += `
                    <div class="summary-row">
                        <span class="summary-label">${name} x ${quantity}</span>
                        <span class="summary-value">₱${numericPrice.toFixed(2)}</span>
                    </div>
                `;
            });

            const lineItemsContainer = document.getElementById('summaryLineItems');
            if (lineItemsContainer) {
                lineItemsContainer.innerHTML = rowsHtml;
            }

            baseSubtotal = subtotal;
        } catch (error) {
            console.error('Error loading checkout totals from Firestore:', error);
            baseSubtotal = 0;
        }

        // Reload user discount info if user is signed in
        if (authUser || (window.firebaseAuth && window.firebaseAuth.currentUser)) {
            await loadUserDiscountInfo();
        }

        initPointsSummary();
    }

    async function loadUserDiscountInfo() {
        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.getDoc) {
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                userDiscountInfo = null;
                return;
            }

            const userDocRef = window.doc(db, 'customers', user.uid);
            const userSnap = await window.getDoc(userDocRef);

            if (userSnap.exists()) {
                const userData = userSnap.data() || {};
                userDiscountInfo = userData.discountInfo || null;
            } else {
                userDiscountInfo = null;
            }
        } catch (error) {
            console.error('Error loading user discount info:', error);
            userDiscountInfo = null;
        }
    }

    async function loadAddressesForCheckout(authUser) {
        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.getDoc) {
                console.warn('Firebase not fully initialized for checkout addresses');
                return;
            }

            const user = authUser || auth.currentUser;
            if (!user) {
                console.warn('No authenticated user on checkout page; no saved addresses');
                return;
            }

            const userDocRef = window.doc(db, 'customers', user.uid);
            const userSnap = await window.getDoc(userDocRef);
            const select = document.getElementById('delivery-address');
            const nameInput = document.getElementById('contactName');
            const phoneInput = document.getElementById('contactPhone');
            const emailInput = document.getElementById('contactEmail');

            let addresses = [];
            let userData = null;
            if (userSnap.exists()) {
                userData = userSnap.data() || {};
                addresses = Array.isArray(userData.addresses) ? userData.addresses : [];
                // Load discount info for ID verification discount
                userDiscountInfo = userData.discountInfo || null;
                // Recalculate totals with discount
                await loadCheckoutTotalsFromFirestore(user);
            } else {
                userDiscountInfo = null;
            }

            // Prefill contact details for logged-in customers
            if (nameInput && user) {
                const fullName = `${userData?.firstName || ''} ${userData?.lastName || ''}`.trim() || user.displayName || '';
                nameInput.value = fullName;
            }
            if (phoneInput && userData && userData.phone) {
                phoneInput.value = userData.phone;
            }
            if (emailInput) {
                emailInput.value = (userData && userData.email) || user.email || '';
            }

            if (select) {
                checkoutAddresses = addresses;

                let optionsHtml = '<option value="">Select saved address</option>';
                addresses.forEach((address) => {
                    const id = address.id || `addr-${Date.now()}`;
                    const barangay = address.barangay || address.province || '';
                    const fullAddr =
                        address.fullAddress ||
                        `${address.street || ''}, ${address.city || ''}, ${barangay} ${address.postal || ''}`;
                    const label = address.label || 'Other';
                    optionsHtml += `<option value="${id}">${label} - ${fullAddr}</option>`;
                });
                optionsHtml += '<option value="new">+ Add New Address</option>';

                select.innerHTML = optionsHtml;
            }
        } catch (error) {
            console.error('Error loading checkout addresses from Firestore:', error);
        }
    }

    // Expose functions to window
    window.checkout = {
        applyPoints,
        toggleNewAddress,
        placeOrder,
        goBackToCart,
        toggleGCashDetails,
        handleFileUpload,
        removeFile,
        togglePromoPanel,
        applyPromoCode
    };

    // Global functions for onclick handlers
    window.applyPoints = applyPoints;
    window.toggleNewAddress = toggleNewAddress;
    window.placeOrder = placeOrder;
    window.goBackToCart = goBackToCart;
    window.toggleGCashDetails = toggleGCashDetails;
    window.handleFileUpload = handleFileUpload;

    // Initialize on DOM ready
    document.addEventListener('DOMContentLoaded', () => {
        // If the last attempt successfully created an order but navigation failed,
        // continue to the receipt (avoids duplicate submissions).
        try {
            const raw = window.localStorage?.getItem(PENDING_RECEIPT_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                const url = parsed?.url;
                const ts = Number(parsed?.ts) || 0;
                if (url && ts && (Date.now() - ts) < 10 * 60 * 1000) {
                    window.localStorage?.removeItem(PENDING_RECEIPT_KEY);
                    window.location.href = url;
                    return;
                }
                window.localStorage?.removeItem(PENDING_RECEIPT_KEY);
            }
        } catch (e) {}

        updateTotalChip(document.getElementById('summaryTotal')?.textContent || '₱0.00');

        // Save-address confirm modal wiring
        const saveModal = document.getElementById('saveAddressConfirmModal');
        const saveYes = document.getElementById('saveAddressConfirmYes');
        const saveNo = document.getElementById('saveAddressConfirmNo');
        const saveClose = document.getElementById('closeSaveAddressConfirm');
        if (saveYes) {
            saveYes.addEventListener('click', () => {
                closeSaveAddressConfirmModal();
                if (saveAddressResolve) saveAddressResolve(true);
                saveAddressResolve = null;
            });
        }
        if (saveNo) {
            saveNo.addEventListener('click', () => {
                closeSaveAddressConfirmModal();
                if (saveAddressResolve) saveAddressResolve(false);
                saveAddressResolve = null;
            });
        }
        if (saveClose) {
            saveClose.addEventListener('click', () => {
                closeSaveAddressConfirmModal();
                if (saveAddressResolve) saveAddressResolve(false);
                saveAddressResolve = null;
            });
        }
        if (saveModal) {
            saveModal.addEventListener('click', (e) => {
                if (e.target === saveModal) {
                    closeSaveAddressConfirmModal();
                    if (saveAddressResolve) saveAddressResolve(false);
                    saveAddressResolve = null;
                }
            });
        }

        const params = new URLSearchParams(window.location.search);
        const service = (params.get('service') || '').toLowerCase();
        const table = (params.get('table') || '').trim();

        const dinePill = document.querySelector('.service-pill[data-service="dinein"]');
        const dinePanel = document.getElementById('service-dinein');
        const tableInput = document.getElementById('table-number');

        const isDineInFromQr = service === 'dinein' && !!table;

        // For normal customers (not from a table QR), completely hide
        // the Dine-In option so they cannot select it.
        if (!isDineInFromQr) {
            if (dinePill) dinePill.classList.add('hidden');
            if (dinePanel) dinePanel.classList.add('hidden');
        } else {
            // QR from a table: show dine-in and auto-fill the table number.
            if (dinePill) dinePill.classList.remove('hidden');
            if (dinePanel) dinePanel.classList.remove('hidden');
            if (tableInput) {
                tableInput.value = table;
                tableInput.readOnly = true;
            }
        }

        const initialService = getInitialServiceType();
        setServiceType(initialService);

        // Promo input: keep it in sync with current totals
        const promoInput = document.getElementById('promoCode');
        if (promoInput) {
            promoInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    applyPromoCode();
                }
            });
        }

        document.querySelectorAll('.service-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.service;
                if (type) setServiceType(type);
            });
        });

        // Hide GCash details when a different payment method is selected
        document.querySelectorAll('input[name="payment"]').forEach(function (r) {
            r.addEventListener('change', updateGCashDetailsVisibility);
        });
        updateGCashDetailsVisibility();

        // No guest ordering: require login to access checkout.
        if (window.firebaseAuth && window.onAuthStateChanged) {
            window.onAuthStateChanged(window.firebaseAuth, (user) => {
                if (!user) {
                    if (window.showAlert) {
                        window.showAlert('Please sign in or create an account to proceed to checkout.', 'info');
                    }
                    const file = (window.location.pathname || '').split('/').pop() || 'checkout.html';
                    const redirectTarget = `${file}${window.location.search || ''}`;
                    window.location.href = `login.html?reason=checkout&redirect=${encodeURIComponent(redirectTarget)}`;
                    return;
                }

                loyaltyEnabled = true;
                // Sync loyalty points from Firestore (defaults to 0 if missing).
                (async () => {
                    try {
                        const res = await window.utils?.ensureCustomerLoyaltyDefaults?.(user);
                        if (res && typeof res.points === 'number') {
                            // ensureCustomerLoyaltyDefaults already syncs localStorage, but keep explicit safety.
                            try {
                                window.localStorage?.setItem('ppp_points', String(Math.max(0, res.points)));
                            } catch (e) {}
                        }
                        initPointsSummary();
                    } catch (e) {}
                })();
                loadCheckoutTotalsFromFirestore(user);
                loadAddressesForCheckout(user);
                setContactFieldsLocked(true);
            });
        } else {
            if (window.showAlert) {
                window.showAlert('Please sign in or create an account to proceed to checkout.', 'info');
            }
            const file = (window.location.pathname || '').split('/').pop() || 'checkout.html';
            const redirectTarget = `${file}${window.location.search || ''}`;
            window.location.href = `login.html?reason=checkout&redirect=${encodeURIComponent(redirectTarget)}`;
        }

        const citySelect = document.getElementById('city');
        if (citySelect) {
            citySelect.addEventListener('change', () => {
                refreshBarangayOptions();
            });
        }
    });

    // Handle recomply to declined order
    async function handleRecomply(orderId, orderDataStr) {
        await window.utils.waitForFirebaseReady();

        const db = window.firebaseDb;
        const auth = window.firebaseAuth;
        if (!db || !auth || !window.doc || !window.getDoc || !window.updateDoc || !window.serverTimestamp) {
            throw new Error('Firebase not ready for recomply');
        }

        const user = auth.currentUser;
        if (!user) {
            throw new Error('You must be signed in to recomply');
        }

        // Parse order data
        let orderData;
        try {
            orderData = JSON.parse(orderDataStr);
        } catch (e) {
            throw new Error('Invalid order data');
        }

        // Verify order exists and belongs to user
        const orderRef = window.doc(db, 'orders', orderId);
        const orderSnap = await window.getDoc(orderRef);
        
        if (!orderSnap.exists()) {
            throw new Error('Order not found');
        }

        const currentOrderData = orderSnap.data();
        const orderUserId = currentOrderData.userId;
        const orderEmail = currentOrderData.customerInfo?.email?.toLowerCase().trim();
        const userEmail = user.email?.toLowerCase().trim();
        
        // Verify ownership
        if (orderUserId !== user.uid && orderEmail !== userEmail) {
            throw new Error('You do not have permission to recomply to this order');
        }

        // Verify order is declined
        if (currentOrderData.status?.toLowerCase() !== 'declined') {
            throw new Error('This order is not declined');
        }

        // Get payment method
        const paymentMethod = document.querySelector('input[name="payment"]:checked')?.value;
        if (!paymentMethod || paymentMethod !== 'gcash') {
            throw new Error('Recomply is only available for GCash orders');
        }

        // Get GCash details
        const fileInput = document.getElementById('payment-proof');
        const file = fileInput && fileInput.files && fileInput.files[0];
        const accountNameInput = document.getElementById('gcash-account-name');
        const refInput = document.getElementById('gcash-ref');

        if (!file) {
            throw new Error('Please upload your GCash payment screenshot');
        }

        const accountName = (accountNameInput?.value || '').trim();
        if (!accountName) {
            throw new Error('Please enter your GCash account name');
        }

        const refNo = (refInput?.value || '').trim();
        if (!refNo) {
            throw new Error('Please enter your GCash reference number');
        }

        // Upload new payment proof
        const paymentProof = await uploadPaymentProof(file);

        // Get current version and history
        // When order is declined, version is incremented, so currentVersion is the next version to use
        const currentVersion = currentOrderData.paymentProofVersion || 1;
        const existingHistory = Array.isArray(currentOrderData.paymentProofHistory) ? currentOrderData.paymentProofHistory : [];

        // Create new proof entry for this version
        // Note: Cannot use serverTimestamp() inside arrays, so use Timestamp.now() instead
        const fns = window.firestoreFunctions;
        const now = fns && fns.Timestamp ? fns.Timestamp.now() : new Date();
        const newProofEntry = {
            version: currentVersion,
            paymentProofPath: paymentProof.path,
            paymentProofUrl: paymentProof.url,
            uploadedAt: now,
            declinedAt: null,
            declineReason: null
        };

        // Add to history
        const updatedHistory = [...existingHistory, newProofEntry];

        // Update order - keep same version since we're resubmitting at this version level
        const updateData = {
            status: 'pending',
            paymentProofVersion: currentVersion,
            paymentProofHistory: updatedHistory,
            'payment.gcashProofUrl': paymentProof.url,
            'payment.gcashProofPath': paymentProof.path,
            'payment.gcashAccountName': accountName,
            'payment.gcashRefNo': refNo,
            updatedAt: fns && fns.serverTimestamp ? fns.serverTimestamp() : new Date()
        };

        // Remove decline fields if deleteField is available
        if (fns && fns.deleteField) {
            updateData.declineReason = fns.deleteField();
            updateData.declinedAt = fns.deleteField();
        }

        await window.updateDoc(orderRef, updateData);

        // Clear recomply data
        localStorage.removeItem('ppp_recomply_order_id');
        localStorage.removeItem('ppp_recomply_order_data');

        // Show success and redirect
        if (window.showAlert) {
            window.showAlert('Payment proof resubmitted successfully! Your order is being reviewed.', 'success');
        } else {
            alert('Payment proof resubmitted successfully! Your order is being reviewed.');
        }

        // Redirect to order details
        window.location.href = `order_details.html?orderId=${encodeURIComponent(orderId)}`;
    }
})();


