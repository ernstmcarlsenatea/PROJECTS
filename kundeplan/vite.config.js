import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/PROJECTS/' : '/',
  plugins: [react()],
  build: {
    // Split heavy third-party deps into their own long-cached chunks so the
    // main app bundle stays small. Hashed filenames mean a Firebase SDK
    // bump only invalidates the firebase chunk, not the whole app.
    rollupOptions: {
      output: {
        manualChunks: {
          firebase: [
            'firebase/app',
            'firebase/auth',
            'firebase/firestore',
          ],
          msal: [
            '@azure/msal-browser',
            '@azure/msal-react',
          ],
          react: [
            'react',
            'react-dom',
            'react-dom/client',
          ],
        },
      },
    },
  },
});