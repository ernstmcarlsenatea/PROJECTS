import { getApp, getApps, initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: (import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyDorw7eeJtpJcqSr3crBIFiiq8OEqj56FA').trim(),
  authDomain: (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'kundeplan.firebaseapp.com').trim(),
  projectId: (import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'kundeplan').trim(),
  appId: (import.meta.env.VITE_FIREBASE_APP_ID ?? '1:519939507728:web:5be17b1b2c391294742c95').trim(),
  storageBucket: (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'kundeplan.firebasestorage.app').trim(),
  messagingSenderId: (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '519939507728').trim(),
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

function isMissingDefaultDatabaseError(error) {
  const message = String(error?.message ?? '');
  return error?.code === 'not-found' || message.includes("Database '(default)' not found");
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
  let cloudAvailable = true;

  return {
    enabled: true,
    userKey,
    reason: null,
    async loadSnapshot() {
      if (!cloudAvailable) {
        return null;
      }

      try {
        const snapshot = await getDoc(stateRef);
        if (!snapshot.exists()) {
          return null;
        }
        return snapshot.data();
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) {
          cloudAvailable = false;
          return null;
        }

        throw error;
      }
    },
    async saveSnapshot(payload) {
      if (!cloudAvailable) {
        return;
      }

      try {
        await setDoc(
          stateRef,
          {
            ...payload,
            userKey,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (error) {
        if (isMissingDefaultDatabaseError(error)) {
          cloudAvailable = false;
          return;
        }

        throw error;
      }
    },
  };
}
