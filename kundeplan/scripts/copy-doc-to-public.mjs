// One-shot helper: copy your authenticated Firestore doc to the 'public' doc.
//
// Usage (from /workspaces/PROJECTS/kundeplan):
//   FB_EMAIL="ernst.magne.carlsen@atea.no" FB_PASSWORD="your-password" \
//     node scripts/copy-doc-to-public.mjs
//
// Optional overrides:
//   SOURCE_KEY="custom_user_key"   (default: sanitized lowercase email)
//   TARGET_KEY="public"            (default: public)
//   DRY_RUN=1                      (preview only, no write)

import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyDorw7eeJtpJcqSr3crBIFiiq8OEqj56FA',
  authDomain: 'kundeplan.firebaseapp.com',
  projectId: 'kundeplan',
  appId: '1:519939507728:web:5be17b1b2c391294742c95',
  storageBucket: 'kundeplan.firebasestorage.app',
  messagingSenderId: '519939507728',
};

const email = process.env.FB_EMAIL;
const password = process.env.FB_PASSWORD;

if (!email || !password) {
  console.error('Set FB_EMAIL and FB_PASSWORD environment variables.');
  process.exit(1);
}

function sanitizeKey(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

const sourceKey = process.env.SOURCE_KEY ?? sanitizeKey(email.toLowerCase());
const targetKey = process.env.TARGET_KEY ?? 'public';
const dryRun = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN ?? '').toLowerCase());

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

try {
  console.log(`Signing in as ${email}…`);
  await signInWithEmailAndPassword(auth, email, password);
  console.log('Signed in.');

  const sourceRef = doc(db, 'kundeplanStates', sourceKey);
  const targetRef = doc(db, 'kundeplanStates', targetKey);

  console.log(`Reading source doc: kundeplanStates/${sourceKey}`);
  const snap = await getDoc(sourceRef);
  if (!snap.exists()) {
    console.error(`Source doc kundeplanStates/${sourceKey} does not exist.`);
    process.exit(2);
  }

  const data = snap.data();
  const summary = {
    hasState: Boolean(data?.state),
    versionCount: data?.versionCount ?? (Array.isArray(data?.versions) ? data.versions.length : null),
    keys: Object.keys(data ?? {}),
    updatedAt: data?.updatedAt?.toDate?.()?.toISOString?.() ?? null,
  };
  console.log('Source summary:', summary);

  if (dryRun) {
    console.log('DRY_RUN set — not writing. Exiting.');
    process.exit(0);
  }

  console.log(`Writing to target doc: kundeplanStates/${targetKey}`);
  await setDoc(targetRef, { ...data, copiedFrom: sourceKey, copiedAt: new Date().toISOString() });
  console.log('Done. Reload the prod site to see updated data.');
  process.exit(0);
} catch (err) {
  console.error('Copy failed:', err?.code || '', err?.message || err);
  process.exit(3);
}
