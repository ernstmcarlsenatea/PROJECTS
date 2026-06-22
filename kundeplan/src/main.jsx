import React from 'react';
import ReactDOM from 'react-dom/client';
import { PublicClientApplication } from '@azure/msal-browser';
import { MsalProvider, useMsal } from '@azure/msal-react';
import App from './App.jsx';
import { AuthGuard } from './AuthGuard.jsx';
import { FirebaseAuthGate } from './FirebaseAuthGate.jsx';
import { msalConfig } from './authConfig.js';
import { FEATURE_FLAGS } from './featureFlags.js';
import '../styles.css';

// Phase 6 — register the PWA service worker in production builds when the
// offline flag is on. If the flag is off but a worker is already registered
// from a previous build, unregister it so the user is not stuck on a stale
// shell. SW is intentionally not registered in dev to avoid the usual HMR
// vs SW caching footguns.
if ('serviceWorker' in navigator) {
  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  if (FEATURE_FLAGS.offline && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(swUrl).catch(() => {});
    });
  } else {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => {
        if (reg.active && reg.active.scriptURL.endsWith('/sw.js')) reg.unregister();
      });
    }).catch(() => {});
  }
}

function AuthenticatedAppShell() {
  const { instance, accounts } = useMsal();
  const activeAccount = accounts[0] ?? null;

  return (
    <App
      auth={{
        enabled: true,
        activeAccount,
        signOut: () => instance.logoutRedirect(),
      }}
    />
  );
}

const publicAccessValue = (import.meta.env.VITE_PUBLIC_ACCESS ?? 'true').trim().toLowerCase();
const isPublicAccessEnabled = ['1', 'true', 'yes', 'on'].includes(publicAccessValue);
const configuredClientId = (import.meta.env.VITE_ENTRA_CLIENT_ID ?? '').trim();
const isAuthConfigured = configuredClientId.length > 0 && configuredClientId !== 'your-client-id-here';
const authProvider = (import.meta.env.VITE_AUTH_PROVIDER ?? '').trim().toLowerCase();
const rootElement = document.getElementById('root');

if (authProvider === 'firebase') {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <FirebaseAuthGate>
        {({ user, signOut }) => (
          <App
            auth={{
              enabled: true,
              activeAccount: {
                username: user.email ?? user.uid,
                name: user.displayName ?? user.email ?? user.uid,
                homeAccountId: user.uid,
              },
              signOut,
            }}
          />
        )}
      </FirebaseAuthGate>
    </React.StrictMode>,
  );
} else if (isPublicAccessEnabled || !isAuthConfigured) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App auth={{ enabled: false, activeAccount: null, signOut: null, publicAccess: true }} />
    </React.StrictMode>,
  );
} else {
  const msalInstance = new PublicClientApplication(msalConfig);
  msalInstance.initialize().then(() => {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <MsalProvider instance={msalInstance}>
          <AuthGuard>
            <AuthenticatedAppShell />
          </AuthGuard>
        </MsalProvider>
      </React.StrictMode>,
    );
  });
}