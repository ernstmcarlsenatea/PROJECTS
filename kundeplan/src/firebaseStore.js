import { getApp, getApps, initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';

export const firebaseConfig = {
  apiKey: (import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyDorw7eeJtpJcqSr3crBIFiiq8OEqj56FA').trim(),
  authDomain: (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'kundeplan.firebaseapp.com').trim(),
  projectId: (import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'kundeplan').trim(),
  appId: (import.meta.env.VITE_FIREBASE_APP_ID ?? '1:519939507728:web:5be17b1b2c391294742c95').trim(),
  storageBucket: (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'kundeplan.firebasestorage.app').trim(),
  messagingSenderId: (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '519939507728').trim(),
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

function isConfigured() {
  return REQUIRED_KEYS.every((key) => Boolean(firebaseConfig[key]));
}

function getDb() {
  if (!isConfigured()) {
    return null;
  }

  return getFirestore(firebaseApp);
}

function sanitizeKey(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

// Shared document key: every signed-in user reads from and writes to the same
// Firestore document so that the latest content is always visible to everyone,
// including first-time users. The `auth` argument is intentionally ignored.
const SHARED_DOC_KEY = 'shared';

// eslint-disable-next-line no-unused-vars
function getUserKey(auth) {
  return SHARED_DOC_KEY;
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
      subscribeSnapshot() {
        return () => {};
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
    subscribeSnapshot(onChange, onError) {
      if (!cloudAvailable) {
        return () => {};
      }

      return onSnapshot(
        stateRef,
        { includeMetadataChanges: false },
        (snapshot) => {
          if (!snapshot.exists()) {
            onChange(null, { fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites });
            return;
          }
          onChange(snapshot.data(), {
            fromCache: snapshot.metadata.fromCache,
            hasPendingWrites: snapshot.metadata.hasPendingWrites,
          });
        },
        (error) => {
          if (isMissingDefaultDatabaseError(error)) {
            cloudAvailable = false;
            return;
          }
          if (typeof onError === 'function') {
            onError(error);
          } else {
            console.error('Cloud snapshot subscription failed:', error);
          }
        },
      );
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
