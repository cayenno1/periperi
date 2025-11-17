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
    if (!window.firebaseAuth || !window.firebaseReady) {
      setTimeout(initAuthListener, RETRY_DELAY_MS);
      return;
    }

    const currentUser = window.firebaseAuth.currentUser;
    if (currentUser) {
      updateProfileUI(currentUser);
    }

    window.onAuthStateChanged(window.firebaseAuth, async (user) => {
      await updateProfileUI(user);
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

