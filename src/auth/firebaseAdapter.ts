import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onIdTokenChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { type AuthAdapter, FirebaseConfigError } from "./authTypes";

const requiredValue = (raw: string | undefined, name: string): string => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed.startsWith("REPLACE_WITH_")) {
    throw new FirebaseConfigError(`${name} is not configured.`);
  }
  return trimmed;
};

const readConfig = () => ({
  apiKey: requiredValue(import.meta.env.VITE_FIREBASE_API_KEY, "VITE_FIREBASE_API_KEY"),
  authDomain: requiredValue(
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    "VITE_FIREBASE_AUTH_DOMAIN",
  ),
  projectId: requiredValue(
    import.meta.env.VITE_FIREBASE_PROJECT_ID,
    "VITE_FIREBASE_PROJECT_ID",
  ),
  appId: requiredValue(import.meta.env.VITE_FIREBASE_APP_ID, "VITE_FIREBASE_APP_ID"),
});

/** The only module that imports the Firebase SDK. Never imported by any test. */
export const createFirebaseAdapter = (): AuthAdapter => {
  const config = readConfig();
  // Safe under React StrictMode's double-mounting.
  const app = getApps().length ? getApp() : initializeApp(config);
  const auth = getAuth(app);
  void setPersistence(auth, browserLocalPersistence);
  const provider = new GoogleAuthProvider();
  // Why one "Sign out" control satisfies "sign-out/change-account": signing out
  // and back in always offers the account chooser.
  provider.setCustomParameters({ prompt: "select_account" });

  return {
    subscribe: (listener) =>
      onIdTokenChanged(auth, (user) => {
        listener(user ? { uid: user.uid, email: user.email } : null);
      }),
    signIn: async () => {
      await signInWithPopup(auth, provider);
    },
    signOut: async () => {
      await signOut(auth);
    },
    getToken: async (forceRefresh) =>
      (await auth.currentUser?.getIdToken(forceRefresh)) ?? null,
  };
};
