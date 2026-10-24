# 2.5 changes

## PDFs are stored on the device and open instantly (even after the app is reopened)
- `www/pdf-viewer.js` keeps every PDF's bytes in IndexedDB (`ECampusPDFs`), keyed by URL. The first open (or the
  background prefetch) downloads once; every later open reads local storage — no network, survives closing and
  reopening the app, works offline. Storage is requested as *persistent* so Android doesn't evict it under pressure.
  Same rule as before: a stored URL is never refetched; a changed link is a new download.
- Works for any URL (no longer depends on it ending in `.pdf` or on the service worker being active), refuses to store
  a non-PDF body (e.g. an HTML error page served with status 200), and a stored copy that fails to parse is discarded
  and re-downloaded once.
- PDFs cached by earlier builds (`ecampus-pdf-cache-v1`) are migrated into the new store the first time they are
  opened, then deleted from the old cache so nothing is stored twice. `sw.js` no longer writes PDFs to Cache Storage.
- Faster paint: pdf.js is bundled (`npm run build` → `www/vendor/pdfjs`, new dependency `pdfjs-dist@3.11.174`), warmed at
  idle and loaded in parallel with the bytes (CDN is only a fallback). Pages are laid out from page 1's size straight
  away and their true sizes are filled in in the background, instead of reading every page before showing any.
- `window.pdfStore` (`prefetch`, `prune`, `has`, `remove`). Ad-hoc PDFs are capped at 300 MB (oldest first); tagged sets
  (BAFs) are managed by `prune()` when their links change.
- The `ecampus:pdf-open / -ready / -close` events that `study-time.js` listens to are unchanged.

## BAFs App is native in the Search tab (iframe removed)
- `www/bafs.js` + `www/bafs.css` replace `www/bafs-study-planner.html` (deleted) and the `<iframe>` in `search.js`.
  Same screens (Home/countdown, Timetable, Question Bank, PYQ, Syllabus, Paper Pattern, Notes) and the same
  verified-only gate, now in the page itself: it scrolls with the tab, runs edge to edge, and the PDF viewer, toasts,
  verification screen and Paper Pattern viewer are direct calls instead of postMessage / `window.parent`.
- Isolation is by scoping: every CSS rule is under `#bafs-root`, ids are `bafs-*`, keyframes are `bafs-*`. Text uses the
  app's Inter, and icons use the app's own bundled Material Symbols Outlined (see "Works offline" below).
- Data is cached in `localStorage` (`bafs_data_v1`): re-opening paints immediately and works offline, then refreshes
  from Supabase in the background (no re-render if nothing changed). A failed fetch no longer leaves shimmers forever.
- Back button: `main.js` calls `bafsIsAtHome()` / `bafsGoBack()` (an internal view stack, no `history.pushState`).
  `search.js` unmounts the app when another pill (Leaderboard, Popular, Suggested) is chosen.
- `sw.js`: cache name v12 → v14; `bafs.js`, `bafs.css` and `vendor/pdfjs/*` are precached.
- `tests/study-time-ui.test.mjs`: the "BAFs pill embeds the iframe" case now asserts native mounting / teardown.

## Works offline: BAFS icons, and the "No Internet" strip
- BAFS icons showed as plain words ("timer", "chevron_right"…) with no internet because BAFS loaded *Material Symbols
  Rounded* from Google Fonts. It now uses the app's own self-hosted `material-symbols-outlined.woff2` (already in
  `fonts/`, precached by `sw.js`, and containing the full icon set), so every BAFS icon renders offline and BAFS makes no
  Google request at all. The icons are the Outlined style (like the rest of the app) instead of Rounded.
  `fonts/icons-used.txt` now lists the BAFS icons too, so a future `get-fonts.py --subset` keeps them.
- The "No Internet Connection" strip no longer floats over the content. `--sat` (already used by every header, view and
  sheet for top padding) is now `status bar + strip height`: while `<html>` has `.offline-strip`, `--offline-h` is 1.75rem,
  so the whole app moves down by exactly the strip's height and nothing is covered (it used to cover e.g. the search bar,
  because only the home `<header>` was pushed). `--sat-raw` is the status bar alone; the strip sits at `top: var(--sat-raw)`.
  The old per-element `header.style.marginTop` hack is gone. The PDF viewer (full screen, above the strip) resets `--sat`
  to `--sat-raw` so it has no blank gap. Also fixed: dropping offline again during the 2.5 s "Back Online" message no
  longer lets the old timer hide the strip.
- Files: `tailwind-src.css` (variables), `style.css` (strip + `.offline-strip`), `index.html` (markup + toggle), `pdf-viewer.js`.

## Build note
- Run `npm install && npm run build` (CI already does) so `www/vendor/pdfjs/` exists. Without it the viewer still works
  through the CDN fallback, but not offline on a first launch.
