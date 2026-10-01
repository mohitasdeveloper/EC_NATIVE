# tests

Zero-dependency Node tests for the admin panel. Run from the repo root:

```bash
npm test          # both files
node tests/admin-panel.test.mjs
node tests/rpc-contract.test.mjs
```

Needs Node 18+ (CI already uses 24). Nothing to install.

## What they cover

**`admin-panel.test.mjs`** loads the real `www/admin.js` against a tiny fake DOM and
canned RPC responses, then drives every tab and checks:

- what renders (tabs, stats, lists, detail screens; no Colleges tab)
- that each button fires the right RPC with the exact parameters
- that user-supplied text (names, post content) is HTML-escaped
- that the shared `#modal-confirm-action` is restored afterwards (red "Delete"), so
  other parts of the app's confirm dialogs aren't affected — plus danger (red) vs
  safe (green) styling
- that you can't suspend/delete yourself from the UI, and the back handler unwinds
  detail → list before closing the panel
- that a failing request shows an error instead of hanging on the loading skeleton

It prints one stack trace to stderr on purpose (the failure-path test).

**`rpc-contract.test.mjs`** reads `admin.js` and `supabase/admin_panel.sql` and fails if they
disagree: an RPC the JS calls that the SQL doesn't define, a parameter name that
doesn't match, a field the UI reads that the RPC doesn't return, or an `admin_*`
function missing its `_require_admin()` check or `GRANT`.

## What they do NOT cover

- **The SQL itself running.** There is no Postgres here. Run `supabase/admin_panel.sql`
  once in the Supabase SQL editor; see the first-run checklist in
  `docs/PROJECT_STRUCTURE.md`.
- **Real rendering.** Layout, dark mode, safe-area padding and icons on a device.
- **Row-level security / grants on your live database** and the existing triggers'
  behaviour (verification approval → notification, etc.).
- **Suspension at login.** `auth.js` / `main.js` changes were syntax-checked only.

## Added in 2.8
- **`screen-privacy.test.mjs`** loads the real `www/screen-privacy.js` against a fake native bridge, fake
  `localStorage` and a fake Supabase client: cached setting blocks at launch, the PDF viewer closing can't
  switch the app-wide block off, server on/off, failed checks keep the last state, Realtime + foreground
  re-checks, and that main.js / the login screen / the PDF viewer / the service worker are wired to it.
- `admin-panel.test.mjs` also drives the tick colour ring (pointer angle -> hue -> `#RRGGBB`), the reset-password
  flow (validation, confirm, RPC params, hidden for admins) and the Full Privacy switch.
- `rpc-contract.test.mjs` also checks the new SQL: password reset refuses admins, stores a bcrypt hash, signs the
  user out and audits; `app_settings` is read-only to clients; tick colours must be `#RRGGBB`.

