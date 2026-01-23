// Profile login and UI updates
'use strict';

const CUSTOMERS_COLLECTION = 'customers';
const LOGIN_PAGE = 'login.html';
const RETRY_DELAY_MS = 10;

// Update profile UI
async function updateProfileUI(user) {
  const profileText = document.getElementById('profileText');
  const profileIcon = document.getElementById('profileIcon');
  const profileDropdown = document.getElementById('profileDropdown');
  const profileName = document.getElementById('profileName');
  const profileEmail = document.getElementById('profileEmail');
  const logoutBtn = document.getElementById('logoutBtn');
  const profileButton = document.getElementById('profileButton');

  if (!profileText || !profileIcon || !profileButton) {
    return;
  }

  const isAccountPage = document.body.classList.contains('account-page');

  // Remove loading state and mark as checked
  profileButton.classList.remove('checking-auth');
  profileButton.classList.add('auth-checked');

  if (user) {
    profileButton.classList.add('logged-in');
    profileIcon.style.display = '';
    profileText.style.display = '';

    if (profileName) profileName.textContent = user.displayName || 'User';
    if (profileEmail) profileEmail.textContent = user.email || '';

    fetchUserData(user.uid)
      .then((userData) => {
        if (userData) {
          if (profileName) profileName.textContent = userData.fullName;
          if (profileEmail) profileEmail.textContent = userData.email;
        }
      })
      .catch((error) => {
        console.error('Error fetching user data:', error);
      });
  } else {
    if (!isAccountPage) {
      profileButton.classList.remove('logged-in');
      profileIcon.style.display = '';
      profileText.style.display = '';
      if (profileText) profileText.textContent = 'Sign In';
    }
    if (profileName) profileName.textContent = 'Your Account';
    if (profileEmail) profileEmail.textContent = 'user@example.com';
  }
}

// Set loading state while checking auth
function setProfileLoadingState() {
  const profileText = document.getElementById('profileText');
  const profileIcon = document.getElementById('profileIcon');
  const profileButton = document.getElementById('profileButton');

  if (!profileText || !profileIcon || !profileButton) {
    return;
  }

  // Add loading state
  profileButton.classList.add('checking-auth');

  // Show loading text
  if (profileText) {
    profileText.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    profileText.style.display = 'block';
  }
  if (profileIcon) {
    profileIcon.style.display = 'none';
  }
}

// Set loading state immediately - runs synchronously before page render
(function() {
  'use strict';
  // This runs immediately when script loads, before DOM is ready
  if (typeof document !== 'undefined') {
    // Use a MutationObserver to catch the element as soon as it's added
    const observer = new MutationObserver(function(mutations) {
      const profileButton = document.getElementById('profileButton');
      const profileText = document.getElementById('profileText');

      if (profileButton && profileText && !profileButton.classList.contains('checking-auth') && !profileButton.classList.contains('logged-in')) {
        setProfileLoadingState();
        observer.disconnect();
      }
    });

    // Start observing
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      // If body doesn't exist yet, wait for it
      document.addEventListener('DOMContentLoaded', function() {
        const profileButton = document.getElementById('profileButton');
        if (profileButton && !profileButton.classList.contains('checking-auth') && !profileButton.classList.contains('logged-in')) {
          setProfileLoadingState();
        }
        observer.disconnect();
      });
    }

    // Also try immediately in case elements already exist
    setTimeout(function() {
      const profileButton = document.getElementById('profileButton');
      const profileText = document.getElementById('profileText');
      if (profileButton && profileText && !profileButton.classList.contains('checking-auth') && !profileButton.classList.contains('logged-in')) {
        setProfileLoadingState();
      }
    }, 0);
  }
})();

// Fetch user data
async function fetchUserData(userId) {
  try {
    const userDoc = await window.getDoc(window.doc(window.firebaseDb, CUSTOMERS_COLLECTION, userId));

    if (!userDoc.exists()) {
      return null;
    }

    const userData = userDoc.data();
    const firstName = userData.firstName || '';
    const lastName = userData.lastName || '';
    const fullName = `${firstName} ${lastName}`.trim() || 'User';
    const email = userData.email || '';

    return { fullName, email };
  } catch (error) {
    console.error('Error fetching user data:', error);
    return null;
  }
}

function applyDropdownContext() {
  const dropdown = document.getElementById('profileDropdown');
  if (!dropdown) return;

  const bodyClasses = document.body?.classList || [];
  const currentPath = window.location.pathname.split('/').pop() || 'index.html';

  dropdown.querySelectorAll('.profile-item[data-hide-on-body]').forEach((item) => {
    const hideClasses = (item.dataset.hideOnBody || '')
      .split(',')
      .map((cls) => cls.trim())
      .filter(Boolean);

    const shouldHide = hideClasses.some((cls) => bodyClasses.contains(cls));
    item.style.display = shouldHide ? 'none' : '';
  });

  dropdown.querySelectorAll('.profile-item[data-nav-target]').forEach((item) => {
    if (item.style.display === 'none') {
      item.classList.remove('current-page');
      item.removeAttribute('aria-current');
      return;
    }

    const target = item.dataset.navTarget;
    if (!target) return;

    const matchesBodyClass = bodyClasses.contains(`${target}-page`);
    const matchesPath = currentPath === `${target}.html`;
    const isCurrent = matchesBodyClass || matchesPath;

    if (isCurrent) {
      item.classList.add('current-page');
      item.setAttribute('aria-current', 'page');
    } else {
      item.classList.remove('current-page');
      item.removeAttribute('aria-current');
    }
  });
}

// Setup profile auth
function initProfileAuth() {
  const btn = document.getElementById('profileButton');
  const dropdown = document.getElementById('profileDropdown');

  if (!btn || !dropdown) {
    return;
  }

  function toggleDropdown(e) {
    e.stopPropagation();
    const user = window.firebaseAuth?.currentUser;

    if (!user) {
      window.location.href = LOGIN_PAGE;
      return;
    }

    dropdown.classList.toggle('show');
  }

  function handleOutside(e) {
    if (!dropdown.classList.contains('show')) return;
    if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
      dropdown.classList.remove('show');
    }
  }

  btn.addEventListener('click', toggleDropdown);
  document.addEventListener('click', handleOutside);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dropdown.classList.remove('show');
  });

  applyDropdownContext();

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async function() {
      try {
        await window.signOut(window.firebaseAuth);
        dropdown.classList.remove('show');
        localStorage.removeItem('ppp_user');
        await updateProfileUI(null);
        window.location.href = LOGIN_PAGE;
      } catch (error) {
        console.error('Error signing out:', error);
        alert('Error signing out. Please try again.');
      }
    });
  }

  // Setup auth listener
  function initAuthListener() {
    // Ensure loading state is set (profile-login.js should have done this, but ensure it)
    const profileButton = document.getElementById('profileButton');
    if (profileButton && !profileButton.classList.contains('checking-auth') && !profileButton.classList.contains('logged-in')) {
      setProfileLoadingState();
    }

    if (!window.firebaseAuth || !window.firebaseReady) {
      setTimeout(initAuthListener, RETRY_DELAY_MS);
      return;
    }

    const currentUser = window.firebaseAuth.currentUser;
    if (currentUser) {
      updateProfileUI(currentUser);
    } else {
      // No user found, update UI to show Sign In
      updateProfileUI(null);
    }

    window.onAuthStateChanged(window.firebaseAuth, async (user) => {
      await updateProfileUI(user);
      applyDropdownContext();
    });
  }

  initAuthListener();
}

// Setup on page load
function initialize() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initProfileAuth);
  } else {
    initProfileAuth();
  }
}

initialize();

