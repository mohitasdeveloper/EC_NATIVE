# 2.3 changes

## In-app Admin Panel
- New `www/admin.js` (dynamically imported, admin-only) + `#settings-admin-panel` shell in `www/index.html` +
  `setupAdminEntryPoint` / `openAdminPanel` / back-button hook in `www/main.js`. Entry: Settings → Admin Panel,
  shown only when `users.is_admin`.
- Tabs: Overview, Verify (approve/reject student IDs; no "Approved" list because approval deletes the verification row), Reports (delete/protect post, suspend user, dismiss/resolve),
  Tickets (reply + status), Users (search; account type, verification status, tick colour, poll/event permission,
  volunteer, admin, suspend, soft-delete), App Config (forced-update version code + message).
- `supabase/admin_panel.sql` (run once): `users.is_admin`, `users.is_suspended`, guard trigger, and the `admin_*`
  SECURITY DEFINER functions. Each checks `_require_admin()` server-side.

## Suspension (new, separate from deactivation)
- `is_deactivated` is a self-service pause that users can undo from the login screen, so it can't ban anyone.
  Admin bans use the new `users.is_suspended`, enforced in `www/auth/auth.js` (login) and `www/main.js` (boot).

## Hardening
- `guard_is_admin_column` trigger: non-admins can no longer change `is_admin`, `is_suspended`, `role`, `tick_type`,
  `special_post` or `is_volunteer` on their own row.

## Fixes found while testing
- Shared `#modal-confirm-action`: the admin panel restores its label/colour on every close so other confirms keep
  their red "Delete" button.
- A failed request now shows an error card instead of leaving the loading skeleton up forever (both tab loads and user search).

## Housekeeping
- `www/fonts/icons-used.txt`: added the admin panel's icons so a future `get-fonts.py --subset` keeps them.
- `ARCHITECTURE.md`: corrected the stale "Tailwind via play-CDN" claim; added Admin Panel section.
- New `docs/PROJECT_STRUCTURE.md`, `tests/`, and `npm test`.

## Version
- Not bumped by this change (`package.json` still 2.2.0; the workflow's versionName is untouched). versionCode is still
  GitHub run number + 100. After releasing, raise Min Version Code in the admin panel's App Config tab.
