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

    // Merge customer data from old account to new account
    async function mergeCustomerData(sourceUid, targetUid) {
        try {
            const db = window.firebaseDb;
            if (!db || !window.doc || !window.getDoc || !window.setDoc || !window.collection || !window.getDocs || !window.query || !window.where) {
                console.warn('Firebase not ready for data merge');
                return;
            }

            const sourceRef = window.doc(db, 'customers', sourceUid);
            const targetRef = window.doc(db, 'customers', targetUid);
            
            const sourceSnap = await window.getDoc(sourceRef);
            const targetSnap = await window.getDoc(targetRef);
            
            if (!sourceSnap.exists()) return; // Nothing to merge
            
            const sourceData = sourceSnap.data() || {};
            const targetData = targetSnap.exists() ? (targetSnap.data() || {}) : {};
            
            // Merge strategy: prefer target data, but fill in missing fields from source
            const mergedData = {
                ...sourceData,
                ...targetData,
                // Always prefer target's email and uid
                email: targetData.email || sourceData.email,
                uid: targetUid,
                // Merge loyalty points (add them together)
                points: (normalizePoints(targetData.points) || 0) + (normalizePoints(sourceData.points) || 0),
                // Merge points history
                pointsHistory: [
                    ...(Array.isArray(targetData.pointsHistory) ? targetData.pointsHistory : []),
                    ...(Array.isArray(sourceData.pointsHistory) ? sourceData.pointsHistory : [])
                ],
                // Prefer target's profile data, but use source if target is missing
                firstName: targetData.firstName || sourceData.firstName || null,
                lastName: targetData.lastName || sourceData.lastName || null,
                phone: targetData.phone || sourceData.phone || null,
                // Keep earliest createdAt
                createdAt: targetData.createdAt || sourceData.createdAt || new Date(),
                // Track that accounts were linked
                accountsLinked: true,
                linkedAt: new Date(),
                linkedFromUid: sourceUid
            };
            
            await window.setDoc(targetRef, mergedData, { merge: true });
            
            // Merge cart items
            try {
                const sourceCartCol = window.collection(sourceRef, 'cartItems');
                const targetCartCol = window.collection(targetRef, 'cartItems');
                
                const sourceCartSnap = await window.getDocs(sourceCartCol);
                if (!sourceCartSnap.empty) {
                    for (const cartDoc of sourceCartSnap.docs) {
                        const cartData = cartDoc.data();
                        // Check if item already exists in target cart
                        const existingQuery = window.query(
                            targetCartCol,
                            window.where('itemId', '==', cartData.itemId || '')
                        );
                        const existingSnap = await window.getDocs(existingQuery);
                        
                        if (existingSnap.empty) {
                            // Item doesn't exist in target cart, add it
                            await window.setDoc(window.doc(targetCartCol, cartDoc.id), cartData);
                        }
                    }
                }
            } catch (cartError) {
                console.warn('Error merging cart items:', cartError);
            }
            
            // Merge addresses
            try {
                const sourceAddressesCol = window.collection(sourceRef, 'addresses');
                const targetAddressesCol = window.collection(targetRef, 'addresses');
                
                const sourceAddressesSnap = await window.getDocs(sourceAddressesCol);
                if (!sourceAddressesSnap.empty) {
                    for (const addrDoc of sourceAddressesSnap.docs) {
                        const addrData = addrDoc.data();
                        await window.setDoc(window.doc(targetAddressesCol, addrDoc.id), addrData);
                    }
                }
            } catch (addrError) {
                console.warn('Error merging addresses:', addrError);
            }
            
            // Merge reviews (copy to target's reviews subcollection)
            try {
                const sourceReviewsCol = window.collection(sourceRef, 'reviews');
                const targetReviewsCol = window.collection(targetRef, 'reviews');
                
                const sourceReviewsSnap = await window.getDocs(sourceReviewsCol);
                if (!sourceReviewsSnap.empty) {
                    for (const reviewDoc of sourceReviewsSnap.docs) {
                        const reviewData = reviewDoc.data();
                        // Update userId to target UID
                        reviewData.userId = targetUid;
                        await window.setDoc(window.doc(targetReviewsCol, reviewDoc.id), reviewData);
                    }
                }
            } catch (reviewError) {
                console.warn('Error merging reviews:', reviewError);
            }
            
            // Update orders to point to new UID (optional - may want to keep historical data)
            // This is commented out as it might affect order history integrity
            // Uncomment if you want to transfer orders to the new account
            /*
            try {
                const ordersCol = window.collection(db, 'orders');
                const ordersQuery = window.query(ordersCol, window.where('userId', '==', sourceUid));
                const ordersSnap = await window.getDocs(ordersQuery);
                
                if (!ordersSnap.empty) {
                    const updateDocFn = window.updateDoc;
                    for (const orderDoc of ordersSnap.docs) {
                        await updateDocFn(orderDoc.ref, { userId: targetUid });
                    }
                }
            } catch (orderError) {
                console.warn('Error updating orders:', orderError);
            }
            */
            
            console.log('Customer data merged successfully from', sourceUid, 'to', targetUid);
        } catch (error) {
            console.error('Error merging customer data:', error);
            throw error;
        }
    }

    function normalizePoints(value) {
        const num = Number(value);
        return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
    }

    // Check if current user can link a provider account
    async function canLinkProviderAccount(providerKey) {
        try {
            const auth = window.firebaseAuth;
            const fetchSignInMethods = window.fetchSignInMethodsForEmail;
            
            if (!auth || !fetchSignInMethods) return false;
            
            const user = auth.currentUser;
            if (!user || !user.email) return false;
            
            const signInMethods = await fetchSignInMethods(auth, user.email);
            const providerId = providerKey === 'google' ? 'google.com' : null;
            
            if (!providerId) return false;
            
            // Check if provider is not already linked
            const isProviderLinked = user.providerData?.some(
                provider => provider.providerId === providerId
            );
            
            // Check if provider method exists for this email
            const hasProviderMethod = signInMethods.includes(providerId);
            
            // Can link if provider method exists but not currently linked
            return hasProviderMethod && !isProviderLinked;
        } catch (error) {
            console.warn('Error checking if can link provider:', error);
            return false;
        }
    }

    // OAuth / Social sign-in (customers only)
    async function signInWithProvider(providerKey, options = {}) {
        try {
            await window.utils?.waitForFirebaseReady?.();

            const auth = window.firebaseAuth;
            const signInPopup = window.signInWithPopup;
            const linkWithCredential = window.linkWithCredential;
            const fetchSignInMethods = window.fetchSignInMethodsForEmail;
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

            try {
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
                // Handle account exists with different credential
                if (error.code === 'auth/account-exists-with-different-credential') {
                    const email = error.email || error.customData?.email;
                    if (!email || !fetchSignInMethods) {
                        return { success: false, error };
                    }

                    try {
                        // Fetch sign-in methods for this email
                        const signInMethods = await fetchSignInMethods(auth, email);
                        
                        // Check if password is one of the methods
                        const hasPassword = signInMethods.includes('password');
                        
                        if (hasPassword) {
                            // Prompt user to sign in with password first, then link
                            return {
                                success: false,
                                error: {
                                    code: 'auth/account-exists-with-different-credential',
                                    message: 'This email is already registered with email/password. Please sign in with your password first, then you can link your Google account from your account settings.',
                                    email: email,
                                    canLink: true,
                                    existingMethods: signInMethods
                                }
                            };
                        } else {
                            // Account exists but we can't link automatically
                            return {
                                success: false,
                                error: {
                                    code: 'auth/account-exists-with-different-credential',
                                    message: 'This email is already registered with a different sign-in method. Please sign in with your existing method.',
                                    email: email,
                                    existingMethods: signInMethods
                                }
                            };
                        }
                    } catch (fetchError) {
                        // If we can't fetch methods, return generic error
                        return {
                            success: false,
                            error: {
                                code: 'auth/account-exists-with-different-credential',
                                message: 'This email is already registered with a different sign-in method. Please sign in with your existing method.',
                                email: email
                            }
                        };
                    }
                }
                throw error;
            }
        } catch (error) {
            return { success: false, error };
        }
    }

    // Link provider account to existing email/password account
    // User must be signed in with email/password first
    async function linkAccountWithProvider(providerKey) {
        try {
            await window.utils?.waitForFirebaseReady?.();

            const auth = window.firebaseAuth;
            const signInPopup = window.signInWithPopup;
            const linkWithCredential = window.linkWithCredential;
            
            if (!auth || !signInPopup || !linkWithCredential) {
                throw new Error('Account linking is not available right now.');
            }

            const user = auth.currentUser;
            if (!user) {
                throw new Error('Please sign in with your email and password first, then you can link your Google account.');
            }

            // Get the provider
            const factory = PROVIDER_REGISTRY[String(providerKey || '').toLowerCase()];
            const provider = factory ? factory() : null;
            if (!provider) {
                throw new Error('This sign-in provider is not available right now.');
            }

            // Sign in with provider to get credential
            const providerCredential = await signInPopup(auth, provider);
            
            // Check if the provider account has a different UID (means it's a separate account)
            const providerUid = providerCredential.user?.uid;
            const currentUid = user.uid;
            
            // Link the credential to the current user
            await linkWithCredential(user, providerCredential.credential);
            
            // If provider account had different UID, merge its data
            if (providerUid && providerUid !== currentUid) {
                try {
                    await mergeCustomerData(providerUid, currentUid);
                } catch (mergeError) {
                    console.warn('Error merging data during account link:', mergeError);
                    // Don't fail the link if merge fails
                }
            }

            return { success: true };
        } catch (error) {
            return { success: false, error };
        }
    }

    // Link email/password to existing Google account
    // User must be signed in with Google first
    async function linkEmailPasswordToAccount(email, password) {
        try {
            await window.utils?.waitForFirebaseReady?.();

            const auth = window.firebaseAuth;
            const linkWithCredential = window.linkWithCredential;
            const EmailAuthProvider = window.EmailAuthProvider;
            
            if (!auth || !linkWithCredential || !EmailAuthProvider) {
                throw new Error('Account linking is not available right now.');
            }

            const user = auth.currentUser;
            if (!user) {
                throw new Error('Please sign in with Google first, then you can link your email/password.');
            }

            // Create email/password credential
            const emailCredential = EmailAuthProvider.credential(email, password);
            
            // Link the credential to the current user
            await linkWithCredential(user, emailCredential);

            return { success: true };
        } catch (error) {
            return { success: false, error };
        }
    }

    // Driver login: uses staff collection in Firestore (email, password, role)
    // Finds staff by email or staffId; requires role "Driver" (trailing spaces trimmed) and matching password
    async function loginDriver(emailOrStaffId, password) {
        try {
            await window.utils?.waitForFirebaseReady?.();
        } catch (e) { /* non-blocking */ }

        const db = window.firebaseDb;
        const docFn = window.doc;
        const collectionFn = window.collection;
        const queryFn = window.query;
        const whereFn = window.where;
        const getDocsFn = window.getDocs;

        if (!db || !docFn || !collectionFn || !queryFn || !whereFn || !getDocsFn) {
            return { success: false, error: { message: 'Driver login is not available right now. Please try again later.' } };
        }

        try {
            const input = String(emailOrStaffId || '').trim();
            const pass = String(password || '').trim();
            if (!input || !pass) {
                return { success: false, error: { message: 'Invalid email or password' } };
            }

            const staffRef = collectionFn(db, 'staff');
            let snapshot = null;

            // 1. Find by email (exact)
            let emailQuery = queryFn(staffRef, whereFn('email', '==', input));
            snapshot = await getDocsFn(emailQuery);

            // 2. If not found, try email lowercased (Firestore is case-sensitive)
            if (snapshot.empty && input.indexOf('@') !== -1) {
                emailQuery = queryFn(staffRef, whereFn('email', '==', input.toLowerCase()));
                snapshot = await getDocsFn(emailQuery);
            }

            // 3. If not found by email, try by staffId (e.g. "2023133729")
            if (snapshot.empty) {
                const staffIdQuery = queryFn(staffRef, whereFn('staffId', '==', input));
                snapshot = await getDocsFn(staffIdQuery);
            }

            if (snapshot.empty) {
                return { success: false, error: { message: 'Invalid email or password' } };
            }

            const staffDoc = snapshot.docs[0];
            const staffData = staffDoc.data() || {};

            // 4. Role must be "Driver" (trim handles "Driver " with trailing space)
            const role = String(staffData.role || '').trim();
            if (role !== 'Driver') {
                return { success: false, error: { message: 'This account is not authorized for driver access.' } };
            }

            // 5. Password from staff document; compare with trimmed form password
            const storedPassword = staffData.password != null ? String(staffData.password).trim() : '';
            if (storedPassword !== pass) {
                return { success: false, error: { message: 'Invalid email or password' } };
            }

            // 5. Store driver info in localStorage (same shape driver.html expects)
            const firstName = staffData.firstName || '';
            const lastName = staffData.lastName || '';
            const middleName = staffData.middleName || '';
            const suffix = staffData.suffix || '';
            const fullName = `${firstName} ${middleName} ${lastName} ${suffix}`.trim() || null;

            try {
                localStorage.setItem('ppp_driver', JSON.stringify({
                    id: staffDoc.id,
                    email: staffData.email || input,
                    role: 'Driver',
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

            // 6. Update lastLoginAt (staff document; drivers collection if it exists)
            try {
                const updateDocFn = window.updateDoc;
                const serverTimestampFn = window.serverTimestamp;
                if (updateDocFn && serverTimestampFn) {
                    const updateData = { lastLoginAt: serverTimestampFn(), updatedAt: serverTimestampFn() };
                    try {
                        await updateDocFn(docFn(db, 'drivers', staffDoc.id), { ...updateData, availability: 'available' });
                    } catch (_) {
                        await updateDocFn(docFn(db, 'staff', staffDoc.id), updateData);
                    }
                }
            } catch (e) { /* non-blocking */ }

            return { success: true, redirect: 'driver.html' };
        } catch (error) {
            return {
                success: false,
                error: { message: error?.message || 'An error occurred during driver login. Please try again.' }
            };
        }
    }

    // Unified login: try customer first, then driver
    async function unifiedLogin(email, password) {
        const customerResult = await loginUser(email, password);
        
        if (customerResult.success) {
            return customerResult;
        }

        // Fallback to driver login for certain error codes (e.g. staff/Driver in Firebase Auth but not a customer)
        const fallbackCodes = [
            'auth/user-not-found',
            'auth/wrong-password',
            'auth/invalid-email',
            'auth/invalid-credential',
            'auth/email-not-verified'
        ];

        if (customerResult.error && fallbackCodes.includes(customerResult.error.code)) {
            return await loginDriver(email, password);
        }

        return customerResult;
    }

    // Register user
    async function registerUser(firstName, lastName, email, phone, password) {
        try {
            const auth = window.firebaseAuth;
            const fetchSignInMethods = window.fetchSignInMethodsForEmail;
            
            // Check if email already exists with Google sign-in
            try {
                const signInMethods = await fetchSignInMethods(auth, email);
                const hasGoogle = signInMethods.includes('google.com');
                
                if (hasGoogle) {
                    // Account exists with Google - offer to link instead
                    return {
                        success: false,
                        error: {
                            code: 'auth/email-already-in-use',
                            message: 'This email is already registered with Google. Would you like to link your email/password account to your existing Google account?',
                            canLink: true,
                            existingMethods: signInMethods
                        }
                    };
                }
            } catch (checkError) {
                // If check fails, proceed with registration attempt
                console.warn('Could not check existing sign-in methods:', checkError);
            }

            const userCredential = await window.createUserWithEmailAndPassword(
                auth,
                email,
                password
            );

            const user = userCredential.user;

            if (!user || !user.uid) {
                throw new Error('Account creation failed');
            }

            // Send email verification
            await window.sendEmailVerification(user);

            // Check if there's existing customer data from a Google account (shouldn't happen, but just in case)
            const existingData = await getCustomerData(user.uid);
            
            // Save user data to database (merge with existing if any)
            await window.setDoc(window.doc(window.firebaseDb, "customers", user.uid), {
                firstName: firstName,
                lastName: lastName,
                email: email,
                phone: phone,
                createdAt: existingData?.createdAt || new Date(),
                uid: user.uid,
                // Merge loyalty points if they exist
                points: normalizePoints(existingData?.points) || 0,
                lastEarnedPoints: normalizePoints(existingData?.lastEarnedPoints) || 0,
                lastEarnedAt: existingData?.lastEarnedAt || null,
                pointsHistory: Array.isArray(existingData?.pointsHistory) ? existingData.pointsHistory : []
            }, { merge: true });

            return { success: true };
            
        } catch (error) {
            // Handle email already in use - might be Google account
            if (error.code === 'auth/email-already-in-use') {
                try {
                    const auth = window.firebaseAuth;
                    const fetchSignInMethods = window.fetchSignInMethodsForEmail;
                    const signInMethods = await fetchSignInMethods(auth, email);
                    const hasGoogle = signInMethods.includes('google.com');
                    
                    if (hasGoogle) {
                        return {
                            success: false,
                            error: {
                                code: 'auth/email-already-in-use',
                                message: 'This email is already registered with Google. Would you like to link your email/password account to your existing Google account?',
                                canLink: true,
                                existingMethods: signInMethods
                            }
                        };
                    }
                } catch (checkError) {
                    // Fall through to default error
                }
            }
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
                return error.message || 'This email is already registered with a different sign-in method. Please sign in with your existing method.';
            case 'auth/email-already-in-use':
                return error.message || 'This email is already registered. Please use a different email or sign in.';
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
        linkAccountWithProvider,
        linkEmailPasswordToAccount,
        mergeCustomerData,
        canLinkProviderAccount,
        sendPasswordReset,
        getErrorMessage
    };
    ppp.auth = authApi;
    window.auth = authApi;
})();

