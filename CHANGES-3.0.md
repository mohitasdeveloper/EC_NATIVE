# 3.0 changes — no Realtime, fewer requests (smaller Supabase logs), hide/show the BAFs App

## Version
- **versionName is now 3.0** (set in `.github/workflows/android-build.yml`; it was 2.1 — the 2.2 … 2.10 changelogs never
  changed it), and `package.json` is **3.0.0** (it had been left at 2.2.0).
- **versionCode is unchanged** — still GitHub run number + 100. It only ever goes up and is what the forced-update gate
  compares, so a new versionName does not reset it. When you raise `min_version_code` for this release, use this build's
  **versionCode** (run number + 100), not "3.0".

## Minimum Android version
- **minSdkVersion is now 24 (Android 7.0)**, was 23. Google Play's automatic protection requires 24 or higher and
  rejected the first 3.0 upload. The CI workflow sets it in `android/variables.gradle` and `android/app/build.gradle`
  and **fails the build** if it ends up anything else. Phones on Android 6.0 can't install 3.0 and stay on their current
  version (so don't count on the forced-update screen for them).

Goal: stay far away from the Supabase Free-plan limits (Realtime connections, log ingestion) by
doing less in the background. Nothing visible was removed except the live "New posts" pill.

## What changed
- **Realtime is gone.** The app no longer opens any Realtime WebSocket.
  - `feed.js`: removed `setupRealtimeFeed()` and the floating **New posts** pill it showed. New posts now
    appear on launch, on pull-to-refresh, and after the "Back online" soft refresh.
  - `screen-privacy.js`: removed the Realtime subscription. Full Privacy is still applied from the cached
    value at launch and re-checked on boot and whenever the app returns to the foreground — now **at most
    once a minute** (was 10 s). `initScreenPrivacy()` takes no options any more.
- **Database:** new `supabase/disable_realtime.sql` removes every table from the `supabase_realtime`
  publication (run it once). `admin_panel.sql` no longer adds `app_settings` to it, and takes it out if an
  older run had put it there.
- **Analytics sends less often** (same data, bigger batches):
  - Insights events: batch every **20 s** (was 4 s).
  - Study time: send after **120 s** of reading (was 30 s); still sent on viewer close, when the app is
    backgrounded and at the next launch.
- Service worker cache bumped to **v22** so devices drop the old shell.

## Admin: hide / show the BAFs App
- **Admin → App Config → Show BAFs App** (new switch under Full Privacy). Switch it off and the BAFs App circle disappears
  from Home for every user and the app can't be opened (also closes it if someone has it open). Nothing is deleted;
  switch it on to bring it back.
- Stored as `app_settings.bafs_app_hidden` (hidden = true). It stores the opposite of "visible" on purpose: no row, or a
  failed check, means **visible** — the app can never hide BAFs by accident.
- Picked up on launch and when the app returns to the foreground (at most once a minute). The last known value is
  cached on the device, so it also applies offline. Builds older than 3.0 don't know the setting and keep showing it.
- New `www/app-settings.js` reads **all** `app_settings` rows in one request and is shared by Full Privacy and this
  switch, so adding the switch costs no extra request. If the BAFs App is hidden and there are no Page apps, the empty
  tray strip is hidden too.
- `admin_panel.sql` (re-run it): `admin_set_app_setting` now accepts `bafs_app_hidden`, and the row is seeded (visible).

## Tests
- New `tests/no-realtime.test.mjs` fails if any `www/` file opens a channel / listens to `postgres_changes`, or
  if any SQL adds a table to the Realtime publication.
- `screen-privacy.test.mjs` and `study-time-tracker.test.mjs` updated for the new thresholds.

## Rolling it out
1. Run `supabase/disable_realtime.sql` in the Supabase SQL editor, and re-run `supabase/admin_panel.sql` (it is safe to
   re-run) so the BAFs switch can be saved.
2. Build and publish the new app version, then raise `min_version_code` (see `version-gate.js`) so that older
   builds — which still open Realtime connections — are forced to update.
