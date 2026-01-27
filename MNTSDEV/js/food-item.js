// ============================================
// FOOD ITEM PAGE FUNCTIONALITY
// Food item detail page specific JavaScript
// ============================================

(function() {
    'use strict';

    // State variables
    let currentQty = 1;
    let unitPrice = 150;
    let currentItemId = null;
    let currentItemName = '';
    let currentItemImg = '';
    let currentVariations = [];
    let selectedVariation = null;
    let currentSauces = [];
    let selectedSauce = null;
    let baseItemData = null;
    let sauceScrollPosition = 0;
    const FAVORITES_KEY = 'ppp_favorites_v1';

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

    // Load allergen information
    function loadAllergenInfo(item) {
        const allergenSection = document.getElementById('allergen-section');
        const allergenInfo = document.getElementById('allergen-info');
        
        if (!allergenSection || !allergenInfo) return;

        let allergens = item.allergen !== undefined ? item.allergen : 
                        (item.allergens !== undefined ? item.allergens : 
                        (item.allergy !== undefined ? item.allergy : null));
        
        if (allergens === null || allergens === undefined) {
            allergenSection.style.display = 'none';
            allergenSection.setAttribute('hidden', '');
            return;
        }

        allergenSection.style.display = 'block';
        allergenSection.removeAttribute('hidden');
        
        let allergenArray = [];
        if (allergens) {
            if (typeof allergens === 'string') {
                allergenArray = allergens.split(',').map(a => a.trim()).filter(a => a);
            } else if (Array.isArray(allergens)) {
                allergenArray = allergens.filter(a => a);
            } else if (typeof allergens === 'object') {
                allergenArray = Object.values(allergens).filter(a => a);
            }
        }

        if (allergenArray.length === 0) {
            allergenInfo.innerHTML = '<span class="allergen-no-allergens">No allergens</span>';
            return;
        }

        allergenInfo.innerHTML = allergenArray.map(allergen => {
            return `<span class="allergen-tag">${allergen}</span>`;
        }).join('');
    }

    // Load sauces from database
    async function loadSauces(item) {
        const sauceSection = document.getElementById('sauce-section');
        const sauceCards = document.getElementById('sauce-cards');
        
        if (!sauceSection || !sauceCards) return;

        // Check if item category is "ribs" or "Peri chicken" (case insensitive)
        const itemCategory = (item.category || item.type || '').toLowerCase();
        const shouldShowSauces = itemCategory.includes('ribs') || 
                                 itemCategory.includes('peri chicken') ||
                                 itemCategory.includes('perichicken') ||
                                 itemCategory === 'ribs' ||
                                 itemCategory === 'peri chicken';

        if (!shouldShowSauces) {
            sauceSection.style.display = 'none';
            sauceSection.setAttribute('hidden', '');
            currentSauces = [];
            selectedSauce = null;
            return;
        }

        try {
            // Fetch sauces from menu collection where category = "sauce"
            const sauces = await window.firestore.fetchMenuItems('sauce');
            
            if (!sauces || sauces.length === 0) {
                sauceSection.style.display = 'none';
                sauceSection.setAttribute('hidden', '');
                currentSauces = [];
                selectedSauce = null;
                return;
            }

            // Enrich each sauce with maxServingsPerDay, remaining, and isUnavailable
            for (const sauce of sauces) {
                const max = typeof sauce.maxServingsPerDay === 'number'
                    ? sauce.maxServingsPerDay
                    : (typeof sauce.maxServingsPerDay === 'string' ? parseFloat(sauce.maxServingsPerDay) : null);
                if (max == null || max === undefined || isNaN(max) || max <= 0) {
                    sauce._isUnavailable = true;
                    sauce._remaining = 0;
                } else {
                    const served = await window.firestore.fetchDailyServedCount(sauce.id);
                    sauce._remaining = Math.max(0, max - served);
                    sauce._isUnavailable = sauce._remaining <= 0;
                }
            }

            currentSauces = sauces;
            sauceScrollPosition = 0;
            
            const sauceCards = document.getElementById('sauce-cards');
            if (!sauceCards) return;
            
            sauceCards.innerHTML = sauces.map((sauce, index) => {
                const sauceName = sauce.displayName || sauce.name || sauce.title || `Sauce ${index + 1}`;
                const saucePrice = typeof sauce.price === 'number' 
                    ? sauce.price 
                    : (typeof sauce.price === 'string' ? parseFloat(sauce.price) : 0);
                const isSelected = selectedSauce && selectedSauce.id === sauce.id;
                const sauceImage = sauce.imageDataUrl || sauce.image || sauce.img || '';
                const isUnavail = sauce._isUnavailable === true;
                const statusText = isUnavail ? 'Unavailable' : `${sauce._remaining} left`;
                const cardClass = [isSelected ? 'active' : '', isUnavail ? 'unavailable' : ''].filter(Boolean).join(' ');
                
                return `
                    <div 
                        class="sauce-card ${cardClass}" 
                        data-sauce-id="${sauce.id}"
                        data-unavailable="${isUnavail ? '1' : '0'}"
                        onclick="window.foodItem.selectSauce('${sauce.id}')"
                    >
                        <div class="sauce-card-image">
                            ${sauceImage ? `<img src="${sauceImage}" alt="${sauceName}" />` : '<div class="sauce-card-placeholder"><i class="fas fa-image"></i></div>'}
                        </div>
                        <div class="sauce-card-info">
                            <div class="sauce-card-name">${sauceName}</div>
                            <div class="sauce-card-remaining">${statusText}</div>
                        </div>
                    </div>
                `;
            }).join('');

            sauceSection.style.display = 'block';
            sauceSection.removeAttribute('hidden');
            
            // Update navigation buttons visibility
            updateSauceNavigation();
            
            // Auto-select first available sauce if none selected
            if (selectedSauce === null && sauces.length > 0) {
                const firstAvailable = sauces.find(s => !s._isUnavailable);
                if (firstAvailable) selectSauce(firstAvailable.id);
            }
        } catch (error) {
            console.error('Error loading sauces:', error);
            sauceSection.style.display = 'none';
            sauceSection.setAttribute('hidden', '');
            currentSauces = [];
            selectedSauce = null;
        }
    }

    // Select sauce
    function selectSauce(sauceId) {
        const sauce = currentSauces.find(s => s.id === sauceId);
        if (!sauce) return;
        if (sauce._isUnavailable === true) return;

        selectedSauce = sauce;

        document.querySelectorAll('.sauce-card').forEach((card) => {
            if (card.dataset.sauceId === sauceId) {
                card.classList.add('active');
            } else {
                card.classList.remove('active');
            }
        });
    }

    // Navigate sauces (carousel)
    function navigateSauces(direction) {
        const sauceCards = document.getElementById('sauce-cards');
        const sauceCardsWrapper = document.getElementById('sauce-cards-wrapper');
        if (!sauceCards || !sauceCardsWrapper) return;

        const cardWidth = 180; // Approximate card width + margin
        const visibleCards = Math.floor(sauceCardsWrapper.offsetWidth / cardWidth);
        const maxScroll = Math.max(0, (currentSauces.length - visibleCards) * cardWidth);
        
        sauceScrollPosition += direction * cardWidth * visibleCards;
        sauceScrollPosition = Math.max(0, Math.min(sauceScrollPosition, maxScroll));
        
        sauceCards.style.transform = `translateX(-${sauceScrollPosition}px)`;
        sauceCards.style.transition = 'transform 0.3s ease';
        
        updateSauceNavigation();
    }

    // Update sauce navigation buttons visibility
    function updateSauceNavigation() {
        const leftBtn = document.getElementById('sauce-nav-left');
        const rightBtn = document.getElementById('sauce-nav-right');
        const sauceCardsWrapper = document.getElementById('sauce-cards-wrapper');
        
        if (!leftBtn || !rightBtn || !sauceCardsWrapper) return;
        
        const cardWidth = 180;
        const visibleCards = Math.floor(sauceCardsWrapper.offsetWidth / cardWidth);
        const maxScroll = Math.max(0, (currentSauces.length - visibleCards) * cardWidth);
        
        // Show/hide navigation buttons
        leftBtn.style.display = sauceScrollPosition > 0 ? 'flex' : 'none';
        rightBtn.style.display = sauceScrollPosition < maxScroll ? 'flex' : 'none';
    }

    // Resolve kcal from an object (variation or base item). Tries kcalUnit, calories, kcal.
    function resolveKcal(obj) {
        if (!obj) return null;
        const v = obj.kcalUnit ?? obj.calories ?? obj.kcal;
        if (v == null || v === '') return null;
        const n = typeof v === 'number' ? v : parseFloat(v);
        return (isNaN(n) ? null : n);
    }

    // Load variations
    function loadVariations(item) {
        const variationSection = document.getElementById('variation-section');
        const variationButtons = document.getElementById('variation-buttons');
        
        if (!variationSection || !variationButtons) return;

        const variations = (item.variations && Array.isArray(item.variations) && item.variations.length > 0) 
            ? item.variations 
            : [];
        
        if (variations.length === 0) {
            variationSection.style.display = 'none';
            variationSection.setAttribute('hidden', '');
            currentVariations = [];
            selectedVariation = null;
            return;
        }

        currentVariations = variations;
        
        variationButtons.innerHTML = variations.map((variation, index) => {
            const variationName = variation.name || variation.title || `Variation ${index + 1}`;
            const variationPrice = typeof variation.price === 'number' 
                ? variation.price 
                : (typeof variation.price === 'string' ? parseFloat(variation.price) : unitPrice);
            const isSelected = selectedVariation && selectedVariation.index === index;
            const vq = (variation.quantity ?? 0) || 0;
            const isVUnavailable = vq <= 0;
            const varId = variation.variationId || variation.id || '';
            return `
                <button 
                    class="variation-btn ${isSelected ? 'active' : ''} ${isVUnavailable ? 'unavailable' : ''}" 
                    data-variation-index="${index}"
                    data-variation-id="${String(varId).replace(/"/g, '&quot;')}"
                    onclick="window.foodItem.selectVariation(${index})"
                >
                    <span class="variation-name">${variationName}</span>
                    <span class="variation-price">₱${variationPrice.toFixed(2)}</span>
                </button>
            `;
        }).join('');

        variationSection.style.display = 'block';
        variationSection.removeAttribute('hidden');
        
        if (selectedVariation === null && variations.length > 0) {
            selectVariation(0);
        }
    }

    // Select variation
    function selectVariation(index) {
        if (!currentVariations || index < 0 || index >= currentVariations.length) return;

        const variation = currentVariations[index];
        selectedVariation = { index, ...variation };

        document.querySelectorAll('.variation-btn').forEach((btn, i) => {
            if (i === index) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        const variationPrice = typeof variation.price === 'number' 
            ? variation.price 
            : (typeof variation.price === 'string' ? parseFloat(variation.price) : unitPrice);
        
        unitPrice = variationPrice;
        const priceDisplay = `₱${variationPrice.toFixed(2)}`;
        
        const priceEl = document.querySelector('.food-price');
        if (priceEl) priceEl.textContent = priceDisplay;

        if (variation.description) {
            const descEl = document.querySelector('.food-description');
            if (descEl) descEl.textContent = variation.description;
        } else if (baseItemData) {
            const descEl = document.querySelector('.food-description');
            const baseDesc = baseItemData.description || 
                (Array.isArray(baseItemData.ingredients) && baseItemData.ingredients[0] 
                    ? baseItemData.ingredients[0].description 
                    : 'No description available for this item yet.');
            if (descEl) descEl.textContent = baseDesc;
        }

        if (variation.img || variation.image || variation.imageDataUrl) {
            const imgEl = document.querySelector('.food-image');
            if (imgEl) {
                const variationImg = variation.img || variation.image || variation.imageDataUrl;
                imgEl.src = variationImg;
                imgEl.style.display = 'block';
                currentItemImg = variationImg;
            }
        } else if (baseItemData) {
            const rawImg = baseItemData.img || baseItemData.image || baseItemData.imageDataUrl || '';
            const imgEl = document.querySelector('.food-image');
            if (imgEl && rawImg) {
                imgEl.src = rawImg;
                imgEl.style.display = 'block';
            }
            currentItemImg = rawImg;
        }

        if (variation.name || variation.title) {
            const titleEl = document.querySelector('.food-title');
            if (titleEl) {
                const baseTitle = baseItemData?.displayName || baseItemData?.name || baseItemData?.title || 'Menu item';
                const variationName = variation.name || variation.title;
                titleEl.textContent = `${baseTitle} - ${variationName}`;
                currentItemName = `${baseTitle} - ${variationName}`;
            }
        } else if (baseItemData) {
            const titleEl = document.querySelector('.food-title');
            if (titleEl) {
                const ingredients = Array.isArray(baseItemData.ingredients) ? baseItemData.ingredients : [];
                const primaryIngredient = ingredients[0] || {};
                const baseTitle = baseItemData.displayName || baseItemData.name || baseItemData.title || primaryIngredient.ingredientName || 'Menu item';
                titleEl.textContent = baseTitle;
                currentItemName = baseTitle;
            }
        }

        // Update kcal: use selected variation's calories (kcalUnit/calories/kcal), else base item's
        const kcalVal = resolveKcal(variation) ?? resolveKcal(baseItemData);
        const kcalDisplay = (kcalVal != null && !isNaN(kcalVal)) ? `${Math.round(kcalVal)} kcal` : '--';
        const kcalValEl = document.querySelector('#food-kcal .food-kcal-value');
        if (kcalValEl) kcalValEl.textContent = kcalDisplay;

        changeQty(0);
        updateAddToCartButtonState();
    }

    // Get available quantity: for variations use variation.quantity; for non-variation use data.quantity. Null/undefined -> 0.
    function getAvailableQuantity() {
        if (selectedVariation) return Math.max(0, (selectedVariation.quantity ?? 0) || 0);
        if (!baseItemData) return 0;
        return Math.max(0, (baseItemData.quantity ?? 0) || 0);
    }

    // Enable/disable Add to Cart based on quantity. When quantity is 0 or null, or available < currentQty, disable.
    function updateAddToCartButtonState() {
        const addBtn = document.querySelector('.add-to-cart-btn');
        if (!addBtn) return;
        const avail = getAvailableQuantity();
        if (avail <= 0) {
            addBtn.disabled = true;
            addBtn.setAttribute('aria-label', 'Unavailable');
            return;
        }
        if (avail < currentQty) {
            addBtn.disabled = true;
            addBtn.setAttribute('aria-label', `Only ${avail} left`);
            return;
        }
        addBtn.disabled = false;
        addBtn.removeAttribute('aria-label');
    }

    // Change quantity
    function changeQty(delta) {
        const qtyElem = document.getElementById('qty');
        currentQty = Math.max(1, Math.min(99, currentQty + delta));
        qtyElem.value = currentQty;
        
        const addBtn = document.querySelector('.add-to-cart-btn');
        const totalPrice = unitPrice * currentQty;
        addBtn.querySelector('.total-price').textContent = `₱${totalPrice.toFixed(2)}`;
        updateAddToCartButtonState();
    }

    // Handle quantity input change (when user types)
    function handleQtyInputChange() {
        const qtyElem = document.getElementById('qty');
        if (!qtyElem) return;
        
        let value = parseInt(qtyElem.value, 10);
        
        // Validate and clamp to 1-99
        if (isNaN(value) || value < 1) {
            value = 1;
        } else if (value > 99) {
            value = 99;
        }
        
        currentQty = value;
        qtyElem.value = currentQty;
        
        const addBtn = document.querySelector('.add-to-cart-btn');
        const totalPrice = unitPrice * currentQty;
        addBtn.querySelector('.total-price').textContent = `₱${totalPrice.toFixed(2)}`;
        updateAddToCartButtonState();
    }

    // Handle quantity input in real-time (prevent invalid input)
    function handleQtyInput() {
        const qtyElem = document.getElementById('qty');
        if (!qtyElem) return;
        
        let value = qtyElem.value;
        
        // Remove any non-numeric characters
        value = value.replace(/[^0-9]/g, '');
        
        // Limit to 2 digits
        if (value.length > 2) {
            value = value.substring(0, 2);
        }
        
        // Update the input value
        if (value !== qtyElem.value) {
            qtyElem.value = value;
        }
        
        // Update current quantity if valid
        const numValue = parseInt(value, 10);
        if (!isNaN(numValue) && numValue >= 1 && numValue <= 99) {
            currentQty = numValue;
            const addBtn = document.querySelector('.add-to-cart-btn');
            const totalPrice = unitPrice * currentQty;
            addBtn.querySelector('.total-price').textContent = `₱${totalPrice.toFixed(2)}`;
            updateAddToCartButtonState();
        }
    }


    // Add to cart
    async function addToCart() {
        const btn = document.querySelector('.add-to-cart-btn');
        if (!btn || btn.disabled) return;

        const avail = getAvailableQuantity();
        if (avail <= 0) {
            if (window.utils?.showToast) {
                window.utils.showToast('This item is currently unavailable.', 'error', 2200);
            } else {
                alert('This item is currently unavailable.');
            }
            return;
        }
        if (avail < currentQty) {
            if (window.utils?.showToast) {
                window.utils.showToast(`Only ${avail} available. Please reduce quantity.`, 'error', 2200);
            } else {
                alert(`Only ${avail} available. Please reduce quantity.`);
            }
            return;
        }

        // Build product object for customer-cart.js
        let productId = currentItemId;
        let productName = currentItemName;
        
        // If variation is selected, use variation ID
        if (selectedVariation) {
            const variationId = selectedVariation.variationId || selectedVariation.id;
            if (variationId) {
                productId = variationId;
            }
            const variationName = selectedVariation.name || selectedVariation.title;
            if (variationName) {
                productName = `${currentItemName} - ${variationName}`;
            }
        }

        // Check if product has includedSauces (linked sauces)
        // We need to fetch the product to check for includedSauces
        try {
            await window.utils?.waitForFirebaseReady();
            const product = await window.firestore?.fetchMenuItemById?.(currentItemId);
            
            if (product && Array.isArray(product.includedSauces) && product.includedSauces.length > 0) {
                // Product has linked sauces - use customer-cart.js addToCart which will open modal
                if (window.customerCart && window.customerCart.addToCart) {
                    // Build product object for customer-cart
                    const products = window.customerCart.getProducts();
                    const cartProduct = products.find(p => p.id === productId);
                    
                    if (cartProduct) {
                        window.customerCart.addToCart(productId, currentQty);
                        return;
                    }
                }
            }
        } catch (e) {
            console.warn('Error checking for linked sauces:', e);
        }

        // No linked sauces or customer-cart not available - use old system
        const originalContent = btn.innerHTML;
        const originalBg = btn.style.background;

        btn.innerHTML = '<i class="fas fa-check"></i><span>Added to Cart!</span>';
        btn.style.background = '#4caf50';
        btn.disabled = true;

        try {
            if (typeof window.incrementCartCount === 'function') {
                window.incrementCartCount(currentQty);
            } else {
                const key = 'ppp_cart_count';
                const raw = window.localStorage?.getItem(key);
                const current = Number(raw);
                const safeCurrent = !Number.isFinite(current) || Number.isNaN(current) ? 0 : current;
                const next = safeCurrent + currentQty;
                window.localStorage?.setItem(key, String(next));

                document.querySelectorAll('.cart-badge').forEach((badge) => {
                    badge.textContent = String(next);
                });

                document.dispatchEvent(new CustomEvent('cart:count-changed', {
                    detail: { count: next }
                }));
            }
        } catch (e) {
            console.warn('Failed to sync cart count from food_item:', e);
        }

        try {
            let displayName = productName;
            
            // Sauce is linked to the food item (not separate)
            const payload = {
                itemId: currentItemId,
                name: displayName,
                imageUrl: currentItemImg,
                price: unitPrice,
                quantity: currentQty,
                variation: selectedVariation ? {
                    name: selectedVariation.name || selectedVariation.title,
                    price: selectedVariation.price,
                    id: selectedVariation.variationId || selectedVariation.id || null
                } : null,
                sauce: selectedSauce ? {
                    id: selectedSauce.id,
                    name: selectedSauce.displayName || selectedSauce.name || selectedSauce.title,
                    price: 0  // Sauce is free/included
                } : null
            };

            const user = window.firebaseAuth?.currentUser || null;
            if (user) {
                await window.cart.saveCartItemToFirestore(payload);
            } else {
                window.cart.addGuestCartItem(payload);
            }
        } catch (e) {
            console.error('Error saving food item to cart from food_item page:', e);
        }

        setTimeout(() => {
            if (!btn.isConnected) return;
            btn.innerHTML = originalContent;
            btn.style.background = originalBg;
            btn.disabled = false;
        }, 1000);
    }

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
        const ids = getIdList(FAVORITES_KEY);
        return ids.includes(String(itemId));
    }

    function updateFavoriteButton() {
        const btn = document.getElementById('favToggleBtn');
        if (!btn) return;
        const fav = isFavorite(currentItemId);
        btn.classList.toggle('is-fav', fav);
        btn.setAttribute('aria-label', fav ? 'Remove from favorites' : 'Add to favorites');
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = fav ? 'fas fa-heart' : 'far fa-heart';
        }
    }

    function toggleFavorite() {
        if (!currentItemId) return;
        const ids = getIdList(FAVORITES_KEY);
        const id = String(currentItemId);
        const idx = ids.indexOf(id);
        const next = idx === -1 ? [id, ...ids] : ids.filter((x) => x !== id);
        setIdList(FAVORITES_KEY, next.slice(0, 100));
        updateFavoriteButton();
        if (window.utils?.showToast) {
            window.utils.showToast(idx === -1 ? 'Added to favorites' : 'Removed from favorites', 'success', 1800);
        }
    }



    // Load reviews for item - synced with Firebase menu subcollection
    async function loadReviewsForItem(itemId) {
        if (!itemId) {
            console.warn('No itemId provided for loadReviewsForItem');
            return;
        }

        // Ensure Firebase is ready
        if (!window.firestore?.fetchReviewsForItem || !window.firestore?.fetchReviewSummaryForItem) {
            console.warn('Firestore not ready for reviews');
            return;
        }

        try {
            // Fetch fresh reviews from Firebase menu subcollection: menu/{itemId}/reviews/{reviewId}
            const reviews = await window.firestore.fetchReviewsForItem(itemId);
            const summary = await window.firestore.fetchReviewSummaryForItem(itemId);

            const ratings = reviews.map(r => r.rating);
            const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
            ratings.forEach(rating => {
                const bucket = Math.max(1, Math.min(5, Math.round(rating)));
                breakdown[bucket] = (breakdown[bucket] || 0) + 1;
            });

            const count = ratings.length;
            const avg = summary ? summary.average : (count ? (ratings.reduce((a, b) => a + b, 0) / count) : 0);
            const avgText = avg.toFixed(1);
            const countLabel = count === 1 ? '1 review' : `${count} reviews`;

            const badgeRatingText = document.querySelector('.rating-badge .rating-text') || document.getElementById('rating-text');
            if (badgeRatingText) {
                badgeRatingText.textContent = count > 0 ? `${avgText} (${countLabel})` : 'No reviews yet';
            }

            const ratingStars = document.querySelector('.rating-badge .stars') || document.getElementById('rating-stars');
            if (ratingStars) {
                ratingStars.innerHTML = count > 0 ? generateStarDisplay(avg) : '<i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i>';
            }

            const circleNumber = document.querySelector('.rating-number');
            if (circleNumber) {
                circleNumber.textContent = count > 0 ? avgText : '-';
            }

            const reviewCountEl = document.querySelector('.review-count');
            if (reviewCountEl) {
                reviewCountEl.textContent = count > 0 ? countLabel : 'No reviews yet';
            }

            const overallStars = document.getElementById('overall-stars');
            if (overallStars) {
                overallStars.innerHTML = count > 0 ? generateStarDisplay(avg) : '<i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i><i class="far fa-star"></i>';
            }

            const maxBucket = Math.max(1, breakdown[1], breakdown[2], breakdown[3], breakdown[4], breakdown[5]);
            [5,4,3,2,1].forEach((stars) => {
                const countEl = document.getElementById(`rb-${stars}-count`);
                if (countEl) countEl.textContent = String(breakdown[stars] || 0);
                const bar = document.querySelector(`.rb-bar-inner.rb-${stars}`);
                if (bar) {
                    const value = breakdown[stars] || 0;
                    const width = maxBucket ? (value / maxBucket) * 100 : 0;
                    bar.style.width = `${width}%`;
                }
            });

            const listEl = document.querySelector('.reviews-list');
            if (!listEl) return;

            const emptyEl = listEl.querySelector('.no-reviews');

            if (!reviews.length) {
                if (emptyEl) {
                    emptyEl.style.display = 'block';
                    listEl.innerHTML = '';
                    listEl.appendChild(emptyEl);
                }
                return;
            }

            const auth = window.firebaseAuth || null;
            const currentUserId = auth && auth.currentUser ? auth.currentUser.uid : null;

            // Separate reviews by current user's account (strict matching)
            const ownReviews = [];
            const otherReviews = [];
            reviews.forEach((rev) => {
                // Strict user ID matching to ensure sync with account
                if (currentUserId && rev.userId && rev.userId === currentUserId) {
                    ownReviews.push(rev);
                } else {
                    otherReviews.push(rev);
                }
            });

            const buildCards = (collection, yourReview = false) =>
                collection.map((rev) => {
                    const stars = '★★★★★';
                    // Strict user ID matching for "Your review" badge
                    const isOwn = yourReview || (currentUserId && rev.userId && rev.userId === currentUserId);
                    
                    // Escape HTML for security
                    const safeName = (rev.name || 'Customer').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const safeText = (rev.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const safeDate = rev.createdAtLabel ? rev.createdAtLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
                    
                    return `
                        <div class="review-item-card">
                            <div class="review-item-header">
                                <div class="review-item-main">
                                    <div class="review-item-rating">
                                        <span class="review-score">${(rev.rating || 0).toFixed(1)}</span>
                                        <span class="review-stars">${stars}</span>
                                    </div>
                                    <div class="review-item-meta">
                                        <span class="review-author">${safeName}</span>
                                        ${safeDate ? `<span class="review-date">· ${safeDate}</span>` : ''}
                                        ${isOwn ? '<span class="review-pill">Your review</span>' : ''}
                                    </div>
                                </div>
                            </div>
                            <p class="review-item-text">${safeText}</p>
                        </div>
                    `;
                }).join('');

            const yourSection = document.getElementById('your-reviews-section');
            const yourList = document.getElementById('your-reviews-list');
            const yourCount = document.getElementById('your-reviews-count');
            const otherSection = document.getElementById('other-reviews-section');
            const otherList = document.getElementById('other-reviews-list');
            const otherCount = document.getElementById('other-reviews-count');
            const yourEmptyMarkup = '<div class="reviews-empty-state"><p>You have not reviewed this dish yet.</p></div>';
            const otherEmptyMarkup = `
                <div class="no-reviews">
                    <i class="fas fa-comment-slash"></i>
                    <h3>No reviews yet</h3>
                    <p>Be the first to share your experience with this dish!</p>
                </div>
            `;

            if (yourSection && yourList && yourCount) {
                if (ownReviews.length) {
                    yourSection.hidden = false;
                    yourList.innerHTML = buildCards(ownReviews, true);
                    yourCount.textContent = `${ownReviews.length} ${ownReviews.length === 1 ? 'entry' : 'entries'}`;
                } else {
                    yourSection.hidden = true;
                    yourList.innerHTML = yourEmptyMarkup;
                    yourCount.textContent = '';
                }
            }

            if (otherSection && otherList && otherCount) {
                if (otherReviews.length) {
                    otherList.innerHTML = buildCards(otherReviews, false);
                    otherCount.textContent = `${otherReviews.length} ${otherReviews.length === 1 ? 'review' : 'reviews'}`;
                } else {
                    otherList.innerHTML = otherEmptyMarkup;
                    otherCount.textContent = '0 reviews';
                }
            }
        } catch (error) {
            console.error('Error loading reviews for item:', error);
        }
    }

    // Load food item
    async function loadFoodItem() {
        await window.utils.waitForFirebaseReady();

        const params = new URLSearchParams(window.location.search);
        const idFromUrl = params.get('id');

        let item = null;

        try {
            if (idFromUrl) {
                item = await window.firestore.fetchMenuItemById(idFromUrl);
            }

            if (!item) {
                const items = await window.firestore.fetchMenuItems('all');
                if (items.length > 0) {
                    item = items[0];
                }
            }
        } catch (error) {
            console.error('Error fetching food item:', error);
        }

        if (!item) {
            console.warn('No menu item found for food_item page');
            return;
        }

        const ingredients = Array.isArray(item.ingredients) ? item.ingredients : [];
        const primaryIngredient = ingredients[0] || {};

        const title = item.displayName || item.name || item.title || primaryIngredient.ingredientName || 'Menu item';
        const basePrice =
            typeof item.price === 'number'
                ? item.price
                : typeof primaryIngredient.baseAmountPerDish === 'number'
                    ? primaryIngredient.baseAmountPerDish
                    : 150;
        unitPrice = basePrice;
        const priceDisplay = `₱${basePrice.toFixed(2)}`;

        const description =
            item.description ||
            primaryIngredient.description ||
            'No description available for this item yet.';

        const rawImg = item.img || item.image || item.imageDataUrl || '';
        const hasImage = !!rawImg;

        baseItemData = item;
        currentItemId = item.id || null;
        currentItemName = title;
        currentItemImg = hasImage ? rawImg : '';

        updateFavoriteButton();

        loadAllergenInfo(item);
        loadVariations(item);
        // Sauce selection removed - sauces are now handled via linked items modal

        const variations = Array.isArray(item.variations) ? item.variations : [];
        if (variations.length === 0) {
            const imgEl = document.querySelector('.food-image');
            const imgContainer = imgEl ? imgEl.parentElement : null;
            const titleEl = document.querySelector('.food-title');
            const priceEl = document.querySelector('.food-price');
            const descEl = document.querySelector('.food-description');
            const btnPriceEl = document.querySelector('.add-to-cart-btn .total-price');

            if (titleEl) titleEl.textContent = title;
            if (priceEl) priceEl.textContent = priceDisplay;
            if (btnPriceEl) btnPriceEl.textContent = priceDisplay;
            if (descEl) descEl.textContent = description;

            // Kcal from item (kcalUnit/calories/kcal); show "--" when not set
            const kcalValEl = document.querySelector('#food-kcal .food-kcal-value');
            if (kcalValEl) {
                const v = resolveKcal(item);
                kcalValEl.textContent = (v != null && !isNaN(v)) ? `${Math.round(v)} kcal` : '--';
            }

            const loadingSpinner = document.querySelector('.food-image-loading');
            if (loadingSpinner) {
                loadingSpinner.style.display = 'none';
            }

            if (imgEl && hasImage) {
                imgEl.src = rawImg;
                imgEl.alt = title;
                imgEl.style.display = 'block';
            } else if (imgEl && imgContainer) {
                imgEl.style.display = 'none';
                const placeholder = document.createElement('div');
                placeholder.className = 'food-image placeholder';
                placeholder.textContent = 'No image available';
                imgContainer.appendChild(placeholder);
            }
        }

        changeQty(0);

        if (item.id) {
            loadReviewsForItem(item.id);
        }
    }

    // Expose to window
    window.foodItem = {
        changeQty,
        addToCart,
        selectVariation,
        selectSauce,
        navigateSauces,
        loadFoodItem,
        loadReviewsForItem,
        handleQtyInputChange,
        handleQtyInput,
        toggleFavorite
    };

    // Global functions for onclick handlers
    window.changeQty = changeQty;
    window.addToCart = addToCart;
    window.selectVariation = selectVariation;
    window.handleQtyInputChange = handleQtyInputChange;
    window.handleQtyInput = handleQtyInput;
    window.toggleFavorite = toggleFavorite;

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
        changeQty(0);
        loadFoodItem();
        updateFavoriteButton();
        
        // Update sauce navigation on window resize
        window.addEventListener('resize', () => {
            if (currentSauces.length > 0) {
                updateSauceNavigation();
            }
        });
    });
})();

