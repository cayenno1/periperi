// Global variables
let activeDropdown = null;

// Dropdown functionality
function toggleDropdown(dropdownId) {
    // Close any currently open dropdown
    if (activeDropdown && activeDropdown !== dropdownId) {
        const currentDropdown = document.getElementById(activeDropdown);
        if (currentDropdown) {
            currentDropdown.classList.remove('show');
        }
    }
    
    // Toggle the clicked dropdown
    const dropdown = document.getElementById(dropdownId);
    if (dropdown) {
        dropdown.classList.toggle('show');
        activeDropdown = dropdown.classList.contains('show') ? dropdownId : null;
    }
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(event) {
    if (activeDropdown) {
        const dropdown = document.getElementById(activeDropdown);
        const button = event.target.closest('[onclick*="toggleDropdown"]');
        
        if (!dropdown.contains(event.target) && !button) {
            dropdown.classList.remove('show');
            activeDropdown = null;
        }
    }
});

// Order management functions
function editOrder(orderId) {
    alert(`Edit order ${orderId} - This would open an edit form in a real application`);
}

function deleteOrder(orderId) {
    if (confirm(`Are you sure you want to delete order ${orderId}?`)) {
        alert(`Order ${orderId} deleted successfully`);
        // In a real application, this would make an API call to delete the order
    }
}

// Driver management functions
function editDriver(driverId) {
    alert(`Edit driver ${driverId} - This would open an edit form in a real application`);
}

function deleteDriver(driverId) {
    if (confirm(`Are you sure you want to delete driver ${driverId}?`)) {
        alert(`Driver ${driverId} deleted successfully`);
    }
}

function printDriver(driverId) {
    alert(`Printing driver ${driverId} information`);
    // In a real application, this would trigger a print dialog
}

// Inventory management functions
function editItem(itemId) {
    alert(`Edit item ${itemId} - This would open an edit form in a real application`);
}

function deleteItem(itemId) {
    if (confirm(`Are you sure you want to delete item ${itemId}?`)) {
        alert(`Item ${itemId} deleted successfully`);
    }
}

// Sales report functions
function switchReport(reportType) {
    // Remove active class from all sales activity tabs
    document.querySelectorAll('.sales-activity-tabs .tab-btn').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Add active class to clicked tab
    event.target.classList.add('active');
    
    // In a real application, this would load different report data
    console.log(`Switched to ${reportType} report`); // No popup notification
}

function switchTime(timePeriod) {
    // Remove active class from all time tabs
    document.querySelectorAll('.time-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Add active class to clicked tab
    event.target.classList.add('active');
    
    // In a real application, this would filter data by time period
    console.log(`Switched to ${timePeriod} view`); // No popup notification
}

function exportReport() {
    // In a real application, this would generate and download the report
    console.log('Exporting report...'); // No popup notification
}

function changePage(page) {
    if (page === 'prev' || page === 'next') {
        alert(`Navigate to ${page} page`);
    } else {
        // Remove active class from all page buttons
        document.querySelectorAll('.page-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        
        // Add active class to clicked page button
        event.target.classList.add('active');
        
        alert(`Navigate to page ${page}`);
    }
}

function exportReport() {
    alert('Export functionality - In a real application, this would download a report file');
    // Note: Export buttons don't need backend functionality as per requirements
}

function exportInventoryReport() {
    // Create CSV content for inventory report
    const csvContent = "Menu ID,Item Name,Category,Quantity,Price,Status\n" +
        "ID01,Grilled Chicken,Meat,45,P150.00,Low Stock\n" +
        "ID02,Chicken Rice Meal,Rice Meal,120,P180.00,High Stock\n" +
        "ID03,Spaghetti,Pasta,85,P120.00,Normal\n" +
        "ID04,Shawarma,Meat,25,P200.00,Low Stock\n" +
        "ID05,BBQ Ribs,Limited Time,95,P250.00,High Stock\n" +
        "ID06,French Fries,Sides,60,P80.00,Normal\n" +
        "ID07,Utensils,Packaging,200,P2.00,High Stock\n" +
        "ID08,Take-out Box,Packaging,15,P5.00,Low Stock";
    
    // Create and download the file
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'inventory_report_' + new Date().toISOString().split('T')[0] + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    showNotification('Inventory report exported successfully!', 'success');
}

// Customer management functions
function selectCustomer(customerId) {
    // Remove selected class from all customer items
    document.querySelectorAll('.customer-item').forEach(item => {
        item.classList.remove('selected');
    });
    
    // Add selected class to clicked customer
    event.target.closest('.customer-item').classList.add('selected');
    
    alert(`Selected customer ${customerId}`);
}

function switchTab(tabName) {
    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Add active class to clicked tab
    event.target.classList.add('active');
    
    // Show/hide tab content
    const reviewsTab = document.getElementById('reviewsTab');
    const rewardsTab = document.getElementById('rewardsTab');
    
    if (tabName === 'reviews') {
        if (reviewsTab) reviewsTab.style.display = 'block';
        if (rewardsTab) rewardsTab.style.display = 'none';
    } else if (tabName === 'rewards') {
        if (reviewsTab) reviewsTab.style.display = 'none';
        if (rewardsTab) rewardsTab.style.display = 'block';
    }
}

function toggleReviewOptions(reviewId) {
    alert(`Review options for review ${reviewId}`);
}

// Menu management functions
function addFood() {
    alert('Add Food - This would open a form to add new food items');
}

function toggleItemMenu(itemId) {
    // Close any other open item menus
    document.querySelectorAll('.item-menu').forEach(menu => {
        if (menu.id !== `itemMenu${itemId}`) {
            menu.classList.remove('show');
        }
    });
    
    // Toggle the clicked item menu
    const menu = document.getElementById(`itemMenu${itemId}`);
    if (menu) {
        menu.classList.toggle('show');
    }
}

// Admin profile functions
function addUser() {
    alert('Add User - This would open a form to add new admin users');
}

// Activity logs functions
function toggleReviewOptions(reviewId) {
    alert(`Review options for review ${reviewId}`);
}

// Initialize page-specific functionality
document.addEventListener('DOMContentLoaded', function() {
    // Set active navigation item based on current page
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const navItems = document.querySelectorAll('.nav-item');
    
    navItems.forEach(item => {
        const link = item.querySelector('a');
        if (link && link.getAttribute('href') === currentPage) {
            item.classList.add('active');
        }
    });
    
    // Initialize any page-specific functionality
    if (currentPage === 'customer.html') {
        // Initialize customer management specific functionality
        console.log('Customer management page loaded');
    } else if (currentPage === 'sales.html') {
        // Initialize sales report specific functionality
        console.log('Sales report page loaded');
    } else if (currentPage === 'menu.html') {
        // Initialize menu management specific functionality
        console.log('Menu management page loaded');
    }
});

// Utility functions
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    // Style the notification
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#d4edda' : type === 'error' ? '#f8d7da' : '#d1ecf1'};
        color: ${type === 'success' ? '#155724' : type === 'error' ? '#721c24' : '#0c5460'};
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 10000;
        max-width: 300px;
        word-wrap: break-word;
    `;
    
    // Add to page
    document.body.appendChild(notification);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// Form validation helper
function validateForm(formData) {
    const errors = [];
    
    // Example validation rules
    if (!formData.name || formData.name.trim() === '') {
        errors.push('Name is required');
    }
    
    if (!formData.email || !isValidEmail(formData.email)) {
        errors.push('Valid email is required');
    }
    
    return errors;
}

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// Search functionality
function performSearch(searchTerm) {
    console.log(`Searching for: ${searchTerm}`);
    // In a real application, this would make an API call to search for data
    showNotification(`Searching for "${searchTerm}"...`, 'info');
}

// Filter functionality
function applyFilter(filterType, filterValue) {
    console.log(`Applying filter: ${filterType} = ${filterValue}`);
    // In a real application, this would filter the displayed data
    showNotification(`Filter applied: ${filterType} = ${filterValue}`, 'info');
}

// Export all functions to global scope for HTML onclick handlers
window.toggleDropdown = toggleDropdown;
window.editOrder = editOrder;
window.deleteOrder = deleteOrder;
window.editDriver = editDriver;
window.deleteDriver = deleteDriver;
window.printDriver = printDriver;
window.editItem = editItem;
window.deleteItem = deleteItem;
window.switchReport = switchReport;
window.switchTime = switchTime;
window.changePage = changePage;
window.exportReport = exportReport;
window.exportInventoryReport = exportInventoryReport;
window.selectCustomer = selectCustomer;
window.switchTab = switchTab;
window.toggleReviewOptions = toggleReviewOptions;
window.addFood = addFood;
window.toggleItemMenu = toggleItemMenu;
window.addUser = addUser;

// Add Food Dashboard Functions
function showAddFood() {
    document.getElementById('addFoodDashboard').style.display = 'block';
    document.getElementById('foodSection').style.display = 'none';
}

function hideAddFood() {
    document.getElementById('addFoodDashboard').style.display = 'none';
    document.getElementById('foodSection').style.display = 'block';
}

function previewImage(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const imagePreview = document.getElementById('imagePreview');
            imagePreview.innerHTML = `<img src="${e.target.result}" alt="Food Preview">`;
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function removeImage() {
    const imagePreview = document.getElementById('imagePreview');
    imagePreview.innerHTML = `
        <div class="upload-placeholder">
            <i class="fas fa-plus"></i>
            <span>Add Photo</span>
        </div>
    `;
    document.getElementById('imageInput').value = '';
}

function submitFood() {
    const category = document.getElementById('category').value;
    const foodId = document.getElementById('foodId').value;
    const foodName = document.getElementById('foodName').value;
    const price = document.getElementById('price').value;
    const description = document.getElementById('description').value;
    
    if (!foodName || !price) {
        alert('Please fill in all required fields');
        return;
    }
    
    // Here you would typically send the data to a server
    console.log('Adding food:', { category, foodId, foodName, price, description });
    
    // Reset form
    document.getElementById('foodId').value = '';
    document.getElementById('foodName').value = '';
    document.getElementById('price').value = '';
    document.getElementById('description').value = '';
    removeImage();
    
    // Show success message and go back to menu
    alert('Food item added successfully!');
    hideAddFood();
}

// Update the existing addFood function
function addFood() {
    showAddFood();
}

window.showAddFood = showAddFood;
window.hideAddFood = hideAddFood;
window.previewImage = previewImage;
window.removeImage = removeImage;
window.submitFood = submitFood;

// User Profile Dashboard Functions
function showUserProfile() {
    document.getElementById('userProfileDashboard').style.display = 'block';
    // Hide other sections if they exist
    const adminProfiles = document.querySelector('.admin-profiles');
    if (adminProfiles) {
        adminProfiles.style.display = 'none';
    }
}

function hideUserProfile() {
    document.getElementById('userProfileDashboard').style.display = 'none';
    // Show other sections if they exist
    const adminProfiles = document.querySelector('.admin-profiles');
    if (adminProfiles) {
        adminProfiles.style.display = 'block';
    }
}

window.showUserProfile = showUserProfile;
window.hideUserProfile = hideUserProfile;

// Driver Dashboard Functions
function logIn() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
    });
    
    // Update the logged in time
    const timeTracking = document.querySelector('.time-tracking');
    if (timeTracking) {
        const loginTime = timeTracking.querySelector('p:first-child');
        if (loginTime) {
            loginTime.innerHTML = `<i class="fas fa-sign-in-alt"></i> Logged in: ${timeString}`;
        }
    }
    
    // Update availability toggle
    const toggle = document.getElementById('availabilityToggle');
    if (toggle) {
        toggle.checked = true;
    }
    
    showNotification('Successfully logged in!', 'success');
}

function logOut() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
    });
    
    // Update the logged out time
    const timeTracking = document.querySelector('.time-tracking');
    if (timeTracking) {
        const logoutTime = timeTracking.querySelector('p:last-child');
        if (logoutTime) {
            logoutTime.innerHTML = `<i class="fas fa-sign-out-alt"></i> Last logout: ${timeString}`;
        }
    }
    
    // Update availability toggle
    const toggle = document.getElementById('availabilityToggle');
    if (toggle) {
        toggle.checked = false;
    }
    
    showNotification('Successfully logged out!', 'success');
}

function markPickedUp(orderId) {
    if (confirm(`Mark order #${orderId} as picked up?`)) {
        // Update the delivery status
        const deliveryCard = document.querySelector(`[onclick*="markPickedUp('${orderId}')"]`).closest('.delivery-card');
        if (deliveryCard) {
            const statusElement = deliveryCard.querySelector('.delivery-status');
            const actionsElement = deliveryCard.querySelector('.delivery-actions');
            
            if (statusElement) {
                statusElement.textContent = 'On the Way';
                statusElement.className = 'delivery-status in-transit';
            }
            
            if (actionsElement) {
                actionsElement.innerHTML = `
                    <button class="btn btn-warning" onclick="markDelivered('${orderId}')">
                        <i class="fas fa-check-circle"></i> Mark as Delivered
                    </button>
                    <button class="btn btn-danger" onclick="reportIssue('${orderId}')">
                        <i class="fas fa-exclamation-triangle"></i> Report Issue
                    </button>
                `;
            }
        }
        
        showNotification(`Order #${orderId} marked as picked up!`, 'success');
    }
}

function markDelivered(orderId) {
    if (confirm(`Mark order #${orderId} as delivered?`)) {
        // Update the delivery status
        const deliveryCard = document.querySelector(`[onclick*="markDelivered('${orderId}')"]`).closest('.delivery-card');
        if (deliveryCard) {
            const statusElement = deliveryCard.querySelector('.delivery-status');
            const actionsElement = deliveryCard.querySelector('.delivery-actions');
            
            if (statusElement) {
                statusElement.textContent = 'Delivered';
                statusElement.className = 'delivery-status delivered';
            }
            
            if (actionsElement) {
                actionsElement.innerHTML = `
                    <button class="btn btn-success" disabled>
                        <i class="fas fa-check-circle"></i> Delivered
                    </button>
                `;
            }
        }
        
        showNotification(`Order #${orderId} marked as delivered!`, 'success');
    }
}

function reportIssue(orderId) {
    const issue = prompt(`Report issue for order #${orderId}:\n\n1. Customer not available\n2. Address problem\n3. Payment issue\n4. Other\n\nPlease describe the issue:`);
    
    if (issue && issue.trim() !== '') {
        showNotification(`Issue reported for order #${orderId}: ${issue}`, 'info');
        
        // In a real application, this would send the issue report to the admin
        console.log(`Issue reported for order ${orderId}:`, issue);
    }
}

// Add driver functions to global scope
window.logIn = logIn;
window.logOut = logOut;
window.markPickedUp = markPickedUp;
window.markDelivered = markDelivered;
window.reportIssue = reportIssue;

