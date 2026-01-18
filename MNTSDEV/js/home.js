// ============================================
// HOME PAGE FUNCTIONALITY
// Home page specific JavaScript
// ============================================

(function() {
    'use strict';

    // Generate star display HTML
    function generateHomeStarDisplay(rating) {
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

    // Load promotional hero images from Firestore promotionList collection (placement: banner)
    async function loadPromoImages() {
        try {
            await window.utils.waitForFirebaseReady();
            const db = window.firebaseDb;
            const collection = window.collection;
            const getDocs = window.getDocs;
            if (!db || !collection || !getDocs) {
                console.warn('Firestore not ready for promo images');
                return [];
            }

            const promoCol = collection(db, 'promotionList');
            const snap = await getDocs(promoCol);
            const urls = [];
            snap.forEach((docSnap) => {
                const data = docSnap.data() || {};
                const placement = (data.placement || '').toLowerCase();
                const visibility = (data.visibility || '').toLowerCase();
                const imageUrl = data.imageUrl || data.image || null;
                if (placement === 'banner' && visibility !== 'hidden' && imageUrl) {
                    urls.push(imageUrl);
                }
            });
            console.info('[promo] banner images from Firestore:', urls.length);
            return urls;
        } catch (error) {
            console.error('Error loading promo images from Firestore:', error);
            return [];
        }
    }

    // Fetch review summary for home page
    async function fetchHomeReviewSummary(itemId) {
        return await window.firestore.fetchReviewSummaryForItem(itemId);
    }

    // Carousel scroll function
    function scrollCarousel(direction) {
        const container = document.querySelector('.bestsellers-container');
        const scrollAmount = 320;
        
        if (direction === 'next') {
            container.scrollBy({
                left: scrollAmount,
                behavior: 'smooth'
            });
        } else {
            container.scrollBy({
                left: -scrollAmount,
                behavior: 'smooth'
            });
        }
    }

    // Populate Customer Favorites section
    async function populateHomeFavorites() {
        const container = document.querySelector('.bestsellers-container');
        if (!container) return;

        container.innerHTML = `
            <div class="bestseller-card">
                <div class="bestseller-content">
                    <p class="bestseller-description">Loading favorites...</p>
                </div>
            </div>
        `;

        const items = await window.firestore.fetchMenuItems('all');
        if (!items.length) {
            container.innerHTML = `
                <div class="home-favorites-empty">
                    <p>Menu is unavailable right now. Please check back later.</p>
                </div>
            `;
            return;
        }

        // Exclude sauce items from favorites
        const nonSauceItems = items.filter((item) => {
            const category = (item.category || item.type || '').toLowerCase();
            return category && category.includes('sauce') ? false : true;
        });

        if (!nonSauceItems.length) {
            container.innerHTML = `
                <div class="home-favorites-empty">
                    <p>No menu items available at the moment.</p>
                </div>
            `;
            return;
        }

        // Fetch ratings for display (do not filter by them)
        const itemsWithRatings = await Promise.all(
            nonSauceItems.map(async (item) => {
                const reviewSummary = await fetchHomeReviewSummary(item.id);
                const rating = reviewSummary ? reviewSummary.average : 0;
                return { ...item, rating, reviewCount: reviewSummary ? reviewSummary.count : 0 };
            })
        );

        // Limit to first 12 items to keep the carousel manageable
        const selected = itemsWithRatings.slice(0, 12);

        container.innerHTML = selected.map((item) => {
            const rawImg = item.img || item.image || item.imageDataUrl || '';
            const hasImage = !!rawImg;
            const imgSrc = hasImage ? rawImg : 'food_img.png';

            const ingredients = Array.isArray(item.ingredients) ? item.ingredients : [];
            const primaryIngredient = ingredients[0] || {};
            
            const name =
                item.displayName ||
                item.name ||
                item.title ||
                primaryIngredient.ingredientName ||
                'Menu item';

            // Get price from variations if available
            let basePrice = 150;
            const variations = Array.isArray(item.variations) ? item.variations : [];
            
            if (variations.length > 0) {
                const firstVariation = variations[0];
                if (firstVariation && typeof firstVariation.price === 'number') {
                    basePrice = firstVariation.price;
                } else if (firstVariation && typeof firstVariation.price === 'string') {
                    basePrice = parseFloat(firstVariation.price) || basePrice;
                }
            } else {
                if (typeof item.price === 'number') {
                    basePrice = item.price;
                } else if (typeof primaryIngredient.baseAmountPerDish === 'number') {
                    basePrice = primaryIngredient.baseAmountPerDish;
                }
            }

            const description =
                item.description ||
                primaryIngredient.description ||
                'Flame-grilled favorite from Pablo\'s Peri Peri.';

            const rating = item.rating || 0;
            const reviewCount = item.reviewCount || 0;
            const starsHtml = generateHomeStarDisplay(rating);
            const ratingText = reviewCount > 0 
                ? `${rating.toFixed(1)} (${reviewCount} ${reviewCount === 1 ? 'review' : 'reviews'})`
                : 'No reviews yet';

            const attrSafeName = String(name).replace(/"/g, '&quot;');
            const attrSafeImg = String(imgSrc).replace(/"/g, '&quot;');

            return `
                <div class="bestseller-card" data-item-id="${item.id}" onclick="window.location.href='food_item.html?id=${item.id}'">
                    <div class="bestseller-image">
                        <img src="${imgSrc}" alt="${name}" class="food-image">
                    </div>
                    <div class="bestseller-content">
                        <h3 class="bestseller-title">${name}</h3>
                        <div class="bestseller-rating">
                            <span class="bestseller-stars">
                                ${starsHtml}
                            </span>
                            <span class="bestseller-rating-text">
                                ${ratingText}
                            </span>
                        </div>
                        <p class="bestseller-description">${description}</p>
                        <div class="price-section">
                            <p class="bestseller-price">${window.utils.formatPeso(basePrice)}</p>
                            <button 
                                class="add-to-cart-btn"
                                data-item-id="${item.id}"
                                data-item-name="${attrSafeName}"
                                data-item-price="${basePrice}"
                                data-item-img="${attrSafeImg}"
                                onclick="event.stopPropagation(); window.cart.addToCart(event)"
                            >
                                <i class="fas fa-plus"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // Initialize home page
    function initializeHome() {
        // Back to top button
        const backToTop = document.querySelector('.back-to-top');
        if (backToTop) {
            const toggleBackToTop = () => {
                if (window.scrollY > 400) backToTop.classList.add('show');
                else backToTop.classList.remove('show');
            };
            window.addEventListener('scroll', toggleBackToTop, { passive: true });
            backToTop.addEventListener('click', () => {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        }

        // Hero image slider
        (async function setupHeroSlider() {
            const slider = document.querySelector('.hero-slider');
            if (!slider) return;

            // Load promotional images from Firebase Storage; fallback to a single default image
            const promoImages = await loadPromoImages();
            console.info('[promo] using images count:', promoImages.length);
            const images = promoImages.length ? promoImages : ['peri.jpg'];

            const slidesHtml = images.map((url, idx) => `
                <div class="hero-slide ${idx === 0 ? 'is-active' : ''}">
                    <img src="${url}" alt="Promotion slide ${idx + 1}">
                </div>
            `).join('');

            const dotsHtml = images.length > 1
                ? images.map((_, idx) => `
                    <button class="hero-slider-dot ${idx === 0 ? 'is-active' : ''}" type="button" data-slide="${idx}"></button>
                `).join('')
                : '';

            const controlsHtml = images.length > 1 ? `
                <button class="hero-slider-control hero-slider-control-prev" type="button" aria-label="Previous image">
                    &#10094;
                </button>
                <button class="hero-slider-control hero-slider-control-next" type="button" aria-label="Next image">
                    &#10095;
                </button>
            ` : '';

            const dotsWrapper = dotsHtml ? `<div class="hero-slider-dots" aria-hidden="true">${dotsHtml}</div>` : '';

            slider.innerHTML = `
                ${slidesHtml}
                ${controlsHtml}
                ${dotsWrapper}
            `;

            const slides = Array.from(slider.querySelectorAll('.hero-slide'));
            const dots = Array.from(slider.querySelectorAll('.hero-slider-dot'));
            const prevBtn = slider.querySelector('.hero-slider-control-prev');
            const nextBtn = slider.querySelector('.hero-slider-control-next');

            if (slides.length <= 1) return;

            let currentIndex = 0;
            let autoplayTimer = null;
            const AUTOPLAY_INTERVAL = 3000;

            function setActiveSlide(index) {
                currentIndex = (index + slides.length) % slides.length;

                slides.forEach((slide, i) => {
                    slide.classList.toggle('is-active', i === currentIndex);
                });

                dots.forEach((dot, i) => {
                    dot.classList.toggle('is-active', i === currentIndex);
                });
            }

            function nextSlide() {
                setActiveSlide(currentIndex + 1);
            }

            function prevSlide() {
                setActiveSlide(currentIndex - 1);
            }

            function resetAutoplay() {
                if (autoplayTimer) clearInterval(autoplayTimer);
                autoplayTimer = setInterval(nextSlide, AUTOPLAY_INTERVAL);
            }

            if (nextBtn) {
                nextBtn.addEventListener('click', () => {
                    nextSlide();
                    resetAutoplay();
                });
            }

            if (prevBtn) {
                prevBtn.addEventListener('click', () => {
                    prevSlide();
                    resetAutoplay();
                });
            }

            dots.forEach((dot, index) => {
                dot.addEventListener('click', () => {
                    setActiveSlide(index);
                    resetAutoplay();
                });
            });

            resetAutoplay();
        })();

        // Scroll reveal animation
        const observerOptions = {
            threshold: 0.1,
            rootMargin: '0px 0px -50px 0px'
        };

        const observer = new IntersectionObserver(function(entries) {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0)';
                }
            });
        }, observerOptions);

        document.querySelectorAll('.bestseller-card, .info-card').forEach(el => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(30px)';
            el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
            observer.observe(el);
        });

        // Populate Customer Favorites
        populateHomeFavorites();

        // Highlight current page in banner nav
        const path = window.location.pathname.split('/').pop() || 'index.html';
        const homeLink = document.querySelector('.banner-nav-link-home');
        const menuLink = document.querySelector('.banner-nav-link-menu');

        if (path === 'menu.html' && menuLink) {
            menuLink.classList.add('is-active');
        } else if ((path === '' || path === 'index.html') && homeLink) {
            homeLink.classList.add('is-active');
        }
    }

    // Expose functions
    window.home = {
        scrollCarousel,
        populateHomeFavorites
    };

    // Global function for onclick handlers
    window.scrollCarousel = scrollCarousel;

    // Initialize when DOM is ready
    document.addEventListener('DOMContentLoaded', initializeHome);
})();

