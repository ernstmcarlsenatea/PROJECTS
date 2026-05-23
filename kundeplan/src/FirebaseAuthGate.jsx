import { useEffect, useMemo, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { firebaseApp } from './firebaseStore.js';

function getAllowedDomain() {
  const raw = (import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN ?? '').trim().toLowerCase();
  return raw.length > 0 ? raw : null;
}

function isEmailAllowed(email) {
  const allowedDomain = getAllowedDomain();
  if (!allowedDomain) return true;
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${allowedDomain}`);
}

function describeFirebaseError(err) {
  const code = err?.code ?? '';
  switch (code) {
    case 'auth/invalid-email':
      return 'That email address is not valid.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    case 'auth/user-not-found':
      return 'No account found for that email. Use “Create account” first.';
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Wrong email or password.';
    case 'auth/email-already-in-use':
      return 'An account already exists for that email. Use “Sign in” instead.';
    case 'auth/weak-password':
      return 'Password is too weak. Use at least 8 characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    default:
      return err?.message ?? 'Authentication failed.';
  }
}

export function FirebaseAuthGate({ children }) {
  const auth = useMemo(() => getAuth(firebaseApp), []);
  const [user, setUser] = useState(() => auth.currentUser);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const allowedDomain = getAllowedDomain();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      if (nextUser && !isEmailAllowed(nextUser.email)) {
        firebaseSignOut(auth).catch(() => {});
        setUser(null);
        setError(`Only ${allowedDomain ? `@${allowedDomain}` : 'allowed'} accounts can sign in.`);
        setReady(true);
        return;
      }
      setUser(nextUser);
      setReady(true);
    });
    return unsubscribe;
  }, [auth, allowedDomain]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setInfo(null);

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setError('Enter your email address.');
      return;
    }
    if (!isEmailAllowed(trimmedEmail)) {
      setError(`Only ${allowedDomain ? `@${allowedDomain}` : 'allowed'} accounts can sign in.`);
      return;
    }

    if (mode === 'reset') {
      setStatus('working');
      try {
        await sendPasswordResetEmail(auth, trimmedEmail);
        setInfo(
          'If an account exists for that email, a password reset link has been sent. ' +
          'Check spam too. If nothing arrives, no password account exists yet — use “Create account”.',
        );
        setMode('sign-in');
      } catch (err) {
        console.error('sendPasswordResetEmail failed:', err);
        setError(describeFirebaseError(err));
      } finally {
        setStatus('idle');
      }
      return;
    }

    if (!password || password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setStatus('working');
    try {
      if (mode === 'create') {
        await createUserWithEmailAndPassword(auth, trimmedEmail, password);
      } else {
        await signInWithEmailAndPassword(auth, trimmedEmail, password);
      }
      setPassword('');
    } catch (err) {
      console.error('Auth failed:', err);
      setError(describeFirebaseError(err));
    } finally {
      setStatus('idle');
    }
  }

  if (!ready) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p className="auth-label">Kundeplan</p>
          <p className="auth-status">Checking session…</p>
          <span className="auth-spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!user) {
    const showPassword = mode !== 'reset';
    const submitLabel = {
      'sign-in': status === 'working' ? 'Signing in…' : 'Sign in',
      create: status === 'working' ? 'Creating account…' : 'Create account',
      reset: status === 'working' ? 'Sending…' : 'Send reset email',
    }[mode];

    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p className="auth-label">Kundeplan</p>
          <h1 className="auth-title">
            {mode === 'create' ? 'Create account' : mode === 'reset' ? 'Reset password' : 'Sign in'}
          </h1>
          <p className="auth-status">
            {allowedDomain
              ? `Use your @${allowedDomain} email address.`
              : 'Enter your email and password.'}
          </p>
          <form onSubmit={handleSubmit} className="auth-form">
            <label className="auth-field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={allowedDomain ? `you@${allowedDomain}` : 'you@example.com'}
                autoComplete="email"
                required
              />
            </label>
            {showPassword ? (
              <label className="auth-field">
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                  minLength={8}
                  required
                />
              </label>
            ) : null}
            <button type="submit" className="primary-button" disabled={status === 'working'}>
              {submitLabel}
            </button>
          </form>

          <div className="auth-links">
            {mode !== 'sign-in' ? (
              <button
                type="button"
                className="link-button"
                onClick={() => { setMode('sign-in'); setError(null); setInfo(null); }}
              >
                Back to sign in
              </button>
            ) : null}
            {mode !== 'create' ? (
              <button
                type="button"
                className="link-button"
                onClick={() => { setMode('create'); setError(null); setInfo(null); }}
              >
                Create account
              </button>
            ) : null}
            {mode !== 'reset' ? (
              <button
                type="button"
                className="link-button"
                onClick={() => { setMode('reset'); setError(null); setInfo(null); }}
              >
                Forgot password?
              </button>
            ) : null}
          </div>

          {info ? <p className="auth-status auth-success">{info}</p> : null}
          {error ? <p className="auth-status auth-error">{error}</p> : null}
        </div>
      </div>
    );
  }

  return children({
    user,
    signOut: () => firebaseSignOut(auth),
  });
}
