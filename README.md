## QuickCode – local development

Active apps and directories:
- Frontend (Vite/React): `client/`
- Backend (Express): `server/`

### Frontend: run locally
1) Ensure the API is running (see server section below)
2) Create `client/.env.local` (one-time):
```
VITE_API_BASE=http://localhost:8787
# Optional: restrict sign-in domain in UI
# VITE_ALLOWED_DOMAIN=yourdomain.com
```
3) Start dev server:
```
npm run dev --prefix client
```

### Backend/API: run locally
1) Create `server/.env` (one-time):
```
SHEETS_SPREADSHEET_ID=<google-sheet-id>
SHEETS_LOG_TITLE=Credit Card - Log
# Optional: restrict sign-in domain on API
# ALLOWED_DOMAIN=yourdomain.com
```
2) Share your Google Sheet with the service account email in `server/credentials/service-account.json` (Editor)
3) Start API:
```
npm run start --prefix server
```

Sanity check the Sheets connection:
```
curl http://localhost:8787/sheets/test
```

### Notes
- Secrets are ignored by git via `.gitignore`:
  - `server/.env`, `server/credentials/service-account.json`, `client/.env.local`
- The legacy CRA root `src/`, `public/`, and `build/` have been removed; only `client/` is used for the frontend.
