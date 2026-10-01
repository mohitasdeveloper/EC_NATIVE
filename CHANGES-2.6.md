# 2.6 changes — Pages

## Followers no longer get every Page post twice
- Root cause: publishing as a Page fired the `notify_page_followers()` **trigger** (AFTER INSERT on `posts` /
  `hotposts`) *and* `feed.js` / `hotposts.js` then called the 4-arg `notify_page_followers(...)` **RPC** themselves.
  Two `notifications` rows per follower → two bell entries and two pushes.
- `feed.js` and `hotposts.js` no longer call the RPC; the trigger is the only fan-out.
- Server-side (`supabase/migration_page_v14_channel_course_dedupe.sql`): existing duplicates are deleted, a unique index
  on `notifications (user_id, sender_id, type, target_id)` for `page_new_post` / `page_new_hotpost` makes a repeat
  impossible, the trigger uses `ON CONFLICT DO NOTHING`, and the 4-arg RPC is a no-op so older installed builds that
  still call it can't re-create the problem (it also had no auth check — anyone could spam any Page's followers).

## Broadcast by course
- The broadcast composer has a "Send to" picker: **Everyone**, or any mix of courses, with a per-year *Select all* /
  *Clear* (FY / SY / TY). A live "Will reach N people" line shows the audience before sending; Send is disabled when a
  selection matches nobody.
- `broadcast_page_message(p_content, p_courses text[] DEFAULT NULL)` — NULL/empty = everyone (unchanged), otherwise only
  users whose `users.course` exactly matches. Messages and notifications are written from one shared recipient set.
  New `count_page_broadcast_recipients(p_courses)` powers the preview.
- `BROADCAST_COURSE_GROUPS` in `messages.js` mirrors `COURSE_GROUPS` in `auth.js` (exact strings, e.g. `SY B.A.`) — keep
  them in sync if a course is ever added.

## Pages are read-only channels
- For anyone who isn't a Page, a Page's thread now looks like a channel: no composer (replaced by "Only <Page> can send
  messages here."), no Reply in the message menu, no swipe-to-reply, header reads "Official Page · Channel", and the
  inbox row carries a campaign icon. Reactions, copy and delete-for-me still work.
- Enforced in the database too: `messages_insert_page_bypass` now only allows a Page as sender, and a RESTRICTIVE policy
  `messages_no_user_to_page` blocks any non-Page → Page insert. A Page can still message anyone, no connection needed.
- Existing user → Page messages stay visible in the Page's own inbox; nobody can add new ones.

## Deploy order
1. Run `supabase/migration_page_v14_channel_course_dedupe.sql` in the Supabase SQL editor (safe to re-run).
2. Ship the app build. Until step 1 is run, "Everyone" broadcasts still work, course targeting shows
   "Course broadcasts need the latest database update.", and the recipient preview stays blank.

## Tests
- New `tests/page-channel-contract.test.mjs` (in `npm test`): no client-side Page fan-out, broadcast/count RPC args match
  the SQL, course lists match `auth.js`, channel guards present, and the migration and `schema.sql` agree.
