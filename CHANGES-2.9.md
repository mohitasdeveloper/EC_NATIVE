# 2.9 changes — Hotposts and Messages removed completely

Stories ("Hotposts") and direct messages are gone from the app, the database and the push edge
function. **Page broadcast** (course-targeted messages from Pages) went with them, because it was
built on the `messages` table. Pages still publish posts to the feed and followers still get a
`page_new_post` notification, once.

## Run order (matters)
1. **Ship the new build and force the update.** Old builds call tables the cleanup script drops, so
   they would error on the Messages tab / Hotposts tray until updated. The new build's `versionCode`
   is `github.run_number + 100` (see the "Automate Version Code" step in `android-build.yml`); then run,
   separately, in the SQL editor:
   `UPDATE public.app_version_control SET min_version_code = <that number> WHERE platform = 'android';`
2. **Deploy the edge function:** `supabase functions deploy send-push-notification`
   (`supabase/functions/send-push-notification/index.ts`).
3. **Run the updated `supabase/insights.sql`, then `supabase/admin_insights.sql`.** They no longer read
   the dropped tables; the old versions would fail at runtime once the tables are gone.
4. **Run `supabase/cleanup_hotposts_messages.sql`.** It is one transaction, idempotent, and has an
   optional backup block at the top. **It permanently deletes** all chats, reactions, chat settings,
   hotposts, views, likes, and the notification rows of the removed types. The last statement is a
   check that should return zero rows; anything it lists is an object this repo doesn't know about that
   still references a removed table.

Not covered by SQL: hotpost media in **Cloudinary** (delete it, and the unused upload presets, from the
Cloudinary dashboard).

## What changed in the app
- **Deleted:** `www/hotposts.js`, `www/messages.js`.
- **Navigation:** the Messages tab is gone (bottom nav is now Home / Search / Profile); no Hotposts
  tray on the dashboard; no story ring on the profile photo.
- **Profiles:** the "Message" button is gone (Follow / Following / Connected remain).
- **Sharing a post:** the paper-plane button now opens the OS share sheet / copies the deep link
  directly. The "send to a connection" sheet is gone.
- **Settings:** the "Messages" push toggle and the "Muted chats" list are gone. The account-pause and
  delete-account copy no longer mentions messages / hotposts.
- **Notifications:** the bell never renders `hotpost_like`, `hotpost_reply`, `page_new_hotpost`,
  `new_message` or `page_message` (network or offline cache). Push-tap routing for them is removed.
- **Insights / Admin Insights are posts-only:** story reach, story likes/replies, "Top stories", the
  Posts/Stories switch, story detail, story viewers, "stories watched", and the `message_sent` /
  `story_*` timeline entries are removed (client and SQL).
- **Housekeeping:** `createNotification()` (only used by the removed features), Hotpost/chat CSS, the
  `hotposts_cache` IndexedDB store (IndexedDB is now v6 and deletes it on devices that have it), the
  Cloudinary video/hotpost presets in `config.js`. Service-worker cache bumped to v17 so devices drop
  the deleted modules.
- **Bug fixed as a side effect:** `messages.js` and `feed.js` both defined `window.cancelReply`, and the
  messages one won (loaded later), so the comment "replying to…" cancel button was calling the chat's
  function. Gone with `messages.js`.

## Database
- `supabase/cleanup_hotposts_messages.sql` (new) — see run order above. Drops `messages`,
  `message_reactions`, `conversation_settings`, `hotposts`, `hotpost_views`, `hotpost_likes`,
  `hotpost_replies`; the functions `trg_hotpost_like/reply`, `enforce_unsend_window`,
  `broadcast_page_message`, `count_page_broadcast_recipients`, `dm_is_blocked/connected/current_user_id`,
  and the story-only insights functions. Each function is dropped *without* CASCADE: if something else
  still depends on one it is kept and a NOTICE says so.
- The Page fan-out unique index and `notify_page_followers()` trigger now cover `page_new_post` only.
- `schema.sql` is the post-cleanup state. `migration_page_v14_channel_course_dedupe.sql` keeps only the
  duplicate-notification fix (its broadcast and read-only-channel parts lived on `messages`).

## Edge function
`send-push-notification` skips the removed types (so a stray row can't become a generic "New Activity"
push), no longer has a "messages" category, and no longer reads `conversation_settings`. Everything
else — FCM auth, titles and bodies for likes, comments, mentions, connections, follows, Page posts —
is unchanged.

## Tests
`page-channel-contract.test.mjs` became `page-fanout-contract.test.mjs`: it keeps the "Page posts notify
each follower once" checks and now also guards the removal (no module/markup/CSS/SQL/edge-function
leftovers; the cleanup script drops everything, children first, and ends with the zero-rows check).
The Insights and Admin Insights tests were updated to posts-only. `npm test`: 13 files, all passing.
Like the rest of the suite these do **not** run Postgres — read `cleanup_hotposts_messages.sql` once
before running it.

## Optional follow-ups (not done here)
- `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` in the CI-generated manifest were only needed for hotpost video
  recording (ID verification uses the camera with `audio: false`). You can drop them to shorten the Play
  Store permission list; it's a native change, so it wasn't bundled into this release.
- `@capacitor/camera` is declared in `package.json` but not imported by any web code.
