// Profile loading state initialization
// Runs immediately to prevent "Sign In" text flash when switching pages
(function() {
  'use strict';
  
  function setProfileLoading() {
    const btn = document.getElementById('profileButton');
    const text = document.getElementById('profileText');
    const icon = document.getElementById('profileIcon');
    
    if (btn && text && !btn.classList.contains('checking-auth') && !btn.classList.contains('logged-in')) {
      btn.classList.add('checking-auth');
      text.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      text.style.display = 'block';
      if (icon) icon.style.display = 'none';
    }
  }
  
  // Try immediately if elements exist
  setProfileLoading();
  
  // Also try on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setProfileLoading);
  } else {
    setProfileLoading();
  }
  
  // Fallback: use MutationObserver to catch elements as they're added
  const observer = new MutationObserver(function() {
    setProfileLoading();
    const btn = document.getElementById('profileButton');
    if (btn && (btn.classList.contains('checking-auth') || btn.classList.contains('logged-in'))) {
      observer.disconnect();
    }
  });
  
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
  }
})();

