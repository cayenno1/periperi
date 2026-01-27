// ============================================
// NOTIFICATION SYSTEM
// Handles order notifications, system updates, and declined order recomply
// Persisted in Firestore: customers/{uid}/notifs (subcollection)
// - Read/mark-all-as-read state is saved; no re-notifying on refresh for read items
// - Badge only shows for NEW unread notifications
// - Notifications auto-deleted after 7 days (Cloud Function)
// ============================================

(function() {
    'use strict';

    const NOTIFS_SUBCOLLECTION = 'notifs';

    let notifications = [];
    let unreadCount = 0;
    let orderListeners = new Map(); // orderId -> unsubscribe function
    let notifUnsubscribe = null;   // unsubscribe for notifs onSnapshot
    let isInitialized = false;
    let previousOrderStates = new Map(); // orderId -> previous order data
    let currentPage = 1;
    const NOTIFICATIONS_PER_PAGE = 10;
    let selectedNotifications = new Set(); // Set of notification IDs
    let isSelectionMode = false;

    // Notification types
    const NOTIFICATION_TYPES = {
        ORDER_STATUS_CHANGE: 'order_status_change',
        ORDER_DECLINED: 'order_declined',
        SYSTEM_UPDATE: 'system_update',
        PAYMENT_REQUIRED: 'payment_required',
        DISCOUNT_VERIFIED: 'discount_verified',
        DISCOUNT_DECLINED: 'discount_declined'
    };

    // Initialize notification system
    async function init() {
        if (isInitialized) return;

        // Wait for utils to be available
        if (window.utils && typeof window.utils.waitForFirebaseReady === 'function') {
            await window.utils.waitForFirebaseReady();
        }

        const user = window.firebaseAuth?.currentUser;
        if (user) {
            subscribeToNotifs(user.uid);
            setupOrderListeners(user);
        }

        // Listen for auth state changes
        if (window.onAuthStateChanged && window.firebaseAuth) {
            window.onAuthStateChanged(window.firebaseAuth, (user) => {
                if (user) {
                    subscribeToNotifs(user.uid);
                    setupOrderListeners(user);
                } else {
                    clearNotifications();
                }
            });
        }

        isInitialized = true;
        renderNotifications();
    }

    // Subscribe to Firestore notifs subcollection: customers/{uid}/notifs
    // Source of truth: only unread items drive the badge; read items stay read across refresh
    function subscribeToNotifs(uid) {
        if (!uid || !window.firebaseDb || !window.collection || !window.doc || !window.query || !window.orderBy || !window.limit || !window.onSnapshot) {
            console.warn('Firebase not ready for notifs subscription');
            return;
        }

        // Unsubscribe previous listener
        if (notifUnsubscribe) {
            try { notifUnsubscribe(); } catch (e) { console.warn('Notif unsubscribe error:', e); }
            notifUnsubscribe = null;
        }

        const notifsCol = window.collection(window.doc(window.firebaseDb, 'customers', uid), NOTIFS_SUBCOLLECTION);
        const q = window.query(
            notifsCol,
            window.orderBy('createdAt', 'desc'),
            window.limit(50)
        );

        notifUnsubscribe = window.onSnapshot(q, (snapshot) => {
            const previousCount = notifications.length;
            notifications = snapshot.docs.map((d) => {
                const data = d.data() || {};
                const createdAt = data.createdAt;
                let ts = Date.now();
                if (createdAt && typeof createdAt.toMillis === 'function') ts = createdAt.toMillis();
                else if (typeof createdAt === 'number') ts = createdAt;

                return {
                    id: d.id,
                    type: data.type || NOTIFICATION_TYPES.SYSTEM_UPDATE,
                    title: data.title || '',
                    message: data.message || '',
                    orderId: data.orderId || null,
                    orderNumber: data.orderNumber || null,
                    declineReason: data.declineReason || null,
                    oldStatus: data.oldStatus || null,
                    newStatus: data.newStatus || null,
                    actionRequired: !!data.actionRequired,
                    read: !!data.read,
                    timestamp: ts
                };
            });
            
            // Reset to page 1 if notifications count changed significantly
            const totalPages = Math.ceil(notifications.length / NOTIFICATIONS_PER_PAGE);
            if (currentPage > totalPages && totalPages > 0) {
                currentPage = totalPages;
            }
            
            // Remove deleted notifications from selection
            const existingIds = new Set(notifications.map(n => n.id));
            selectedNotifications.forEach(id => {
                if (!existingIds.has(id)) {
                    selectedNotifications.delete(id);
                }
            });
            
            updateUnreadCount();
            renderNotifications();
        }, (error) => {
            console.warn('Notifs snapshot error:', error);
        });
    }

    // Setup real-time listeners for user's orders
    async function setupOrderListeners(user) {
        if (!window.firebaseDb || !window.collection || !window.query || !window.where || !window.onSnapshot) {
            console.warn('Firebase functions not available for notifications');
            return;
        }

        // Clean up existing listeners
        orderListeners.forEach(unsub => {
            try { unsub(); } catch (e) { console.warn('Error unsubscribing listener:', e); }
        });
        orderListeners.clear();
        previousOrderStates.clear();

        try {
            const ordersCol = window.collection(window.firebaseDb, 'orders');

            // Listen to authenticated orders
            const authQuery = window.query(
                ordersCol,
                window.where('userId', '==', user.uid)
            );

            const unsubscribeAuth = window.onSnapshot(authQuery, (snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    const orderId = change.doc.id;
                    const newData = change.doc.data();
                    const oldData = previousOrderStates.get(orderId) || null;
                    previousOrderStates.set(orderId, { ...newData });
                    // Only 'modified' to avoid notifying for existing orders on first load
                    if (change.type === 'modified') {
                        handleOrderChange(orderId, oldData, newData);
                    }
                });
            }, (error) => { console.warn('Error in auth order listener:', error); });

            orderListeners.set('auth', unsubscribeAuth);

            // Listen to guest orders (by email)
            if (user.email) {
                const guestQuery = window.query(
                    ordersCol,
                    window.where('isGuest', '==', true)
                );

                const unsubscribeGuest = window.onSnapshot(guestQuery, (snapshot) => {
                    snapshot.docChanges().forEach((change) => {
                        const orderId = change.doc.id;
                        const data = change.doc.data();
                        const orderEmail = (data.customerInfo?.email || '').toLowerCase().trim();
                        const userEmail = (user.email || '').toLowerCase().trim();
                        if (orderEmail && orderEmail === userEmail) {
                            const oldData = previousOrderStates.get(orderId) || null;
                            previousOrderStates.set(orderId, { ...data });
                            if (change.type === 'modified') {
                                handleOrderChange(orderId, oldData, data);
                            }
                        }
                    });
                }, (error) => { console.warn('Error in guest order listener:', error); });

                orderListeners.set('guest', unsubscribeGuest);
            }
        } catch (error) {
            console.error('Error setting up order listeners:', error);
        }
    }

    // Handle order status changes
    function handleOrderChange(orderId, oldData, newData) {
        if (!newData) return;

        const oldStatus = (oldData?.status || 'pending').toLowerCase();
        const newStatus = (newData.status || 'pending').toLowerCase();
        const orderNumber = newData.orderNumber || newData.trackingId || orderId;
        const displayId = orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;

        if (newStatus === 'declined' && oldStatus !== 'declined') {
            const declineReason = newData.declineReason || 'Payment verification failed';
            addNotification({
                type: NOTIFICATION_TYPES.ORDER_DECLINED,
                title: 'Order Declined',
                message: `Order ${displayId} has been declined: ${declineReason}`,
                orderId: orderId,
                orderNumber: displayId,
                declineReason: declineReason,
                actionRequired: true
            });
            return;
        }

        if (oldStatus !== newStatus && oldStatus !== 'declined' && newStatus !== 'declined') {
            const statusLabels = {
                'pending': 'Pending',
                'preparing': 'In Kitchen',
                'ready': 'Ready',
                'out for delivery': 'Out for Delivery',
                'delivered': 'Done',
                'completed': 'Completed'
            };
            addNotification({
                type: NOTIFICATION_TYPES.ORDER_STATUS_CHANGE,
                title: 'Order Status Updated',
                message: `Order ${displayId} is now ${statusLabels[newStatus] || newStatus}`,
                orderId: orderId,
                orderNumber: displayId,
                oldStatus: oldStatus,
                newStatus: newStatus
            });
        }
    }

    // Add a new notification to Firestore (customers/{uid}/notifs)
    // Badge only increases when this creates a new unread doc; on refresh we load from Firestore and only count unread
    async function addNotification(payload) {
        const user = window.firebaseAuth?.currentUser;
        if (!user || !window.firebaseDb || !window.collection || !window.doc || !window.addDoc || !window.serverTimestamp) {
            return;
        }

        // Dedupe: same orderId + type within 5 seconds
        const exists = notifications.some(n =>
            n.orderId === payload.orderId &&
            n.type === payload.type &&
            (Date.now() - n.timestamp) < 5000
        );
        if (exists) return;

        const notifsCol = window.collection(window.doc(window.firebaseDb, 'customers', user.uid), NOTIFS_SUBCOLLECTION);
        const data = {
            type: payload.type,
            title: payload.title,
            message: payload.message,
            read: false,
            createdAt: window.serverTimestamp()
        };
        if (payload.orderId != null) data.orderId = payload.orderId;
        if (payload.orderNumber != null) data.orderNumber = payload.orderNumber;
        if (payload.declineReason != null) data.declineReason = payload.declineReason;
        if (payload.oldStatus != null) data.oldStatus = payload.oldStatus;
        if (payload.newStatus != null) data.newStatus = payload.newStatus;
        if (payload.actionRequired != null) data.actionRequired = !!payload.actionRequired;

        try {
            await window.addDoc(notifsCol, data);
            // onSnapshot will update notifications and badge
            showNotificationBadge();
        } catch (e) {
            console.warn('Error adding notification to Firestore:', e);
        }
    }

    // Add system notification
    function addSystemNotification(title, message) {
        addNotification({
            type: NOTIFICATION_TYPES.SYSTEM_UPDATE,
            title: title,
            message: message
        });
    }

    // Update unread count and badge (only unread drive the badge; no re-notify for read on refresh)
    function updateUnreadCount() {
        unreadCount = notifications.filter(n => !n.read).length;
        const badge = document.getElementById('notificationBadge');
        if (badge) {
            if (unreadCount > 0) {
                badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        }
    }

    // Render notifications with pagination
    function renderNotifications() {
        const list = document.getElementById('notificationList');
        const empty = document.getElementById('notificationEmpty');
        const paginationContainer = document.getElementById('notificationPagination');
        const selectionControls = document.getElementById('notificationSelectionControls');
        
        if (!list) return;

        if (notifications.length === 0) {
            if (empty) empty.style.display = 'block';
            list.innerHTML = '';
            if (paginationContainer) paginationContainer.style.display = 'none';
            if (selectionControls) selectionControls.style.display = 'none';
            return;
        }

        if (empty) empty.style.display = 'none';

        // Calculate pagination
        const totalPages = Math.ceil(notifications.length / NOTIFICATIONS_PER_PAGE);
        const startIndex = (currentPage - 1) * NOTIFICATIONS_PER_PAGE;
        const endIndex = startIndex + NOTIFICATIONS_PER_PAGE;
        const paginatedNotifications = notifications.slice(startIndex, endIndex);

        // Render selection controls - buttons are already in HTML, just update their state
        if (selectionControls) {
            if (isSelectionMode) {
                selectionControls.style.display = 'flex';
                const selectAllBtn = document.getElementById('selectAllNotifications');
                const deleteSelectedBtn = document.getElementById('deleteSelectedNotifications');
                
                if (selectAllBtn) {
                    const allSelected = paginatedNotifications.length > 0 && 
                                      paginatedNotifications.every(n => selectedNotifications.has(n.id));
                    selectAllBtn.innerHTML = allSelected ? 
                        '<i class="fas fa-square"></i> Deselect All' : 
                        '<i class="fas fa-check-square"></i> Select All';
                }
                
                if (deleteSelectedBtn) {
                    const selectedCount = Array.from(selectedNotifications).filter(id => 
                        paginatedNotifications.some(n => n.id === id)
                    ).length;
                    deleteSelectedBtn.disabled = selectedCount === 0;
                    deleteSelectedBtn.innerHTML = `<i class="fas fa-trash"></i> Delete (${selectedCount})`;
                }
            } else {
                selectionControls.style.display = 'none';
            }
        }

        // Render notification items
        list.innerHTML = paginatedNotifications.map(notif => {
            const date = new Date(notif.timestamp);
            const timeAgo = getTimeAgo(date);
            const icon = getNotificationIcon(notif.type);
            const readClass = notif.read ? 'read' : 'unread';
            const isSelected = selectedNotifications.has(notif.id);
            const checkboxHtml = isSelectionMode ? `
                <input type="checkbox" 
                       class="notification-checkbox" 
                       data-notification-id="${escapeHtml(notif.id)}"
                       ${isSelected ? 'checked' : ''}
                       onclick="event.stopPropagation(); window.notifications?.toggleNotificationSelection('${escapeHtml(notif.id)}')">
            ` : '';

            return `
                <div class="notification-item ${readClass} ${isSelected ? 'selected' : ''}" 
                     data-notification-id="${escapeHtml(notif.id)}" 
                     onclick="${isSelectionMode ? '' : `window.notifications?.handleNotificationClick('${escapeHtml(notif.id)}')`}">
                    ${checkboxHtml}
                    <div class="notification-icon-small">${icon}</div>
                    <div class="notification-content">
                        <div class="notification-title">${escapeHtml(notif.title)}</div>
                        <div class="notification-message">${escapeHtml(notif.message)}</div>
                        <div class="notification-time">${timeAgo}</div>
                        ${notif.type === NOTIFICATION_TYPES.ORDER_DECLINED && notif.actionRequired && !isSelectionMode ? `
                            <button class="notification-action-btn" onclick="event.stopPropagation(); window.notifications?.recomplyOrder('${escapeHtml(notif.orderId || '')}')">
                                <i class="fas fa-redo"></i> Recomply
                            </button>
                        ` : ''}
                    </div>
                    ${!notif.read ? '<div class="notification-dot"></div>' : ''}
                </div>
            `;
        }).join('');

        // Render pagination controls
        if (paginationContainer && totalPages > 1) {
            paginationContainer.style.display = 'flex';
            paginationContainer.innerHTML = `
                <button class="notification-pagination-btn" 
                        ${currentPage === 1 ? 'disabled' : ''} 
                        onclick="event.stopPropagation(); window.notifications?.goToPage(${currentPage - 1})">
                    <i class="fas fa-chevron-left"></i> Previous
                </button>
                <span class="notification-pagination-info">Page ${currentPage} of ${totalPages}</span>
                <button class="notification-pagination-btn" 
                        ${currentPage === totalPages ? 'disabled' : ''} 
                        onclick="event.stopPropagation(); window.notifications?.goToPage(${currentPage + 1})">
                    Next <i class="fas fa-chevron-right"></i>
                </button>
            `;
        } else if (paginationContainer) {
            paginationContainer.style.display = 'none';
        }
    }

    function getNotificationIcon(type) {
        const icons = {
            [NOTIFICATION_TYPES.ORDER_STATUS_CHANGE]: '<i class="fas fa-shopping-bag"></i>',
            [NOTIFICATION_TYPES.ORDER_DECLINED]: '<i class="fas fa-times-circle"></i>',
            [NOTIFICATION_TYPES.SYSTEM_UPDATE]: '<i class="fas fa-info-circle"></i>',
            [NOTIFICATION_TYPES.PAYMENT_REQUIRED]: '<i class="fas fa-credit-card"></i>',
            [NOTIFICATION_TYPES.DISCOUNT_VERIFIED]: '<i class="fas fa-id-card"></i>',
            [NOTIFICATION_TYPES.DISCOUNT_DECLINED]: '<i class="fas fa-id-card"></i>'
        };
        return icons[type] || '<i class="fas fa-bell"></i>';
    }

    function getTimeAgo(date) {
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'Just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    function escapeHtml(text) {
        if (text == null) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    function toggleDropdown() {
        const dropdown = document.getElementById('notificationDropdown');
        if (!dropdown) return;

        if (dropdown.style.display === 'none' || !dropdown.style.display) {
            dropdown.style.display = 'flex';
            currentPage = 1; // Reset to first page when opening
            renderNotifications();
        } else {
            dropdown.style.display = 'none';
            // Exit selection mode when closing
            if (isSelectionMode) {
                exitSelectionMode();
            }
        }
    }

    function goToPage(page) {
        const totalPages = Math.ceil(notifications.length / NOTIFICATIONS_PER_PAGE);
        if (page >= 1 && page <= totalPages) {
            currentPage = page;
            renderNotifications();
            // Scroll to top of notification list
            const list = document.getElementById('notificationList');
            if (list) {
                list.scrollTop = 0;
            }
        }
    }

    function toggleSelectionMode() {
        isSelectionMode = !isSelectionMode;
        if (!isSelectionMode) {
            exitSelectionMode();
        } else {
            selectedNotifications.clear();
        }
        renderNotifications();
    }

    function exitSelectionMode() {
        isSelectionMode = false;
        selectedNotifications.clear();
    }

    function toggleNotificationSelection(notificationId) {
        if (selectedNotifications.has(notificationId)) {
            selectedNotifications.delete(notificationId);
        } else {
            selectedNotifications.add(notificationId);
        }
        renderNotifications();
    }

    function selectAllNotifications() {
        const list = document.getElementById('notificationList');
        if (!list) return;
        
        const totalPages = Math.ceil(notifications.length / NOTIFICATIONS_PER_PAGE);
        const startIndex = (currentPage - 1) * NOTIFICATIONS_PER_PAGE;
        const endIndex = startIndex + NOTIFICATIONS_PER_PAGE;
        const paginatedNotifications = notifications.slice(startIndex, endIndex);
        
        const allSelected = paginatedNotifications.every(n => selectedNotifications.has(n.id));
        
        if (allSelected) {
            // Deselect all on current page
            paginatedNotifications.forEach(n => selectedNotifications.delete(n.id));
        } else {
            // Select all on current page
            paginatedNotifications.forEach(n => selectedNotifications.add(n.id));
        }
        renderNotifications();
    }

    async function deleteSelectedNotifications() {
        const selectedIds = Array.from(selectedNotifications);
        if (selectedIds.length === 0) return;

        const count = selectedIds.length;
        const message = count === 1 
            ? 'Are you sure you want to delete this notification? This action cannot be undone.'
            : `Are you sure you want to delete ${count} notifications? This action cannot be undone.`;

        // Use custom modal instead of browser confirm
        if (window.showConfirm && typeof window.showConfirm === 'function') {
            window.showConfirm(message, async () => {
                await performDelete(selectedIds);
            }, () => {
                // User cancelled, do nothing
            });
        } else {
            // Fallback to browser confirm if modal not available
            if (!confirm(message)) {
                return;
            }
            await performDelete(selectedIds);
        }
    }

    async function performDelete(selectedIds) {
        const user = window.firebaseAuth?.currentUser;
        if (!user || !window.firebaseDb || !window.doc || !window.deleteDoc) {
            const errorMsg = 'Unable to delete notifications. Please try again.';
            if (window.showAlert && typeof window.showAlert === 'function') {
                window.showAlert(errorMsg, 'error');
            } else if (window.utils && typeof window.utils.showModal === 'function') {
                window.utils.showModal(errorMsg, {
                    type: 'error',
                    title: 'Error'
                });
            } else {
                alert(errorMsg);
            }
            return;
        }

        try {
            // Delete all selected notifications
            for (const notifId of selectedIds) {
                const ref = window.doc(window.firebaseDb, 'customers', user.uid, NOTIFS_SUBCOLLECTION, notifId);
                await window.deleteDoc(ref);
            }
            
            // Clear selection and exit selection mode
            selectedNotifications.clear();
            exitSelectionMode();
            
            // Show success message
            const count = selectedIds.length;
            const successMsg = count === 1 
                ? 'Notification deleted successfully.'
                : `${count} notifications deleted successfully.`;
            
            if (window.showAlert && typeof window.showAlert === 'function') {
                window.showAlert(successMsg, 'success');
            } else if (window.utils && typeof window.utils.showModal === 'function') {
                window.utils.showModal(successMsg, {
                    type: 'success',
                    title: 'Success',
                    autoClose: true,
                    duration: 2000
                });
            }
            
            // onSnapshot will update the list automatically
        } catch (e) {
            console.error('Error deleting notifications:', e);
            const errorMsg = 'Error deleting notifications. Please try again.';
            if (window.showAlert && typeof window.showAlert === 'function') {
                window.showAlert(errorMsg, 'error');
            } else if (window.utils && typeof window.utils.showModal === 'function') {
                window.utils.showModal(errorMsg, {
                    type: 'error',
                    title: 'Error'
                });
            } else {
                alert(errorMsg);
            }
        }
    }

    // Mark one as read in Firestore; onSnapshot will update local state and badge
    async function handleNotificationClick(notificationId) {
        const notif = notifications.find(n => n.id === notificationId);
        if (!notif) return;

        const user = window.firebaseAuth?.currentUser;
        if (!user || !window.firebaseDb || !window.doc || !window.updateDoc) return;

        try {
            const ref = window.doc(window.firebaseDb, 'customers', user.uid, NOTIFS_SUBCOLLECTION, notificationId);
            await window.updateDoc(ref, { read: true });
        } catch (e) {
            console.warn('Error marking notification as read:', e);
        }

        if (notif.orderId) {
            window.location.href = `order_details.html?orderId=${encodeURIComponent(notif.orderId)}`;
        }
    }

    // Mark all as read in Firestore
    async function markAllAsRead() {
        const user = window.firebaseAuth?.currentUser;
        if (!user || !window.firebaseDb || !window.doc || !window.updateDoc) return;

        const unread = notifications.filter(n => !n.read);
        if (unread.length === 0) return;

        try {
            for (const n of unread) {
                const ref = window.doc(window.firebaseDb, 'customers', user.uid, NOTIFS_SUBCOLLECTION, n.id);
                await window.updateDoc(ref, { read: true });
            }
            // onSnapshot will update local and badge
        } catch (e) {
            console.warn('Error marking all as read:', e);
        }
    }

    // Recomply to declined order
    async function recomplyOrder(orderId) {
        if (!orderId) return;

        try {
            if (window.utils && typeof window.utils.waitForFirebaseReady === 'function') {
                await window.utils.waitForFirebaseReady();
            }

            const db = window.firebaseDb;
            if (!db || !window.doc || !window.getDoc) {
                alert('Unable to load order. Please try again.');
                return;
            }

            const orderRef = window.doc(db, 'orders', orderId);
            const orderSnap = await window.getDoc(orderRef);

            if (!orderSnap.exists()) {
                alert('Order not found.');
                return;
            }

            const orderData = orderSnap.data();

            if (orderData.status?.toLowerCase() !== 'declined') {
                alert('This order is not declined.');
                return;
            }

            const paymentMethod = (orderData.paymentMode || orderData.payment?.method || '').toLowerCase();
            if (paymentMethod !== 'gcash') {
                alert('Recomply is only available for GCash orders.');
                return;
            }

            localStorage.setItem('ppp_recomply_order_id', orderId);
            localStorage.setItem('ppp_recomply_order_data', JSON.stringify(orderData));

            window.location.href = 'checkout.html?recomply=true';
        } catch (error) {
            console.error('Error recomply order:', error);
            alert('Unable to process recomply. Please try again.');
        }
    }

    function clearNotifications() {
        notifications = [];
        unreadCount = 0;

        if (notifUnsubscribe) {
            try { notifUnsubscribe(); } catch (e) { console.warn('Notif unsubscribe error:', e); }
            notifUnsubscribe = null;
        }

        orderListeners.forEach(unsub => {
            try { unsub(); } catch (e) { console.warn('Error unsubscribing:', e); }
        });
        orderListeners.clear();
        previousOrderStates.clear();

        renderNotifications();
        updateUnreadCount();
    }

    function showNotificationBadge() {
        const badge = document.getElementById('notificationBadge');
        if (badge && unreadCount > 0) {
            badge.style.animation = 'pulse 0.5s ease-in-out';
            setTimeout(() => { badge.style.animation = ''; }, 500);
        }
    }

    window.notifications = {
        init,
        toggleDropdown,
        handleNotificationClick,
        markAllAsRead,
        recomplyOrder,
        addSystemNotification,
        goToPage,
        toggleSelectionMode,
        toggleNotificationSelection,
        selectAllNotifications,
        deleteSelectedNotifications
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('notificationDropdown');
        const button = document.getElementById('notificationButton');

        if (!dropdown || !button) return;

        // Check if click is inside dropdown or button
        const clickedInsideDropdown = dropdown.contains(e.target);
        const clickedInsideButton = button.contains(e.target);
        
        // Also check if the clicked element is a button or inside a button within the dropdown
        const clickedButton = e.target.closest('button');
        const clickedInsideDropdownButton = clickedButton && dropdown.contains(clickedButton);

        // Only close if click is completely outside dropdown and button
        if (!clickedInsideDropdown && !clickedInsideButton && !clickedInsideDropdownButton) {
            dropdown.style.display = 'none';
            // Exit selection mode when closing
            if (isSelectionMode) {
                exitSelectionMode();
            }
        }
    });
})();
