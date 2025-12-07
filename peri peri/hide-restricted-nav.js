// Hide restricted navigation immediately on page load (runs before page renders)
// This script should be included in the <head> of all admin pages
(function() {
    try {
        const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
        if (session) {
            const staffSession = JSON.parse(session);
            const userRole = staffSession.role || '';
            if (userRole !== 'Owner' && userRole !== 'Admin') {
                const style = document.createElement('style');
                style.id = 'restrict-admin-profile';
                style.textContent = 'a[href*="admin-profile.html"], .nav-item:has(a[href*="admin-profile.html"]) { display: none !important; }';
                (document.head || document.documentElement).appendChild(style);
            }
        }
    } catch(e) {
        console.warn('Could not hide navigation immediately:', e);
    }
})();


