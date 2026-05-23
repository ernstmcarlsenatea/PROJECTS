import { useEffect } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { loginRequest } from './authConfig.js';

export function AuthGuard({ children }) {
  const { instance, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  useEffect(() => {
    if (!isAuthenticated && inProgress === InteractionStatus.None) {
      instance.loginRedirect(loginRequest).catch((error) => {
        console.error('MSAL loginRedirect failed:', error);
      });
    }
  }, [isAuthenticated, inProgress, instance]);

  if (!isAuthenticated) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p className="auth-label">ATEA AS · Kundeplan</p>
          <p className="auth-status">
            {inProgress !== InteractionStatus.None
              ? 'Signing in with ATEA Entra ID…'
              : 'Redirecting to Microsoft login…'}
          </p>
          <span className="auth-spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  return children;
}
