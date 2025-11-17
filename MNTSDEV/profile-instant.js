// Instant profile UI update
(function() {
  'use strict';

  const SESSION_STORAGE_KEY = 'justLoggedIn';
  const PROFILE_BUTTON_ID = 'profileButton';
  const PROFILE_ICON_ID = 'profileIcon';
  const PROFILE_TEXT_ID = 'profileText';
  const MAX_RETRIES = 50;
  const RETRY_DELAY = 10;

  // Update profile instantly
  function updateProfileInstantly(retryCount = 0) {
    const justLoggedIn = sessionStorage.getItem(SESSION_STORAGE_KEY);
    
    if (justLoggedIn !== 'true') {
      return;
    }

    const button = document.getElementById(PROFILE_BUTTON_ID);
    const icon = document.getElementById(PROFILE_ICON_ID);
    const text = document.getElementById(PROFILE_TEXT_ID);

    if (!button || !icon || !text) {
      if (retryCount < MAX_RETRIES) {
        setTimeout(() => updateProfileInstantly(retryCount + 1), RETRY_DELAY);
      }
      return;
    }

    button.classList.add('logged-in');
    icon.style.display = '';
    text.style.display = '';
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }

  updateProfileInstantly();
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      updateProfileInstantly();
    });
  }
})();

