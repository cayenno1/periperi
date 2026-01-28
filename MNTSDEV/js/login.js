

(function() {
    'use strict';

    let isSubmitting = false;
    const GUEST_CART_KEY = 'ppp_guest_cart';

    function getRedirectParam() {
        try {
            const params = new URLSearchParams(window.location.search);
            return (params.get('redirect') || '').trim();
        } catch (e) {
            return '';
        }
    }

    function sanitizeRedirect(value) {
        const v = String(value || '').trim();
        if (!v) return '';
        // Disallow absolute URLs / protocol-relative / path traversal
        if (v.includes('://') || v.startsWith('//') || v.includes('\\') || v.includes('..')) return '';
        // Only allow local html pages (optionally with a querystring)
        const ok = /^[a-zA-Z0-9_\-/]+\.html(\?.*)?$/.test(v);
        return ok ? v : '';
    }

    function wireAuthLinks(redirectTarget) {
        const signUpLink = document.querySelector('.restaurant-auth-footer a[href^="register.html"]');
        if (signUpLink && redirectTarget) {
            signUpLink.href = `register.html?redirect=${encodeURIComponent(redirectTarget)}`;
        }
    }

    function readGuestCart() {
        try {
            const raw = window.localStorage?.getItem(GUEST_CART_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function clearGuestCart() {
        try {
            window.localStorage?.removeItem(GUEST_CART_KEY);
        } catch (e) {}
    }

    async function migrateGuestCartToUserCart() {
        // When user logs in from guest checkout prompt, move local cart into Firestore cart.
        try {
            await window.utils?.waitForFirebaseReady?.();

            const user = window.firebaseAuth?.currentUser || null;
            if (!user) return;

            const cart = readGuestCart();
            if (!cart.length) return;

            const db = window.firebaseDb;
            if (!db || !window.doc || !window.collection || !window.getDocs || !window.query || !window.where || !window.setDoc || !window.updateDoc) {
                return;
            }

            const customerRef = window.doc(db, 'customers', user.uid);
            const cartItemsCol = window.collection(customerRef, 'cartItems');

            for (const item of cart) {
                const itemId = item?.itemId || null;
                const name = item?.name || null;
                const imageUrl = item?.imageUrl || null;
                const quantity = typeof item?.quantity === 'number' ? item.quantity : Number(item?.quantity) || 1;
                const lineTotal = typeof item?.price === 'number' ? item.price : Number(item?.price) || 0;
                const variation = item?.variation || null;
                const sauce = item?.sauce || null;

                let existingSnap = null;
                if (itemId) {
                    const q = window.query(cartItemsCol, window.where('itemId', '==', itemId));
                    const existingQuerySnap = await window.getDocs(q);
                    existingQuerySnap.forEach((docSnap) => {
                        const data = docSnap.data() || {};
                        const variationMatch = JSON.stringify(data.variation || null) === JSON.stringify(variation || null);
                        const sauceMatch = JSON.stringify(data.sauce || null) === JSON.stringify(sauce || null);
                        if (variationMatch && sauceMatch && !existingSnap) existingSnap = docSnap;
                    });
                }

                if (existingSnap) {
                    const data = existingSnap.data() || {};
                    const currentQty = typeof data.quantity === 'number' ? data.quantity : Number(data.quantity) || 0;
                    const currentPrice = typeof data.price === 'number' ? data.price : Number(data.price) || 0;
                    await window.updateDoc(existingSnap.ref, {
                        quantity: currentQty + quantity,
                        price: currentPrice + lineTotal,
                        updatedAt: new Date()
                    });
                } else {
                    const cartItemRef = window.doc(cartItemsCol);
                    await window.setDoc(cartItemRef, {
                        itemId,
                        name,
                        imageUrl,
                        price: lineTotal,
                        quantity,
                        variation,
                        sauce,
                        createdAt: new Date()
                    });
                }
            }

            // Clear guest cart after successful migration
            clearGuestCart();
        } catch (e) {
            console.warn('Guest cart migration failed:', e);
        }
    }

    // Initialize password toggle
    function initPasswordToggle() {
        const passwordToggle = document.getElementById('passwordToggle');
        const passwordInput = document.getElementById('password');
        if (!passwordToggle || !passwordInput) return;

        const passwordIcon = passwordToggle.querySelector('i');
        if (!passwordIcon) return;

        passwordToggle.addEventListener('click', function() {
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                passwordIcon.classList.remove('fa-eye');
                passwordIcon.classList.add('fa-eye-slash');
            } else {
                passwordInput.type = 'password';
                passwordIcon.classList.remove('fa-eye-slash');
                passwordIcon.classList.add('fa-eye');
            }
        });
    }

    // Modal functions
    function showForgotPassword() {
        const modal = document.getElementById('forgotPasswordModal');
        if (modal) modal.style.display = 'flex';
    }

    function closeModal() {
        const modal = document.getElementById('forgotPasswordModal');
        if (modal) modal.style.display = 'none';
    }

    // Expose to window for onclick handlers
    window.closeModal = closeModal;

    // Initialize forgot password modal
    function initForgotPasswordModal() {
        const forgotPasswordLink = document.querySelector('.forgot-password');
        if (forgotPasswordLink) {
            forgotPasswordLink.addEventListener('click', function(e) {
                e.preventDefault();
                showForgotPassword();
            });
        }

        const modal = document.getElementById('forgotPasswordModal');
        if (modal) {
            modal.addEventListener('click', function(e) {
                if (e.target === this) {
                    closeModal();
                }
            });
        }
    }

    // Form submission
    function initLoginForm() {
        const form = document.getElementById('loginForm');
        if (!form) return;

        form.addEventListener('submit', async function(e) {
            e.preventDefault();

            if (isSubmitting) return;

            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;

            window.auth.clearAllErrors(['email', 'password']);

            let hasErrors = false;

            if (!email) {
                window.auth.showError('email', 'Email is required');
                hasErrors = true;
            }

            if (!password) {
                window.auth.showError('password', 'Password is required');
                hasErrors = true;
            }

            if (hasErrors) return;

            window.auth.setFormState(
                true,
                'submitButton',
                'submitButtonText',
                'Signing In...',
                'Sign In'
            );
            isSubmitting = true;

            const redirectTarget = sanitizeRedirect(getRedirectParam());
            const result = await window.auth.unifiedLogin(email, password);
            isSubmitting = false;

            if (result.success) {
                // If they had a guest cart, migrate it into the logged-in Firestore cart.
                if (result.redirect !== 'driver.html') {
                    await migrateGuestCartToUserCart();
                }
                // Never override driver login redirect.
                const finalTarget =
                    result.redirect === 'driver.html'
                        ? 'driver.html'
                        : (redirectTarget || result.redirect || 'index.html');
                window.location.href = finalTarget;
            } else {
                window.auth.setFormState(
                    false,
                    'submitButton',
                    'submitButtonText',
                    'Signing In...',
                    'Sign In'
                );

                const errorMessage = window.auth.getErrorMessage(result.error);
                const errorField = result.error?.code === 'auth/email-not-verified' ? 'email' : 'email';
                window.auth.showError(errorField, errorMessage);
            }
        });
    }

    async function handleProviderSignIn(providerKey) {
        if (isSubmitting) return;

        const redirectTarget = sanitizeRedirect(getRedirectParam());

        // Reuse the existing submit button spinner/disable behavior.
        window.auth.setFormState(
            true,
            'submitButton',
            'submitButtonText',
            'Signing In...',
            'Sign In'
        );
        isSubmitting = true;

        const oauthButtons = document.querySelectorAll('[data-auth-provider]');
        oauthButtons.forEach((btn) => {
            try { btn.disabled = true; } catch (e) {}
        });

        const result = await window.auth.signInWithProvider(providerKey, { redirectTarget });
        isSubmitting = false;

        if (result.success) {
            await migrateGuestCartToUserCart();
            const finalTarget = redirectTarget || result.redirect || 'index.html';
            window.location.href = finalTarget;
            return;
        }

        window.auth.setFormState(
            false,
            'submitButton',
            'submitButtonText',
            'Signing In...',
            'Sign In'
        );
        oauthButtons.forEach((btn) => {
            try { btn.disabled = false; } catch (e) {}
        });

        // Handle account linking scenario
        if (result.error?.code === 'auth/account-exists-with-different-credential' && result.error?.canLink) {
            const errorMessage = result.error.message || 'This email is already registered with email/password. Please sign in with your password first, then you can link your Google account.';
            window.auth.showError('email', errorMessage);
            // Show additional info about linking
            const emailInput = document.getElementById('email');
            if (emailInput) {
                emailInput.value = result.error.email || '';
            }
            return;
        }

        const errorMessage = window.auth.getErrorMessage(result.error);
        window.auth.showError('email', errorMessage);
    }

    function initProviderButtons() {
        const buttons = document.querySelectorAll('[data-auth-provider]');
        if (!buttons || buttons.length === 0) return;

        buttons.forEach((btn) => {
            const provider = btn.getAttribute('data-auth-provider');
            if (!provider) return;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                handleProviderSignIn(provider);
            });
        });
    }

    // Password reset form
    function initPasswordResetForm() {
        const form = document.getElementById('resetPasswordForm');
        if (!form) return;

        form.addEventListener('submit', async function(e) {
            e.preventDefault();

            const emailInput = document.getElementById('resetEmail');
            const email = emailInput ? emailInput.value.trim() : '';

            if (!email) {
                if (window.showAlert) {
                    window.showAlert('Please enter your email address.', 'warning');
                } else {
                    alert('Please enter your email address.');
                }
                return;
            }

            const result = await window.auth.sendPasswordReset(email);

            if (result.success) {
                if (window.showAlert) {
                    window.showAlert('Password reset email sent. Please check your inbox.', 'success');
                } else {
                    alert('Password reset email sent. Please check your inbox.');
                }
                closeModal();
            } else {
                let message = 'Failed to send password reset email. Please try again.';
                if (result.error) {
                    switch (result.error.code) {
                        case 'auth/user-not-found':
                            message = 'No account found with this email address.';
                            break;
                        case 'auth/invalid-email':
                            message = 'Invalid email address. Please enter a valid email.';
                            break;
                        case 'auth/network-request-failed':
                            message = 'Network error. Please check your internet connection and try again.';
                            break;
                        default:
                            message = result.error.message || message;
                    }
                }
                if (window.showAlert) {
                    window.showAlert(message, 'error');
                } else {
                    alert(message);
                }
            }
        });
    }

    // Clear errors on input
    function initInputListeners() {
        const emailInput = document.getElementById('email');
        const passwordInput = document.getElementById('password');

        if (emailInput) {
            emailInput.addEventListener('input', () => window.auth.clearError('email'));
        }
        if (passwordInput) {
            passwordInput.addEventListener('input', () => window.auth.clearError('password'));
        }
    }

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', function() {
        const redirectTarget = sanitizeRedirect(getRedirectParam());
        wireAuthLinks(redirectTarget);
        initPasswordToggle();
        initForgotPasswordModal();
        initLoginForm();
        initProviderButtons();
        initPasswordResetForm();
        initInputListeners();
    });
})();

