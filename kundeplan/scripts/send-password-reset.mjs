// Send Firebase password-reset email.
// Usage:  FB_EMAIL="you@example.com" node scripts/send-password-reset.mjs

import { initializeApp } from 'firebase/app';
import { getAuth, sendPasswordResetEmail } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyDorw7eeJtpJcqSr3crBIFiiq8OEqj56FA',
  authDomain: 'kundeplan.firebaseapp.com',
  projectId: 'kundeplan',
  appId: '1:519939507728:web:5be17b1b2c391294742c95',
  storageBucket: 'kundeplan.firebasestorage.app',
  messagingSenderId: '519939507728',
};

const email = process.env.FB_EMAIL;
if (!email) {
  console.error('Set FB_EMAIL env var.');
  process.exit(1);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

try {
  await sendPasswordResetEmail(auth, email);
  console.log(`Reset email request sent for ${email}.`);
  console.log('If an account exists, a reset link will arrive (check spam).');
  console.log('If nothing arrives within a few minutes, the account does not exist yet — create one via the dev app sign-in screen.');
  process.exit(0);
} catch (err) {
  console.error('Failed:', err?.code || '', err?.message || err);
  process.exit(2);
}
