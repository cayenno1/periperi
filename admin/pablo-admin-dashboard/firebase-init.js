// Firebase Initialization Script
// Include this in all admin pages that need Firebase access

// Firebase SDK
(async function() {
    try {
        // Import Firebase modules
        const { initializeApp } = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js");
        const { getAnalytics } = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-analytics.js");
        const { getFirestore, doc, getDoc, collection, getDocs, updateDoc, setDoc, serverTimestamp, increment } = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js");

        // Your web app's Firebase configuration
        const firebaseConfig = {
            apiKey: "AIzaSyA4N_Q6hTfKGBdnSkZxWRyyYxeJNFncOKw",
            authDomain: "pablo-s-peri-peri-database.firebaseapp.com",
            projectId: "pablo-s-peri-peri-database",
            storageBucket: "pablo-s-peri-peri-database.firebasestorage.app",
            messagingSenderId: "862159042861",
            appId: "1:862159042861:web:2b2fb016e7425ccb4ffba4",
            measurementId: "G-DCHYP7XPME"
        };

        // Initialize Firebase (only if not already initialized)
        if (!window.firebaseApp) {
            window.firebaseApp = initializeApp(firebaseConfig);
            window.analytics = getAnalytics(window.firebaseApp);
            window.db = getFirestore(window.firebaseApp);

            // Make Firebase functions available globally
            window.firestoreFunctions = {
                doc,
                getDoc,
                collection,
                getDocs,
                updateDoc,
                setDoc,
                serverTimestamp,
                increment
            };
            
            console.log('Firebase initialized successfully');
            console.log('Firestore functions available:', Object.keys(window.firestoreFunctions));
            
            // Dispatch custom event to notify that Firebase is ready
            window.dispatchEvent(new CustomEvent('firebaseReady'));
        } else {
            console.log('Firebase already initialized');
            window.dispatchEvent(new CustomEvent('firebaseReady'));
        }
    } catch (error) {
        console.error('Error initializing Firebase:', error);
        console.error('Error details:', {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: error.cause
        });
        window.firebaseInitError = error;
        window.dispatchEvent(new CustomEvent('firebaseError', { detail: error }));
    }
})();

