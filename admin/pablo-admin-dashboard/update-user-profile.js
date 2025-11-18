// Update User Profile Display
// This script updates the profile button and dropdown with the logged-in user's information

async function updateUserProfile() {
    // Get session data
    const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
    
    if (!session) {
        console.warn('No session found, profile will show default');
        return;
    }

    try {
        const staffSession = JSON.parse(session);
        
        // Fetch full user data from Firebase if available
        let fullStaffData = staffSession;
        if (window.db && window.firestoreFunctions && staffSession.staffId) {
            try {
                const { doc, getDoc } = window.firestoreFunctions;
                const staffDocRef = doc(window.db, 'staff', staffSession.staffId);
                const staffDocSnap = await getDoc(staffDocRef);
                if (staffDocSnap.exists()) {
                    fullStaffData = { ...staffSession, ...staffDocSnap.data() };
                }
            } catch (e) {
                console.warn('Could not fetch full staff data:', e);
            }
        }
        
        // Update profile button text - show First + Last name
        const profileButtons = document.querySelectorAll('.profile-btn span');
        profileButtons.forEach(button => {
            // Show First Name + Last Name
            if (fullStaffData.firstName && fullStaffData.lastName) {
                let displayName = fullStaffData.firstName + ' ' + fullStaffData.lastName;
                if (fullStaffData.suffix) {
                    displayName += ' ' + fullStaffData.suffix;
                }
                button.textContent = displayName;
            } else if (fullStaffData.email) {
                // Fallback to email name if names not available
                const emailName = fullStaffData.email.split('@')[0];
                button.textContent = emailName.charAt(0).toUpperCase() + emailName.slice(1);
            } else if (fullStaffData.staffId) {
                button.textContent = fullStaffData.staffId;
            } else {
                // Remove "Admin" text if no data available
                button.textContent = '';
            }
        });

        // Clean up any incorrectly added user-info-header from profile card dropdowns
        const allProfileCardDropdowns = document.querySelectorAll('.profile-card .dropdown-menu, [id^="profile"][id$="Dropdown"]');
        allProfileCardDropdowns.forEach(dropdown => {
            const userInfoHeader = dropdown.querySelector('.user-info-header');
            if (userInfoHeader) {
                userInfoHeader.remove();
            }
        });

        // Update dropdown menu with user information
        // EXCLUDE profile card dropdowns (they should show their respective user's info, not current user's)
        // Only update the admin dropdown in the header, not profile card dropdowns
        const adminDropdown = document.getElementById('adminDropdown');
        const dropdownsToUpdate = adminDropdown ? [adminDropdown] : [];
        
        dropdownsToUpdate.forEach(menu => {
            // Skip if this is a profile card dropdown (has ID starting with "profile" and ending with "Dropdown")
            if (menu.id && menu.id.startsWith('profile') && menu.id.endsWith('Dropdown')) {
                return;
            }
            // Skip if this dropdown is inside a profile card
            if (menu.closest('.profile-card')) {
                return;
            }
            // Update or add user info in dropdown
            const existingItems = menu.querySelectorAll('.dropdown-item');
            
            // Check if user info header already exists
            let userInfoHeader = menu.querySelector('.user-info-header');
            
            if (!userInfoHeader && existingItems.length > 0) {
                // Create user info header
                userInfoHeader = document.createElement('div');
                userInfoHeader.className = 'user-info-header';
                userInfoHeader.style.cssText = `
                    padding: 12px 16px;
                    border-bottom: 1px solid #e9ecef;
                    background: #f8f9fa;
                `;
                
                const userEmail = document.createElement('div');
                userEmail.style.cssText = `
                    font-weight: 600;
                    color: #495057;
                    font-size: 14px;
                    margin-bottom: 4px;
                `;
                userEmail.textContent = fullStaffData.email || fullStaffData.staffId;
                
                const userRole = document.createElement('div');
                userRole.style.cssText = `
                    font-size: 12px;
                    color: #6c757d;
                `;
                userRole.textContent = `Staff ID: ${fullStaffData.staffId} | Role: ${fullStaffData.role || 'Staff'}`;
                
                userInfoHeader.appendChild(userEmail);
                userInfoHeader.appendChild(userRole);
                
                // Insert at the beginning of dropdown
                menu.insertBefore(userInfoHeader, existingItems[0]);
            } else if (userInfoHeader) {
                // Update existing header
                const emailDiv = userInfoHeader.querySelector('div:first-child');
                const roleDiv = userInfoHeader.querySelector('div:last-child');
                if (emailDiv) emailDiv.textContent = fullStaffData.email || fullStaffData.staffId;
                if (roleDiv) roleDiv.textContent = `Staff ID: ${fullStaffData.staffId} | Role: ${fullStaffData.role || 'Staff'}`;
            }
        });

        // Update admin profile page if it exists
        updateAdminProfilePage(fullStaffData);

        // Store staff session globally for easy access
        window.currentStaffSession = fullStaffData;
        
    } catch (e) {
        console.error('Error updating user profile:', e);
    }
}

// Update admin profile page with user data
function updateAdminProfilePage(staffData) {
    // Update user card in profile page
    const userNameSection = document.querySelector('.user-name-section h3');
    if (userNameSection) {
        let displayName = '';
        if (staffData.firstName && staffData.lastName) {
            displayName = staffData.firstName + ' ' + staffData.lastName;
            if (staffData.suffix) {
                displayName += ' ' + staffData.suffix;
            }
        } else if (staffData.email) {
            const emailName = staffData.email.split('@')[0];
            displayName = emailName.charAt(0).toUpperCase() + emailName.slice(1);
        } else {
            displayName = staffData.staffId || 'User';
        }
        userNameSection.innerHTML = `${displayName} <i class="fas fa-chevron-right"></i>`;
    }

    const userRole = document.querySelector('.user-role');
    if (userRole) {
        userRole.textContent = `@${staffData.role || 'Staff'}`;
    }

    const userIdSection = document.querySelector('.user-id-section span');
    if (userIdSection) {
        userIdSection.textContent = `Staff ID: ${staffData.staffId}`;
    }

    // Update name fields in personal info form if exists
    const firstNameInput = document.querySelector('input[placeholder*="first name" i]');
    if (firstNameInput && staffData.firstName) {
        firstNameInput.value = staffData.firstName;
    }

    const middleNameInput = document.querySelector('input[placeholder*="middle name" i]');
    if (middleNameInput && staffData.middleName) {
        middleNameInput.value = staffData.middleName;
    }

    const lastNameInput = document.querySelector('input[placeholder*="last name" i]');
    if (lastNameInput && staffData.lastName) {
        lastNameInput.value = staffData.lastName;
    }

    // Update email in personal info if form exists
    const emailInputs = document.querySelectorAll('input[type="email"]');
    emailInputs.forEach(input => {
        if (input.placeholder && input.placeholder.toLowerCase().includes('email')) {
            if (!input.value || input.value === '') {
                input.value = staffData.email || '';
            }
        }
    });
}

// Update profile button immediately with session data
function updateProfileButtonImmediately() {
    const session = sessionStorage.getItem('staffSession') || localStorage.getItem('staffSession');
    if (session) {
        try {
            const staffSession = JSON.parse(session);
            // Update profile button immediately with session data
            const profileButtons = document.querySelectorAll('.profile-btn span, #profileName');
            profileButtons.forEach(button => {
                if (staffSession.firstName && staffSession.lastName) {
                    let displayName = staffSession.firstName + ' ' + staffSession.lastName;
                    if (staffSession.suffix) {
                        displayName += ' ' + staffSession.suffix;
                    }
                    button.textContent = displayName;
                } else if (staffSession.email) {
                    const emailName = staffSession.email.split('@')[0];
                    button.textContent = emailName.charAt(0).toUpperCase() + emailName.slice(1);
                } else if (staffSession.staffId) {
                    button.textContent = staffSession.staffId;
                } else {
                    button.textContent = '';
                }
            });
        } catch (e) {
            console.warn('Could not parse session for immediate update:', e);
        }
    } else {
        // No session - clear the text
        const profileButtons = document.querySelectorAll('.profile-btn span, #profileName');
        profileButtons.forEach(button => {
            button.textContent = '';
        });
    }
}

// Run on page load - wait for Firebase to initialize
function initProfileUpdate() {
    // First, update immediately with session data (no Firebase wait)
    updateProfileButtonImmediately();
    
    // Then wait for Firebase and do full update
    let attempts = 0;
    const checkFirebase = setInterval(() => {
        attempts++;
        if (window.db || attempts > 50) {
            clearInterval(checkFirebase);
            updateUserProfile();
        }
    }, 100);
}

// Run immediately if DOM is ready, otherwise wait
if (document.readyState === 'loading') {
    // Update immediately even while loading
    updateProfileButtonImmediately();
    document.addEventListener('DOMContentLoaded', initProfileUpdate);
} else {
    initProfileUpdate();
}

// Also update immediately when script loads (for inline scripts)
updateProfileButtonImmediately();

// Also update when session changes (if needed)
window.addEventListener('storage', function(e) {
    if (e.key === 'staffSession') {
        updateUserProfile();
    }
});

// Make function available globally
window.updateUserProfile = updateUserProfile;

