import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAodOjvZb4KtsIQV4J0XcyZxGYLoAo2KuQ",
  authDomain: "utahsportshq.firebaseapp.com",
  projectId: "utahsportshq",
  storageBucket: "utahsportshq.firebasestorage.app",
  messagingSenderId: "543219279083",
  appId: "1:543219279083:web:6bc3c331e03149dc834aae",
  measurementId: "G-NCQYS5Z5SC",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

export { auth, db, googleProvider, signInWithPopup, signOut };
