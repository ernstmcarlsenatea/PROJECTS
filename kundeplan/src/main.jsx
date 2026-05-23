import React from 'react';
import ReactDOM from 'react-dom/client';
import { PublicClientApplication } from '@azure/msal-browser';
import { MsalProvider, useMsal } from '@azure/msal-react';
import App from './App.jsx';
import { AuthGuard } from './AuthGuard.jsx';
import { msalConfig } from './authConfig.js';
import '../styles.css';

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

if (isPublicAccessEnabled || !isAuthConfigured) {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App auth={{ enabled: false, activeAccount: null, signOut: null, publicAccess: true }} />
    </React.StrictMode>,
  );
} else {
  const msalInstance = new PublicClientApplication(msalConfig);
  msalInstance.initialize().then(() => {
    ReactDOM.createRoot(document.getElementById('root')).render(
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