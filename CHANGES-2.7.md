# 2.7 changes — Anonymous comments

## What it does
- The comment composer has a **Comment anonymously** toggle. When on, the comment (or reply) shows as
  **Anonymous** with the same fixed avatar as Anonymous posts. Works on every post type (text, image,
  event, poll, anonymous) and, unlike Anonymous posts, **never expires**.
- Anonymous comments hide the name, avatar, verified tick and every link to the real profile, in the comment
  list, the "latest comment" preview on post cards, and the notification bell.
- The commenter sees a small "· you" marker on their own anonymous comments so they can find and delete them.
- Replying to an anonymous comment doesn't prefill an `@Anonymous` mention.
- The toggle always starts **off** when the comments screen opens and stays on across consecutive posts.
  On your **own Anonymous post** it is forced on and locked — replying under your real name there would out you.

## Same privacy model as Anonymous posts (read this)
`post_comments.user_id` is still stored and still comes back from the API: the author needs to delete their own
comment and admins need to moderate. The app never *renders* it, but anyone inspecting network traffic could
read it. That is the same trade-off `post_type = 'anonymous'` already makes. If you need stronger anonymity,
the fix is a view/RPC that nulls `user_id` for anonymous rows and returns an `is_mine` flag instead.

## Notifications
- `notifications.is_anonymous` is set by the comment trigger for `post_comment`, `comment_reply` and
  `comment_mention`; the bell then shows "Anonymous". Tapping still opens the post and the comments.
- **Push is not covered here.** FCM goes out through the `send-push-notification` Edge Function, which is not
  in this repo. If it builds its title/body from the sender's name, it must check `record.is_anonymous` and use
  "Anonymous" — otherwise the OS push names the commenter even though the bell doesn't.

## Deploy order
1. Run `supabase/anonymous_comments.sql` in the Supabase SQL editor (safe to re-run).
2. Update the push Edge Function (above) before step 3.
3. Ship the app build. Until step 1, ordinary comments and the bell still work (the client only sends
   `is_anonymous` when true, and queries use `*`); the toggle shows
   "Anonymous comments need the latest database update."

## Out of scope
- Hotpost (Stories) replies are a separate table (`hotpost_replies`) and are not changed.

## Tests
- New `tests/anonymous-comments-contract.test.mjs` (in `npm test`): SQL and client agree on the column,
  every surface masks the commenter, `is_anonymous` is only sent when true, no expiry, deploy-order safety.
- Service worker cache bumped to `ecampus-cache-v15`.
