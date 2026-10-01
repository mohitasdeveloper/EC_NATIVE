# Insights

An Instagram-style analytics system: every user gets an **Insights** screen for their own posts,
stories, account and audience. Nobody can see anyone else's — enforced in Postgres, not just hidden
in the UI.

## One-time setup (do this before shipping)

Run **`supabase/insights.sql`** once in the Supabase SQL editor. It's additive and idempotent —
safe to re-run, doesn't touch any existing table or RPC. Until it's run, the Insights screen shows
a "not set up yet" message instead of erroring, and the client-side tracker quietly disables itself
after its first failed write (see "Fails safe" below).

## What it's built from

Most of what Insights shows was **already in the database** — likes, comments, saves, story views,
story replies, your connections/followers. What didn't exist was a record of who *saw* things. That
gap is filled by one new append-only table:

- **`public.insight_events`**(`supabase/insights.sql`) — one row per impression, share, link tap,
  profile visit, or story navigation action. Written only through `record_insight_events()`, read
  only through the `insights_*` functions below. RLS is on with **no policies** and all table
  privileges are revoked from every client role — the functions are the only door in or out.

Reached through:
- **`www/insights-track.js`** — statically imported by `main.js`. Watches post cards with an
  `IntersectionObserver` (counts an impression at ≥50% visible for ≥1s), and exposes
  `window.trackInsightEvent` / `window.markInsightProfileSource` for `hotposts.js` and `post-card.js`
  to call for story navigation, shares and link taps. Batches and flushes every 4s.
- **`www/insights.js`** — the screen itself (Overview / Content / Audience tabs, post & story
  detail). Dynamically imported on first open via `window.openInsights()`, the same lazy pattern as
  `admin.js`. Renders into the `#settings-insights-panel` shell in `index.html`. Charts are hand-rolled
  inline SVG — no chart library, since the app ships fully bundled/offline.

Entry points: the sidebar, your own profile ("Insights" next to "Edit Profile"), a post's `⋮` menu
("View insights"), and a story's Activity panel ("Insights" next to "Delete").

## Access model

Every `insights_*` function resolves "who's asking" from `auth.uid()` via `public.users.auth_user_id`
(this schema's established pattern — never compare an app-level `user_id` column to `auth.uid()`
directly) and only ever returns *that user's own* content. The internal `_insights_*` helper
functions take an owner id as a parameter, which is why they're `REVOKE`d from every client role —
without that revoke, Postgres's default `GRANT ... TO PUBLIC` on functions would let any signed-in
user query anyone's numbers by calling the helper directly.

## Fails safe

- **SQL not deployed yet**: the tracker's first write gets a "function does not exist" error, and it
  switches itself off for the rest of the session — no retry storm, no console spam. The Insights
  screen shows a plain explanation instead of a generic error.
- **Network hiccup**: the tracker re-queues the batch (capped) and retries on the next flush.
- **Slow response after the user has already navigated away**: `insights.js` tags each request and
  discards a response that arrives after a newer one was already requested, so a slow "Audience"
  fetch can never flash on top of the "Overview" tab the user switched back to.

## Known limits

- **History starts at deployment.** Post impressions, profile visits, shares and link taps before
  `insights.sql` was run were never recorded — there's nothing to backfill them from. Story views are
  the one exception: they're read from the pre-existing `hotpost_views` table, so those are complete
  from before Insights existed.
- **"New audience" can't see departures.** It's driven by `connections.updated_at`, and removed
  connections are hard-deleted in this schema, so an unfollow/disconnect never shows up as a dip.
- **Impressions are counted client-side.** A modified client or a page that never rendered (e.g. the
  app was killed mid-scroll) can under- or over-count by a little. This is the same trade-off
  Instagram/every app with client-side impression tracking makes.
- **Demographics are privacy-thresholded on purpose**: hidden entirely under 5 people in the
  audience, and any bucket under 3 is folded into "Other" — by design, not a bug if a small course
  cohort disappears from the list.

## Tests

- `tests/insights-contract.test.mjs` — static check that the JS and SQL agree (function names,
  parameter names, event types, JSON keys), and that the access-control properties above (helpers
  locked down, nothing granted to `anon`, identity always from `auth.uid()`) are actually present in
  the SQL text. Doesn't run Postgres — run `insights.sql` in the SQL editor to check it's valid.
- `tests/insights-ui.test.mjs` — runs the real `insights.js` / `insights-track.js` against a fake DOM
  and canned RPC responses: every tab, drill-down, empty state, the missing-SQL and network-failure
  paths, and the "slow response for a screen you've left" race.

Both run as part of `npm test`.
