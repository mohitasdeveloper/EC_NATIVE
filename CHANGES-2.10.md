# 2.10 changes — Mini Apps

## What changed
- **Home:** a **Mini Apps** tray of circles now sits at the top of the dashboard (where the Hotposts tray used to be).
  Each circle is one entry in `MINI_APPS` (`www/mini-apps.js`): icon + name. Today it holds one app, the **BAFs App**,
  using the study icon. The circle is **88px** (was 64) and the icon is fitted whole inside it — a square icon fills the circle,
  any other shape is sized to the largest box that fits, so nothing is cropped. (A stray "school" Material icon used to show
  beside the image because Tailwind's later-loaded CSS un-hid it; fixed.)
- **Icon bundling:** the app loads `www/img/study-icon.png` first, the hosted URL only if that file is missing, and a Material
  "school" icon if neither loads. Commit the PNG to `www/img/`; if it isn't there, the CI build downloads it into that
  folder before packaging, so the APK carries it either way.
- **Search:** the **BAFs App** pill is gone, and so is the **Leaderboard** pill (Search is just Popular · Suggested now).
  Search no longer starts on BAFs for TY B.Com (Accounting & Finance) students — it always starts on Popular.
- **Leaderboard → BAFs App:** the BAFs App now has a **bottom bar: Home · Leaderboard**. The Leaderboard code moved out of
  `search.js` into `www/leaderboard.js`; `bafs.js` mounts it into the Leaderboard tab and unmounts it when you leave.
  The bar shows on those two screens only (drill-downs like Notes keep their own header). Back from Leaderboard goes
  to Home; back again leaves the app. It lives behind the BAFs verification lock, like the rest of the app.
- **Full screen:** tapping a circle slides a full-screen layer (`#modal-mini-app`) up over the whole app — header and bottom
  nav included — and mounts the app inside it. It scrolls on its own and never triggers the Home pull-to-refresh.
- **Back navigation:** hardware back / gesture steps back **inside** the mini app first (Notes → Home …), then closes the
  overlay from the app's home screen. A PDF, comments, notifications or the ID-verification screen opened on top of a mini
  app close before the mini app does. The BAFs home screen also has a top bar with a back arrow that closes it.
- **Offline:** the bundled icon and `leaderboard.js` are precached by the service worker (the hosted fallback is cached too);
  cache name bumped to v21 so devices drop the old shell.

- **Page Services removed.** Gone from the app: the **Services** row on My Profile and on Page profiles (cards, "View All"),
  the add / edit / delete service sheet, the icon picker, the All Services screen, and the **Services** tab and "Services"
  section in Search results (Search is now All · Users · Pages, and the box reads "Search students or pages...").
  `window.openServiceLink` is kept — despite the name it is the app's general in-app link opener (Help / Privacy / Terms,
  event "View Link" and register buttons, BAFs study material).
  The `page_services` table is untouched, so nothing is lost and this is reversible; if you want it gone for good,
  `DROP TABLE public.page_services;` in the Supabase SQL editor (no app code reads it any more).

- **Page Mini Apps (new).** Pages (official accounts) can now publish their own mini apps. Page accounts get a dashed
  **Manage** circle first in the Home tray → **My Mini Apps**, where they can add several apps, each with a name, their
  own app's https URL, an optional icon image URL, an **Open inside ECampus** switch (in-app full screen vs phone
  browser) and a **Visible on Home** switch (hide / show without deleting). Everyone sees active apps as circles after
  the BAFs App (a letter shows if there is no icon). Tapping one opens the URL with the student's details added:
  `?student_id=5490&name=Mohit%20Mali&course=TYBAF&dp_url=https://…&theme=dark` (`student_id` keeps the existing +5489
  scheme). **Run `supabase/page_mini_apps.sql` once** in the Supabase SQL editor first — until then the tray just
  shows the built-in BAFs App. Details: `docs/PAGE_MINI_APPS.md`.

## Files
- New: `www/mini-apps.js`, `www/leaderboard.js`, `www/page-mini-apps.js`, `www/link-params.js`, `supabase/page_mini_apps.sql`, `docs/PAGE_MINI_APPS.md`, `www/img/README.md`, `tests/mini-apps-contract.test.mjs`, `tests/mini-apps-flow.test.mjs`.
- Changed: `www/index.html` (tray, overlay, pill removed), `www/main.js` (init + back router), `www/search.js`,
  `www/bafs.js` (top bar, bottom bar + Leaderboard tab, scroll host, back-at-home closes), `.github/workflows/android-build.yml` (icon bundling step), `www/bafs.css`, `www/style.css`, `www/sw.js`,
  tests that asserted the BAFs pill, and the docs that described it.
- No database, edge-function or build-script changes.

## Adding another mini app
Add an entry to `MINI_APPS` in `www/mini-apps.js` (`id`, `name`, `icon`, `fallbackIcon`, `load`, `mount`, `unmount`,
optional `handleBack`). Nothing else needs to change.
