// ============================================
// MENU PAGE FUNCTIONALITY
// Menu page specific JavaScript
// ============================================

(function() {
    'use strict';

    let currentCategory = 'favorites';

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

    // Hydrate card ratings with live review data
    async function hydrateCardRatings(items) {
        if (!Array.isArray(items) || !items.length) return;

        await Promise.all(items.map(async (item) => {
            if (!item || !item.id) return;

            const card = document.querySelector(`.menu-card[data-item-id="${item.id}"]`);
            if (!card) return;

            const ratingLabel = card.querySelector('[data-rating-label]');
            const starsDisplay = card.querySelector('[data-stars-display]');
            if (!ratingLabel) return;

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
            const items = await window.firestore.fetchMenuItems(menuKey);

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

            menuContent.innerHTML = items.map((item) => {
                const rawImg = item.img || item.image || item.imageDataUrl || '';
                const hasImage = !!rawImg;
                const imgSrc = hasImage ? rawImg : '';
                const popular = !!item.popular;
                const badge = item.badge || '';

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
                    ? `<img src="${imgSrc}" alt="${displayName}" class="card-image">`
                    : `<div class="card-image" style="display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:#666;font-size:0.9rem;">
                         No photo available
                       </div>`;

                return `
                    <div class="menu-card" data-popular="${popular}" data-item-id="${item.id}" onclick="openFoodItem('${item.id}')">
                        <div class="card-image-container">
                            ${imageHtml}
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
                                    onclick="window.cart.addToCart(event)"
                                >
                                    <i class="fas fa-plus"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // After cards are rendered, hydrate rating badges with live review data
            hydrateCardRatings(items);

            updateEmptyState();
        } catch (error) {
            console.error('Error rendering menu:', error);
            menuContent.innerHTML = `
                <div class="empty-state show">
                    <i class="fas fa-exclamation-triangle"></i>
                    <h4>Error loading menu</h4>
                    <p>Please try again later.</p>
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
                    renderMenu(category);
                    
                    // Update section title
                    const categoryTitle = this.textContent.trim().toUpperCase();
                    const sectionTitle = document.querySelector('.section-category-title');
                    if (sectionTitle) {
                        sectionTitle.textContent = categoryTitle;
                    }
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
        generateStarDisplay
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

