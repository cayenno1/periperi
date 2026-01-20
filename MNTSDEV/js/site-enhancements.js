// ============================================================
// SITE ENHANCEMENTS
// - Mobile bottom nav injection
// - Lazy-load images by default
// - Keep cart badge mirrored on bottom nav
// ============================================================

(function () {
  'use strict';

  const ACTIVE_BY_PATH = [
    { key: 'home', paths: ['index.html', ''] },
    { key: 'menu', paths: ['menu.html', 'food_item.html'] },
    { key: 'cart', paths: ['cart_review.html', 'checkout.html'] },
    { key: 'orders', paths: ['orders.html', 'order_details.html', 'completion_receipt_page.html'] }
  ];

  function getActiveKey() {
    const path = (window.location.pathname || '').split('/').pop() || '';
    const match = ACTIVE_BY_PATH.find((x) => x.paths.includes(path));
    return match ? match.key : null;
  }

  function safeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function getCartCount() {
    try {
      const raw = window.localStorage?.getItem('ppp_cart_count');
      return Math.max(0, safeNumber(raw, 0));
    } catch {
      return 0;
    }
  }

  function setBottomNavBadge(count) {
    const badge = document.querySelector('.ppp-bottom-nav-badge');
    if (!badge) return;
    const n = Math.max(0, safeNumber(count, 0));
    badge.textContent = String(n);
    badge.style.display = n > 0 ? 'inline-flex' : 'none';
  }

  function ensureBottomNav() {
    // Avoid adding it on admin/driver pages (if any) or if already present.
    if (document.querySelector('.ppp-bottom-nav')) return;
    const bodyClass = document.body?.className || '';
    if (bodyClass.includes('driver')) return;

    const nav = document.createElement('nav');
    nav.className = 'ppp-bottom-nav';
    nav.setAttribute('aria-label', 'Primary');

    const active = getActiveKey();
    nav.innerHTML = `
      <div class="ppp-bottom-nav-inner">
        <a href="index.html" class="${active === 'home' ? 'is-active' : ''}" aria-label="Home">
          <span class="ppp-bottom-nav-icon"><i class="fas fa-home"></i></span>
          <span class="ppp-bottom-nav-label">Home</span>
        </a>
        <a href="menu.html" class="${active === 'menu' ? 'is-active' : ''}" aria-label="Menu">
          <span class="ppp-bottom-nav-icon"><i class="fas fa-utensils"></i></span>
          <span class="ppp-bottom-nav-label">Menu</span>
        </a>
        <a href="cart_review.html" class="${active === 'cart' ? 'is-active' : ''}" aria-label="Cart">
          <span class="ppp-bottom-nav-icon">
            <i class="fas fa-shopping-bag"></i>
            <span class="ppp-bottom-nav-badge" style="display:none;">0</span>
          </span>
          <span class="ppp-bottom-nav-label">Cart</span>
        </a>
        <a href="orders.html" class="${active === 'orders' ? 'is-active' : ''}" aria-label="Orders">
          <span class="ppp-bottom-nav-icon"><i class="fas fa-receipt"></i></span>
          <span class="ppp-bottom-nav-label">Orders</span>
        </a>
      </div>
    `;

    document.body.appendChild(nav);
    setBottomNavBadge(getCartCount());

    document.addEventListener('cart:count-changed', (e) => {
      const count = typeof e.detail?.count === 'number' ? e.detail.count : getCartCount();
      setBottomNavBadge(count);
    });
  }

  function ensureStickyAddBar() {
    if (!document.body?.classList?.contains('food-item-page')) return;
    if (document.querySelector('.ppp-sticky-addbar')) return;

    const bar = document.createElement('div');
    bar.className = 'ppp-sticky-addbar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Add to cart');

    bar.innerHTML = `
      <div class="ppp-sticky-addbar-inner">
        <div class="ppp-sticky-qty" aria-label="Quantity">
          <button type="button" class="btn btn-light" data-action="minus" aria-label="Decrease quantity">
            <i class="fas fa-minus"></i>
          </button>
          <input type="text" inputmode="numeric" pattern="\\d{1,2}" maxlength="2" aria-label="Quantity" value="1">
          <button type="button" class="btn btn-light" data-action="plus" aria-label="Increase quantity">
            <i class="fas fa-plus"></i>
          </button>
        </div>
        <button type="button" class="btn btn-danger ppp-sticky-addbtn" aria-label="Add to cart">
          <span style="font-weight:700;">Add to Cart</span>
          <span class="ppp-sticky-total" style="margin-left:10px;">₱0.00</span>
        </button>
      </div>
    `;

    document.body.appendChild(bar);

    const qtyInput = bar.querySelector('input');
    const minusBtn = bar.querySelector('[data-action="minus"]');
    const plusBtn = bar.querySelector('[data-action="plus"]');
    const addBtn = bar.querySelector('.ppp-sticky-addbtn');
    const totalEl = bar.querySelector('.ppp-sticky-total');

    const getMainQtyEl = () => document.getElementById('qty');
    const getMainTotalEl = () => document.querySelector('.add-to-cart-btn .total-price');

    function syncFromMain() {
      const mainQty = getMainQtyEl();
      const mainTotal = getMainTotalEl();
      if (qtyInput && mainQty) qtyInput.value = String(mainQty.value || '1');
      if (totalEl && mainTotal) totalEl.textContent = String(mainTotal.textContent || '₱0.00');
    }

    function commitQtyToMain(raw) {
      const mainQty = getMainQtyEl();
      if (!mainQty) return;
      mainQty.value = String(raw || '1');
      if (typeof window.handleQtyInputChange === 'function') {
        window.handleQtyInputChange();
      }
      syncFromMain();
    }

    if (minusBtn) {
      minusBtn.addEventListener('click', () => {
        if (typeof window.changeQty === 'function') window.changeQty(-1);
        syncFromMain();
      });
    }
    if (plusBtn) {
      plusBtn.addEventListener('click', () => {
        if (typeof window.changeQty === 'function') window.changeQty(1);
        syncFromMain();
      });
    }
    if (qtyInput) {
      qtyInput.addEventListener('input', () => {
        // Keep only digits (max 2 chars)
        qtyInput.value = String(qtyInput.value || '').replace(/[^\d]/g, '').slice(0, 2);
      });
      qtyInput.addEventListener('blur', () => {
        const v = qtyInput.value === '' ? '1' : qtyInput.value;
        commitQtyToMain(v);
      });
    }
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (typeof window.addToCart === 'function') window.addToCart();
      });
    }

    // Keep in sync even if variation changes price.
    syncFromMain();
    setInterval(syncFromMain, 350);
  }

  function applyLazyLoadingDefaults() {
    // Avoid overriding intentional eager loads (hero banners, etc.).
    document.querySelectorAll('img').forEach((img) => {
      if (img.closest('.hero-section, .hero-slider, .hero-slide')) return;
      if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
      if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    ensureBottomNav();
    ensureStickyAddBar();
    applyLazyLoadingDefaults();
  });
})();

