// ============================================
// DRIVER LOGIN PAGE FUNCTIONALITY
// ============================================

(function() {
    'use strict';

    // Setup password toggle
    function initPasswordToggle() {
        const driverPassToggle = document.getElementById('driverPassToggle');
        const driverPassInput = document.getElementById('driverPass');
        if (!driverPassToggle || !driverPassInput) return;

        const driverPassIcon = driverPassToggle.querySelector('i');
        if (!driverPassIcon) return;

        driverPassToggle.addEventListener('click', function() {
            if (driverPassInput.type === 'password') {
                driverPassInput.type = 'text';
                driverPassIcon.classList.replace('fa-eye', 'fa-eye-slash');
            } else {
                driverPassInput.type = 'password';
                driverPassIcon.classList.replace('fa-eye-slash', 'fa-eye');
            }
        });
    }

    // Handle form submission
    function initForm() {
        const form = document.getElementById('driverLoginForm');
        if (!form) return;

        form.addEventListener('submit', function(e) {
            e.preventDefault();
            const user = document.getElementById('driverUser').value.trim().toLowerCase();
            const pass = document.getElementById('driverPass').value;
            
            if (user === 'relez' && pass === '123') {
                try {
                    localStorage.setItem('ppp_user', JSON.stringify({
                        id: user,
                        role: 'driver'
                    }));
                } catch (e) {
                    console.error('Error saving driver info:', e);
                }
                window.location.href = 'driver.html';
            } else {
                if (window.showAlert) {
                    window.showAlert('Invalid username or password', 'error');
                } else {
                    alert('Invalid username or password');
                }
            }
        });
    }

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', function() {
        initPasswordToggle();
        initForm();
    });
})();

