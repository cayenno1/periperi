// Mobile menu toggle functionality
function toggleMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar && overlay) {
        sidebar.classList.toggle('mobile-open');
        overlay.classList.toggle('active');
    }
}

// Close mobile menu when clicking outside
document.addEventListener('click', function(event) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    const toggleBtn = document.querySelector('.mobile-menu-toggle');
    
    if (sidebar && overlay && toggleBtn) {
        if (!sidebar.contains(event.target) && 
            !toggleBtn.contains(event.target) && 
            sidebar.classList.contains('mobile-open')) {
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('active');
        }
    }
});

// Close mobile menu when window is resized to desktop size
window.addEventListener('resize', function() {
    if (window.innerWidth > 768) {
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar && overlay) {
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('active');
        }
    }
});

