/**
 * Mobile Menu Tray Functionality
 * Handles opening/closing of mobile menu tray on all pages
 */

document.addEventListener('DOMContentLoaded', function() {
  const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
  const mobileMenuOverlay = document.querySelector('.mobile-menu-overlay');
  const mobileMenuTray = document.querySelector('.mobile-menu-tray');
  const mobileMenuClose = document.querySelector('.mobile-menu-close');
  const mobileMenuLinks = document.querySelectorAll('.mobile-menu-nav-link');

  // Open mobile menu
  function openMobileMenu() {
    if (mobileMenuOverlay && mobileMenuTray) {
      mobileMenuOverlay.classList.add('active');
      mobileMenuTray.classList.add('active');
      document.body.classList.add('mobile-menu-open');
    }
  }

  // Close mobile menu
  function closeMobileMenu() {
    if (mobileMenuOverlay && mobileMenuTray) {
      mobileMenuOverlay.classList.remove('active');
      mobileMenuTray.classList.remove('active');
      document.body.classList.remove('mobile-menu-open');
    }
  }

  // Toggle mobile menu
  function toggleMobileMenu() {
    if (mobileMenuTray && mobileMenuTray.classList.contains('active')) {
      closeMobileMenu();
    } else {
      openMobileMenu();
    }
  }

  // Event listeners
  if (mobileMenuToggle) {
    mobileMenuToggle.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      toggleMobileMenu();
    });
  }

  if (mobileMenuClose) {
    mobileMenuClose.addEventListener('click', function(e) {
      e.preventDefault();
      closeMobileMenu();
    });
  }

  if (mobileMenuOverlay) {
    mobileMenuOverlay.addEventListener('click', function(e) {
      if (e.target === mobileMenuOverlay) {
        closeMobileMenu();
      }
    });
  }

  // Close menu when clicking on a link
  mobileMenuLinks.forEach(link => {
    link.addEventListener('click', function() {
      // Small delay to allow navigation
      setTimeout(() => {
        closeMobileMenu();
      }, 100);
    });
  });

  // Close menu on escape key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && mobileMenuTray && mobileMenuTray.classList.contains('active')) {
      closeMobileMenu();
    }
  });

  // Prevent body scroll when menu is open
  const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      if (mutation.attributeName === 'class') {
        const isOpen = document.body.classList.contains('mobile-menu-open');
        if (isOpen) {
          document.body.style.overflow = 'hidden';
        } else {
          document.body.style.overflow = '';
        }
      }
    });
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });
});
