# 2.1 changes

## Play Console: DEX code optimization (Obfuscation 2%)
- `.github/workflows/android-build.yml`: new step "Enable R8" turns on `minifyEnabled true` + `shrinkResources true`
  (release), switches to `proguard-android-optimize.txt`, writes `proguard-rules.pro` (keeps for
  @JavascriptInterface bridges, Capacitor plugins, @capgo/inappbrowser, MainActivity) and `res/raw/keep.xml`
  (keeps drawables/mipmaps looked up by name, e.g. the splash).
- R8 mapping.txt is uploaded as an artifact; the .aab already carries it for Play Console.

## Play Console: edge-to-edge recommendations
- Removed `@capacitor/status-bar` (its window colour APIs are what Play flags as deprecated).
- Status-bar strip colour is already drawn by `.status-bar-guard`; icon colour now via built-in `SystemBars.setStyle()`
  (`www/main.js`, `www/auth/auth.js`).

## Internal links
- `@capacitor/browser` (Chrome Custom Tabs = Chrome UI + URL) replaced by `@capgo/inappbrowser` native WebView.
- `openServiceLink(url, openInApp, title, opts)`: open-in-app links use the native WebView; fallback is the in-page
  iframe viewer, never Chrome. External (open_in_app = false) links still go to the system browser.
- Help / Privacy / Terms in Settings now go through the same router (`{ plain: true }` = no student_id/name params).

## Version
- versionName 2.1 (versionCode still = GitHub run number).

## Offline start-up (app didn't open without internet)
- Cause 1: supabase-js (plus Quill, html2canvas, Font Awesome) loaded from CDNs. Offline, `window.supabase` was
  undefined, `supabase.js` threw, and since `main.js` imports it the whole app never started.
  -> Now copied from npm into `www/vendor/` by `scripts/vendor.js` (part of `npm run build`, which CI already runs).
- Cause 2: after ~1 h the access token is expired; offline it can't refresh, `getSession()` returned no session
  and the app redirected to the login page. -> `main.js` now falls back to the stored session + cached profile
  when offline (supabase-js refreshes the token itself once online).
- Service worker: cache v6, precaches the vendor files and the JS modules that were missing from the list.
- NOTE: any web host that serves `www/` must run `npm install && npm run build` (as it already must for tailwind.css).

## Sign-up goes straight into the app
- `www/auth/auth.js`: after "Create Account" the user is signed in and sent to `index.html` — no second login.
  If Supabase still returns no session (email confirmation ON), it signs in with the password just chosen; only if that
  fails does it fall back to the old "confirm your email" message.
- Waits (max ~2 s) for the `users` row created by the DB trigger, and clears any previous user's cached profile.
- To make this seamless in Supabase: Authentication -> Providers -> Email -> turn OFF "Confirm email".

## BAFs App: verified-only + Paper Pattern images
- `www/bafs-study-planner.html`: whole app renders blurred behind a "Verified students only / Verify to unlock" card
  unless `verification_status === 'verified'` (pending / rejected get their own wording). Button opens the app's
  verification screen; the gate lifts by itself once the profile refreshes to `verified`.
  PDFs and Paper Pattern also refuse to open while locked.
- Paper Pattern rows now open their image (from `page_services_rows.csv`, "Paper Pattern for SEM V") inside the app
  via `openServiceLink(url, true, title, { plain: true })`. Matched by paper name / short name; edit `PP_ALIASES`
  in the file if a name doesn't line up.
- `www/main.js`: `window.getVerificationStatus()`; `www/verification.js`: refreshes profile after submitting.
- Service worker cache bumped to v7.

## ID verification: prefilled details + live camera capture
- `www/verification.js`: Full Name, Student ID and Course are now prefilled from the user's profile
  (`full_name`, `student_id`, `course`) instead of being cleared. They stay editable; a field is only refilled
  from a later profile refresh while it is still untouched (hook in `populateProfileUI` -> `window.prefillVerificationForm`).
- ID card photo can now come from **Use Camera** (in-app live capture: frame guide, switch camera, review with Retake / Use Photo)
  or **Upload** (gallery / files). If `getUserMedia` is unavailable or fails for a non-permission reason, it falls back to the
  phone's camera app via `<input capture="environment">`.
- Captured photos are never mirrored, are held in memory only, and go through the same `compressImage` + upload path as before.
- Fixed: removing the chosen photo (the X) didn't clear the module's image variable, so a removed photo could still be submitted.
- `www/index.html`: new `#modal-verify-camera`; `www/main.js`: hardware back closes it first.
- Service worker cache bumped to v8. Uses the existing `CAMERA` permission; no new plugins or manifest changes.

## Index splash: removed the full-screen image
- `www/index.html`: removed the remote full-screen splash `<img>` (postimg `g.png`) from `#app-splash-screen`.
  The in-page splash is now just the logo + "ECampus" + "from BKBNC" (previously the fallback layer); no network image is needed to show it.
- `hideSplash()` in `www/main.js` is unchanged (it removes `#app-splash-screen` as before).
- Service worker cache bumped to v9.

## Build: versionCode offset
- `.github/workflows/android-build.yml`: `versionCode` is now `github.run_number + 100` (was just the run number).
  Play already has code 87 (2.0.3) and an inactive 12 (2.1 upload), so a plain run number (12) was lower than the live build
  and would never be offered to existing users. Builds from now on start at 101+ and keep rising with each run.
- Code 12 stays used up on Play (bundles can't be deleted); it is inactive and harmless.
