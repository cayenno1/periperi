// ============================================
// HELP PAGE FUNCTIONALITY
// ============================================

(function() {
    'use strict';

    // Initialize FAQ accordion
    function initFAQ() {
        document.querySelectorAll('.faq-q').forEach(btn => {
            btn.addEventListener('click', function() {
                const item = btn.parentElement;
                const answer = item.querySelector('.faq-a');
                const isOpen = answer.style.display === 'block';
                answer.style.display = isOpen ? 'none' : 'block';
                btn.querySelector('i')?.classList.toggle('fa-rotate-180');
            });
        });
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

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', function() {
        initFAQ();
        initProfileDropdown();
    });
})();

