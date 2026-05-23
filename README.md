# PROJECTS
PROJECTS

## Cloud Hosting (GitHub Pages)

Kundeplan is configured for automatic cloud deployment on every push to main.

- Workflow file: .github/workflows/deploy-kundeplan-pages.yml
- App source: kundeplan/
- Live URL (after first successful deploy): https://ernstmcarlsenatea.github.io/PROJECTS/

### One-time setup in GitHub

1. Open repository settings.
2. Go to Pages.
3. Under Build and deployment, set Source to GitHub Actions.
4. Push to main (or run the workflow manually from Actions tab).

## Cloud Data (Firebase Firestore)

Kundeplan now supports cloud persistence with Firebase Firestore and automatically migrates existing local data on first cloud-enabled run.

### Setup

1. In Firebase Console, open Project settings and create a Web app if needed.
2. Copy the Firebase web config values.
3. Create `kundeplan/.env` from `kundeplan/.env.example` and fill in all `VITE_FIREBASE_*` values.
4. Run the app (`npm run dev`) and open it once to trigger one-time local-to-cloud migration.

### Important

- Firebase Project ID is usually a text value (for example, `my-project-id`).
- The numeric value you shared (`519939507728`) is typically the project number, not the Project ID field used in web config.
- If Firebase config is missing, the app keeps using localStorage fallback.
