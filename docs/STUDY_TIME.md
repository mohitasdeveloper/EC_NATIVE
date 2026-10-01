# Study time & Leaderboard

Time spent reading PDFs in the in-app viewer is tracked per student and ranked on a
**Leaderboard** pill (Search tab → Popular · Suggested · BAFs App · **Leaderboard**), with
Daily / Weekly / All-time views and a per-view switch to hide your name.

## One-time setup
Run **`supabase/study_time.sql`** once in the Supabase SQL editor of the **main** app project
(not the separate BAFs-content project). Idempotent. Until it is run the leaderboard says it isn't
set up, and the tracker keeps the seconds on the device and sends them after you deploy it.

## What counts as study time
`www/pdf-viewer.js` dispatches `ecampus:pdf-open / -ready / -close` (no detail; the URL is never
exposed). `www/study-time.js` runs a clock only while **all** of these hold: a PDF is on screen
(ready — not the spinner or error card), the app is in the foreground, and there was a touch /
scroll / zoom in the last 5 minutes. It covers every PDF the viewer opens (BAFs notes, question
banks, past papers, and PDFs opened via `openServiceLink`), because the BAFs App is mounted natively
in the Search tab (`www/bafs.js`) and opens PDFs through the same top-level overlay. A PDF that is
already stored on the device (see CHANGES-2.5.md) opens instantly and is timed exactly the same way.

Seconds are bucketed by IST day in `localStorage` (per user, persisted every 5 s), and sent to
`record_study_time()` every 30 s, on close, when backgrounded, and at next launch — so offline
reading and a killed app aren't lost.

## Periods
Daily = today (IST). Weekly = Monday → today (IST). All-time = everything. Day boundary is fixed
to `Asia/Kolkata` (single-college app); `istDay()` in `study-time.js` and `_study_today()` in SQL
must stay in step.

## Hiding your name
Three independent switches (Daily, Weekly, All-time), stored in `study_leaderboard_prefs`.
**Enforced in Postgres:** for a hidden entry `study_leaderboard()` returns `user_id`, `full_name`,
`profile_img_url` and `tick_type` as NULL, so other clients never receive who it is. Rank and time
still count. You always see your own row (tagged "You", with a "Hidden from others" note). Users you
have blocked / who blocked you are masked the same way. Deleted, deactivated, suspended accounts and
Pages never appear.

## Anti-abuse and known limits
- Time is **client-reported**. The server drops days older than today-2 or in the future, credits
  ≤ 4 h per call and ≤ 12 h per day. That stops absurd values but not a determined user with a
  script claiming up to 12 h/day. There is no way to verify reading server-side (PDFs are hosted
  elsewhere).
- A retry after a lost response can double-count one small batch (≤ ~30 s).
- The leaderboard needs a network connection; only *tracking* works offline.
- The leaderboard covers every student with study time, not only the BAF course.

## Tests
- `tests/study-time-contract.test.mjs` — JS ↔ SQL names/params/periods/caps agree; grants; identity
  from `auth.uid()`; hidden identity fields only ever emitted inside the masking CASE.
- `tests/study-time-tracker.test.mjs` — fake clock: idle, background, spinner, offline, retry, missing SQL.
- `tests/study-time-ui.test.mjs` — real `search.js`: rows, anonymous masking, escaping, periods,
  switches, and the stale-response races.
None run Postgres: run `study_time.sql` in the SQL editor to validate it.
