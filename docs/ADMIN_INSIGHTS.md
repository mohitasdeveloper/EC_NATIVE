# Admin Activity & Insights

The identity-level counterpart to `docs/INSIGHTS.md`. Every user's own Insights screen shows
counts, never who — same as Instagram. This is the other side of that: admins investigating a
report or a stalking complaint can see identity-level detail (who visited whose profile, who
viewed a post and how often, a user's complete activity) that regular Insights
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
- **Posts, with viewers** — the user's own posts; tap any one to see exactly who saw it, how
  many times, and what they did (liked / commented / saved / shared).
- **Full activity timeline** — paginated, newest first: posts, comments, likes given,
  saves, poll votes, RSVPs, connections made, shares, profile visits made and received, and —
  behind an opt-in checkbox, since it's high-volume — every post viewed.

A post's viewer list shows `Viewed 3×` when someone saw it more than once (counted from
`insight_events`; see `record_insight_events()` in `insights.sql`).

(Story viewers, message-sent entries and "stories watched" were removed along with the Hotposts and
Messages features — see `ARCHITECTURE.md` → "Removed features (2.9)".)

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
  admin-gated, `SECURITY DEFINER` with a pinned search path, granted to `authenticated` only, that
  nothing still reads the removed Hotposts / Messages tables, and that the big `UNION ALL` in the activity-feed function has
  matching columns in every branch (the easiest place for that kind of query to silently break).
- `tests/admin-insights-ui.test.mjs` — runs the real `admin.js` drill-down (user → activity hub →
  visitors / content → per-item viewers, and → the paginated feed) against a fake DOM and canned
  RPC responses, including the multi-level back-navigation this feature added.

Both run as part of `npm test`.
