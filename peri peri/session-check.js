// Session Management and Authentication Check for admin pages
// This script should be included in all admin pages to protect them

// Check if user has valid session
function checkStaffSession() {
    const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
    
    if (!session) {
        // No session found, redirect to login
        redirectToLogin();
        return null;
    }

    try {
        const staffSession = JSON.parse(session);
        
        // Validate session structure
        if (!staffSession.staffId || !staffSession.email) {
            // Invalid session, clear it and redirect
            clearSession();
            redirectToLogin();
            return null;
        }

        return staffSession;
    } catch (e) {
        // Invalid session data, clear it and redirect
        console.error('Error parsing session:', e);
        clearSession();
        redirectToLogin();
        return null;
    }
}

// Verify session against Firebase
async function verifySessionWithFirebase(staffSession) {
    try {
        // Wait for Firebase to initialize (max 3 seconds)
        let attempts = 0;
        while ((!window.db || !window.firestoreFunctions) && attempts < 30) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }

        if (!window.db || !window.firestoreFunctions) {
            console.warn('Firebase not initialized, skipping verification');
            return true; // Allow access if Firebase not available (for development)
        }

        const db = window.db;
        const { doc, getDoc } = window.firestoreFunctions;

        // Check if staff document still exists and is active
        const staffDocRef = doc(db, 'staff', staffSession.staffId);
        const staffDocSnap = await getDoc(staffDocRef);

        if (!staffDocSnap.exists()) {
            // Staff account no longer exists
            return false;
        }

        const staffData = staffDocSnap.data();

        // Check if account is still active
        if (staffData.status !== 'active') {
            return false;
        }

        // Check if email matches (in case account was updated)
        if (staffData.email !== staffSession.email) {
            return false;
        }

        // Update session with latest role from Firebase
        if (staffData.role && staffData.role !== staffSession.role) {
            staffSession.role = staffData.role;
            const storageType = window.sessionStorage.getItem('staffSession') ? 'sessionStorage' : 'localStorage';
            window[storageType].setItem('staffSession', JSON.stringify(staffSession));
        }

        return true;
    } catch (error) {
        console.error('Error verifying session:', error);
        // On error, allow access (fail open for development)
        // In production, you might want to fail closed
        return true;
    }
}

// Redirect to login page
function redirectToLogin() {
    // Store the current page to redirect back after login
    const currentPage = window.location.pathname.split('/').pop();
    sessionStorage.setItem('redirectAfterLogin', currentPage);
    
    // Redirect to login
    window.location.href = 'staff-login.html';
}

// Clear session
function clearSession() {
    sessionStorage.removeItem('staffSession');
    localStorage.removeItem('staffSession');
}

// Logout function
function logout() {
    clearSession();
    redirectToLogin();
}

// Check role-based access
function checkRoleAccess(session, requiredRoles) {
    if (!requiredRoles || requiredRoles.length === 0) {
        return true; // No role restriction
    }
    
    const userRole = session.role || '';
    return requiredRoles.includes(userRole);
}

// Hide restricted navigation immediately (synchronous, no Firebase wait)
function hideRestrictedNavigationImmediately() {
    const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
    if (!session) {
        return;
    }

    try {
        const staffSession = JSON.parse(session);
        const userRole = staffSession.role || '';
        
        applyNavigationHideRules(userRole);
    } catch (e) {
        console.warn('Could not parse session for immediate navigation hide:', e);
    }
}

// Initialize session check on page load
async function initSessionCheck() {
    // Check if we're on the login page - don't check session there
    if (window.location.pathname.includes('staff-login.html') || 
        window.location.pathname.includes('staff-register.html')) {
        return;
    }

    // Hide restricted navigation immediately (before Firebase check)
    hideRestrictedNavigationImmediately();

    const session = checkStaffSession();
    
    if (!session) {
        // Already redirected to login
        return;
    }

    // Check role-based access for admin profile page immediately (before Firebase)
    if (window.location.pathname.includes('admin-profile.html')) {
        const hasAccess = checkRoleAccess(session, ['Owner', 'Admin']);
        if (!hasAccess) {
            alert('Access denied. This page is only accessible to Owners and Admins.');
            window.location.href = 'index.html';
            return;
        }
    }

    // Verify session with Firebase to get latest role
    const isValid = await verifySessionWithFirebase(session);
    
    if (!isValid) {
        // Session is invalid, clear it and redirect
        clearSession();
        alert('Your session has expired or your account is no longer active. Please log in again.');
        redirectToLogin();
        return;
    }

    // Get updated session (role might have been updated from Firebase)
    const updatedSession = checkStaffSession();
    if (!updatedSession) {
        return;
    }

    // Re-check role-based access after Firebase verification (in case role changed)
    if (window.location.pathname.includes('admin-profile.html')) {
        const hasAccess = checkRoleAccess(updatedSession, ['Owner', 'Admin']);
        if (!hasAccess) {
            alert('Access denied. This page is only accessible to Owners and Admins.');
            window.location.href = 'index.html';
            return;
        }
    }

    // Enforce role-based restrictions (e.g., drivers blocked from admin pages)
    const hasRoleAccess = enforceRoleRestrictions(updatedSession);
    if (!hasRoleAccess) {
        return;
    }

    // Session is valid, update UI if needed
    updateUIWithSession(updatedSession);
    
    // Hide navigation items based on role (update after Firebase verification)
    hideRestrictedNavigation(updatedSession);
}

// Update UI with session information
function updateUIWithSession(session) {
    // Update profile button or user display if needed
    const profileButtons = document.querySelectorAll('.profile-btn span');
    if (profileButtons.length > 0 && session.email) {
        // You can update the profile button to show staff email
        // profileButtons[0].textContent = session.email;
    }
}

// Hide restricted navigation items based on user role
function hideRestrictedNavigation(session) {
    const userRole = session.role || '';
    applyNavigationHideRules(userRole);
}

// Common navigation hide rules based on role
function applyNavigationHideRules(userRoleRaw) {
    const role = (userRoleRaw || '').toLowerCase();
    const hideSelectors = [];

    // Cashier should not see sales, admin profile, or activity logs
    if (role === 'cashier') {
        hideSelectors.push(
            'a[href*="sales.html"]',
            'a[href*="activity-logs.html"]',
            'a[href*="admin-profile.html"]'
        );
    }

    // Non-owner/admin still can't see admin profile
    if (role !== 'owner' && role !== 'admin') {
        hideSelectors.push('a[href*="admin-profile.html"]');
    }

    // Drivers (if ever present) shouldn't see restricted links either
    if (role === 'driver') {
        hideSelectors.push(
            'a[href*="sales.html"]',
            'a[href*="activity-logs.html"]',
            'a[href*="admin-profile.html"]'
        );
    }

    if (hideSelectors.length === 0) {
        // Remove any previously added style
        const style = document.getElementById('restrict-admin-profile');
        if (style) style.remove();
        return;
    }

    // Add CSS rule to hide immediately
    let style = document.getElementById('restrict-admin-profile');
    if (!style) {
        style = document.createElement('style');
        style.id = 'restrict-admin-profile';
        (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = hideSelectors.join(', ') + ' { display: none !important; }';

    // Also hide via DOM manipulation
    const hideNavItem = function() {
        hideSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(link => {
                const navItem = link.closest('.nav-item');
                if (navItem) {
                    navItem.style.display = 'none';
                }
            });
        });
    };

    if (document.body) hideNavItem();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', hideNavItem);
    } else {
        setTimeout(hideNavItem, 0);
    }
}

// Role-based page restrictions
function enforceRoleRestrictions(session) {
    if (!session || !session.role) {
        return true;
    }

    const role = (session.role || '').toLowerCase();
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    // Block any unknown role
    const allowedRoles = new Set(['owner', 'admin', 'cashier']);
    if (!allowedRoles.has(role)) {
        alert('Access denied. Your role is not permitted to access the admin dashboard.');
        clearSession();
        redirectToLogin();
        return false;
    }

    // Drivers: block entirely from admin
    if (role === 'driver') {
        alert('Access denied. Drivers cannot access the admin dashboard.');
        clearSession();
        redirectToLogin();
        return false;
    }

    // Cashiers: block specific pages
    const cashierBlocked = new Set(['sales.html', 'activity-logs.html', 'admin-profile.html']);
    if (role === 'cashier' && cashierBlocked.has(currentPage)) {
        alert('Access denied. Cashiers cannot access this page.');
        window.location.href = 'index.html';
        return false;
    }

    return true;
}

// Make functions available globally
window.checkStaffSession = checkStaffSession;
window.verifySessionWithFirebase = verifySessionWithFirebase;
window.checkRoleAccess = checkRoleAccess;
window.logout = logout;
window.clearSession = clearSession;

// Hide navigation immediately when script loads (before DOM ready)
hideRestrictedNavigationImmediately();

// Run session check when DOM is loaded
if (document.readyState === 'loading') {
    // Hide navigation immediately even while loading
    document.addEventListener('DOMContentLoaded', function() {
        hideRestrictedNavigationImmediately();
        initSessionCheck();
    });
} else {
    initSessionCheck();
}

