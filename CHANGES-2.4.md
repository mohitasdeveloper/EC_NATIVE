# 2.4 changes

## Study time + Leaderboard
- `www/study-time.js` (new): times PDF reading; `www/pdf-viewer.js` now dispatches
  `ecampus:pdf-open/-ready/-close` (no URL in the event).
- `www/search.js`: new **Leaderboard** pill (`www/index.html`, right after **BAFs App**) with
  Daily / Weekly / All-time, "Your study time" summary and three hide-my-name switches.
- `supabase/study_time.sql` (run once): tables, RPCs, name masking enforced server-side.
- Also fixed: a slow Popular/Suggested response could overwrite whichever pill was selected
  afterwards (`loadDiscoverList` now checks the active pill).
- `sw.js`: precaches `study-time.js`, cache name v11 → v12. `icons-used.txt`: +leaderboard, +timer.
- Docs: `docs/STUDY_TIME.md`. Tests: three new suites, added to `npm test`.
- Version not bumped (`package.json` stays 2.2.0), as in 2.3.
