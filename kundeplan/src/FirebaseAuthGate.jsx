import { useEffect, useMemo, useState } from 'react';
import {
  getAuth,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { firebaseApp } from './firebaseStore.js';

const EMAIL_STORAGE_KEY = 'kundeplan-firebase-signin-email';

function getAllowedDomain() {
  const raw = (import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN ?? '').trim().toLowerCase();
  return raw.length > 0 ? raw : null;
}

function isEmailAllowed(email) {
  const allowedDomain = getAllowedDomain();
  if (!allowedDomain) {
    return true;
  }
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${allowedDomain}`);
}

function buildActionCodeSettings() {
  return {
    url: window.location.origin + window.location.pathname,
    handleCodeInApp: true,
  };
}

export function FirebaseAuthGate({ children }) {
  const auth = useMemo(() => getAuth(firebaseApp), []);
  const [user, setUser] = useState(() => auth.currentUser);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
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

  useEffect(() => {
    if (!isSignInWithEmailLink(auth, window.location.href)) {
      return;
    }

    let storedEmail = window.localStorage.getItem(EMAIL_STORAGE_KEY);
    if (!storedEmail) {
      storedEmail = window.prompt('Please confirm the email you used to sign in:') ?? '';
    }

    if (!storedEmail) {
      setError('Sign-in cancelled. Please request a new link.');
      return;
    }

    setStatus('completing');
    signInWithEmailLink(auth, storedEmail, window.location.href)
      .then(() => {
        window.localStorage.removeItem(EMAIL_STORAGE_KEY);
        window.history.replaceState({}, document.title, window.location.pathname);
        setStatus('idle');
      })
      .catch((err) => {
        console.error('Email link sign-in failed:', err);
        setError(err?.message ?? 'Sign-in failed. Please request a new link.');
        setStatus('idle');
      });
  }, [auth]);

  async function handleSendLink(event) {
    event.preventDefault();
    setError(null);

    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setError('Enter your email address.');
      return;
    }
    if (!isEmailAllowed(trimmed)) {
      setError(`Only ${allowedDomain ? `@${allowedDomain}` : 'allowed'} accounts can sign in.`);
      return;
    }

    setStatus('sending');
    try {
      await sendSignInLinkToEmail(auth, trimmed, buildActionCodeSettings());
      window.localStorage.setItem(EMAIL_STORAGE_KEY, trimmed);
      setStatus('sent');
    } catch (err) {
      console.error('sendSignInLinkToEmail failed:', err);
      setError(err?.message ?? 'Could not send sign-in link.');
      setStatus('idle');
    }
  }

  if (!ready || status === 'completing') {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p className="auth-label">Kundeplan</p>
          <p className="auth-status">
            {status === 'completing' ? 'Completing sign-in…' : 'Checking session…'}
          </p>
          <span className="auth-spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p className="auth-label">Kundeplan</p>
          <h1 className="auth-title">Sign in</h1>
          <p className="auth-status">
            {allowedDomain
              ? `Use your @${allowedDomain} email. We will send you a one-time sign-in link.`
              : 'Enter your email. We will send you a one-time sign-in link.'}
          </p>
          <form onSubmit={handleSendLink} className="auth-form">
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
            <button
              type="submit"
              className="primary-button"
              disabled={status === 'sending'}
            >
              {status === 'sending' ? 'Sending…' : 'Send sign-in link'}
            </button>
          </form>
          {status === 'sent' ? (
            <p className="auth-status auth-success">
              Sign-in link sent. Open it on this device to continue.
            </p>
          ) : null}
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
