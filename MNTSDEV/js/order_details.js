(() => {
  'use strict';

  function goHome() { window.location.href = 'index.html'; }
  function goToMenu() { window.location.href = 'menu.html'; }
  function goToCart() { window.location.href = 'cart_review.html'; }

  const GUEST_CART_KEY = 'ppp_guest_cart';
  const itemAvailability = {};
  const missingItemsCache = new Set();

  // Expose nav helpers to inline handlers
  window.goHome = goHome;
  window.goToMenu = goToMenu;
  window.goToCart = goToCart;

  let currentOrderForReceipt = null;
  let currentOrderIdForReceipt = null;
  let unsubscribeOrderListener = null;

  const DELIVERY_TRACKER_STEPS = [
    { key: 'pending', label: 'Pending' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'out_for_delivery', label: 'Out for Delivery' },
    { key: 'completed', label: 'Completed' }
  ];

  async function waitForFirebaseReady(maxAttempts = 120, delayMs = 100) {
    let attempts = 0;
    while (!window.firebaseReady && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempts++;
    }
  }

  function safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function toBoolAvailability(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const v = value.toLowerCase();
      if (v === 'available' || v === 'yes' || v === 'true') return true;
      if (v === 'unavailable' || v === 'no' || v === 'false') return false;
    }
    return true;
  }

  function checkMasServingPerDayAvailability(item) {
    if (!item) return false;
    
    // Check maxServingsPerDay to determine availability
    // null/undefined means unlimited (available), only 0 or negative means unavailable
    const maxServingsPerDay = typeof item.maxServingsPerDay === 'number' 
      ? item.maxServingsPerDay 
      : (typeof item.maxServingsPerDay === 'string' 
        ? parseFloat(item.maxServingsPerDay) 
        : null);

    // If maxServingsPerDay is null/undefined, item is available (unlimited)
    // Only 0 or negative means unavailable
    return maxServingsPerDay === null || maxServingsPerDay === undefined || (!isNaN(maxServingsPerDay) && maxServingsPerDay > 0);
  }

  function setCartCountShared(count) {
    const next = Math.max(0, safeNumber(count, 0));
    if (typeof window.setCartCount === 'function') {
      window.setCartCount(next);
      return;
    }
    try {
      window.localStorage?.setItem('ppp_cart_count', String(next));
    } catch (e) {}
    document.querySelectorAll('.cart-badge').forEach((badge) => {
      badge.textContent = String(next);
    });
    document.dispatchEvent(new CustomEvent('cart:count-changed', { detail: { count: next } }));
  }

  async function verifyOrderItems(items) {
    const missingNames = [];
    const idsToCheck = Array.from(
      new Set(
        (Array.isArray(items) ? items : [])
          .map((it) => it?.itemId)
          .filter(Boolean)
      )
    );

    if (!Array.isArray(items) || !items.length) {
      return { ok: false, message: 'Order has no items.', missingNames };
    }

    // If any item is missing an itemId, treat it as unavailable
    items.forEach((it) => {
      if (!it?.itemId) {
        missingNames.push(it?.name || 'Item');
      }
    });

    try {
      await waitForFirebaseReady();
      if (!window.firestore?.fetchMenuItemById) {
        return { ok: false, message: 'Menu data is unavailable right now.', missingNames };
      }

      for (const id of idsToCheck) {
        if (Object.prototype.hasOwnProperty.call(itemAvailability, id)) continue;
        try {
          const item = await window.firestore.fetchMenuItemById(id);
          const exists = !!item && item.active !== false;
          // Use masServingPerDay to check availability
          const available = exists && checkMasServingPerDayAvailability(item);
          itemAvailability[id] = available;
          if (!available) missingItemsCache.add(id);
        } catch (e) {
          console.warn('Failed to check menu item for reorder:', e);
          itemAvailability[id] = false;
          missingItemsCache.add(id);
        }
      }

      (Array.isArray(items) ? items : []).forEach((it) => {
        const id = it?.itemId;
        if (!id) return;
        const available = itemAvailability[id];
        if (!available) {
          missingNames.push(it?.name || 'Item');
        }
      });

      const uniqueMissing = [...new Set(missingNames)];
      const ok = uniqueMissing.length === 0;
      return {
        ok,
        missingNames: uniqueMissing,
        message: ok
          ? ''
          : `Some items no longer exist and cannot be added to cart: ${uniqueMissing.join(', ')}`
      };
    } catch (error) {
      console.error('Error verifying order items for reorder:', error);
      return { ok: false, message: 'Could not verify menu items.', missingNames };
    }
  }

  function setReorderButtonState(btn, { allowed, message = '', checking = false } = {}) {
    if (!btn) return;
    const label = btn.querySelector('span') || btn;
    // Keep button clickable so the user can see the error alert on click
    btn.disabled = checking;
    btn.classList.toggle('disabled', checking);
    btn.style.opacity = checking ? '0.6' : '';
    btn.style.cursor = checking ? 'wait' : '';
    btn.title = message || '';
    if (label) {
      label.textContent = checking ? 'Checking...' : allowed ? 'Reorder' : 'Unavailable';
    }
  }

  function normalizeCartItems(items) {
    return (Array.isArray(items) ? items : []).map((it, idx) => {
      const qty = safeNumber(it.quantity, 1) || 1;
      const unit = safeNumber(it.unitPrice, safeNumber(it.price, 0));
      const lineTotal = safeNumber(it.lineTotal, unit * qty);
      return {
        id: it.itemId || `reorder-${Date.now()}-${idx}`,
        itemId: it.itemId || null,
        name: it.name || 'Item',
        imageUrl: it.imageUrl || null,
        price: lineTotal,
        quantity: qty,
        variation: it.variation || null,
        sauce: it.sauce || null
      };
    });
  }

  function renderOrderNotFound() {
    const titleEl = document.getElementById('orderTitle');
    if (titleEl) titleEl.textContent = 'Order not found';
    const box = document.getElementById('orderBox');
    if (box) box.style.display = 'none';
  }

  function normalizeTrackerStatus(rawStatus) {
    const raw = (rawStatus || '').toString().trim().toLowerCase();
    if (!raw) return 'pending';
    
    // Check for cancelled/declined statuses first
    if (raw === 'cancelled' || raw === 'canceled' || raw === 'declined') {
      return 'cancelled';
    }
    
    // Map to standardized status keys (simplified to 4 statuses)
    if (raw === 'completed' || raw === 'delivered') return 'completed';
    if (raw === 'out_for_delivery' || raw === 'out for delivery' || 
        raw.includes('out') && raw.includes('delivery') ||
        raw.includes('driver') || raw.includes('rider') || raw.includes('courier') ||
        raw.includes('on_the_way') || raw.includes('on the way') || raw.includes('on-the-way')) {
      return 'out_for_delivery';
    }
    if (raw === 'preparing' || raw === 'being-cooked' || raw === 'cooking' || 
        raw.includes('preparing') || raw === 'ready' || raw === 'confirmed' || 
        raw === 'accepted' || raw === 'new') {
      // Map ready, confirmed, accepted, new to preparing
      return 'preparing';
    }
    if (raw === 'pending') return 'pending';
    
    // Default fallback
    return 'pending';
  }

  function deriveStatusInfo(rawStatus) {
    const trackerKey = normalizeTrackerStatus(rawStatus || 'pending');
    const labelMap = {
      pending: 'Pending',
      preparing: 'Preparing',
      out_for_delivery: 'Out for Delivery',
      completed: 'Completed',
      delivered: 'Completed',
      cancelled: 'Cancelled',
      canceled: 'Cancelled',
      declined: 'Declined'
    };
    return {
      trackerKey,
      label: labelMap[trackerKey] || (rawStatus ? String(rawStatus).charAt(0).toUpperCase() + String(rawStatus).slice(1) : 'Pending'),
      isCompleted: trackerKey === 'completed' || trackerKey === 'delivered',
      isCancelled: trackerKey === 'cancelled'
    };
  }

  const PICKUP_TRACKER_STEPS = [
    { key: 'pending', label: 'Pending' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'completed', label: 'Completed' }
  ];

  function renderDeliveryTracker(trackerEl, trackerStatusKey) {
    if (!trackerEl) return;
    if (!trackerStatusKey) {
      trackerEl.style.display = 'none';
      trackerEl.innerHTML = '';
      return;
    }

    const activeIdx = Math.max(
      0,
      DELIVERY_TRACKER_STEPS.findIndex((step) => step.key === trackerStatusKey)
    );

    // Calculate progress percentage for the progress bar
    const progress = activeIdx >= 0 ? ((activeIdx + 1) / DELIVERY_TRACKER_STEPS.length) * 100 : 0;
    trackerEl.style.setProperty('--progress', `${progress}%`);

    trackerEl.style.display = 'flex';
    trackerEl.innerHTML = DELIVERY_TRACKER_STEPS
      .map((step, idx) => {
        const isActive = idx === activeIdx;
        const isCompleted = idx < activeIdx;
        const classes = ['od-step'];
        if (isActive) classes.push('active');
        if (isCompleted) classes.push('completed');
        return `<div class="${classes.join(' ')}" data-step="${step.key}"><span>${step.label}</span></div>`;
      })
      .join('');
  }

  function renderPickupTracker(trackerEl, trackerStatusKey) {
    if (!trackerEl) return;
    if (!trackerStatusKey) {
      trackerEl.style.display = 'none';
      trackerEl.innerHTML = '';
      return;
    }

    // Map delivery statuses to pickup statuses (skip out_for_delivery)
    let mappedKey = trackerStatusKey;
    if (trackerStatusKey === 'out_for_delivery') {
      mappedKey = 'preparing'; // For pickup, "out for delivery" maps to "preparing"
    }

    const activeIdx = Math.max(
      0,
      PICKUP_TRACKER_STEPS.findIndex((step) => step.key === mappedKey)
    );

    // Calculate progress percentage for the progress bar
    const progress = activeIdx >= 0 ? ((activeIdx + 1) / PICKUP_TRACKER_STEPS.length) * 100 : 0;
    trackerEl.style.setProperty('--progress', `${progress}%`);

    trackerEl.style.display = 'flex';
    trackerEl.innerHTML = PICKUP_TRACKER_STEPS
      .map((step, idx) => {
        const isActive = idx === activeIdx;
        const isCompleted = idx < activeIdx;
        const classes = ['od-step'];
        if (isActive) classes.push('active');
        if (isCompleted) classes.push('completed');
        return `<div class="${classes.join(' ')}" data-step="${step.key}"><span>${step.label}</span></div>`;
      })
      .join('');
  }

  async function seedCartWithItems(cartItems) {
    const totalQty = (Array.isArray(cartItems) ? cartItems : []).reduce(
      (sum, item) => sum + safeNumber(item.quantity, 0),
      0
    );

    try {
      await waitForFirebaseReady();
      const db = window.firebaseDb;
      const auth = window.firebaseAuth;
      const user = auth?.currentUser;

      if (user && db && window.doc && window.collection && window.getDocs && window.deleteDoc && window.setDoc) {
        const customerRef = window.doc(db, 'customers', user.uid);
        const cartCol = window.collection(customerRef, 'cartItems');
        const snap = await window.getDocs(cartCol);
        for (const docSnap of snap.docs) {
          await window.deleteDoc(docSnap.ref);
        }
        for (const item of cartItems) {
          const cartDoc = window.doc(cartCol);
          await window.setDoc(cartDoc, {
            itemId: item.itemId,
            name: item.name,
            imageUrl: item.imageUrl,
            price: item.price,
            quantity: item.quantity,
            variation: item.variation || null,
            sauce: item.sauce || null,
            createdAt: new Date()
          });
        }
      } else {
        window.localStorage?.setItem(GUEST_CART_KEY, JSON.stringify(cartItems));
      }

      setCartCountShared(totalQty);

      if (typeof window.goToCart === 'function') {
        window.goToCart();
      } else {
        window.location.href = 'cart_review.html';
      }
    } catch (error) {
      console.error('Error while seeding cart for reorder:', error);
      if (window.showAlert) {
        window.showAlert('Could not reorder right now. Please try again.', 'error');
      } else {
        alert('Could not reorder right now. Please try again.');
      }
    }
  }

  async function checkReorderAvailability(order, displayStatus, reorderBtn) {
    if (!reorderBtn) return false;
    reorderBtn.style.display = '';
    setReorderButtonState(reorderBtn, { allowed: false, checking: true, message: 'Checking menu availability...' });
    const items = Array.isArray(order.items) ? order.items : [];
    const { ok, message, missingNames } = await verifyOrderItems(items);
    setReorderButtonState(reorderBtn, {
      allowed: true,
      message: message || (missingNames?.length ? `Unavailable: ${missingNames.join(', ')}` : '')
    });
    return ok;
  }

  async function handleReorder(order, displayStatus, reorderBtn) {
    const items = Array.isArray(order.items) ? order.items : [];
    const { ok, message, missingNames } = await verifyOrderItems(items);
    if (!ok) {
      setReorderButtonState(reorderBtn, {
        allowed: false,
        message: message || (missingNames?.length ? `Unavailable: ${missingNames.join(', ')}` : 'Item unavailable')
      });
      if (message || (missingNames && missingNames.length)) {
        if (window.showAlert) {
          window.showAlert(message || `Unavailable: ${missingNames.join(', ')}`, 'error');
        } else {
          alert(message || `Unavailable: ${missingNames.join(', ')}`);
        }
      }
      return;
    }

    const cartItems = normalizeCartItems(items);
    await seedCartWithItems(cartItems);
  }

  function getSelectedOrderId() {
    const params = new URLSearchParams(window.location.search);
    const idFromQuery = params.get('orderId');
    if (idFromQuery) return idFromQuery;
    try {
      const stored = localStorage.getItem('selectedOrderId');
      if (stored) return stored;
    } catch (e) {}
    return null;
  }

  async function fetchOrderFromFirestore(orderId) {
    try {
      await waitForFirebaseReady();
      const db = window.firebaseDb;
      if (!db || !window.doc || !window.getDoc) {
        console.warn('Firebase not fully initialized for order_details load');
        return null;
      }
      const ref = window.doc(db, 'orders', orderId);
      const snap = await window.getDoc(ref);
      if (!snap.exists()) return null;
      return { id: snap.id, ...(snap.data() || {}) };
    } catch (e) {
      console.error('Error loading order from Firestore for details page:', e);
      return null;
    }
  }

  async function subscribeToOrderUpdates(orderId) {
    try {
      await waitForFirebaseReady();
      const db = window.firebaseDb;
      if (!db || !window.doc || !window.onSnapshot) return null;
      const ref = window.doc(db, 'orders', orderId);
      return window.onSnapshot(
        ref,
        (snap) => {
          if (!snap.exists()) {
            renderOrderNotFound();
            return;
          }
          const data = { id: snap.id, ...(snap.data() || {}) };
          populateOrder(data, orderId);
        },
        (error) => {
          console.error('Order live update failed:', error);
        }
      );
    } catch (error) {
      console.error('Error subscribing to order updates:', error);
      return null;
    }
  }

  function populateOrder(order, orderId) {
    const titleEl = document.getElementById('orderTitle');
    const idEl = document.getElementById('orderId');
    const dateEl = document.getElementById('orderDate');
    const totalEl = document.getElementById('orderTotal');
    const statusEl = document.getElementById('orderStatus');
    const itemsContainer = document.getElementById('orderItems');
    const serviceSegment = document.getElementById('serviceSegment');
    const serviceDetailsEl = document.getElementById('serviceDetails');
    const chipsEl = document.getElementById('metaChips');
    const tracker = document.getElementById('tracker');
    const paymentSubtitleEl = document.getElementById('paymentSubtitle');
    const receiptEl = document.getElementById('receipt');
    const reorderBtn = document.getElementById('reorderBtn');
    const receiptBtn = document.getElementById('receiptBtn');
    const reviewsSegment = document.getElementById('reviewsSegment');
    const orderItemReviews = document.getElementById('orderItemReviews');

    const displayId = orderId || order.id || '—';
    if (titleEl) titleEl.textContent = `Order ${displayId}`;
    if (idEl) idEl.textContent = `Order ${displayId}`;

    // Date
    const rawTs = order.timestamp || order.createdAt || null;
    if (dateEl) {
      if (rawTs) {
        const d = rawTs?.toDate ? rawTs.toDate() : new Date(rawTs);
        dateEl.textContent = !Number.isNaN(d.getTime())
          ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          : String(rawTs);
      } else {
        dateEl.textContent = '';
      }
    }

    // Status
    const rawStatus = order.status || 'pending';
    const statusInfo = deriveStatusInfo(rawStatus);
    const displayStatus = statusInfo.label.toLowerCase();
    if (statusEl) {
      statusEl.textContent = statusInfo.label;
      statusEl.parentElement.classList.toggle('completed', statusInfo.isCompleted);
    }

    // Total
    const numericTotal =
      typeof order.total === 'number'
        ? order.total
        : Number(order.total) || 0;
    if (totalEl) totalEl.textContent = `₱${numericTotal.toFixed(2)}`;

    // Items list
    const items = Array.isArray(order.items) ? order.items : [];
    const auth = window.firebaseAuth;
    const user = auth?.currentUser;
    const isCompleted = statusInfo.isCompleted;
    
    if (itemsContainer) {
      itemsContainer.innerHTML = items
        .map((it, index) => {
          const name = it.name || 'Item';
          const qty =
            typeof it.quantity === 'number'
              ? it.quantity
              : Number(it.quantity) || 1;
          const lineTotal =
            typeof it.lineTotal === 'number'
              ? it.lineTotal
              : Number(it.lineTotal) || 0;
          const itemId = it.itemId || '';
          
          // Show review button only for completed orders and authenticated users
          const reviewButton = (isCompleted && user && itemId) ? `
            <button class="od-item-review-btn" onclick="orderDetails.toggleItemReview('${itemId}', ${index})" data-item-id="${itemId}">
              Write a Review
            </button>
          ` : '';
          
          return `
              <div class="od-item-row" data-item-index="${index}">
                <div class="od-item-info">
                  <span>${name} x ${qty}</span>
                  <span>₱${lineTotal.toFixed(2)}</span>
                </div>
                ${reviewButton}
              </div>
            `;
        })
        .join('');
    }

    // Service info from deliveryInfo
    const di = order.deliveryInfo || {};
    if (di.serviceType) {
      const type = di.serviceType;
      let subtitle = '';
      if (type === 'dinein' || type === 'dine-in') {
        subtitle = `Dine-In${di.tableNumber ? ' • Table ' + di.tableNumber : ''}`;
      } else if (type === 'pickup') {
        subtitle = `Pickup${di.storeLocation ? ' • ' + di.storeLocation : ''}`;
      } else if (type === 'delivery') {
        subtitle = `Delivery${di.address ? ' • ' + di.address : ''}`;
      } else {
        subtitle = type;
      }

      if (serviceDetailsEl) {
        const lines = [];
        lines.push(`<div>Service: ${subtitle}</div>`);
        if (type === 'delivery' && di.address) {
          lines.push(`<div>Address: ${di.address}</div>`);
        }
        if ((type === 'dinein' || type === 'dine-in') && di.tableNumber) {
          lines.push(`<div>Table: ${di.tableNumber}</div>`);
        }
        if (type === 'pickup' && di.storeLocation) {
          lines.push(`<div>Store: ${di.storeLocation}</div>`);
        }
        serviceDetailsEl.innerHTML = lines.join('');
      }
      if (serviceSegment) serviceSegment.style.display = 'block';

      if (chipsEl) {
        chipsEl.style.display = 'flex';
        chipsEl.innerHTML = '';
        const chip = document.createElement('span');
        chip.className = 'popular-tag';
        chip.textContent = subtitle;
        chipsEl.appendChild(chip);
      }

      // For cancelled/declined orders, show decline reason instead of tracker
      if (statusInfo.isCancelled && tracker) {
        tracker.style.display = 'block';
        tracker.innerHTML = '';
        
        // Get decline reason from order data
        const declineReason = order.declineReason || order.paymentDeclineReason || 'Order was cancelled';
        const declineDate = order.declinedAt || order.paymentDeclinedAt || order.updatedAt || order.createdAt;
        
        let declineHtml = `
          <div style="padding: 16px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; margin-top: 12px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <i class="fas fa-times-circle" style="color: #ff9800; font-size: 1.2em;"></i>
              <strong style="color: #856404;">Order ${statusInfo.label}</strong>
            </div>
            <div style="color: #856404; font-size: 0.95em; line-height: 1.5;">
              <div style="margin-bottom: 4px;"><strong>Reason:</strong></div>
              <div>${declineReason}</div>
            </div>
        `;
        
        if (declineDate) {
          const dateObj = declineDate.toDate ? declineDate.toDate() : new Date(declineDate);
          if (!Number.isNaN(dateObj.getTime())) {
            declineHtml += `
              <div style="margin-top: 8px; font-size: 0.85em; color: #856404; opacity: 0.8;">
                Declined on: ${dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} at ${dateObj.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </div>
            `;
          }
        }
        
        declineHtml += `</div>`;
        tracker.innerHTML = declineHtml;
      } else if (type === 'delivery' && tracker) {
        // Delivery tracker synced to order status
        renderDeliveryTracker(tracker, statusInfo.trackerKey);
      } else if ((type === 'pickup' || type === 'dinein' || type === 'dine-in') && tracker) {
        // For pickup/dine-in, show simplified tracker without "out_for_delivery"
        renderPickupTracker(tracker, statusInfo.trackerKey);
      } else if (tracker) {
        tracker.style.display = 'none';
        tracker.innerHTML = '';
      }
    } else if (tracker) {
      tracker.style.display = 'none';
      tracker.innerHTML = '';
    }

    // Payment-style breakdown (like completion_receipt_page)
    if (receiptEl) {
      const itemsSubtotal = items.reduce((sum, it) => {
        const lineTotal =
          typeof it.lineTotal === 'number'
            ? it.lineTotal
            : Number(it.lineTotal) || 0;
        return sum + lineTotal;
      }, 0);

      const isDelivery = (order.deliveryInfo && order.deliveryInfo.serviceType) === 'delivery';
      const deliveryFee = isDelivery ? 50 : 0;
      const discount = Math.max(0, itemsSubtotal + deliveryFee - numericTotal);

      const lines = [];
      lines.push(
        `<div style='display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;'>
             <span style="font-weight:700;">PABLO'S PERI PERI</span>
             <span style="font-size:0.85em; color:#666;">${new Date().toLocaleDateString()}</span>
           </div>`
      );
      lines.push(`<div style='height:1px; background:#e0e0e0; margin:6px 0 10px 0;'></div>`);
      lines.push(
        `<div style='display:flex; justify-content:space-between;'>
             <span>Sub-Total</span><span>₱${itemsSubtotal.toFixed(2)}</span>
           </div>`
      );
      if (isDelivery) {
        lines.push(
          `<div style='display:flex; justify-content:space-between;'>
               <span>Delivery Fee</span><span>₱${deliveryFee.toFixed(2)}</span>
             </div>`
        );
      }
      if (discount > 0) {
        lines.push(
          `<div style='display:flex; justify-content:space-between; color:#4caf50;'>
               <span>Discount / Points Applied</span><span>-₱${discount.toFixed(2)}</span>
             </div>`
        );
      }
      lines.push(`<div style='height:1px; background:#e0e0e0; margin:8px 0;'></div>`);
      lines.push(
        `<div style='display:flex; justify-content:space-between; font-weight:800;'>
             <span>Total</span><span>₱${numericTotal.toFixed(2)}</span>
           </div>`
      );

      receiptEl.innerHTML = lines.join('');
    }

    if (paymentSubtitleEl) {
      paymentSubtitleEl.textContent = 'See receipt for total breakdown';
    }

    // Actions
    if (reorderBtn) {
      // Only show reorder when the order is completed (not cancelled/declined)
      if (!statusInfo.isCompleted || statusInfo.isCancelled) {
        reorderBtn.style.display = 'none';
        reorderBtn.onclick = null;
      } else {
        reorderBtn.style.display = '';
        checkReorderAvailability(order, displayStatus, reorderBtn);
        reorderBtn.onclick = function () {
          handleReorder(order, displayStatus, reorderBtn);
        };
      }
    }

    if (receiptBtn) {
      receiptBtn.onclick = function () {
        if (currentOrderForReceipt) {
          openReceiptWindow(currentOrderForReceipt, currentOrderIdForReceipt);
        } else {
          window.print();
        }
      };
    }

    // Cache for receipt window
    currentOrderForReceipt = order;
    currentOrderIdForReceipt = orderId || order.id || null;

    // Show reviews section for completed orders (not cancelled/declined)
    if (statusInfo.isCompleted && !statusInfo.isCancelled && reviewsSegment && orderItemReviews) {
      const auth = window.firebaseAuth;
      const user = auth?.currentUser;
      
      if (user) {
        reviewsSegment.style.display = 'block';
        renderItemReviews(items, orderItemReviews);
      } else {
        reviewsSegment.style.display = 'none';
      }
    } else if (reviewsSegment) {
      reviewsSegment.style.display = 'none';
    }
  }

  async function renderItemReviews(items, container) {
    if (!container || !Array.isArray(items) || items.length === 0) {
      container.innerHTML = '';
      return;
    }

    const auth = window.firebaseAuth;
    const user = auth?.currentUser;
    if (!user) {
      container.innerHTML = '<p>Please sign in to review items.</p>';
      return;
    }

    // Load existing reviews for each item and create review containers (hidden by default)
    const reviewsHtml = await Promise.all(
      items.map(async (item, index) => {
        const itemId = item.itemId;
        if (!itemId) return '';

        const itemName = item.name || 'Item';
        let existingReview = null;
        
        try {
          const reviews = await window.firestore.fetchReviewsForItem(itemId);
          existingReview = reviews.find(r => r.userId === user.uid);
        } catch (e) {
          console.warn('Error loading reviews for item:', e);
        }

        return `
          <div class="od-review-item" data-item-id="${itemId}" data-item-index="${index}" style="display:none;">
            <div class="od-review-item-header">
              <h4>${itemName}</h4>
              ${existingReview ? '<span class="review-badge">Reviewed</span>' : ''}
            </div>
            ${existingReview ? `
              <div class="od-review-existing">
                <div class="od-review-rating">
                  ${'★'.repeat(Math.floor(existingReview.rating))}${'☆'.repeat(5 - Math.floor(existingReview.rating))}
                  <span>${existingReview.rating.toFixed(1)}</span>
                </div>
                <p class="od-review-text">${existingReview.text || 'No comment'}</p>
                <button class="od-review-edit-btn" onclick="orderDetails.editReview('${itemId}', '${existingReview.id}')">
                  Edit Review
                </button>
              </div>
            ` : `
              <div class="od-review-form-container">
                <div class="od-review-stars" data-item-id="${itemId}">
                  ${[1, 2, 3, 4, 5].map(i => `
                    <span class="od-review-star" data-rating="${i}" onclick="orderDetails.setItemRating('${itemId}', ${i})">
                      <i class="far fa-star"></i>
                    </span>
                  `).join('')}
                </div>
                <textarea 
                  class="od-review-textarea" 
                  id="review-text-${itemId}"
                  placeholder="Share your experience with this item..."
                  rows="3"
                ></textarea>
                <button 
                  class="od-review-submit-btn" 
                  onclick="orderDetails.submitItemReview('${itemId}')"
                  data-item-id="${itemId}"
                >
                  Submit Review
                </button>
              </div>
            `}
          </div>
        `;
      })
    );

    container.innerHTML = reviewsHtml.join('');
  }

  function toggleItemReview(itemId, itemIndex) {
    const reviewItem = document.querySelector(`.od-review-item[data-item-id="${itemId}"]`);
    const reviewBtn = document.querySelector(`.od-item-review-btn[data-item-id="${itemId}"]`);
    
    if (!reviewItem || !reviewBtn) return;
    
    const isVisible = reviewItem.style.display !== 'none';
    
    if (isVisible) {
      reviewItem.style.display = 'none';
      reviewBtn.textContent = 'Write a Review';
      reviewBtn.classList.remove('active');
    } else {
      reviewItem.style.display = 'block';
      reviewBtn.textContent = 'Close';
      reviewBtn.classList.add('active');
    }
  }

  let currentItemRatings = {};

  function setItemRating(itemId, rating) {
    currentItemRatings[itemId] = rating;
    const stars = document.querySelectorAll(`.od-review-stars[data-item-id="${itemId}"] .od-review-star`);
    stars.forEach((star, index) => {
      const icon = star.querySelector('i');
      if (index < rating) {
        icon.className = 'fas fa-star';
        icon.style.color = '#ffc107';
      } else {
        icon.className = 'far fa-star';
        icon.style.color = '#ddd';
      }
    });
  }

  function showNotification(message, type = 'success', showActions = false, onOk = null, onCancel = null) {
    const notification = document.getElementById('customNotification');
    const messageEl = document.getElementById('notificationMessage');
    const actionsEl = document.getElementById('notificationActions');
    const okBtn = document.getElementById('notificationOkBtn');
    const cancelBtn = document.getElementById('notificationCancelBtn');
    const closeBtn = document.getElementById('notificationCloseBtn');
    const iconEl = notification.querySelector('.custom-notification-icon i');

    if (!notification || !messageEl) return;

    // Set message
    messageEl.textContent = message;

    // Set icon based on type
    if (type === 'success') {
      iconEl.className = 'fas fa-check-circle';
      notification.classList.remove('error');
      notification.classList.add('success');
    } else if (type === 'error') {
      iconEl.className = 'fas fa-exclamation-circle';
      notification.classList.remove('success');
      notification.classList.add('error');
    } else {
      iconEl.className = 'fas fa-info-circle';
      notification.classList.remove('success', 'error');
    }

    // Show/hide actions
    if (showActions) {
      actionsEl.style.display = 'flex';
      okBtn.onclick = () => {
        hideNotification();
        if (onOk) onOk();
      };
      cancelBtn.onclick = () => {
        hideNotification();
        if (onCancel) onCancel();
      };
    } else {
      actionsEl.style.display = 'none';
    }

    // Close button
    closeBtn.onclick = () => {
      hideNotification();
      if (onCancel) onCancel();
    };

    // Show notification
    notification.style.display = 'flex';
    setTimeout(() => {
      notification.classList.add('show');
    }, 10);

    // Auto-hide after 3 seconds if no actions
    if (!showActions) {
      setTimeout(() => {
        hideNotification();
      }, 3000);
    }
  }

  function hideNotification() {
    const notification = document.getElementById('customNotification');
    if (notification) {
      notification.classList.remove('show');
      setTimeout(() => {
        notification.style.display = 'none';
      }, 300);
    }
  }

  async function submitItemReview(itemId) {
    const auth = window.firebaseAuth;
    const user = auth?.currentUser;
    if (!user) {
      showNotification('Please sign in to leave a review.', 'error');
      return;
    }

    const rating = currentItemRatings[itemId] || 0;
    if (rating === 0) {
      showNotification('Please select a rating.', 'error');
      return;
    }

    const textarea = document.getElementById(`review-text-${itemId}`);
    const text = textarea ? textarea.value.trim() : '';

    try {
      await window.firestore.saveReviewForItem({
        itemId,
        rating,
        text,
        anonymous: false
      });

      // Reload reviews and keep the review form open
      const orderItemReviews = document.getElementById('orderItemReviews');
      const order = currentOrderForReceipt;
      if (order && orderItemReviews) {
        await renderItemReviews(order.items || [], orderItemReviews);
        // Show the review item after reload
        const reviewItem = document.querySelector(`.od-review-item[data-item-id="${itemId}"]`);
        if (reviewItem) {
          reviewItem.style.display = 'block';
        }
      }
      
      // Show success notification with option to view item
      showNotification('Review submitted successfully!', 'success', true,
        () => {
          window.location.href = `food_item.html?id=${itemId}`;
        },
        () => {
          // Stay on page
        }
      );
    } catch (error) {
      console.error('Error submitting review:', error);
      showNotification(error.message || 'Failed to submit review. Please try again.', 'error');
    }
  }

  async function editReview(itemId, reviewId) {
    try {
      const reviews = await window.firestore.fetchReviewsForItem(itemId);
      const review = reviews.find(r => r.id === reviewId);
      if (!review) return;

      const container = document.querySelector(`.od-review-item[data-item-id="${itemId}"]`);
      if (!container) return;

      currentItemRatings[itemId] = review.rating;
      
      container.innerHTML = `
        <div class="od-review-item-header">
          <h4>${review.itemName || 'Item'}</h4>
        </div>
        <div class="od-review-form-container">
          <div class="od-review-stars" data-item-id="${itemId}">
            ${[1, 2, 3, 4, 5].map(i => `
              <span class="od-review-star" data-rating="${i}" onclick="orderDetails.setItemRating('${itemId}', ${i})">
                <i class="${i <= review.rating ? 'fas' : 'far'} fa-star" style="color: ${i <= review.rating ? '#ffc107' : '#ddd'}"></i>
              </span>
            `).join('')}
          </div>
          <textarea 
            class="od-review-textarea" 
            id="review-text-${itemId}"
            placeholder="Share your experience with this item..."
            rows="3"
          >${review.text || ''}</textarea>
          <button 
            class="od-review-submit-btn" 
            onclick="orderDetails.updateItemReview('${itemId}', '${reviewId}')"
            data-item-id="${itemId}"
          >
            Update Review
          </button>
        </div>
      `;
    } catch (error) {
      console.error('Error loading review for edit:', error);
      showNotification('Failed to load review for editing.', 'error');
    }
  }

  async function updateItemReview(itemId, reviewId) {
    const auth = window.firebaseAuth;
    const user = auth?.currentUser;
    if (!user) {
      showNotification('Please sign in to update a review.', 'error');
      return;
    }

    const rating = currentItemRatings[itemId] || 0;
    if (rating === 0) {
      showNotification('Please select a rating.', 'error');
      return;
    }

    const textarea = document.getElementById(`review-text-${itemId}`);
    const text = textarea ? textarea.value.trim() : '';

    try {
      await window.firestore.saveReviewForItem({
        itemId,
        rating,
        text,
        anonymous: false,
        reviewId
      });

      // Reload reviews and keep the review form open
      const orderItemReviews = document.getElementById('orderItemReviews');
      const order = currentOrderForReceipt;
      if (order && orderItemReviews) {
        await renderItemReviews(order.items || [], orderItemReviews);
        // Show the review item after reload
        const reviewItem = document.querySelector(`.od-review-item[data-item-id="${itemId}"]`);
        if (reviewItem) {
          reviewItem.style.display = 'block';
        }
      }
      
      showNotification('Review updated successfully!', 'success');
    } catch (error) {
      console.error('Error updating review:', error);
      showNotification(error.message || 'Failed to update review. Please try again.', 'error');
    }
  }

  function openReceiptWindow(order, orderId) {
    const targetOrderId = orderId || order?.id || getSelectedOrderId();
    try {
      // Cache order data so the receipt page can render immediately even if Firestore is slow
      window.localStorage?.setItem('ppp_receipt_order', JSON.stringify({ order, orderId: targetOrderId }));
    } catch (e) {}

    const url = targetOrderId
      ? `completion_receipt_page.html?orderId=${encodeURIComponent(targetOrderId)}&source=order_details`
      : 'completion_receipt_page.html?source=order_details';

    const win = window.open(url, '_blank');
    if (!win) {
      if (window.showAlert) {
        window.showAlert('Please allow popups to view the receipt.', 'warning');
      } else {
        alert('Please allow popups to view the receipt.');
      }
    }
  }

  async function loadOrder() {
    const orderId = getSelectedOrderId();
    let order = null;

    if (unsubscribeOrderListener) {
      unsubscribeOrderListener();
      unsubscribeOrderListener = null;
    }

    if (orderId) {
      unsubscribeOrderListener = await subscribeToOrderUpdates(orderId);
    }

    if (orderId) {
      order = await fetchOrderFromFirestore(orderId);
    }

    if (!order) {
      // Fallback to local cached object
      try {
        const raw = localStorage.getItem('selectedOrder');
        if (raw) order = JSON.parse(raw);
      } catch (e) {}
    }

    if (!order) {
      renderOrderNotFound();
      return;
    }

    populateOrder(order, orderId || order.id || null);
  }

  window.addEventListener('beforeunload', () => {
    if (unsubscribeOrderListener) {
      try {
        unsubscribeOrderListener();
      } catch (e) {}
    }
  });

  // Keep cart badge in sync on this page with shared localStorage value
  (function syncCartBadge() {
    const CART_COUNT_KEY = 'ppp_cart_count';

    function safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return fallback;
      return parsed;
    }

    function getStoredCartCount() {
      try {
        const raw = window.localStorage?.getItem(CART_COUNT_KEY);
        return safeNumber(raw, 0);
      } catch (e) {
        console.warn('Cart count read failed on order_details page:', e);
        return 0;
      }
    }

    function updateCartBadges(count) {
      const badges = document.querySelectorAll('.cart-badge');
      badges.forEach((badge) => {
        badge.textContent = String(Math.max(0, safeNumber(count, 0)));
      });
    }

    document.addEventListener('DOMContentLoaded', () => {
      updateCartBadges(getStoredCartCount());
    });

    document.addEventListener('cart:count-changed', (e) => {
      const count = typeof e.detail?.count === 'number'
        ? e.detail.count
        : getStoredCartCount();
      updateCartBadges(count);
    });
  })();

  // Expose functions to window
  window.orderDetails = {
    setItemRating,
    submitItemReview,
    editReview,
    updateItemReview,
    toggleItemReview
  };

  document.addEventListener('DOMContentLoaded', () => {
    loadOrder();
  });
})();
