// ============================================
// NOTIFICATION SYSTEM
// Handles order notifications, system updates, and declined order recomply
// ============================================

(function() {
    'use strict';

    let notifications = [];
    let unreadCount = 0;
    let orderListeners = new Map(); // orderId -> unsubscribe function
    let isInitialized = false;
    let previousOrderStates = new Map(); // orderId -> previous order data

    // Notification types
    const NOTIFICATION_TYPES = {
        ORDER_STATUS_CHANGE: 'order_status_change',
        ORDER_DECLINED: 'order_declined',
        SYSTEM_UPDATE: 'system_update',
        PAYMENT_REQUIRED: 'payment_required'
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
            loadNotifications();
            setupOrderListeners(user);
        }
        
        // Listen for auth state changes
        if (window.onAuthStateChanged && window.firebaseAuth) {
            window.onAuthStateChanged(window.firebaseAuth, (user) => {
                if (user) {
                    loadNotifications();
                    setupOrderListeners(user);
                } else {
                    clearNotifications();
                }
            });
        }
        
        isInitialized = true;
        renderNotifications();
    }

    // Load notifications from localStorage
    function loadNotifications() {
        try {
            const stored = localStorage.getItem('ppp_notifications');
            if (stored) {
                notifications = JSON.parse(stored);
                updateUnreadCount();
            }
        } catch (e) {
            console.warn('Error loading notifications:', e);
            notifications = [];
        }
    }

    // Save notifications to localStorage
    function saveNotifications() {
        try {
            localStorage.setItem('ppp_notifications', JSON.stringify(notifications));
            updateUnreadCount();
        } catch (e) {
            console.warn('Error saving notifications:', e);
        }
    }

    // Setup real-time listeners for user's orders
    async function setupOrderListeners(user) {
        if (!window.firebaseDb || !window.collection || !window.query || !window.where || !window.onSnapshot) {
            console.warn('Firebase functions not available for notifications');
            return;
        }

        // Clean up existing listeners
        orderListeners.forEach(unsub => {
            try {
                unsub();
            } catch (e) {
                console.warn('Error unsubscribing listener:', e);
            }
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
                    
                    // Get previous state from memory
                    const oldData = previousOrderStates.get(orderId) || null;
                    
                    // Update stored state
                    previousOrderStates.set(orderId, { ...newData });
                    
                    if (change.type === 'modified' || change.type === 'added') {
                        handleOrderChange(orderId, oldData, newData);
                    }
                });
            }, (error) => {
                console.warn('Error in auth order listener:', error);
            });

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
                        const orderEmail = data.customerInfo?.email?.toLowerCase().trim();
                        const userEmail = user.email.toLowerCase().trim();
                        
                        if (orderEmail === userEmail) {
                            // Get previous state from memory
                            const oldData = previousOrderStates.get(orderId) || null;
                            
                            // Update stored state
                            previousOrderStates.set(orderId, { ...data });
                            
                            if (change.type === 'modified' || change.type === 'added') {
                                handleOrderChange(orderId, oldData, data);
                            }
                        }
                    });
                }, (error) => {
                    console.warn('Error in guest order listener:', error);
                });

                orderListeners.set('guest', unsubscribeGuest);
            }
        } catch (error) {
            console.error('Error setting up order listeners:', error);
        }
    }

    // Handle order status changes
    function handleOrderChange(orderId, oldData, newData) {
        if (!newData) return;

        const oldStatus = oldData?.status?.toLowerCase() || 'pending';
        const newStatus = newData.status?.toLowerCase() || 'pending';
        const orderNumber = newData.orderNumber || newData.trackingId || orderId;
        const displayId = orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;

        // Check if order was declined
        if (newStatus === 'declined' && oldStatus !== 'declined') {
            const declineReason = newData.declineReason || 'Payment verification failed';
            addNotification({
                id: `order_declined_${orderId}_${Date.now()}`,
                type: NOTIFICATION_TYPES.ORDER_DECLINED,
                title: 'Order Declined',
                message: `Order ${displayId} has been declined: ${declineReason}`,
                orderId: orderId,
                orderNumber: displayId,
                declineReason: declineReason,
                timestamp: Date.now(),
                read: false,
                actionRequired: true
            });
            return; // Don't process other status changes for declined orders
        }
        // Check for other status changes (but not if it was already declined)
        else if (oldStatus !== newStatus && oldStatus !== 'declined' && newStatus !== 'declined') {
            const statusLabels = {
                'pending': 'Pending',
                'preparing': 'Preparing',
                'ready': 'Ready',
                'out for delivery': 'Out for Delivery',
                'delivered': 'Delivered',
                'completed': 'Completed'
            };

            addNotification({
                id: `order_status_${orderId}_${Date.now()}`,
                type: NOTIFICATION_TYPES.ORDER_STATUS_CHANGE,
                title: 'Order Status Updated',
                message: `Order ${displayId} is now ${statusLabels[newStatus] || newStatus}`,
                orderId: orderId,
                orderNumber: displayId,
                oldStatus: oldStatus,
                newStatus: newStatus,
                timestamp: Date.now(),
                read: false
            });
        }
    }

    // Add a new notification
    function addNotification(notification) {
        // Check if similar notification already exists (prevent duplicates)
        const exists = notifications.some(n => 
            n.orderId === notification.orderId && 
            n.type === notification.type &&
            Date.now() - n.timestamp < 5000 // Within 5 seconds
        );

        if (exists) return;

        notifications.unshift(notification); // Add to beginning
        notifications = notifications.slice(0, 50); // Keep only last 50
        saveNotifications();
        renderNotifications();
        showNotificationBadge();
    }

    // Add system notification
    function addSystemNotification(title, message) {
        addNotification({
            id: `system_${Date.now()}`,
            type: NOTIFICATION_TYPES.SYSTEM_UPDATE,
            title: title,
            message: message,
            timestamp: Date.now(),
            read: false
        });
    }

    // Update unread count
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

    // Render notifications
    function renderNotifications() {
        const list = document.getElementById('notificationList');
        const empty = document.getElementById('notificationEmpty');
        if (!list) return;

        if (notifications.length === 0) {
            if (empty) empty.style.display = 'block';
            list.innerHTML = '';
            return;
        }

        if (empty) empty.style.display = 'none';

        list.innerHTML = notifications.map(notif => {
            const date = new Date(notif.timestamp);
            const timeAgo = getTimeAgo(date);
            const icon = getNotificationIcon(notif.type);
            const readClass = notif.read ? 'read' : 'unread';

            return `
                <div class="notification-item ${readClass}" data-notification-id="${notif.id}" onclick="window.notifications?.handleNotificationClick('${notif.id}')">
                    <div class="notification-icon-small">${icon}</div>
                    <div class="notification-content">
                        <div class="notification-title">${escapeHtml(notif.title)}</div>
                        <div class="notification-message">${escapeHtml(notif.message)}</div>
                        <div class="notification-time">${timeAgo}</div>
                        ${notif.type === NOTIFICATION_TYPES.ORDER_DECLINED && notif.actionRequired ? `
                            <button class="notification-action-btn" onclick="event.stopPropagation(); window.notifications?.recomplyOrder('${notif.orderId}')">
                                <i class="fas fa-redo"></i> Recomply
                            </button>
                        ` : ''}
                    </div>
                    ${!notif.read ? '<div class="notification-dot"></div>' : ''}
                </div>
            `;
        }).join('');
    }

    // Get notification icon based on type
    function getNotificationIcon(type) {
        const icons = {
            [NOTIFICATION_TYPES.ORDER_STATUS_CHANGE]: '<i class="fas fa-shopping-bag"></i>',
            [NOTIFICATION_TYPES.ORDER_DECLINED]: '<i class="fas fa-times-circle"></i>',
            [NOTIFICATION_TYPES.SYSTEM_UPDATE]: '<i class="fas fa-info-circle"></i>',
            [NOTIFICATION_TYPES.PAYMENT_REQUIRED]: '<i class="fas fa-credit-card"></i>'
        };
        return icons[type] || '<i class="fas fa-bell"></i>';
    }

    // Get time ago string
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

    // Escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Toggle notification dropdown
    function toggleDropdown() {
        const dropdown = document.getElementById('notificationDropdown');
        if (!dropdown) return;

        if (dropdown.style.display === 'none' || !dropdown.style.display) {
            dropdown.style.display = 'flex';
            renderNotifications();
        } else {
            dropdown.style.display = 'none';
        }
    }

    // Handle notification click
    function handleNotificationClick(notificationId) {
        const notif = notifications.find(n => n.id === notificationId);
        if (!notif) return;

        // Mark as read
        notif.read = true;
        saveNotifications();
        renderNotifications();

        // Navigate based on type
        if (notif.orderId) {
            window.location.href = `order_details.html?orderId=${encodeURIComponent(notif.orderId)}`;
        }
    }

    // Mark all as read
    function markAllAsRead() {
        notifications.forEach(n => n.read = true);
        saveNotifications();
        renderNotifications();
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
            
            // Check if order is actually declined
            if (orderData.status?.toLowerCase() !== 'declined') {
                alert('This order is not declined.');
                return;
            }

            // Check if it's a GCash order that needs payment proof
            const paymentMethod = (orderData.paymentMode || orderData.payment?.method || '').toLowerCase();
            if (paymentMethod !== 'gcash') {
                alert('Recomply is only available for GCash orders.');
                return;
            }

            // Store order info and redirect to checkout with recomply mode
            localStorage.setItem('ppp_recomply_order_id', orderId);
            localStorage.setItem('ppp_recomply_order_data', JSON.stringify(orderData));
            
            // Redirect to checkout page
            window.location.href = 'checkout.html?recomply=true';
        } catch (error) {
            console.error('Error recomply order:', error);
            alert('Unable to process recomply. Please try again.');
        }
    }

    // Clear notifications
    function clearNotifications() {
        notifications = [];
        orderListeners.forEach(unsub => {
            try {
                unsub();
            } catch (e) {
                console.warn('Error unsubscribing:', e);
            }
        });
        orderListeners.clear();
        previousOrderStates.clear();
        saveNotifications();
        renderNotifications();
    }

    // Show notification badge animation
    function showNotificationBadge() {
        const badge = document.getElementById('notificationBadge');
        if (badge && unreadCount > 0) {
            badge.style.animation = 'pulse 0.5s ease-in-out';
            setTimeout(() => {
                badge.style.animation = '';
            }, 500);
        }
    }

    // Expose to window
    window.notifications = {
        init,
        toggleDropdown,
        handleNotificationClick,
        markAllAsRead,
        recomplyOrder,
        addSystemNotification
    };

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('notificationDropdown');
        const button = document.getElementById('notificationButton');
        
        if (dropdown && button && 
            !dropdown.contains(e.target) && 
            !button.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
})();

