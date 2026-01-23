// Authentication helpers for login/register/reset flows.
// Exposes a small API for the simple multi-page setup.

(function() {
    'use strict';

    const ppp = (window.ppp = window.ppp || {});
    const PROVIDER_REGISTRY = {
        // Add more providers by registering a key here and adding a matching button in HTML:
        // <button data-auth-provider="github">Continue with GitHub</button>
        google: () => (window.GoogleAuthProvider ? new window.GoogleAuthProvider() : null),
        // Apple example (needs console enable + services id):
        // apple: () => (window.OAuthProvider ? new window.OAuthProvider('apple.com') : null)
    };

    // Error handling helpers
    function showError(fieldId, message) {
        const errorElement = document.getElementById(fieldId + 'Error');
        const inputElement = document.getElementById(fieldId);
        if (errorElement) {
            errorElement.textContent = message;
        }
        if (inputElement) {
            inputElement.classList.add('error');
        }
    }

    function clearError(fieldId) {
        const errorElement = document.getElementById(fieldId + 'Error');
        const inputElement = document.getElementById(fieldId);
        if (errorElement) {
            errorElement.textContent = '';
        }
        if (inputElement) {
            inputElement.classList.remove('error');
        }
    }

    function clearAllErrors(fields) {
        fields.forEach(field => clearError(field));
    }

    // Form state management
    function setFormState(submitting, buttonId, buttonTextId, submittingText, normalText) {
        const submitButton = document.getElementById(buttonId);
        const submitButtonText = document.getElementById(buttonTextId);
        
        if (submitting) {
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.classList.add('disabled');
            }
            if (submitButtonText) {
                submitButtonText.textContent = submittingText;
            }
        } else {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.classList.remove('disabled');
            }
            if (submitButtonText) {
                submitButtonText.textContent = normalText;
            }
        }
    }

    // Password toggle functionality
    function setupPasswordToggle(toggleId, inputId) {
        const passwordToggle = document.getElementById(toggleId);
        const passwordInput = document.getElementById(inputId);
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

    // Login user (customer via Firebase Auth)
    async function loginUser(email, password) {
        try {
            const userCredential = await window.signInWithEmailAndPassword(
                window.firebaseAuth,
                email,
                password
            );

            const user = userCredential.user;

            // Require verified email before allowing login
            if (!user.emailVerified) {
                if (window.signOut && window.firebaseAuth) {
                    try {
                        await window.signOut(window.firebaseAuth);
                    } catch (signOutError) {
                        console.error('Error signing out unverified user:', signOutError);
                    }
                }
                return {
                    success: false,
                    error: {
                        code: 'auth/email-not-verified',
                        message: 'Please verify your email first. Check your inbox for the verification link we sent when you registered.'
                    }
                };
            }

            // Ensure loyalty defaults exist for this customer (points=0, etc).
            try {
                await window.utils?.ensureCustomerLoyaltyDefaults?.(user);
            } catch (e) {
                // Non-blocking
            }

            sessionStorage.setItem('justLoggedIn', 'true');
            return { success: true, redirect: 'index.html' };
            
        } catch (error) {
            return { success: false, error };
        }
    }

    function splitName(displayName) {
        const raw = String(displayName || '').trim();
        if (!raw) return { firstName: null, lastName: null };
        const parts = raw.split(/\s+/).filter(Boolean);
        if (parts.length === 1) return { firstName: parts[0], lastName: null };
        return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
    }

    async function ensureCustomerDocForOAuthUser(user) {
        try {
            const db = window.firebaseDb;
            if (!db || !window.doc || !window.getDoc || !window.setDoc) return;
            if (!user?.uid) return;

            const customerRef = window.doc(db, 'customers', user.uid);
            const snap = await window.getDoc(customerRef);
            if (snap.exists()) return;

            const { firstName, lastName } = splitName(user.displayName);
            await window.setDoc(customerRef, {
                firstName: firstName || null,
                lastName: lastName || null,
                email: user.email || null,
                phone: null,
                createdAt: new Date(),
                uid: user.uid,
                authProvider: (user.providerData && user.providerData[0] && user.providerData[0].providerId) || null,
                // Loyalty defaults
                points: 0,
                lastEarnedPoints: 0,
                lastEarnedAt: null,
                pointsHistory: []
            });
        } catch (e) {
            // Don't block login if profile write fails.
            console.warn('ensureCustomerDocForOAuthUser failed:', e);
        }
    }

    function normalizeString(value) {
        const v = String(value ?? '').trim();
        return v || '';
    }

    function isCustomerProfileComplete(customerData) {
        const firstName = normalizeString(customerData?.firstName);
        const lastName = normalizeString(customerData?.lastName);
        const phone = normalizeString(customerData?.phone);
        return Boolean(firstName && lastName && phone);
    }

    async function getCustomerData(uid) {
        try {
            const db = window.firebaseDb;
            if (!db || !window.doc || !window.getDoc) return null;
            if (!uid) return null;
            const ref = window.doc(db, 'customers', uid);
            const snap = await window.getDoc(ref);
            return snap.exists() ? (snap.data() || {}) : null;
        } catch (e) {
            return null;
        }
    }

    // OAuth / Social sign-in (customers only)
    async function signInWithProvider(providerKey, options = {}) {
        try {
            await window.utils?.waitForFirebaseReady?.();

            const auth = window.firebaseAuth;
            const signInPopup = window.signInWithPopup;
            if (!auth || !signInPopup) {
                throw new Error('Sign-in provider is not available right now. Please try again later.');
            }

            const factory = PROVIDER_REGISTRY[String(providerKey || '').toLowerCase()];
            const provider = factory ? factory() : null;
            if (!provider) {
                throw new Error('This sign-in provider is not available right now.');
            }

            // Optional scopes (e.g. ['profile', 'email'])
            const scopes = Array.isArray(options.scopes) ? options.scopes : [];
            scopes.forEach((s) => {
                if (s && typeof provider.addScope === 'function') provider.addScope(String(s));
            });

            const userCredential = await signInPopup(auth, provider);
            const user = userCredential?.user || null;

            // Ensure the app has a customer doc for social logins.
            if (user) await ensureCustomerDocForOAuthUser(user);

            sessionStorage.setItem('justLoggedIn', 'true');

            // For Google sign-in, require name + phone completion before continuing.
            const normalizedKey = String(providerKey || '').toLowerCase();
            const desiredRedirect = normalizeString(options?.redirectTarget) || 'index.html';

            if (normalizedKey === 'google' && user?.uid) {
                const customerData = await getCustomerData(user.uid);
                if (!isCustomerProfileComplete(customerData)) {
                    return {
                        success: true,
                        redirect: `complete-profile.html?redirect=${encodeURIComponent(desiredRedirect)}`
                    };
                }
            }

            return { success: true, redirect: desiredRedirect || 'index.html' };
        } catch (error) {
            return { success: false, error };
        }
    }

    // Driver login (Firestore staff collection)
    // Supports login with email or staffId
    async function loginDriver(emailOrStaffId, password) {
        try {
            const db = window.firebaseDb;
            const collectionFn = window.collection;
            const queryFn = window.query;
            const whereFn = window.where;
            const getDocsFn = window.getDocs;

            if (!db || !collectionFn || !queryFn || !whereFn || !getDocsFn) {
                throw new Error('Driver login is not available right now. Please try again later.');
            }

            const staffRef = collectionFn(db, 'staff');
            let snapshot = null;
            let staffDoc = null;
            let staffData = null;

            // First, try to find by email
            const emailQuery = queryFn(
                staffRef,
                whereFn('email', '==', emailOrStaffId)
            );
            snapshot = await getDocsFn(emailQuery);

            // If not found by email, try to find by staffId
            if (snapshot.empty) {
                const staffIdQuery = queryFn(
                    staffRef,
                    whereFn('staffId', '==', emailOrStaffId)
                );
                snapshot = await getDocsFn(staffIdQuery);
            }

            if (snapshot.empty) {
                return {
                    success: false,
                    error: { message: 'Invalid email or password' }
                };
            }

            staffDoc = snapshot.docs[0];
            staffData = staffDoc.data() || {};

            // Check if role is Driver
            if (staffData.role !== 'Driver') {
                return {
                    success: false,
                    error: { message: 'Invalid email or password' }
                };
            }

            // Verify password
            const storedPassword = staffData.password != null ? String(staffData.password) : '';
            if (storedPassword !== password) {
                return {
                    success: false,
                    error: { message: 'Invalid email or password' }
                };
            }

            // Store driver info
            try {
                const firstName = staffData.firstName || '';
                const lastName = staffData.lastName || '';
                const middleName = staffData.middleName || '';
                const suffix = staffData.suffix || '';
                const fullName = `${firstName} ${middleName} ${lastName} ${suffix}`.trim() || null;

                localStorage.setItem('ppp_driver', JSON.stringify({
                    id: staffDoc.id,
                    email: staffData.email || emailOrStaffId, // Use email from document or fallback to input
                    role: staffData.role,
                    firstName: firstName || null,
                    lastName: lastName || null,
                    middleName: middleName || null,
                    suffix: suffix || null,
                    fullName,
                    staffId: staffData.staffId || null,
                    status: staffData.status || null,
                    startShift: staffData.startShift || null,
                    endShift: staffData.endShift || null
                }));
            } catch (e) {
                console.error('Error saving driver info:', e);
            }

            // Update driver login timestamp and availability
            try {
                const updateDocFn = window.updateDoc;
                const docFn = window.doc;
                const serverTimestampFn = window.serverTimestamp;
                
                if (updateDocFn && docFn && serverTimestampFn) {
                    const updateData = {
                        lastLoginAt: serverTimestampFn(),
                        updatedAt: serverTimestampFn()
                    };

                    // Try to update drivers collection first
                    try {
                        const driverRef = docFn(db, 'drivers', staffDoc.id);
                        await updateDocFn(driverRef, {
                            ...updateData,
                            availability: 'available'
                        });
                    } catch (driverError) {
                        // If drivers collection doesn't exist, update staff document
                        const staffRef = docFn(db, 'staff', staffDoc.id);
                        await updateDocFn(staffRef, updateData);
                    }
                }
            } catch (updateError) {
                console.error('Error updating driver login timestamp:', updateError);
                // Don't fail login if update fails
            }

            return { success: true, redirect: 'driver.html' };
        } catch (error) {
            return {
                success: false,
                error: { message: error.message || 'An error occurred during driver login. Please try again.' }
            };
        }
    }

    // Unified login: try customer first, then driver
    async function unifiedLogin(email, password) {
        const customerResult = await loginUser(email, password);
        
        if (customerResult.success) {
            return customerResult;
        }

        // Fallback to driver login for certain error codes
        const fallbackCodes = [
            'auth/user-not-found',
            'auth/wrong-password',
            'auth/invalid-email',
            'auth/invalid-credential'
        ];

        if (customerResult.error && fallbackCodes.includes(customerResult.error.code)) {
            return await loginDriver(email, password);
        }

        return customerResult;
    }

    // Register user
    async function registerUser(firstName, lastName, email, phone, password) {
        try {
            const userCredential = await window.createUserWithEmailAndPassword(
                window.firebaseAuth,
                email,
                password
            );

            const user = userCredential.user;

            if (!user || !user.uid) {
                throw new Error('Account creation failed');
            }

            // Send email verification
            await window.sendEmailVerification(user);

            // Save user data to database
            await window.setDoc(window.doc(window.firebaseDb, "customers", user.uid), {
                firstName: firstName,
                lastName: lastName,
                email: email,
                phone: phone,
                createdAt: new Date(),
                uid: user.uid,
                // Loyalty defaults
                points: 0,
                lastEarnedPoints: 0,
                lastEarnedAt: null,
                pointsHistory: []
            });

            return { success: true };
            
        } catch (error) {
            return { success: false, error };
        }
    }

    // Send password reset email
    async function sendPasswordReset(email) {
        try {
            await window.sendPasswordResetEmail(window.firebaseAuth, email);
            return { success: true };
        } catch (error) {
            return { success: false, error };
        }
    }

    // Get error message for display
    function getErrorMessage(error) {
        if (!error || !error.code) {
            return error?.message || 'An error occurred. Please try again.';
        }

        switch (error.code) {
            case 'auth/unauthorized-domain':
                return 'This domain is not authorized for Google sign-in. If you are using a local server, add localhost/127.0.0.1 under Firebase Authentication → Settings → Authorized domains.';
            case 'auth/popup-blocked':
                return 'Popup was blocked by your browser. Please allow popups and try again.';
            case 'auth/popup-closed-by-user':
                return 'Sign-in popup was closed before completing. Please try again.';
            case 'auth/cancelled-popup-request':
                return 'Another sign-in request is in progress. Please try again.';
            case 'auth/account-exists-with-different-credential':
                return 'This email is already registered with a different sign-in method. Please sign in with your existing method.';
            case 'auth/email-already-in-use':
                return 'This email is already registered. Please use a different email or sign in.';
            case 'auth/invalid-email':
                return 'Invalid email address. Please enter a valid email.';
            case 'auth/weak-password':
                return 'Password is too weak. Please use a stronger password (at least 6 characters).';
            case 'auth/network-request-failed':
                return 'Network error. Please check your internet connection and try again.';
            case 'auth/too-many-requests':
                return 'Too many failed login attempts. Please try again later.';
            case 'auth/user-not-found':
                return 'Invalid email or password';
            case 'auth/wrong-password':
                return 'Invalid email or password';
            case 'auth/invalid-credential':
                return 'Invalid email or password';
            case 'auth/email-not-verified':
                return error.message || 'Please verify your email first.';
            default:
                return error.message || 'An error occurred. Please try again.';
        }
    }

    // Public API (keep legacy global for compatibility).
    const authApi = {
        showError,
        clearError,
        clearAllErrors,
        setFormState,
        setupPasswordToggle,
        loginUser,
        loginDriver,
        unifiedLogin,
        registerUser,
        signInWithProvider,
        sendPasswordReset,
        getErrorMessage
    };
    ppp.auth = authApi;
    window.auth = authApi;
})();

