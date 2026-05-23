// ---------------------------------------------------------------------------
// ATEA AS Entra ID (Azure AD) MSAL configuration
//
// Required setup (one-time, ~2 min):
//  1. Go to https://portal.azure.com → Microsoft Entra ID → App registrations
//  2. Click "New registration"
//     - Name: Kundeplan
//     - Supported account types: "Accounts in this organizational directory only (ATEA AS)"
//     - Redirect URI: Single-page application (SPA) → http://localhost:5173
//       (add your production URL here too once deployed)
//  3. After creation, copy the "Application (client) ID" value
//  4. Paste it into the .env file as VITE_ENTRA_CLIENT_ID=<your-client-id>
// ---------------------------------------------------------------------------

export const msalConfig = {
  auth: {
    clientId: import.meta.env.VITE_ENTRA_CLIENT_ID ?? '',
    authority: 'https://login.microsoftonline.com/65f51067-7d65-4aa9-b996-4cc43a0d7111',
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
};

export const loginRequest = {
  scopes: ['openid', 'profile', 'email'],
};
