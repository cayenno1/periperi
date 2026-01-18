// ============================================
// DRINK PAGE FUNCTIONALITY
// ============================================

(function() {
    'use strict';

    const prices = {
        icetea: { Large: 101, Regular: 90 },
        coke: 79
    };
    
    let qty = { icetea: 1, coke: 0 };
    
    function changeQty(drink, delta) {
        qty[drink] = Math.max(0, qty[drink] + delta);
        const qtyEl = document.getElementById('qty-' + drink);
        if (qtyEl) qtyEl.textContent = qty[drink];
        updateTotal();
    }
    
    function updateTotal() {
        const sizeSelect = document.getElementById('size-icetea');
        if (!sizeSelect) return;
        
        const iceteaSize = sizeSelect.value;
        const iceteaPrice = prices.icetea[iceteaSize];
        const cokePrice = prices.coke;
        
        const total = (iceteaPrice * qty.icetea) + (cokePrice * qty.coke);
        const totalEl = document.getElementById('total-amount');
        if (totalEl) totalEl.textContent = `₱${total}.00`;
    }
    
    function skipDrinks() {
        const totalDrinks = qty.icetea + qty.coke;
        
        if (totalDrinks === 0) {
            window.location.href = 'menu.html';
        } else {
            window.location.href = 'cart_review.html';
        }
    }

    function addToOrder() {
        const totalDrinks = qty.icetea + qty.coke;
        
        if (totalDrinks === 0) {
            return;
        }
        
        showBigNotification();
        
        setTimeout(() => {
            window.location.href = 'cart_review.html';
        }, 1500);
    }

    function showBigNotification() {
        const overlay = document.createElement('div');
        overlay.className = 'big-notification-overlay';
        overlay.innerHTML = `
            <div class="big-notification">
                <div class="checkmark-circle">
                    <i class="fas fa-check"></i>
                </div>
                <h2>Added to Order!</h2>
                <p>Your drinks have been added successfully</p>
            </div>
        `;
        document.body.appendChild(overlay);
        
        setTimeout(() => {
            overlay.remove();
        }, 1500);
    }

    // Initialize profile dropdown
    function initProfileDropdown() {
        const btn = document.getElementById('profileButton');
        const dropdown = document.getElementById('profileDropdown');
        if (!btn || !dropdown) return;

        function toggleDropdown(e) {
            e.stopPropagation();
            dropdown.classList.toggle('show');
        }

        function handleOutside(e) {
            if (!dropdown.classList.contains('show')) return;
            if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
                dropdown.classList.remove('show');
            }
        }

        btn.addEventListener('click', toggleDropdown);
        document.addEventListener('click', handleOutside);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') dropdown.classList.remove('show');
        });

        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', function() {
                dropdown.classList.remove('show');
                alert('You have been logged out.');
                setTimeout(() => {
                    window.location.href = 'login.html';
                }, 300);
            });
        }
    }

    // Expose functions to window for onclick handlers
    window.changeQty = changeQty;
    window.skipDrinks = skipDrinks;
    window.addToOrder = addToOrder;

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', function() {
        const sizeSelect = document.getElementById('size-icetea');
        if (sizeSelect) {
            sizeSelect.addEventListener('change', function() {
                const price = prices.icetea[this.value];
                const priceEl = document.getElementById('price-icetea');
                if (priceEl) {
                    priceEl.textContent = `₱${price}.00`;
                    const nextEl = priceEl.nextElementSibling;
                    if (nextEl) nextEl.textContent = `₱${price}.00 each`;
                }
                updateTotal();
            });
        }
        
        initProfileDropdown();
        updateTotal();
    });
})();

