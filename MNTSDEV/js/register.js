

(function() {
    'use strict';

    let isSubmitting = false;

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
        if (v.includes('://') || v.startsWith('//') || v.includes('\\') || v.includes('..')) return '';
        const ok = /^[a-zA-Z0-9_\-/]+\.html(\?.*)?$/.test(v);
        return ok ? v : '';
    }

    function wireAuthLinks(redirectTarget) {
        const signInLink = document.querySelector('.restaurant-auth-footer a[href^="login.html"]');
        if (signInLink && redirectTarget) {
            signInLink.href = `login.html?redirect=${encodeURIComponent(redirectTarget)}`;
        }
    }

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
                const redirectTarget = sanitizeRedirect(getRedirectParam());
                const next = redirectTarget
                    ? `login.html?redirect=${encodeURIComponent(redirectTarget)}`
                    : 'login.html';
                window.location.href = next;
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
                hasErrors = true;
                
                // Show error using auth helper first
                const errorMessage = 'You must agree to the Terms of Condition to create an account';
                window.auth.showError('terms', errorMessage);
                
                // Get elements
                const termsErrorElement = document.getElementById('termsError');
                const termsLabel = document.getElementById('termsLabel');
                const termsCheckbox = document.getElementById('terms');
                
                // Apply highlighted styling to error message
                if (termsErrorElement) {
                    termsErrorElement.style.cssText = `
                        display: block !important;
                        color: #e53935 !important;
                        font-size: 1rem !important;
                        font-weight: 600 !important;
                        background-color: #fff5f5 !important;
                        padding: 12px 14px !important;
                        border-radius: 6px !important;
                        border: 2px solid #e53935 !important;
                        margin-top: 10px !important;
                        line-height: 1.5 !important;
                    `;
                }
                
                // Add visual flag to checkbox container
                if (termsLabel) {
                    termsLabel.style.cssText = `
                        border: 2px solid #e53935 !important;
                        border-radius: 6px !important;
                        padding: 10px !important;
                        background-color: #fff5f5 !important;
                        display: block !important;
                    `;
                }
                
                // Add error class to checkbox
                if (termsCheckbox) {
                    termsCheckbox.classList.add('error');
                }
                
                // Scroll to the checkbox to ensure user sees it
                setTimeout(() => {
                    if (termsLabel) {
                        termsLabel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, 100);
            } else {
                // Clear visual flag when checked
                const termsLabel = document.getElementById('termsLabel');
                const termsErrorElement = document.getElementById('termsError');
                const termsCheckbox = document.getElementById('terms');
                
                if (termsLabel) {
                    termsLabel.style.cssText = '';
                }
                
                if (termsErrorElement) {
                    termsErrorElement.style.cssText = '';
                }
                
                if (termsCheckbox) {
                    termsCheckbox.classList.remove('error');
                }
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

                // Handle account linking scenario
                if (result.error?.code === 'auth/email-already-in-use' && result.error?.canLink) {
                    const errorMessage = result.error.message || 'This email is already registered with Google. Please sign in with Google first, then you can link your email/password account.';
                    window.auth.showError('email', errorMessage);
                    // Optionally redirect to login page
                    return;
                }

                const errorMessage = window.auth.getErrorMessage(result.error);
                const errorField = result.error?.code === 'auth/weak-password' ? 'password' : 'email';
                window.auth.showError(errorField, errorMessage);
            }
        });
    }

    async function handleProviderSignIn(providerKey) {
        if (isSubmitting) return;

        const redirectTarget = sanitizeRedirect(getRedirectParam());

        const oauthButtons = document.querySelectorAll('[data-auth-provider]');
        oauthButtons.forEach((btn) => {
            try { btn.disabled = true; } catch (e) {}
        });

        window.auth.setFormState(
            true,
            'submitButton',
            'submitButtonText',
            'Creating Account...',
            'Create Account'
        );
        isSubmitting = true;

        const result = await window.auth.signInWithProvider(providerKey, { redirectTarget });
        isSubmitting = false;

        if (result.success) {
            const finalTarget = redirectTarget || result.redirect || 'index.html';
            window.location.href = finalTarget;
            return;
        }

        window.auth.setFormState(
            false,
            'submitButton',
            'submitButtonText',
            'Creating Account...',
            'Create Account'
        );
        oauthButtons.forEach((btn) => {
            try { btn.disabled = false; } catch (e) {}
        });

        // Handle account linking scenario
        if (result.error?.code === 'auth/account-exists-with-different-credential' && result.error?.canLink) {
            const errorMessage = result.error.message || 'This email is already registered with email/password. Please sign in with your password first, then you can link your Google account.';
            window.auth.showError('email', errorMessage);
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
            termsInput.addEventListener('change', function() {
                if (this.checked) {
                    // Clear all error styling when checkbox is checked
                    const termsLabel = document.getElementById('termsLabel');
                    const termsErrorElement = document.getElementById('termsError');
                    
                    window.auth.clearError('terms');
                    
                    if (termsLabel) {
                        termsLabel.style.cssText = '';
                    }
                    
                    if (termsErrorElement) {
                        termsErrorElement.style.cssText = '';
                        termsErrorElement.textContent = '';
                    }
                }
            });
        }
    }

    // Terms of Condition Modal Functions
    async function fetchTermsAndConditions() {
        try {
            await window.utils.waitForFirebaseReady();
            
            const db = window.firebaseDb;
            const docFn = window.doc;
            const getDocFn = window.getDoc;
            const collectionFn = window.collection;
            const getDocsFn = window.getDocs;
            
            if (!db || !docFn || !getDocFn || !collectionFn || !getDocsFn) {
                throw new Error('Firebase not ready');
            }

            console.log('Fetching terms and conditions document...');
            // Fetch the main termsAndConditions document
            const termsRef = docFn(db, 'settings', 'termsAndConditions');
            const termsSnap = await getDocFn(termsRef);
            
            if (!termsSnap.exists()) {
                throw new Error('Terms and conditions document not found in Firestore');
            }

            const termsData = termsSnap.data();
            console.log('Terms document data:', termsData);
            
            const currentVersion = termsData.currentVersion || 1;
            const currentVersionUrl = termsData.currentVersionUrl || '';

            console.log('Current version:', currentVersion);
            console.log('Current version URL:', currentVersionUrl);

            let versionData = null;
            let pdfUrl = currentVersionUrl;

            // Try to fetch the version details from the versions subcollection
            try {
                const versionsCol = collectionFn(termsRef, 'versions');
                const versionsSnap = await getDocsFn(versionsCol);
                
                console.log('Versions subcollection size:', versionsSnap.size);
                
                // Try to find the document matching currentVersion
                versionsSnap.forEach((docSnap) => {
                    const data = docSnap.data();
                    console.log('Version document:', docSnap.id, data);
                    const versionNum = typeof data.version === 'number' ? data.version : Number(data.version);
                    if (versionNum === currentVersion) {
                        versionData = data;
                        console.log('Found matching version data:', versionData);
                    }
                });

                // If no version data found matching currentVersion, try to get any version
                if (!versionData && !versionsSnap.empty) {
                    versionsSnap.forEach((docSnap) => {
                        if (!versionData) {
                            versionData = docSnap.data();
                            console.log('Using first available version data:', versionData);
                        }
                    });
                }
            } catch (subcollectionError) {
                console.warn('Error fetching versions subcollection:', subcollectionError);
                // Continue with main document data
            }

            // If we have version data with downloadUrl, use it
            if (versionData && versionData.downloadUrl) {
                pdfUrl = versionData.downloadUrl;
            }

            // Clean up the URL - remove any extra parameters or fix encoding
            if (pdfUrl) {
                pdfUrl = pdfUrl.trim();
                // If URL contains 'alt=media' without proper query separator, fix it
                if (pdfUrl.includes('alt=media') && !pdfUrl.includes('?') && pdfUrl.includes('&')) {
                    pdfUrl = pdfUrl.replace('&alt=media', '?alt=media');
                }
            }
            
            console.log('Final PDF URL:', pdfUrl);
            
            if (!pdfUrl || pdfUrl === '') {
                throw new Error('No PDF URL found in terms and conditions data');
            }
            
            const result = {
                version: versionData?.version || currentVersion,
                pdfUrl: pdfUrl,
                uploadedAt: versionData?.uploadedAt || null
            };
            
            console.log('Returning terms data:', result);
            return result;
        } catch (error) {
            console.error('Error fetching terms and conditions:', error);
            throw error;
        }
    }

    async function openTermsInNewTab() {
        try {
            console.log('Fetching terms and conditions...');
            const termsData = await fetchTermsAndConditions();
            console.log('Terms data fetched:', termsData);
            
            if (!termsData || !termsData.pdfUrl) {
                alert('Unable to load Terms of Condition. Please try again later.');
                return;
            }

            // Clean and format the PDF URL
            let pdfUrl = termsData.pdfUrl.trim();
            
            // If it's a Firebase Storage URL, ensure it's properly formatted
            if (pdfUrl.includes('firebasestorage.googleapis.com')) {
                // Make sure the URL is complete
                if (!pdfUrl.startsWith('http')) {
                    pdfUrl = 'https://' + pdfUrl;
                }
            }
            
            console.log('Opening PDF in new tab:', pdfUrl);
            
            // Open PDF in new browser tab
            window.open(pdfUrl, '_blank');
        } catch (error) {
            console.error('Error loading terms:', error);
            alert('Unable to load Terms of Condition. Please try again later.');
        }
    }

    // Expose openTermsInNewTab to window for onclick handler
    window.openTermsModal = openTermsInNewTab;

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', function() {
        const redirectTarget = sanitizeRedirect(getRedirectParam());
        wireAuthLinks(redirectTarget);
        window.auth.setupPasswordToggle('passwordToggle', 'password');
        window.auth.setupPasswordToggle('confirmPasswordToggle', 'confirmPassword');
        initProviderButtons();
        initForm();
        initInputListeners();
    });
})();

