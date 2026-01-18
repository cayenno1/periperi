// ============================================
// REGISTER PAGE FUNCTIONALITY
// ============================================

(function() {
    'use strict';

    let isSubmitting = false;

    // Password strength checker
    function checkPasswordStrength(password) {
        let strength = 0;
        let feedback = [];

        if (password.length >= 8) strength++;
        else feedback.push('At least 8 characters');

        if (/[a-z]/.test(password)) strength++;
        else feedback.push('lowercase letter');

        if (/[A-Z]/.test(password)) strength++;
        else feedback.push('uppercase letter');

        if (/[0-9]/.test(password)) strength++;
        else feedback.push('number');

        if (/[^a-zA-Z0-9]/.test(password)) strength++;
        else feedback.push('special character');

        return { strength, feedback };
    }

    function updatePasswordStrength(password) {
        const strengthFill = document.getElementById('passwordStrengthFill');
        const strengthText = document.getElementById('passwordStrengthText');
        const strengthContainer = document.getElementById('passwordStrength');

        if (!strengthFill || !strengthText || !strengthContainer) return;

        if (!password) {
            strengthContainer.style.display = 'none';
            return;
        }

        strengthContainer.style.display = 'block';
        const { strength } = checkPasswordStrength(password);

        const percentage = (strength / 5) * 100;
        strengthFill.style.width = percentage + '%';

        if (strength <= 1) {
            strengthFill.style.backgroundColor = '#e53935';
            strengthText.textContent = 'Weak';
            strengthText.style.color = '#e53935';
        } else if (strength <= 3) {
            strengthFill.style.backgroundColor = '#ff9800';
            strengthText.textContent = 'Medium';
            strengthText.style.color = '#ff9800';
        } else {
            strengthFill.style.backgroundColor = '#4caf50';
            strengthText.textContent = 'Strong';
            strengthText.style.color = '#4caf50';
        }
    }

    // Validation functions
    function validateFirstName(value) {
        if (!value.trim()) {
            return 'First name is required';
        }
        if (value.trim().length < 2) {
            return 'First name must be at least 2 characters';
        }
        if (!/^[a-zA-Z\s'-]+$/.test(value.trim())) {
            return 'First name can only contain letters, spaces, hyphens, and apostrophes';
        }
        return '';
    }

    function validateLastName(value) {
        if (!value.trim()) {
            return 'Last name is required';
        }
        if (value.trim().length < 2) {
            return 'Last name must be at least 2 characters';
        }
        if (!/^[a-zA-Z\s'-]+$/.test(value.trim())) {
            return 'Last name can only contain letters, spaces, hyphens, and apostrophes';
        }
        return '';
    }

    function validateEmail(value) {
        if (!value.trim()) {
            return 'Email is required';
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value.trim())) {
            return 'Please enter a valid email address';
        }
        return '';
    }

    function validatePhone(value) {
        if (!value.trim()) {
            return 'Phone number is required';
        }
        const phoneDigits = value.replace(/[\s\-\(\)]/g, '');
        if (phoneDigits.length < 10 || phoneDigits.length > 11) {
            return 'Please enter a valid phone number';
        }
        return '';
    }

    function validatePassword(value) {
        if (!value) {
            return 'Password is required';
        }
        if (value.length < 6) {
            return 'Password must be at least 6 characters';
        }
        const { strength } = checkPasswordStrength(value);
        if (strength < 2) {
            return 'Password is too weak. Use a mix of letters, numbers, and special characters';
        }
        return '';
    }

    function validateConfirmPassword(value, password) {
        if (!value) {
            return 'Please confirm your password';
        }
        if (value !== password) {
            return 'Passwords do not match';
        }
        return '';
    }

    // Success modal
    function showSuccessModal() {
        const modal = document.getElementById('successModal');
        const closeBtn = document.getElementById('successCloseBtn');

        if (!modal) return;

        modal.style.display = 'flex';

        if (closeBtn) {
            closeBtn.onclick = function() {
                modal.style.display = 'none';
                window.location.href = 'login.html';
            };
        }
    }

    // Form submission
    function initForm() {
        const form = document.getElementById('registerForm');
        if (!form) return;

        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            if (isSubmitting) return;
            
            const firstName = document.getElementById('firstName').value.trim();
            const lastName = document.getElementById('lastName').value.trim();
            const email = document.getElementById('email').value.trim();
            const phone = document.getElementById('phone').value.trim();
            const password = document.getElementById('password').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            const terms = document.getElementById('terms').checked;
            
            window.auth.clearAllErrors(['firstName', 'lastName', 'email', 'phone', 'password', 'confirmPassword', 'terms']);
            
            let hasErrors = false;
            
            const firstNameError = validateFirstName(firstName);
            if (firstNameError) {
                window.auth.showError('firstName', firstNameError);
                hasErrors = true;
            }
            
            const lastNameError = validateLastName(lastName);
            if (lastNameError) {
                window.auth.showError('lastName', lastNameError);
                hasErrors = true;
            }
            
            const emailError = validateEmail(email);
            if (emailError) {
                window.auth.showError('email', emailError);
                hasErrors = true;
            }
            
            const phoneError = validatePhone(phone);
            if (phoneError) {
                window.auth.showError('phone', phoneError);
                hasErrors = true;
            }
            
            const passwordError = validatePassword(password);
            if (passwordError) {
                window.auth.showError('password', passwordError);
                hasErrors = true;
            }
            
            const confirmPasswordError = validateConfirmPassword(confirmPassword, password);
            if (confirmPasswordError) {
                window.auth.showError('confirmPassword', confirmPasswordError);
                hasErrors = true;
            }
            
            if (!terms) {
                window.auth.showError('terms', 'Please agree to the Terms of Service and Privacy Policy');
                hasErrors = true;
            }
            
            if (hasErrors) return;
            
            window.auth.setFormState(
                true,
                'submitButton',
                'submitButtonText',
                'Creating Account...',
                'Create Account'
            );
            isSubmitting = true;

            const result = await window.auth.registerUser(firstName, lastName, email, phone, password);
            isSubmitting = false;

            if (result.success) {
                showSuccessModal();
            } else {
                window.auth.setFormState(
                    false,
                    'submitButton',
                    'submitButtonText',
                    'Creating Account...',
                    'Create Account'
                );

                const errorMessage = window.auth.getErrorMessage(result.error);
                const errorField = result.error?.code === 'auth/weak-password' ? 'password' : 'email';
                window.auth.showError(errorField, errorMessage);
            }
        });
    }

    // Initialize input listeners
    function initInputListeners() {
        const firstNameInput = document.getElementById('firstName');
        const lastNameInput = document.getElementById('lastName');
        const emailInput = document.getElementById('email');
        const phoneInput = document.getElementById('phone');
        const passwordInput = document.getElementById('password');
        const confirmPasswordInput = document.getElementById('confirmPassword');
        const termsInput = document.getElementById('terms');

        if (firstNameInput) {
            firstNameInput.addEventListener('blur', function() {
                const error = validateFirstName(this.value);
                if (error) {
                    window.auth.showError('firstName', error);
                } else {
                    window.auth.clearError('firstName');
                }
            });
            firstNameInput.addEventListener('input', () => window.auth.clearError('firstName'));
        }

        if (lastNameInput) {
            lastNameInput.addEventListener('blur', function() {
                const error = validateLastName(this.value);
                if (error) {
                    window.auth.showError('lastName', error);
                } else {
                    window.auth.clearError('lastName');
                }
            });
            lastNameInput.addEventListener('input', () => window.auth.clearError('lastName'));
        }

        if (emailInput) {
            emailInput.addEventListener('blur', function() {
                const error = validateEmail(this.value);
                if (error) {
                    window.auth.showError('email', error);
                } else {
                    window.auth.clearError('email');
                }
            });
            emailInput.addEventListener('input', () => window.auth.clearError('email'));
        }

        if (phoneInput) {
            phoneInput.addEventListener('blur', function() {
                const error = validatePhone(this.value);
                if (error) {
                    window.auth.showError('phone', error);
                } else {
                    window.auth.clearError('phone');
                }
            });
            phoneInput.addEventListener('input', () => window.auth.clearError('phone'));
        }

        if (passwordInput) {
            passwordInput.addEventListener('input', function() {
                const password = this.value;
                updatePasswordStrength(password);
                window.auth.clearError('password');
                
                const confirmPassword = confirmPasswordInput?.value;
                if (confirmPassword) {
                    const confirmError = validateConfirmPassword(confirmPassword, password);
                    if (confirmError) {
                        window.auth.showError('confirmPassword', confirmError);
                    } else {
                        window.auth.clearError('confirmPassword');
                    }
                }
            });
            passwordInput.addEventListener('blur', function() {
                const error = validatePassword(this.value);
                if (error) {
                    window.auth.showError('password', error);
                } else {
                    window.auth.clearError('password');
                }
            });
        }

        if (confirmPasswordInput) {
            confirmPasswordInput.addEventListener('blur', function() {
                const password = passwordInput?.value;
                const error = validateConfirmPassword(this.value, password);
                if (error) {
                    window.auth.showError('confirmPassword', error);
                } else {
                    window.auth.clearError('confirmPassword');
                }
            });
            confirmPasswordInput.addEventListener('input', function() {
                window.auth.clearError('confirmPassword');
                const password = passwordInput?.value;
                if (this.value && this.value === password) {
                    window.auth.clearError('confirmPassword');
                }
            });
        }

        if (termsInput) {
            termsInput.addEventListener('change', () => window.auth.clearError('terms'));
        }
    }

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', function() {
        window.auth.setupPasswordToggle('passwordToggle', 'password');
        window.auth.setupPasswordToggle('confirmPasswordToggle', 'confirmPassword');
        initForm();
        initInputListeners();
    });
})();

