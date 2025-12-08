// Hide restricted navigation immediately on page load (runs before page renders)
// This script should be included in the <head> of all admin pages
(function() {
    try {
        const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
        if (session) {
            const staffSession = JSON.parse(session);
            const userRole = staffSession.role || '';
            const role = (userRole || '').toLowerCase();
            const hideSelectors = [];

            // Cashier: hide sales, admin profile, activity logs
            if (role === 'cashier') {
                hideSelectors.push(
                    'a[href*="sales.html"]',
                    '.nav-item:has(a[href*="sales.html"])',
                    'a[href*="activity-logs.html"]',
                    '.nav-item:has(a[href*=\"activity-logs.html\"])',
                    'a[href*="admin-profile.html"]',
                    '.nav-item:has(a[href*="admin-profile.html"])'
                );
            }

            // Non-owner/admin: hide admin profile
            if (role !== 'owner' && role !== 'admin') {
                hideSelectors.push(
                    'a[href*="admin-profile.html"]',
                    '.nav-item:has(a[href*="admin-profile.html"])'
                );
            }

            // Drivers: also hide restricted links
            if (role === 'driver') {
                hideSelectors.push(
                    'a[href*="sales.html"]',
                    '.nav-item:has(a[href*="sales.html"])',
                    'a[href*="activity-logs.html"]',
                    '.nav-item:has(a[href*="activity-logs.html"])',
                    'a[href*="admin-profile.html"]',
                    '.nav-item:has(a[href*="admin-profile.html"])'
                );
            }

            if (hideSelectors.length > 0) {
                const style = document.createElement('style');
                style.id = 'restrict-admin-profile';
                style.textContent = hideSelectors.join(', ') + ' { display: none !important; }';
                (document.head || document.documentElement).appendChild(style);
            }
        }
    } catch(e) {
        console.warn('Could not hide navigation immediately:', e);
    }
})();


