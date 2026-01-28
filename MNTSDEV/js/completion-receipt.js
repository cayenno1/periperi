

(function() {
    'use strict';

    // Get URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const RECEIPT_CACHE_KEY = 'ppp_receipt_order';

    // Fallback order number and time (will be overridden if we can load real order)
    const now = new Date();
    const orderDate = now.toLocaleDateString('en-US', {month: '2-digit', day: '2-digit', year: 'numeric'});
    const orderTime = now.toLocaleTimeString('en-US', {hour: '2-digit', minute:'2-digit', hour12: true});
    
    function getCachedReceiptOrder() {
        try {
            const raw = window.localStorage?.getItem(RECEIPT_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch (e) {
            console.warn('Failed to read cached receipt order:', e);
            return null;
        }
    }

    function consumeCachedReceiptOrder() {
        const cached = getCachedReceiptOrder();
        if (cached) {
            try {
                window.localStorage?.removeItem(RECEIPT_CACHE_KEY);
            } catch (e) {}
        }
        return cached;
    }

    function normalizeServiceType(raw) {
        const v = String(raw || '').trim().toLowerCase();
        if (!v) return 'dinein';
        if (v === 'dine-in' || v === 'dinein' || v === 'dine in') return 'dinein';
        if (v === 'pick-up') return 'pickup';
        if (v === 'pickup') return 'pickup';
        if (v === 'delivery') return 'delivery';
        return v.replace(/\s+/g, '');
    }

    function displayServiceLabel(serviceKey) {
        const k = normalizeServiceType(serviceKey);
        if (k === 'dinein') return 'DINE-IN';
        if (k === 'pickup') return 'PICKUP';
        if (k === 'delivery') return 'DELIVERY';
        return String(serviceKey || '').toUpperCase();
    }

    function safeText(v, fallback = '') {
        const s = String(v ?? '').trim();
        return s ? s : fallback;
    }

    function setElText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function setElDisplay(id, show, displayValue = 'block') {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = show ? displayValue : 'none';
    }

    function initializeReceipt() {
        document.getElementById('orderNumber').textContent = Math.floor(Math.random() * 9000) + 1000;
        document.getElementById('orderDate').textContent = orderDate;
        document.getElementById('orderTime').textContent = orderTime;

        // Get payment method from URL parameter
        const paymentMethod = urlParams.get('payment') || 'Cash';
        const paymentMethodUpper = paymentMethod.toUpperCase();
        document.getElementById('paymentMethod').textContent = paymentMethodUpper;

        // Get service type from URL parameter
        const serviceType = urlParams.get('service') || 'dinein';
        document.getElementById('serviceType').textContent = displayServiceLabel(serviceType);

        // Get table number from URL parameter (for dine-in)
        const tableNumber = urlParams.get('table');
        if (tableNumber) {
            document.getElementById('tableNumber').textContent = tableNumber;
            document.getElementById('tableLine').style.display = 'block';
        }

        // Get delivery address from URL parameter (for delivery)
        const deliveryAddress = urlParams.get('address');
        if (deliveryAddress) {
            document.getElementById('deliveryAddress').textContent = deliveryAddress;
            document.getElementById('deliveryAddressLine').style.display = 'block';
        }

        // Get store location from URL parameter (for pickup)
        const storeLocation = urlParams.get('store');
        if (storeLocation) {
            document.getElementById('storeLocation').textContent = storeLocation;
            document.getElementById('storeLocationLine').style.display = 'block';
        }
    }

    function goToAccount() {
        window.location.href = 'account.html';
    }

    function printReceipt() {
        window.print();
    }

    function saveReceipt() {
        const receiptContent = document.getElementById('receiptPaper').innerHTML;
        const printWindow = window.open('', '_blank');
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Receipt - Order #${document.getElementById('orderNumber').textContent}</title>
                <style>
                    ${getReceiptStyles()}
                </style>
            </head>
            <body>
                ${receiptContent}
            </body>
            </html>
        `);
        printWindow.document.close();
        printWindow.print();
    }

    function getReceiptStyles() {
        return `
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            body {
                background: #fff;
                color: #000;
                font-family: 'Courier New', Courier, monospace;
                padding: 20px;
                display: flex;
                justify-content: center;
            }
            .invoice-paper {
                background: #fff;
                color: #000;
                font-family: 'Inter', sans-serif;
                max-width: 800px;
                padding: 40px;
                border: 1px solid #ddd;
            }
            .invoice-header {
                display: flex;
                justify-content: space-between;
                margin-bottom: 40px;
                padding-bottom: 30px;
                border-bottom: 2px solid #e53935;
            }
            .invoice-logo-text {
                font-size: 28px;
                font-weight: 800;
                color: #e53935;
                margin-bottom: 8px;
            }
            .invoice-title {
                font-size: 36px;
                font-weight: 700;
                margin-bottom: 8px;
            }
            .invoice-number {
                font-size: 18px;
                font-weight: 600;
                background: #f5f5f5;
                padding: 8px 16px;
                border-radius: 8px;
            }
            .invoice-details {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 30px;
                margin-bottom: 40px;
                padding: 24px;
                background: #f9f9f9;
            }
            .invoice-items-table {
                width: 100%;
                border-collapse: collapse;
                margin-bottom: 30px;
            }
            .invoice-items-table th {
                padding: 16px 12px;
                text-align: left;
                background: #f5f5f5;
                border-bottom: 2px solid #e0e0e0;
            }
            .invoice-items-table td {
                padding: 16px 12px;
                border-bottom: 1px solid #f0f0f0;
            }
            .invoice-totals {
                margin-bottom: 30px;
            }
            .invoice-totals-content {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 12px;
                padding: 24px;
                background: #f9f9f9;
            }
            .total-row {
                display: flex;
                justify-content: space-between;
                width: 100%;
                max-width: 300px;
            }
            .total-row.final-total {
                border-top: 2px solid #e0e0e0;
                padding-top: 16px;
                margin-top: 8px;
                font-weight: bold;
            }
            .discount {
                color: #4caf50;
            }
            .invoice-payment {
                margin-bottom: 30px;
                padding: 24px;
                background: #f9f9f9;
                border-left: 4px solid #e53935;
            }
            .invoice-footer {
                text-align: center;
                padding-top: 30px;
                border-top: 1px solid #e0e0e0;
            }
        `;
    }

    async function loadOrderFromFirestore() {
        const orderId = urlParams.get('orderId');
        if (!orderId) return;

        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            if (!db || !window.doc || !window.getDoc) {
                console.warn('Firebase not fully initialized for receipt order load');
                return;
            }

            const orderRef = window.doc(db, 'orders', orderId);
            const snap = await window.getDoc(orderRef);
            if (!snap.exists()) {
                console.warn('Order not found for receipt page:', orderId);
                return;
            }

            const order = snap.data() || {};
            populateReceiptFromOrder(order, orderId);
        } catch (error) {
            console.error('Error loading order for receipt:', error);
        }
    }

    async function loadAndRenderLoyalty(orderTotalForPoints = 0) {
        try {
            await window.utils.waitForFirebaseReady();

            const authUser = window.firebaseAuth?.currentUser || null;
            if (!authUser) {
                setElDisplay('loyaltyInfo', false);
                return;
            }

            const db = window.firebaseDb;
            if (!db || !window.doc || !window.getDoc) {
                setElDisplay('loyaltyInfo', false);
                return;
            }

            // Ensure points exists in Firestore (defaults to 0 for new users).
            try {
                await window.utils?.ensureCustomerLoyaltyDefaults?.(authUser);
            } catch (e) {}

            const userDocRef = window.doc(db, 'customers', authUser.uid);
            const snap = await window.getDoc(userDocRef);
            const data = snap.exists() ? (snap.data() || {}) : {};
            const points =
                typeof data.points === 'number'
                    ? data.points
                    : Number(data.points) || 0;

            const earned = Math.floor((Number(orderTotalForPoints) || 0) / 99);
            setElDisplay('loyaltyInfo', true);
            setElText('pointsBalanceValue', `${Math.max(0, points)} pts`);

            if (earned > 0) {
                setElDisplay('earnedPointsLine', true, 'flex');
                setElText('earnedPointsValue', `+${earned} pts`);
            } else {
                setElDisplay('earnedPointsLine', false);
            }

            // Simple next reward hint (keeps expectations clear)
            setElDisplay('pointsHintLine', true, 'flex');
            setElText('nextRewardHint', '1 pt = ₱1 discount at checkout');
        } catch (e) {
            console.warn('Failed to load loyalty points:', e);
            setElDisplay('loyaltyInfo', false);
        }
    }

    function populateReceiptFromOrder(order, orderId) {
        // Order number
        const orderNumberEl = document.getElementById('orderNumber');
        if (orderNumberEl) {
            orderNumberEl.textContent = orderId;
        }

        // Items list
        const itemsContainer = document.getElementById('orderItems');
        if (itemsContainer && Array.isArray(order.items)) {
            let html = '';
            let subtotal = 0;

            order.items.forEach((item) => {
                const name = item.name || 'Item';
                const qty =
                    typeof item.quantity === 'number'
                        ? item.quantity
                        : Number(item.quantity) || 1;
                const lineTotal =
                    typeof item.lineTotal === 'number'
                        ? item.lineTotal
                        : Number(item.lineTotal) || 0;
                const unitPrice = lineTotal / qty;

                subtotal += lineTotal;

                // Format name (keep original case for invoice)
                const itemName = name;
                const formattedUnitPrice = `₱${unitPrice.toFixed(2)}`;
                const formattedTotal = `₱${lineTotal.toFixed(2)}`;

                html += `
                    <tr>
                        <td class="item-col-qty">${qty}</td>
                        <td class="item-col-desc">${itemName}</td>
                        <td class="item-col-price">${formattedUnitPrice}</td>
                        <td class="item-col-total">${formattedTotal}</td>
                    </tr>
                `;
            });

            itemsContainer.innerHTML = html;

            // Totals
            const total =
                typeof order.total === 'number'
                    ? order.total
                    : Number(order.total) || subtotal;

            // Determine if this is a delivery order
            const serviceType =
                (order.deliveryInfo && order.deliveryInfo.serviceType) || null;
            const isDelivery = serviceType == 'delivery';
            const deliveryFee = isDelivery ? 50 : 0;

            // Discount is any difference between subtotal + fee and final total
            const discount = Math.max(0, subtotal + deliveryFee - total);
            
            // Calculate tax (if applicable, 4% of subtotal)
            const tax = subtotal * 0.04;

            const subEl = document.getElementById('receiptSubtotal');
            const ptsEl = document.getElementById('receiptPoints');
            const totEl = document.getElementById('receiptTotal');
            const feeRowEl = document.getElementById('receiptDeliveryFeeRow');
            const feeValEl = document.getElementById('receiptDeliveryFee');
            const taxRowEl = document.getElementById('receiptTaxRow');
            const taxValEl = document.getElementById('receiptTax');
            const ptsRowEl = document.getElementById('receiptPointsRow');

            if (subEl) subEl.textContent = `₱${subtotal.toFixed(2)}`;
            if (feeRowEl && feeValEl) {
                if (isDelivery) {
                    feeRowEl.style.display = 'flex';
                    feeValEl.textContent = `₱${deliveryFee.toFixed(2)}`;
                } else {
                    feeRowEl.style.display = 'none';
                }
            }
            if (taxRowEl && taxValEl) {
                if (tax > 0) {
                    taxRowEl.style.display = 'flex';
                    taxValEl.textContent = `₱${tax.toFixed(2)}`;
                } else {
                    taxRowEl.style.display = 'none';
                }
            }
            if (ptsRowEl && ptsEl) {
                if (discount > 0) {
                    ptsRowEl.style.display = 'flex';
                    ptsEl.textContent = `-₱${discount.toFixed(2)}`;
                } else {
                    ptsRowEl.style.display = 'none';
                }
            }
            if (totEl) totEl.textContent = `₱${total.toFixed(2)}`;
            
            // Update service type display
            if (serviceType) {
                const serviceTypeEl = document.getElementById('serviceType');
                if (serviceTypeEl) {
                    serviceTypeEl.textContent = displayServiceLabel(serviceType);
                }

                const di = order.deliveryInfo || {};
                const tableLineEl = document.getElementById('tableLine');
                const tableNumberEl = document.getElementById('tableNumber');
                const deliveryAddressLineEl = document.getElementById('deliveryAddressLine');
                const deliveryAddressEl = document.getElementById('deliveryAddress');
                const storeLocationLineEl = document.getElementById('storeLocationLine');
                const storeLocationEl = document.getElementById('storeLocation');

                if ((serviceType === 'dinein' || serviceType === 'dine-in') && di.tableNumber && tableLineEl && tableNumberEl) {
                    tableLineEl.style.display = 'block';
                    tableNumberEl.textContent = di.tableNumber;
                } else if (tableLineEl) {
                    tableLineEl.style.display = 'none';
                }

                if (serviceType === 'delivery' && di.address && deliveryAddressLineEl && deliveryAddressEl) {
                    deliveryAddressLineEl.style.display = 'block';
                    deliveryAddressEl.textContent = di.address;
                } else if (deliveryAddressLineEl) {
                    deliveryAddressLineEl.style.display = 'none';
                }

                if (serviceType === 'pickup' && di.storeLocation && storeLocationLineEl && storeLocationEl) {
                    storeLocationLineEl.style.display = 'block';
                    storeLocationEl.textContent = di.storeLocation;
                } else if (storeLocationLineEl) {
                    storeLocationLineEl.style.display = 'none';
                }
            }
            
            // Update payment info
            if (order.payment) {
                const paymentMethodEl = document.getElementById('paymentMethod');
                if (paymentMethodEl && order.payment.method) {
                    paymentMethodEl.textContent = order.payment.method.toUpperCase();
                }
                
                if (order.payment.gcashRefNo) {
                    const paymentCodeEl = document.getElementById('paymentCode');
                    const paymentCodeLineEl = document.getElementById('paymentCodeLine');
                    if (paymentCodeEl) paymentCodeEl.textContent = order.payment.gcashRefNo;
                    if (paymentCodeLineEl) paymentCodeLineEl.style.display = 'block';
                }
            }
            
            // Update date and time from order timestamp
            if (order.timestamp) {
                const orderDateEl = document.getElementById('orderDate');
                if (orderDateEl) {
                    const date = new Date(order.timestamp);
                    orderDateEl.textContent = date.toLocaleDateString('en-US', {month: '2-digit', day: '2-digit', year: 'numeric'});
                }
            }

            // Loyalty points (signed-in customers)
            loadAndRenderLoyalty(total);
        }
    }

    // Expose functions to window
    window.completionReceipt = {
        goToAccount,
        printReceipt,
        saveReceipt
    };

    // Global functions for onclick handlers
    window.goToAccount = goToAccount;
    window.printReceipt = printReceipt;
    window.saveReceipt = saveReceipt;

    // Clear the "pending receipt" key when we successfully land on the receipt page.
    // This key is set by checkout.js before redirecting here; if we don't clear it,
    // the next time the user goes cart_review → checkout, checkout would see the
    // stale key and immediately redirect back to the receipt (bug).
    const PENDING_RECEIPT_KEY = 'ppp_pending_receipt_url';
    try {
        window.localStorage?.removeItem(PENDING_RECEIPT_KEY);
    } catch (e) {}

    // Initialize on DOM ready
    document.addEventListener('DOMContentLoaded', () => {
        initializeReceipt();

        // Use cached order data when coming from order details (faster and works if Firestore is slow)
        const cached = consumeCachedReceiptOrder();
        if (cached?.order) {
            populateReceiptFromOrder(cached.order, cached.orderId || urlParams.get('orderId'));
        }

        loadOrderFromFirestore();
    });
})();




