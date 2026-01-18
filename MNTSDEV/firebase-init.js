// Firebase setup
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, updatePassword, reauthenticateWithCredential, EmailAuthProvider, deleteUser, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  addDoc,
  onSnapshot,
  arrayUnion,
  arrayRemove,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  runTransaction,
  serverTimestamp,
  increment
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  listAll
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

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
const storage = getStorage(app);

// Expose globally
window.firebaseAuth = auth;
window.firebaseDb = db;
window.firebaseStorage = storage;

window.signOut = signOut;
window.onAuthStateChanged = onAuthStateChanged;
window.signInWithEmailAndPassword = signInWithEmailAndPassword;
window.createUserWithEmailAndPassword = createUserWithEmailAndPassword;
window.sendEmailVerification = sendEmailVerification;

window.getDoc = getDoc;
window.doc = doc;
window.setDoc = setDoc;
window.deleteDoc = deleteDoc;
window.addDoc = addDoc;
window.onSnapshot = onSnapshot;
window.arrayUnion = arrayUnion;
window.arrayRemove = arrayRemove;
window.updateDoc = updateDoc;

window.updatePassword = updatePassword;
window.reauthenticateWithCredential = reauthenticateWithCredential;
window.EmailAuthProvider = EmailAuthProvider;
window.deleteUser = deleteUser;
window.sendPasswordResetEmail = sendPasswordResetEmail;

window.collection = collection;
window.getDocs = getDocs;
window.query = query;
window.where = where;
window.orderBy = orderBy;
window.runTransaction = runTransaction;
window.serverTimestamp = serverTimestamp;
window.increment = increment;

// Storage helpers
window.storageRef = ref;
window.uploadBytes = uploadBytes;
window.getDownloadURL = getDownloadURL;
window.listAll = listAll;

window.firebaseReady = true;

