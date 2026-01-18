// ============================================
// LOGIN PAGE FUNCTIONALITY
// ============================================

(function() {
    'use strict';

    let isSubmitting = false;

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

            const result = await window.auth.unifiedLogin(email, password);
            isSubmitting = false;

            if (result.success) {
                window.location.href = result.redirect || 'index.html';
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

    // Password reset form
    function initPasswordResetForm() {
        const form = document.getElementById('resetPasswordForm');
        if (!form) return;

        form.addEventListener('submit', async function(e) {
            e.preventDefault();

            const emailInput = document.getElementById('resetEmail');
            const email = emailInput ? emailInput.value.trim() : '';

            if (!email) {
                alert('Please enter your email address.');
                return;
            }

            const result = await window.auth.sendPasswordReset(email);

            if (result.success) {
                alert('Password reset email sent. Please check your inbox.');
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
                alert(message);
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
        initPasswordToggle();
        initForgotPasswordModal();
        initLoginForm();
        initPasswordResetForm();
        initInputListeners();
    });
})();

