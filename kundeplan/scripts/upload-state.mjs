// Upload a local JSON backup to your authenticated Firestore doc.
// Use this AFTER you've created the Firebase account in the prod app.
//
// 1. Save your dev backup as scripts/dev-state.json (see README / snippet below)
// 2. Run:
//      FB_EMAIL="you@atea.no" FB_PASSWORD='new-password' \
//        node scripts/upload-state.mjs
//
// The expected JSON shape is:
//   { "state": {...}, "versions": [...], "versionCount": <number> }
//
// Browser snippet to produce dev-state.json (run in the dev app's DevTools console):
//   const out = {
//     state: JSON.parse(localStorage.getItem('kundeplan-cartoon-atlas-v2') ?? 'null'),
//     versions: JSON.parse(localStorage.getItem('kundeplan-versions-v1') ?? 'null'),
//     versionCount: Number(localStorage.getItem('kundeplan-version-count-v1') ?? 0),
//   };
//   const a = document.createElement('a');
//   a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], {type:'application/json'}));
//   a.download = 'dev-state.json'; a.click();

import { readFile } from 'node:fs/promises';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';

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
const file = process.env.FILE ?? 'scripts/dev-state.json';

if (!email || !password) {
  console.error('Set FB_EMAIL and FB_PASSWORD environment variables.');
  process.exit(1);
}

function sanitizeKey(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

const userKey = process.env.TARGET_KEY ?? sanitizeKey(email.toLowerCase());

const raw = await readFile(new URL(file, import.meta.url.endsWith('/') ? import.meta.url : import.meta.url + '/..').pathname.replace('/..', ''), 'utf8').catch(async () => {
  // fallback: resolve relative to CWD
  return await readFile(file, 'utf8');
});
const parsed = JSON.parse(raw);

if (!parsed?.state) {
  console.error(`Backup file ${file} has no "state" field. Aborting.`);
  process.exit(2);
}

const payload = {
  state: parsed.state,
  versions: Array.isArray(parsed.versions) ? parsed.versions : [],
  versionCount: Number.isFinite(parsed.versionCount) ? parsed.versionCount : (Array.isArray(parsed.versions) ? parsed.versions.length : 0),
  uploadedFromBackup: true,
  uploadedAt: new Date().toISOString(),
  updatedAt: serverTimestamp(),
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

try {
  console.log(`Signing in as ${email}…`);
  await signInWithEmailAndPassword(auth, email, password);
  console.log(`Writing kundeplanStates/${userKey}`);
  await setDoc(doc(db, 'kundeplanStates', userKey), payload);
  console.log('Done. Reload both dev and prod — they should now show this data.');
  process.exit(0);
} catch (err) {
  console.error('Upload failed:', err?.code || '', err?.message || err);
  process.exit(3);
}
