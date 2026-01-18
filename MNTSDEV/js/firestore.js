// ============================================
// FIRESTORE OPERATIONS
// All Firestore database operations
// ============================================

(function() {
    'use strict';

    const MENU_COLLECTION = 'menu';
    const REVIEWS_SUBCOLLECTION = 'reviews';

    // Fetch menu items with optional category filter
    async function fetchMenuItems(categoryKey) {
        await window.utils.waitForFirebaseReady();

        if (!window.firebaseDb || !window.collection || !window.getDocs) {
            console.warn('Firebase not ready for menu fetch');
            return [];
        }

        try {
            const colRef = window.collection(window.firebaseDb, MENU_COLLECTION);
            const snap = await window.getDocs(colRef);
            const items = [];
            snap.forEach((docSnap) => {
                const data = docSnap.data();
                if (data && data.active === false) return; // skip inactive
                
                // Filter by category if categoryKey is provided
                if (categoryKey && categoryKey !== 'all') {
                    const itemCategory = (data.category || data.type || '').toLowerCase();
                    const categoryKeyLower = categoryKey.toLowerCase();
                    
                    // Special handling for "favorites" category - show only ribs and chicken
                    if (categoryKeyLower === 'favorites') {
                        const isRibs = itemCategory.includes('ribs') || itemCategory === 'ribs';
                        const isChicken = itemCategory.includes('chicken') || 
                                         itemCategory.includes('peri chicken') ||
                                         itemCategory === 'chicken' ||
                                         itemCategory === 'peri chicken';
                        
                        // Only include if it's ribs or chicken
                        if (!isRibs && !isChicken) return;
                    } else {
                        // For other categories, use standard matching
                        const categoryMatch = 
                            itemCategory === categoryKeyLower ||
                            itemCategory.includes(categoryKeyLower) ||
                            categoryKeyLower.includes(itemCategory);
                        
                        // If category doesn't match, skip this item
                        if (!categoryMatch) return;
                    }
                }
                
                items.push({ id: docSnap.id, ...data });
            });
            
            // For "favorites" and "limited" categories, if no items found, return empty array
            // For other categories, return empty array to show category-specific message
            if (items.length === 0 && categoryKey && categoryKey !== 'all') {
                // Return empty array for all categories to show category-specific message
                return [];
            }
            
            return items;
        } catch (error) {
            console.error('Error fetching menu items:', error);
            return [];
        }
    }

    // Fetch a single menu item by ID
    async function fetchMenuItemById(itemId) {
        await window.utils.waitForFirebaseReady();

        const db = window.firebaseDb;
        if (!db || !window.doc || !window.getDoc) {
            console.warn('Firebase not ready for menu item fetch');
            return null;
        }

        try {
            const ref = window.doc(db, MENU_COLLECTION, itemId);
            const snap = await window.getDoc(ref);
            if (snap.exists()) {
                return { id: snap.id, ...snap.data() };
            }
            return null;
        } catch (error) {
            console.error('Error fetching menu item:', error);
            return null;
        }
    }

    // Fetch review summary for an item
    async function fetchReviewSummaryForItem(itemId) {
        await window.utils.waitForFirebaseReady();

        const db = window.firebaseDb;
        if (!db || !window.doc || !window.collection || !window.getDocs) {
            console.warn('Firebase not ready for reviews fetch');
            return null;
        }

        try {
            const itemRef = window.doc(db, MENU_COLLECTION, itemId);
            const reviewsCol = window.collection(itemRef, REVIEWS_SUBCOLLECTION);

            let q = reviewsCol;
            if (window.orderBy && window.query) {
                q = window.query(reviewsCol, window.orderBy('createdAt', 'desc'));
            }

            const snap = await window.getDocs(q);
            let sum = 0;
            let count = 0;

            snap.forEach((docSnap) => {
                const data = docSnap.data() || {};
                const rating = typeof data.rating === 'number' ? data.rating : Number(data.rating) || 0;
                if (!rating) return;
                sum += rating;
                count += 1;
            });

            if (!count) {
                return { average: 0, count: 0 };
            }

            return { average: sum / count, count };
        } catch (error) {
            console.error('Error fetching review summary for item:', error);
            return null;
        }
    }

    // Fetch all reviews for an item
    // Reviews are stored in menu subcollection: menu/{itemId}/reviews/{reviewId}
    // This ensures all pages (menu.html, index.html, food_item.html, account.html, order_details.html) 
    // are synced with the same Firebase data source
    async function fetchReviewsForItem(itemId) {
        await window.utils.waitForFirebaseReady();

        const db = window.firebaseDb;
        if (!db || !window.doc || !window.collection || !window.getDocs) {
            console.warn('Firebase not fully initialized for reviews');
            return [];
        }

        try {
            // Fetch from menu subcollection: menu/{itemId}/reviews/{reviewId}
            const itemRef = window.doc(db, MENU_COLLECTION, itemId);
            const itemReviewsCol = window.collection(itemRef, REVIEWS_SUBCOLLECTION);

            let q = itemReviewsCol;
            if (window.orderBy) {
                q = window.query(itemReviewsCol, window.orderBy('createdAt', 'desc'));
            }

            const snap = await window.getDocs(q);
            const reviews = [];
            const auth = window.firebaseAuth || null;
            const currentUserId = auth && auth.currentUser ? auth.currentUser.uid : null;

            snap.forEach((docSnap) => {
                const data = docSnap.data() || {};
                const rating = typeof data.rating === 'number' ? data.rating : Number(data.rating) || 0;
                const text = (data.text || '').trim();

                if (rating <= 0 && !text) return;

                let createdAtLabel = '';
                const createdRaw = data.createdAt;
                if (createdRaw) {
                    let d;
                    if (createdRaw.toDate) {
                        d = createdRaw.toDate();
                    } else {
                        d = new Date(createdRaw);
                    }
                    if (!Number.isNaN(d.getTime())) {
                        createdAtLabel = d.toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric'
                        });
                    }
                }

                const name = data.anonymous ? 'Anonymous' : (data.displayName || 'Customer');

                // Ensure strict user ID matching for account sync
                const reviewUserId = data.userId || '';
                const isOwn = currentUserId && reviewUserId && reviewUserId === currentUserId;

                reviews.push({
                    id: docSnap.id,
                    userId: reviewUserId,
                    rating,
                    text,
                    name,
                    createdAtLabel,
                    isOwn
                });
            });

            return reviews;
        } catch (error) {
            console.error('Error loading reviews for item:', error);
            return [];
        }
    }

    // Check if user has ordered a specific item
    async function hasUserOrderedItem(userId, itemId) {
        await window.utils.waitForFirebaseReady();

        const db = window.firebaseDb;
        if (!db || !window.collection || !window.query || !window.where || !window.getDocs) {
            return false;
        }

        try {
            // Query orders for this user with status 'delivered' or 'completed'
            const ordersCol = window.collection(db, 'orders');
            const q = window.query(
                ordersCol,
                window.where('userId', '==', userId)
            );
            const snap = await window.getDocs(q);

            for (const docSnap of snap.docs) {
                const orderData = docSnap.data() || {};
                const status = (orderData.status || '').toLowerCase();
                
                // Only check completed orders
                if (status !== 'delivered' && status !== 'completed') {
                    continue;
                }

                const items = Array.isArray(orderData.items) ? orderData.items : [];
                for (const item of items) {
                    if (item.itemId === itemId) {
                        return true;
                    }
                }
            }
            return false;
        } catch (error) {
            console.error('Error checking if user has ordered item:', error);
            return false;
        }
    }

    // Save a review for an item
    async function saveReviewForItem({ itemId, rating, text, anonymous, reviewId = null }) {
        await window.utils.waitForFirebaseReady();

        const db = window.firebaseDb;
        const auth = window.firebaseAuth;

        if (!db || !auth || !window.doc || !window.collection || !window.setDoc || !window.getDoc) {
            throw new Error('Reviews are not available right now. Please try again later.');
        }

        const user = auth.currentUser;
        if (!user) {
            throw new Error('You must be signed in to leave a review.');
        }

        if (!itemId) {
            throw new Error('No item selected for review.');
        }

        // Check if user has ordered this item (skip check for editing existing review)
        if (!reviewId) {
            const hasOrdered = await hasUserOrderedItem(user.uid, itemId);
            if (!hasOrdered) {
                throw new Error('You can only review items you have ordered. Please complete an order first.');
            }
        }

        // Prefer customer's firstName from their profile; fall back to displayName/email
        const customerRef = window.doc(db, 'customers', user.uid);
        let displayName = null;

        if (!anonymous) {
            try {
                const snap = await window.getDoc(customerRef);
                if (snap.exists()) {
                    const data = snap.data() || {};
                    const firstName = data.firstName || '';
                    const lastName = data.lastName || '';
                    const full = `${firstName} ${lastName}`.trim();
                    if (full) {
                        displayName = full;
                    }
                }
            } catch (e) {
                console.warn('Failed to fetch customer profile for review name:', e);
            }

            if (!displayName) {
                const baseName = (user.displayName || (user.email || '').split('@')[0] || 'Customer');
                displayName = baseName;
            }
        }

        const serverTimestampFn = window.serverTimestamp;
        const now = serverTimestampFn ? serverTimestampFn() : new Date();

        // Write under the menu item: menu/{itemId}/reviews/{reviewId}
        const itemRef = window.doc(db, MENU_COLLECTION, itemId);
        const itemReviewsCol = window.collection(itemRef, REVIEWS_SUBCOLLECTION);
        const itemReviewRef = reviewId
            ? window.doc(itemReviewsCol, reviewId)
            : window.doc(itemReviewsCol);

        let preservedCreatedAt = null;
        if (reviewId) {
            try {
                const existingSnap = await window.getDoc(itemReviewRef);
                if (existingSnap.exists()) {
                    preservedCreatedAt = existingSnap.data()?.createdAt || null;
                }
            } catch (e) {
                console.warn('Failed to fetch existing review before update:', e);
            }
        }

        // Get item name for the review
        let itemName = null;
        try {
            const itemSnap = await window.getDoc(itemRef);
            if (itemSnap.exists()) {
                const itemData = itemSnap.data() || {};
                itemName = itemData.displayName || itemData.name || itemData.title || null;
            }
        } catch (e) {
            console.warn('Failed to fetch item name for review:', e);
        }

        const commonData = {
            userId: user.uid,
            rating,
            text,
            anonymous: !!anonymous,
            displayName: anonymous ? null : displayName,
            itemId: itemId,
            itemName: itemName,
            createdAt: preservedCreatedAt || now
        };

        if (reviewId) {
            commonData.updatedAt = now;
        }

        await window.setDoc(itemReviewRef, commonData);

        // Also mirror under the customer: customers/{uid}/reviews/{sameId}
        try {
            const customerReviewsCol = window.collection(customerRef, 'reviews');
            const customerReviewRef = window.doc(customerReviewsCol, itemReviewRef.id);
            await window.setDoc(customerReviewRef, commonData);
        } catch (e) {
            console.warn('Failed to save review under customer document:', e);
        }

        return itemReviewRef.id;
    }

    // Delete a review
    async function deleteReview(itemId, reviewId) {
        try {
            await window.utils.waitForFirebaseReady();

            const db = window.firebaseDb;
            const auth = window.firebaseAuth;

            if (!db || !auth || !window.doc || !window.deleteDoc) {
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                return;
            }

            // Delete from menu/{itemId}/reviews/{reviewId}
            const itemReviewRef = window.doc(db, MENU_COLLECTION, itemId, REVIEWS_SUBCOLLECTION, reviewId);
            await window.deleteDoc(itemReviewRef);

            // Also delete from customers/{uid}/reviews/{reviewId}
            try {
                const customerReviewRef = window.doc(db, 'customers', user.uid, 'reviews', reviewId);
                await window.deleteDoc(customerReviewRef);
            } catch (e) {
                console.warn('Failed to delete mirrored customer review:', e);
            }
        } catch (error) {
            console.error('Error deleting review:', error);
        }
    }

    // Expose to window
    window.firestore = {
        MENU_COLLECTION,
        REVIEWS_SUBCOLLECTION,
        fetchMenuItems,
        fetchMenuItemById,
        fetchReviewSummaryForItem,
        fetchReviewsForItem,
        saveReviewForItem,
        deleteReview,
        hasUserOrderedItem
    };
})();

