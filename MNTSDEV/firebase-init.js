// Firebase setup
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, updatePassword, reauthenticateWithCredential, EmailAuthProvider, deleteUser } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot, arrayUnion, arrayRemove, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA4N_Q6hTfKGBdnSkZxWRyyYxeJNFncOKw",
  authDomain: "pablo-s-peri-peri-database.firebaseapp.com",
  projectId: "pablo-s-peri-peri-database",
  storageBucket: "pablo-s-peri-peri-database.firebasestorage.app",
  messagingSenderId: "862159042861",
  appId: "1:862159042861:web:b9215e4f7fbea8c44ffba4",
  measurementId: "G-76TEJYQHQN"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Expose globally
window.firebaseAuth = auth;
window.firebaseDb = db;
window.signOut = signOut;
window.onAuthStateChanged = onAuthStateChanged;
window.getDoc = getDoc;
window.doc = doc;
window.setDoc = setDoc;
window.deleteDoc = deleteDoc;
window.onSnapshot = onSnapshot;
window.arrayUnion = arrayUnion;
window.arrayRemove = arrayRemove;
window.updateDoc = updateDoc;
window.updatePassword = updatePassword;
window.reauthenticateWithCredential = reauthenticateWithCredential;
window.EmailAuthProvider = EmailAuthProvider;
window.deleteUser = deleteUser;
window.firebaseReady = true;

