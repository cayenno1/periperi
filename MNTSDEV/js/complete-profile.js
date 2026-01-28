

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

    function normalizeString(value) {
        const v = String(value ?? '').trim();
        return v || '';
    }

    function validateFirstName(value) {
        if (!value.trim()) return 'First name is required';
        if (value.trim().length < 2) return 'First name must be at least 2 characters';
        if (!/^[a-zA-Z\s'-]+$/.test(value.trim())) return 'First name can only contain letters, spaces, hyphens, and apostrophes';
        return '';
    }

    function validateLastName(value) {
        if (!value.trim()) return 'Last name is required';
        if (value.trim().length < 2) return 'Last name must be at least 2 characters';
        if (!/^[a-zA-Z\s'-]+$/.test(value.trim())) return 'Last name can only contain letters, spaces, hyphens, and apostrophes';
        return '';
    }

    function validatePhone(value) {
        if (!value.trim()) return 'Phone number is required';
        const phoneDigits = value.replace(/[\s\-\(\)]/g, '');
        if (phoneDigits.length < 10 || phoneDigits.length > 11) return 'Please enter a valid phone number';
        return '';
    }

    function splitName(displayName) {
        const raw = String(displayName || '').trim();
        if (!raw) return { firstName: '', lastName: '' };
        const parts = raw.split(/\s+/).filter(Boolean);
        if (parts.length === 1) return { firstName: parts[0], lastName: '' };
        return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
    }

    function getCurrentPathWithQuery() {
        try {
            const file = (window.location.pathname.split('/').pop() || 'complete-profile.html').trim() || 'complete-profile.html';
            const qs = window.location.search || '';
            return `${file}${qs}`;
        } catch (e) {
            return 'complete-profile.html';
        }
    }

    function isGoogleUser(user) {
        const providers = Array.isArray(user?.providerData) ? user.providerData : [];
        return providers.some((p) => p?.providerId === 'google.com');
    }

    async function loadExistingProfile(user) {
        try {
            await window.utils?.waitForFirebaseReady?.();
            if (!user?.uid) return;

            const db = window.firebaseDb;
            if (!db || !window.doc || !window.getDoc) return;

            const ref = window.doc(db, 'customers', user.uid);
            const snap = await window.getDoc(ref);
            const data = snap.exists() ? (snap.data() || {}) : {};

            const emailRow = document.getElementById('profileEmailRow');
            const emailEl = document.getElementById('profileEmail');
            if (emailRow && emailEl) {
                const email = normalizeString(user.email) || normalizeString(data.email);
                if (email) {
                    emailEl.textContent = email;
                    emailRow.style.display = 'block';
                }
            }

            const providerBadge = document.getElementById('profileProviderBadge');
            if (providerBadge) {
                providerBadge.style.display = isGoogleUser(user) ? 'inline-flex' : 'none';
            }

            const firstNameInput = document.getElementById('firstName');
            const lastNameInput = document.getElementById('lastName');
            const phoneInput = document.getElementById('phone');

            const inferred = splitName(user.displayName);

            if (firstNameInput) firstNameInput.value = normalizeString(data.firstName) || normalizeString(inferred.firstName);
            if (lastNameInput) lastNameInput.value = normalizeString(data.lastName) || normalizeString(inferred.lastName);
            if (phoneInput) phoneInput.value = normalizeString(data.phone);
        } catch (e) {
            // Non-blocking
        }
    }

    async function saveProfile(user, firstName, lastName, phone) {
        const db = window.firebaseDb;
        if (!db || !window.doc) throw new Error('Database is not available right now.');

        const ref = window.doc(db, 'customers', user.uid);
        const payload = {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: phone.trim(),
            email: user.email || null,
            uid: user.uid,
            profileCompleted: true,
            profileCompletedAt: new Date(),
            updatedAt: (typeof window.serverTimestamp === 'function') ? window.serverTimestamp() : new Date()
        };

        // Prefer updateDoc if available; fallback to setDoc with merge.
        if (typeof window.updateDoc === 'function') {
            await window.updateDoc(ref, payload);
            return;
        }
        if (typeof window.setDoc === 'function') {
            await window.setDoc(ref, payload, { merge: true });
            return;
        }

        throw new Error('Database write is not available right now.');
    }

    function initForm(user) {
        const form = document.getElementById('completeProfileForm');
        if (!form) return;

        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            if (isSubmitting) return;

            const firstName = document.getElementById('firstName')?.value || '';
            const lastName = document.getElementById('lastName')?.value || '';
            const phone = document.getElementById('phone')?.value || '';

            window.auth?.clearAllErrors?.(['firstName', 'lastName', 'phone']);

            let hasErrors = false;
            const firstErr = validateFirstName(firstName);
            if (firstErr) { window.auth?.showError?.('firstName', firstErr); hasErrors = true; }
            const lastErr = validateLastName(lastName);
            if (lastErr) { window.auth?.showError?.('lastName', lastErr); hasErrors = true; }
            const phoneErr = validatePhone(phone);
            if (phoneErr) { window.auth?.showError?.('phone', phoneErr); hasErrors = true; }
            if (hasErrors) return;

            window.auth?.setFormState?.(
                true,
                'submitButton',
                'submitButtonText',
                'Saving...',
                'Save & Continue'
            );
            isSubmitting = true;

            try {
                await saveProfile(user, firstName, lastName, phone);
                const redirectTarget = sanitizeRedirect(getRedirectParam()) || 'index.html';
                window.location.href = redirectTarget;
            } catch (err) {
                window.auth?.setFormState?.(
                    false,
                    'submitButton',
                    'submitButtonText',
                    'Saving...',
                    'Save & Continue'
                );
                isSubmitting = false;
                const msg = window.auth?.getErrorMessage?.(err) || (err?.message || 'Could not save profile. Please try again.');
                window.auth?.showError?.('phone', msg);
            }
        });

        // Clear errors on input
        const firstNameInput = document.getElementById('firstName');
        const lastNameInput = document.getElementById('lastName');
        const phoneInput = document.getElementById('phone');
        if (firstNameInput) firstNameInput.addEventListener('input', () => window.auth?.clearError?.('firstName'));
        if (lastNameInput) lastNameInput.addEventListener('input', () => window.auth?.clearError?.('lastName'));
        if (phoneInput) phoneInput.addEventListener('input', () => window.auth?.clearError?.('phone'));
    }

    document.addEventListener('DOMContentLoaded', async function() {
        await window.utils?.waitForFirebaseReady?.();

        const auth = window.firebaseAuth;
        const onAuth = window.onAuthStateChanged;
        if (!auth || typeof onAuth !== 'function') {
            const backTo = getCurrentPathWithQuery();
            window.location.href = `login.html?redirect=${encodeURIComponent(backTo)}`;
            return;
        }

        onAuth(auth, async (user) => {
            if (!user) {
                const backTo = getCurrentPathWithQuery();
                window.location.href = `login.html?redirect=${encodeURIComponent(backTo)}`;
                return;
            }
            await loadExistingProfile(user);
            initForm(user);
        });
    });
})();

