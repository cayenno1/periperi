// ============================================
// MENU PAGE FUNCTIONALITY
// Menu page specific JavaScript
// ============================================

(function() {
    'use strict';

    let currentCategory = 'favorites';
    const FAVORITES_KEY = 'ppp_favorites_v1';
    const MENU_CACHE_PREFIX = 'ppp_menu_cache_v1:';
    const MENU_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
    let lastNonFavoritesCategory = 'favorites';
    let lastNonFavoritesTitle = "PABLO'S FAVORITES";

    function getIdList(key) {
        try {
            const raw = window.localStorage?.getItem(key);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
        } catch (e) {
            return [];
        }
    }

    function setIdList(key, list) {
        try {
            window.localStorage?.setItem(key, JSON.stringify(Array.isArray(list) ? list : []));
        } catch (e) {}
    }

    function isFavorite(itemId) {
        if (!itemId) return false;
        return getIdList(FAVORITES_KEY).includes(String(itemId));
    }

    function toggleFavorite(itemId) {
        if (!itemId) return false;
        const id = String(itemId);
        const ids = getIdList(FAVORITES_KEY);
        const idx = ids.indexOf(id);
        const next = idx === -1 ? [id, ...ids] : ids.filter((x) => x !== id);
        setIdList(FAVORITES_KEY, next.slice(0, 100));
        return idx === -1;
    }

    function updateFavoriteButtonsForItem(itemId) {
        const id = String(itemId || '');
        const fav = isFavorite(id);
        const selector = `.ppp-fav-btn[data-fav-id="${id.replace(/"/g, '\\"')}"]`;
        document.querySelectorAll(selector).forEach((btn) => {
            btn.classList.toggle('is-fav', fav);
            btn.setAttribute('aria-label', fav ? 'Remove from favorites' : 'Add to favorites');
            const icon = btn.querySelector('i');
            if (icon) icon.className = fav ? 'fas fa-heart' : 'far fa-heart';
        });
    }

    function setMenuNotice(html) {
        const header = document.getElementById('menuSectionHeader');
        if (!header) return;
        let box = document.getElementById('pppMenuNotice');
        if (!box) {
            box = document.createElement('div');
            box.id = 'pppMenuNotice';
            box.style.width = '100%';
            box.style.marginTop = '10px';
            header.appendChild(box);
        }
        box.innerHTML = html || '';
    }

    function updateSectionTitle(menuKey) {
        const sectionTitle = document.querySelector('.section-category-title');
        if (!sectionTitle) return;

        if (menuKey === 'myfavorites') {
            sectionTitle.textContent = 'YOUR FAVORITES';
            return;
        }

        const btn = document.querySelector(`.sidebar-category[data-category="${String(menuKey).replace(/"/g, '\\"')}"]`);
        if (btn) {
            sectionTitle.textContent = btn.textContent.trim().toUpperCase();
        }
    }

    function getFavoritesCount() {
        return getIdList(FAVORITES_KEY).length;
    }

    function setFavoritesToggleState() {
        const btn = document.getElementById('favoritesToggleBtn');
        const countEl = document.getElementById('favoritesCount');
        const count = getFavoritesCount();
        if (countEl) countEl.textContent = String(count);
        if (btn) btn.classList.toggle('is-active', currentCategory === 'myfavorites');
    }

    function setActiveSidebarCategory(category) {
        // Best-effort: if the button exists, mark active; otherwise keep current.
        document.querySelectorAll('.sidebar-category').forEach((b) => b.classList.remove('active'));
        const sel = `.sidebar-category[data-category="${String(category).replace(/"/g, '\\"')}"]`;
        const btn = document.querySelector(sel);
        if (btn) btn.classList.add('active');
    }

    function clearSidebarSelection() {
        document.querySelectorAll('.sidebar-category').forEach((b) => b.classList.remove('active'));
    }

    function getMenuCache(key) {
        try {
            const raw = window.localStorage?.getItem(`${MENU_CACHE_PREFIX}${key}`);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            if (!Array.isArray(parsed.items)) return null;
            const ts = Number(parsed.ts) || 0;
            if (!ts || (Date.now() - ts) > MENU_CACHE_TTL_MS) return null;
            return parsed.items;
        } catch (e) {
            return null;
        }
    }

    function setMenuCache(key, items) {
        try {
            window.localStorage?.setItem(`${MENU_CACHE_PREFIX}${key}`, JSON.stringify({ ts: Date.now(), items: items || [] }));
        } catch (e) {}
    }

    async function fetchItemsByIds(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return [];
        if (!window.firestore?.fetchMenuItemById) return [];
        const unique = Array.from(new Set(ids.map(String)));
        const results = await Promise.all(unique.map(async (id) => {
            try {
                return await window.firestore.fetchMenuItemById(id);
            } catch (e) {
                return null;
            }
        }));
        return results.filter(Boolean);
    }

    // Generate star display HTML
    function generateStarDisplay(rating) {
        const fullStars = Math.floor(rating);
        const hasHalfStar = rating % 1 >= 0.5;
        const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);
        
        let starsHtml = '';
        
        for (let i = 0; i < fullStars; i++) {
            starsHtml += '<i class="fas fa-star"></i>';
        }
        
        if (hasHalfStar) {
            starsHtml += '<i class="fas fa-star-half-alt"></i>';
        }
        
        for (let i = 0; i < emptyStars; i++) {
            starsHtml += '<i class="far fa-star"></i>';
        }
        
        return starsHtml;
    }

    // Hydrate card ratings with live review data - synced with Firebase menu subcollection
    async function hydrateCardRatings(items) {
        if (!Array.isArray(items) || !items.length) return;

        // Ensure Firebase is ready
        if (!window.firestore?.fetchReviewSummaryForItem) {
            console.warn('Firestore not ready for review summaries');
            return;
        }

        await Promise.all(items.map(async (item) => {
            if (!item || !item.id) return;

            const card = document.querySelector(`.menu-card[data-item-id="${item.id}"]`);
            if (!card) return;

            const ratingLabel = card.querySelector('[data-rating-label]');
            const starsDisplay = card.querySelector('[data-stars-display]');
            if (!ratingLabel) return;

            try {
                // Fetch fresh review summary from Firebase menu subcollection
                const summary = await window.firestore.fetchReviewSummaryForItem(item.id);
            if (!summary) {
                ratingLabel.textContent = 'No reviews yet';
                if (starsDisplay) {
                    starsDisplay.innerHTML = '<i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i>';
                }
                return;
            }

            const avg = summary.average || 0;
            const count = summary.count || 0;

            if (!count) {
                ratingLabel.textContent = 'No reviews yet';
                if (starsDisplay) {
                    starsDisplay.innerHTML = '<i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i>';
                }
                return;
            }

            const avgText = avg.toFixed(1);
            const countLabel = count === 1 ? '1 review' : `${count} reviews`;
            ratingLabel.textContent = `${avgText} (${countLabel})`;
            
            if (starsDisplay) {
                starsDisplay.innerHTML = generateStarDisplay(avg);
            }
            } catch (error) {
                console.error('Error fetching review summary for item:', item.id, error);
                // Set default values on error
                ratingLabel.textContent = 'No reviews yet';
                if (starsDisplay) {
                    starsDisplay.innerHTML = '<i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i>';
                }
            }
        }));
    }

    // Update empty state visibility
    function updateEmptyState() {
        const emptyState = document.getElementById('emptyState');
        const anyVisible = Array.from(document.querySelectorAll('.menu-card')).some(card => card.style.display !== 'none');
        if (!anyVisible) {
            emptyState.hidden = false;
            emptyState.classList.add('show');
        } else {
            emptyState.hidden = true;
            emptyState.classList.remove('show');
        }
    }

    // Open food item page
    function openFoodItem(itemId) {
        if (!itemId) return;
        const url = `food_item.html?id=${encodeURIComponent(itemId)}`;
        window.location.href = url;
    }

    // Render menu items
    async function renderMenu(menuKey) {
        if (!menuKey) {
            console.warn('renderMenu called without menuKey');
            return;
        }
        
        currentCategory = menuKey;
        updateSectionTitle(menuKey);
        const menuContent = document.getElementById('menuContent');

        if (!menuContent) {
            console.warn('menuContent element not found');
            return;
        }

        // Clear while loading - show skeleton loaders
        menuContent.innerHTML = `
            <div class="menu-skeleton">
                ${Array(6).fill(0).map(() => `
                    <div class="menu-skeleton-card">
                        <div class="skeleton skeleton-image"></div>
                        <div class="skeleton-content">
                            <div class="skeleton skeleton-title"></div>
                            <div class="skeleton skeleton-text"></div>
                            <div class="skeleton skeleton-text-short"></div>
                            <div class="skeleton-footer">
                                <div class="skeleton skeleton-price"></div>
                                <div class="skeleton skeleton-button"></div>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        try {
            setMenuNotice('');

            // Local-only categories
            if (menuKey === 'myfavorites') {
                // Favorites is a header-driven view; keep sidebar unselected.
                clearSidebarSelection();
                const ids = getIdList(FAVORITES_KEY);
                const items = await fetchItemsByIds(ids);
                menuContent.innerHTML = items.length
                    ? items.map(renderCardHtml).join('')
                    : `
                        <div class="empty-state show">
                            <i class="fas fa-heart"></i>
                            <h4>No favorites yet</h4>
                            <p>Tap the heart on a menu item to save it here.</p>
                        </div>
                    `;
                updateEmptyState();
                setFavoritesToggleState();
                return;
            }

            const items = await window.firestore.fetchMenuItems(menuKey);
            // Cache successful fetches for offline/slow connections
            setMenuCache(menuKey, items);

            if (!items.length) {
                // Show category-specific empty message
                menuContent.innerHTML = `
                    <div class="empty-state show">
                        <i class="fas fa-utensils"></i>
                        <h4>No menu items for this category</h4>
                        <p>Check back soon for new items!</p>
                    </div>
                `;
                return;
            }

            function renderCardHtml(item) {
                const rawImg = item.img || item.image || item.imageDataUrl || '';
                const hasImage = !!rawImg;
                const imgSrc = hasImage ? rawImg : '';
                const popular = !!item.popular;
                const badge = item.badge || '';

                // Check maxServingsPerDay to determine availability
                const maxServingsPerDay = typeof item.maxServingsPerDay === 'number' 
                    ? item.maxServingsPerDay 
                    : (typeof item.maxServingsPerDay === 'string' 
                        ? parseFloat(item.maxServingsPerDay) 
                        : null);
                const isUnavailable = maxServingsPerDay === null || maxServingsPerDay === undefined || isNaN(maxServingsPerDay) || maxServingsPerDay <= 0;

                // Get display name from displayName field first, then fallback to other fields
                const ingredients = Array.isArray(item.ingredients) ? item.ingredients : [];
                const primaryIngredient = ingredients[0] || {};
                const displayName =
                    item.displayName ||
                    item.name ||
                    item.title ||
                    primaryIngredient.ingredientName ||
                    'Menu item';
                const attrSafeName = String(displayName).replace(/"/g, '&quot;');
                const attrSafeImg = String(imgSrc).replace(/"/g, '&quot;');

                // Get price from variations if available, otherwise use item price
                let basePrice = 150; // default fallback
                const variations = Array.isArray(item.variations) ? item.variations : [];
                
                if (variations.length > 0) {
                    // Use price from first variation
                    const firstVariation = variations[0];
                    if (firstVariation && typeof firstVariation.price === 'number') {
                        basePrice = firstVariation.price;
                    } else if (firstVariation && typeof firstVariation.price === 'string') {
                        basePrice = parseFloat(firstVariation.price) || basePrice;
                    }
                } else {
                    // No variations, use item price or ingredient price
                    if (typeof item.price === 'number') {
                        basePrice = item.price;
                    } else if (typeof primaryIngredient.baseAmountPerDish === 'number') {
                        basePrice = primaryIngredient.baseAmountPerDish;
                    }
                }
                
                const price = `₱${basePrice.toFixed(2)}`;
                const fav = isFavorite(item.id);

                // Default rating display with stars (will be updated when ratings load)
                const ratingHtml = `
                    <div class="card-rating">
                        <div class="stars-container">
                            <span class="stars" data-stars-display><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i></span>
                            <span class="rating-text" data-rating-label>Loading rating...</span>
                        </div>
                        ${popular ? '<span class="popular-tag">Popular</span>' : ''}
                    </div>
                `;

                const imageHtml = hasImage
                    ? `<img src="${imgSrc}" alt="${displayName}" class="card-image" loading="lazy" decoding="async">`
                    : `<div class="card-image" style="display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:#666;font-size:0.9rem;">
                         No photo available
                       </div>`;

                return `
                    <div class="menu-card ${isUnavailable ? 'unavailable' : ''}" data-popular="${popular}" data-item-id="${item.id}" ${isUnavailable ? '' : `onclick="openFoodItem('${item.id}')"`}>
                        <div class="card-image-container">
                            ${imageHtml}
                            <button class="ppp-fav-btn ${fav ? 'is-fav' : ''}" data-fav-id="${item.id}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}" onclick="window.menu.toggleFavoriteFromCard(event, '${item.id}')">
                                <i class="${fav ? 'fas' : 'far'} fa-heart"></i>
                            </button>
                            ${badge ? `<div class="badge"><i class="fas fa-star"></i> ${badge}</div>` : ''}
                        </div>
                        <div class="card-content">
                            <h3 class="card-title">${displayName}</h3>
                            ${ratingHtml}
                            <div class="price-row">
                                <div class="card-price">${price}</div>
                                <button
                                    class="add-plus-btn"
                                    data-item-id="${item.id}"
                                    data-item-name="${attrSafeName}"
                                    data-item-price="${basePrice}"
                                    data-item-img="${attrSafeImg}"
                                    ${isUnavailable ? 'disabled' : 'onclick="window.cart.addToCart(event)"'}
                                >
                                    <i class="fas fa-plus"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                `;
            }

            menuContent.innerHTML = items.map(renderCardHtml).join('');

            // After cards are rendered, hydrate rating badges with live review data
            hydrateCardRatings(items);

            updateEmptyState();
            setFavoritesToggleState();
        } catch (error) {
            console.error('Error rendering menu:', error);
            const cached = getMenuCache(menuKey);
            if (cached && cached.length) {
                setMenuNotice(`
                    <div style="padding:10px 12px;border:1px solid rgba(0,0,0,0.08);border-radius:14px;background:#fff;">
                        <strong style="color:#222;">Showing saved menu.</strong>
                        <span style="opacity:.8;">You're offline or the network is slow.</span>
                        <button type="button" class="btn btn-sm btn-outline-danger" style="margin-left:10px;" onclick="window.menu.retryMenu()">Retry</button>
                    </div>
                `);
                const renderCachedCard = (item) => {
                    const rawImg = item?.img || item?.image || item?.imageDataUrl || '';
                    const hasImage = !!rawImg;
                    const imgSrc = hasImage ? rawImg : '';
                    const displayName = item?.displayName || item?.name || item?.title || 'Menu item';
                    const popular = !!item?.popular;
                    const badge = item?.badge || '';
                    const fav = isFavorite(item?.id);

                    const imageHtml = hasImage
                        ? `<img src="${imgSrc}" alt="${displayName}" class="card-image" loading="lazy" decoding="async">`
                        : `<div class="card-image" style="display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:#666;font-size:0.9rem;">No photo available</div>`;

                    return `
                        <div class="menu-card" data-item-id="${item?.id || ''}" onclick="openFoodItem('${item?.id || ''}')">
                            <div class="card-image-container">
                                ${imageHtml}
                                <button class="ppp-fav-btn ${fav ? 'is-fav' : ''}" data-fav-id="${item?.id || ''}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}" onclick="window.menu.toggleFavoriteFromCard(event, '${item?.id || ''}')">
                                    <i class="${fav ? 'fas' : 'far'} fa-heart"></i>
                                </button>
                                ${badge ? `<div class="badge"><i class="fas fa-star"></i> ${badge}</div>` : ''}
                            </div>
                            <div class="card-content">
                                <h3 class="card-title">${displayName}</h3>
                                <div class="card-rating">
                                    <div class="stars-container">
                                        <span class="stars"><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i></span>
                                        <span class="rating-text">Offline</span>
                                    </div>
                                    ${popular ? '<span class="popular-tag">Popular</span>' : ''}
                                </div>
                            </div>
                        </div>
                    `;
                };

                menuContent.innerHTML = cached.map(renderCachedCard).join('');
                updateEmptyState();
                setFavoritesToggleState();
                return;
            }

            menuContent.innerHTML = `
                <div class="empty-state show">
                    <i class="fas fa-exclamation-triangle"></i>
                    <h4>Error loading menu</h4>
                    <p>Please check your connection and try again.</p>
                </div>
            `;
        }
    }

    // Sidebar Category Navigation
    function setupSidebarNavigation() {
        document.querySelectorAll('.sidebar-category').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                
                // Remove active from all
                document.querySelectorAll('.sidebar-category').forEach(b => {
                    b.classList.remove('active');
                });
                
                // Add active to clicked
                this.classList.add('active');
                
                // Get category and render immediately
                const category = this.dataset.category;
                if (category) {
                    lastNonFavoritesCategory = category;
                    lastNonFavoritesTitle = this.textContent.trim().toUpperCase();
                    renderMenu(category);
                    updateSectionTitle(category);
                }
            });
        });
    }

    // Sync floating cart count
    function syncFloatingCartCount() {
        const floatingCounter = document.getElementById('cartCount');
        if (!floatingCounter || !window.getCartCount) return;
        floatingCounter.textContent = window.getCartCount();
    }

    // Initialize menu page
    function initializeMenu() {
        setupSidebarNavigation();
        
        // Set "Pablo's Favorites" as active immediately
        const favoritesBtn = document.querySelector('.sidebar-category[data-category="favorites"]');
        if (favoritesBtn) {
            document.querySelectorAll('.sidebar-category').forEach(btn => {
                btn.classList.remove('active');
            });
            favoritesBtn.classList.add('active');
        }
        
        // Update section title
        const sectionTitle = document.querySelector('.section-category-title');
        if (sectionTitle) {
            sectionTitle.textContent = 'PABLO\'S FAVORITES';
        }
        
        // Render menu immediately
        renderMenu('favorites');

        // Favorites quick toggle (header button)
        const favToggleBtn = document.getElementById('favoritesToggleBtn');
        if (favToggleBtn) {
            favToggleBtn.addEventListener('click', () => {
                window.menu.toggleFavoritesView();
            });
        }
        setFavoritesToggleState();

        // Sync floating cart
        syncFloatingCartCount();
        document.addEventListener('cart:count-changed', syncFloatingCartCount);

        // Highlight current page in banner nav
        const path = window.location.pathname.split('/').pop() || 'menu.html';
        const homeLink = document.querySelector('.banner-nav-link-home');
        const menuLink = document.querySelector('.banner-nav-link-menu');

        if (path === 'menu.html' && menuLink) {
            menuLink.classList.add('is-active');
        } else if ((path === '' || path === 'index.html') && homeLink) {
            homeLink.classList.add('is-active');
        }
    }

    // Expose functions
    window.menu = {
        renderMenu,
        openFoodItem,
        updateEmptyState,
        generateStarDisplay,
        toggleFavoriteFromCard: (e, itemId) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            const added = toggleFavorite(itemId);
            updateFavoriteButtonsForItem(itemId);
            setFavoritesToggleState();
            if (currentCategory === 'myfavorites' && !added) {
                // If removing from favorites while viewing favorites, refresh list.
                renderMenu('myfavorites');
            }
            if (window.utils?.showToast) {
                window.utils.showToast(added ? 'Added to favorites' : 'Removed from favorites', 'success', 1800);
            }
        },
        retryMenu: () => renderMenu(currentCategory),
        toggleFavoritesView: () => {
            if (currentCategory === 'myfavorites') {
                const backTo = lastNonFavoritesCategory || 'favorites';
                renderMenu(backTo);
                setActiveSidebarCategory(backTo);
                updateSectionTitle(backTo);
                return;
            }
            lastNonFavoritesCategory = currentCategory || 'favorites';
            lastNonFavoritesTitle = document.querySelector('.section-category-title')?.textContent || lastNonFavoritesTitle;
            // When entering favorites from header, clear sidebar highlight.
            clearSidebarSelection();
            renderMenu('myfavorites');
        }
    };

    // Global function for onclick handlers
    window.openFoodItem = openFoodItem;

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeMenu);
    } else {
        initializeMenu();
    }

    // Final fallback: ensure menu loads even if DOMContentLoaded already fired
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(() => {
            const menuContent = document.getElementById('menuContent');
            const favoritesBtn = document.querySelector('.sidebar-category[data-category="favorites"]');
            if (menuContent && (!menuContent.innerHTML.trim() || menuContent.querySelector('.menu-loading'))) {
                if (favoritesBtn && !favoritesBtn.classList.contains('active')) {
                    document.querySelectorAll('.sidebar-category').forEach(btn => {
                        btn.classList.remove('active');
                    });
                    favoritesBtn.classList.add('active');
                }
                renderMenu('favorites');
            }
        }, 100);
    }
})();

