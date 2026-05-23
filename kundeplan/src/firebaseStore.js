import { getApp, getApps, initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: (import.meta.env.VITE_FIREBASE_API_KEY ?? '').trim(),
  authDomain: (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '').trim(),
  projectId: (import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '').trim(),
  appId: (import.meta.env.VITE_FIREBASE_APP_ID ?? '').trim(),
  storageBucket: (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '').trim(),
  messagingSenderId: (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '').trim(),
};

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

function isConfigured() {
  return REQUIRED_KEYS.every((key) => Boolean(firebaseConfig[key]));
}

function getDb() {
  if (!isConfigured()) {
    return null;
  }

  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return getFirestore(app);
}

function sanitizeKey(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function getUserKey(auth) {
  const principal = auth?.activeAccount?.username ?? auth?.activeAccount?.homeAccountId ?? null;
  if (!principal) {
    return 'public';
  }
  return sanitizeKey(principal.toLowerCase());
}

export function createCloudStore(auth) {
  const db = getDb();
  const userKey = getUserKey(auth);

  if (!db) {
    return {
      enabled: false,
      userKey,
      reason: 'missing_config',
      async loadSnapshot() {
        return null;
      },
      async saveSnapshot() {
        return null;
      },
    };
  }

  const stateRef = doc(db, 'kundeplanStates', userKey);

  return {
    enabled: true,
    userKey,
    reason: null,
    async loadSnapshot() {
      const snapshot = await getDoc(stateRef);
      if (!snapshot.exists()) {
        return null;
      }
      return snapshot.data();
    },
    async saveSnapshot(payload) {
      await setDoc(
        stateRef,
        {
          ...payload,
          userKey,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    },
  };
}
