// client/src/auth/firebase.js
import { initializeApp } from 'firebase/app'
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
} from 'firebase/auth'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
const provider = new GoogleAuthProvider()

export const signIn = () => signInWithPopup(auth, provider)
export const logout = () => signOut(auth)
export const onAuth = (cb) => onAuthStateChanged(auth, cb)