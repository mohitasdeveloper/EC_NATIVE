# Admin Activity & Insights

The identity-level counterpart to `docs/INSIGHTS.md`. Every user's own Insights screen shows
counts, never who — same as Instagram. This is the other side of that: admins investigating a
report or a stalking complaint can see identity-level detail (who visited whose profile, who
rewatched a story and how many times, a user's complete activity) that regular Insights
deliberately withholds.

## One-time setup

Run, in order:

1. `supabase/admin_panel.sql` (if not already — this reuses its `is_admin()` / `_require_admin()`)
2. `supabase/insights.sql` (this reuses its `insight_events` table and row-helper functions)
3. **`supabase/admin_insights.sql`**

All three are idempotent. If you run `admin_insights.sql` before `insights.sql`, the profile-visitor
and viewer-list screens show a plain "not set up yet" message instead of erroring — no crash, just
a reminder of the missing step.

## Where it lives

Reached from the admin panel's **Users** tab → find a user → **Activity & Insights**. From there:

- **Who visited this profile** — every visitor, visit count, first/last visit, how they got there.
- **Posts & stories, with viewers** — the user's own content; tap any item to see exactly who saw
  it, how many times, and what they did (liked / commented / saved / shared / replied).
- **Full activity timeline** — paginated, newest first: posts, stories, comments, likes given,
  saves, poll votes, RSVPs, connections made, messages sent (see below), shares, profile visits made
  and received, and — behind an opt-in checkbox, since it's high-volume — every post and story
  viewed.

Rewatches: a story's viewer list shows `Watched 4× (rewatched)` when the count is above 1. That
number comes from `insight_events` (each replay more than 5 seconds after the last is its own row —
see `record_insight_events()` in `insights.sql`), with a fallback to the older `hotpost_views` table
for views recorded before Insights existed (those count as exactly one view; the table only ever
tracked "seen at all", not replay count, so there's nothing to recover for that period).

## What's deliberately left out

**Message content is never exposed here.** The activity timeline shows that a DM was sent, to whom,
and when — never the body. Seeing that two students exchanged messages is a normal moderation
signal (e.g. spotting a harassment pattern); reading the messages themselves is a much bigger step,
and isn't something an analytics feature should do as a side effect. If a specific investigation
genuinely needs message content, that's a deliberate decision for your team to make outside this
system, not a checkbox in it.

`tests/admin-insights-contract.test.mjs` enforces this mechanically: it fails the build if
`admin_user_activity_feed`'s message branch ever starts selecting a `content` column, and the
behavioural test additionally checks that a message body slipped into the response some other way
still never reaches the rendered page.

## Access model

Every function in `admin_insights.sql` calls `_require_admin()` before touching any data — a
non-admin's token gets "Unauthorized: admin access required," not a row. `admin_get_user` (a
by-id lookup used when you tap a name inside any of these lists) is the identity-level equivalent
of the already-admin-gated `admin_search_users`.

Because this makes browsing behaviour visible in a way regular Insights intentionally isn't, treat
the admin role itself as the sensitive boundary: keep the admin list short, and say in your privacy
policy that admins can see this for moderation purposes.

## Tests

- `tests/admin-insights-contract.test.mjs` — static check of `admin_insights.sql`: every function
  admin-gated, `SECURITY DEFINER` with a pinned search path, granted to `authenticated` only, the
  message-content boundary above, and that the big `UNION ALL` in the activity-feed function has
  matching columns in every branch (the easiest place for that kind of query to silently break).
- `tests/admin-insights-ui.test.mjs` — runs the real `admin.js` drill-down (user → activity hub →
  visitors / content → per-item viewers, and → the paginated feed) against a fake DOM and canned
  RPC responses, including the multi-level back-navigation this feature added.

Both run as part of `npm test`.
