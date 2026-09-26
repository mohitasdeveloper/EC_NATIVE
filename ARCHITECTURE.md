# ECT (ECampus) — Architecture Notes

This document exists because a lot of this app's real behavior lives in places
that aren't obvious from reading the client code alone — specifically, in
Postgres triggers and RLS policies that no file in this repo describes. This
was discovered the hard way (see "The notification system" below) and is
exactly the kind of knowledge that gets lost between sessions if it isn't
written down. Treat this file as living documentation — update it whenever
you discover something not written here, the same way this file itself came
from discovering things not written anywhere.

## Stack

- Vanilla JS, ES modules, no build step. `main.js` is the one `<script
  type="module">` entry point in `index.html`; every other `.js` file is
  imported from there (directly or transitively) or dynamically via
  `import()`.
- Tailwind via play-CDN + a small custom design token config in `index.html`
  (`primary`/`secondary`/`error`/`surface` colors, dark mode via `.dark`
  class or `prefers-color-scheme`).
- Supabase: Postgres + Auth + Realtime + Storage-adjacent (media actually goes
  to Cloudinary, not Supabase Storage). `supabase.js` holds the client init.
- Cloudinary for all image/video upload + on-the-fly transforms
  (`config.js` has the cloud name and upload presets; `optimizeImageUrl()` in
  `main.js` builds the transform URLs).
- Firebase Cloud Messaging for push, via a Supabase Edge Function
  (`supabase/functions/send-push-notification/index.ts`) triggered by a
  database webhook on `notifications` INSERT.
- IndexedDB (`utils.js`) for offline caching of feed/hotposts/notifications
  and an offline action queue.
- Service worker (`sw.js`) for asset caching.

## File map

| File | Responsibility |
|---|---|
| `index.html` | All markup for every screen/modal. No client-side templating framework — screens are `<div id="view-X" class="tab-content hidden">` toggled by `switchTab()`, modals are `<div class="fixed inset-0 z-[N] ... hidden">` toggled by dedicated open/close functions. |
| `main.js` | App bootstrap, tab switching, profile page, connections (`handleConnectionAction` → `manage_connection` RPC), notification settings UI, image optimization, edit-profile flow, single-post view (`generatePostHTML`, now a thin wrapper — see `post-card.js`), report/block modals, action-sheet/popup-menu primitives (`openActionSheet`, `openPopupMenu` — actually defined inline in `index.html`, not `main.js`). |
| `feed.js` | Main feed: fetching/pagination, post creation (text/image/poll/event), likes, comments (including replies + mentions), saves, the feed's own "suggested for you" widget (`generateSuggestionsHTML`, exported and reused by `search.js`'s Discover section). |
| `post-card.js` | The single shared post-card template (`renderPostCardsHtml`) used by both `feed.js`'s main feed and `main.js`'s single-post view — these used to be two hand-copied templates that had drifted apart; see the changelog entry "Killed the feed.js/main.js post-card duplication" for what that cost. Also owns poll rendering (`renderPollBodyHtml`, shared with `feed.js`'s `updatePollUI` in-place refresh) and event-post rendering (register button vs. RSVP button vs. attendee count — see "Event posts" below). |
| `hotposts.js` | Stories ("Hotposts"): the tray, the camera/upload flow, the full-screen viewer, likes, replies (which are actually `messages` rows with `hotpost_reply_id` set), the "who viewed" activity panel. |
| `messages.js` | Direct messages: connections-gated 1:1 chat, read receipts, typing indicators, reactions, replies, unsend, pin/mute/archive/delete (`conversation_settings` table), the inbox list + search. |
| `notifications.js` | The in-app notification bell: fetch, render, realtime subscription, push-permission setup, and the click-routing for both in-app taps and OS push-notification taps (two separate dispatch paths — see below). |
| `search.js` | Search tab + the empty-query "Discover" view (suggested people via `feed.js`'s `generateSuggestionsHTML`, Featured Services). |
| `data-layer.js` | Shared, cached data-fetchers (`getUserSuggestions`, `getAcceptedConnections`, `getHotposts`, `getBlockedUserIds`) plus cache-invalidation hooks (`onConnectionChanged` etc. — called after mutations so other parts of the app don't serve stale cached data) and the shared `createNotification()` helper. |
| `ui.js` | Tiny shared helpers: `showToast`, `popupMenuItem` (used by both the anchored popup menu and the bottom action sheet). |
| `utils.js` | `timeAgo`, `compressImage`, and all the IndexedDB cache read/write functions + the offline action queue. |
| `config.js` | Cloudinary cloud name + upload presets. |
| `supabase.js` | Supabase client init (URL + anon key — yes, hardcoded, this is normal for the anon key specifically). |
| `verification.js` | Student-ID verification flow. **Loaded via a dynamic `import('./verification.js')` in `main.js`**, not a static import — easy to mistake for dead code if you only grep for `from './verification.js'`. |
| `discover.js` | **Genuinely dead code.** Zero references anywhere in the codebase, static or dynamic. Almost certainly superseded by `search.js`'s Discover section. Safe to delete, but nobody's done it yet — flagging here rather than assuming and deleting unilaterally. |
| `sw.js` | Service worker — static asset caching. |
| `.github/workflows/android-build.yml` | **This is the entire native Android project.** There is no `android/` folder in this repo — CI runs `npx cap add android` fresh every build, then this one workflow file writes every native customization (AndroidManifest.xml, MainActivity.java, ProGuard rules, the resource-shrinker keep-list, and — as of this session — the exam-countdown widget's Java/XML) into the freshly-generated tree via inline heredocs, all *before* the Gradle build steps at the bottom. If a native Android feature is ever wanted, this file is where it goes; there's nowhere else to put it. See "BAFS exam widget" below for a full worked example of adding to it. |

## The notification system

This is the part of the app where "what the client code does" and "what
actually happens" diverge the most. A full trigger/function/RLS audit
against the live database (2026-09-18) resolved almost all of the
uncertainty this section used to carry — what follows is verified, not
reconstructed from partial screenshots the way earlier drafts of this
section were. **The rule going forward is unchanged: before adding any new
client-side notification-creation code, check `pg_trigger` on the relevant
table first.** `schema.sql`'s "Functions & Triggers" section now has the
verified, verbatim source for everything below — this section is the
narrative version of the same information.

### Where notifications actually get created

Almost all of them are Postgres triggers, not client code:

| Notification type | Created by | Table/trigger |
|---|---|---|
| `post_like` | `handle_post_like_notification()` | `AFTER INSERT ON post_likes` (`on_post_like`) |
| `comment_like` | `handle_comment_like_notification()` | `AFTER INSERT ON comment_likes` (`on_comment_like`) |
| `post_comment` / `comment_reply` / `comment_mention` | `handle_post_comment_notification()` — one function, branches on `NEW.parent_comment_id` and loops `NEW.mentioned_user_ids` | `AFTER INSERT ON post_comments` (`on_post_comment`) |
| `post_mention` | `handle_new_post_mentions()` | `AFTER INSERT ON posts` (`on_new_post`) |
| `hotpost_like` | `trg_hotpost_like()` | `AFTER INSERT OR UPDATE OF is_deleted ON hotpost_likes` (`on_hotpost_like`) — was `AFTER INSERT` only until `migration_fix_hotpost_like_trigger_v12.sql`; `hotpost_likes` uses a soft-delete pattern (unlike sets `is_deleted=true` via UPDATE, re-liking upserts the same row, also an UPDATE), so the original trigger silently missed every like after a first unlike/relike cycle |
| `connection_request` / `connection_accepted` | `trg_connections()` | `AFTER INSERT OR UPDATE ON connections` (`on_connection_upsert`) — also has a companion `trg_connections_delete()` on `AFTER DELETE` that cleans up stale request notifications when a connection is cancelled/declined/unfriended |
| `page_new_post` / `page_new_hotpost` | `notify_page_followers()` (0-arg overload) | `AFTER INSERT ON posts` / `AFTER INSERT ON hotposts` (`trg_notify_followers_on_post` / `trg_notify_followers_on_hotpost`) — fans out to `page_followers` where `receive_notifications = true`, only when the poster's `role = 'page'` |
| `page_message` | `broadcast_page_message(p_content)` RPC | `messages` + `notifications` rows inserted directly inside the function (`migration_page_broadcast_v13.sql`) — a Page's broadcast/DM, not a trigger |
| `verification_approved` / `verification_rejected` | `auto_delete_verification_data()` | `AFTER UPDATE OF verification_status ON users` — also deletes the sensitive ID/selfie data from `student_verifications` once approved |

**Created client-side** (confirmed via the full audit to have no matching trigger):

| Notification type | Created by | Why client-side |
|---|---|---|
| `new_follower` | `main.js`'s `handleFollowAction` | The only one that worked before this session's notification work started |
| `hotpost_reply` | `hotposts.js`'s `handleReplyToHotpost` | Inserts into `messages` (with `hotpost_reply_id` set), which has no notification trigger. See "the hotpost_replies red herring" below — there IS a trigger for `hotpost_reply` notifications, but it's on a different, unused table. |
| `new_message` | `messages.js` (`sendChatMessage`, `sendPostToChat`, `retryFailedMessage`) | Same — `messages` has no notification trigger for plain sends |

`createNotification()` in `data-layer.js` is the shared client-side path for
the three above — enforces "never notify yourself" and, since a recent
change, routes Page-sent messages to `page_message` instead of `new_message`
via `messages.js`'s `notifyNewMessage()` wrapper.

### The `hotpost_replies` red herring

There's a whole separate table, `hotpost_replies` (`hotpost_id, replier_id,
author_id, content`), with its own trigger (`on_hotpost_reply` →
`trg_hotpost_reply()`) that already creates `hotpost_reply` notifications
correctly. **Nothing in this app's current code writes to that table.**
`hotposts.js`'s actual reply flow inserts into `messages` with
`hotpost_reply_id` set instead — a different, unified design that presumably
replaced whatever used `hotpost_replies` originally. The trigger is real and
armed, just permanently dormant given current code. This means the
client-side `hotpost_reply` notification in `hotposts.js` is genuinely
necessary, not a duplicate — confirmed only by checking which table is
actually written to, not just whether a trigger with a matching name exists.

### Other dead/orphaned database objects found during the audit

Same pattern as `discover.js` in the file map above — these exist, are
armed, and do nothing because nothing calls or triggers them:
- `notify_page_followers(p_page_id uuid, p_type text, p_message text, p_target_id uuid)` — a second overload of the fan-out function above, with explicit params instead of an implicit trigger `NEW`. Not attached to any trigger; nothing in this repo calls it as an RPC either.
- `trg_post_like()`, `trg_post_unlike()`, `trg_post_comment()` — earlier or alternate versions of `handle_post_like_notification()`/`handle_post_comment_notification()`, not attached to any trigger.
- A second `cast_poll_vote(p_post_id, p_user_id, p_option_id, p_is_undo)` overload exists alongside the simpler `cast_poll_vote(p_post_id, p_option_id, p_is_undo)` (which uses `auth.uid()` directly) — the four-argument one has real deadline/permission checks (custom voter lists, connections-only voting) that the simpler one completely lacks. Not confirmed which one `feed.js` actually calls; worth checking before assuming poll voting restrictions are enforced server-side.

### `manage_connection` RPC

Connection request/accept/cancel/decline/unfriend/block/unblock all go
through `manage_connection(p_target_user_id uuid, p_action text)`, called via
`supabase.rpc(...)` from `main.js`'s `handleConnectionAction`. Its source is
now verified and captured verbatim in `schema.sql`. It does **not** create
notifications itself — `trg_connections()` on the `connections` table does
that (see table above). An earlier round of this session's work briefly
added duplicate `INSERT INTO notifications` calls directly inside
`manage_connection`, wrongly assuming the trigger didn't exist; that was
reverted once the duplicate rows were found live (two rows, identical down
to the microsecond timestamp).

### Push delivery

The push mechanism is a **raw Postgres trigger**, not a "database webhook"
in the sense of a separate configured resource — Supabase's Database
Webhooks dashboard feature is a UI wrapper around exactly this kind of
trigger. Confirmed live:

```
TRIGGER: send_push_on_notification AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(
    'https://<project>.supabase.co/functions/v1/send-push-notification',
    'POST', '{"Authorization":"Bearer <service-role-jwt>", ...}', '{}', '5000')
```

The edge function itself lives at `supabase/functions/send-push-notification/index.ts`
in this repo — note the exact name (**`send-push-notification`**, hyphenated
this way specifically) matches the deployed URL above. An earlier draft of
this repo had it under a differently-named folder
(`push-notification-sender`) purely because that name was never actually
confirmed against the live deployment until this audit; it's been renamed to
match.

It does, in order:
1. Looks up the recipient's `fcm_token` and `push_settings` — no token, no push, silently.
2. Maps the notification `type` to a settings category (`likes` / `comments` / `mentions` / `connections` / `messages`) and aborts if that category is toggled off. `page_message` maps to `messages`, same as `new_message` — a Page's messages still respect the global toggle, they just can't be muted per-conversation (see below).
3. For `new_message` specifically (not `page_message`): checks the recipient's `conversation_settings` row for that sender (`muted_until`) and aborts if currently muted. This has to happen server-side, with the service-role key — a user's own mute settings for a conversation aren't readable by the *other* participant under RLS.
4. Builds a title/body and sends via FCM's v1 API using a Google service-account JWT. `new_message` pushes are deliberately generic ("`<name>` sent you a message.", no content) for lock-screen privacy; `page_message` pushes show the sender's real name as the title and the actual message content — a deliberate exception, since these are official/broadcast-style messages, not private 1:1 chat.

### In-app notification list vs. push

Two different things, can show different information:
- **Push** = whatever the edge function sends to the device.
- **In-app list** (`notifications.js`'s `fetchNotifications()`) filters both
  `new_message` and `page_message` out of its query entirely — chats
  (Page broadcasts included) have their own inbox/unread badge, and showing
  them again in the bell list was judged as clutter, even for Pages. The row
  still exists in `notifications` (the push and mute-check both depend on
  it), it's just never fetched into the in-app list.
- There are **three separate dispatch points** for tapping a notification
  type to actually navigate somewhere: `notifications.js`'s
  `handleNotificationClick` (in-app tap), `notifications.js`'s
  `pushNotificationActionPerformed` listener (OS banner tapped while
  backgrounded), and `main.js`'s cold-start pending-route handler (app fully
  closed, opened via the push). `new_message` was missed in all three the
  first time it was added, purely because nobody checked all three.

## Page messaging (broadcast + non-connection chat)

Pages can message any user, and any user can message a Page, without an
accepted connection — an explicit, narrow exception to the connections-gated
messaging model, not a general opening:
- `messages` has two pre-existing permissive INSERT policies, both requiring
  a connection (`Send messages to connections`, `messages_insert_connected_sender`
  — functionally redundant with each other, using different helper
  functions). A third permissive policy, `messages_insert_page_bypass`
  (`migration_page_broadcast_v13.sql`), was added rather than modifying
  either existing one — Postgres OR's permissive policies together, so this
  only adds a way for an insert to succeed when either side is a Page,
  leaving ordinary student-to-student messaging exactly as gated as before.
- `broadcast_page_message(p_content text)` is a `SECURITY DEFINER` RPC that
  inserts one `messages` row and one `page_message` notification per user
  (excluding the sender, deleted/deactivated accounts, and anyone who's
  blocked the page) in two `INSERT ... SELECT` statements — not a client-side
  loop, for the same reliability reason as the follower fan-out trigger.
- `messages.js`'s inbox builder (`deriveThreads()`) used to resolve every
  thread's partner info purely from `acceptedConnections`, and explicitly
  filtered out any thread whose partner wasn't found there. A broadcast (or
  any Page message) to a non-connection would have been silently invisible
  in the recipient's inbox. Fixed by having `fetchInbox()` additionally
  resolve any non-connection thread partner who is specifically a `role =
  'page'` account (`pagePartnersCache`), merged into the same lookup
  `deriveThreads()` already used.
- Pages can't be muted: `isMuted()` in `messages.js` returns `false`
  unconditionally for any partner found in `pagePartnersCache`, and
  `buildChatRowMenu()` omits the Mute option entirely (not just disables it)
  when the partner is a Page — both single-sourced from the same cache so
  they can't drift out of sync with each other.

## Messaging model

- 1:1 only, normally gated to accepted connections (`getAcceptedConnections`),
  with a narrow, verified exception for Page accounts — see "Page messaging"
  above for the exact RLS policies involved.
- `conversation_settings(user_id, partner_id, muted_until, pinned, pinned_at,
  archived, archived_at, deleted_at)` — one row per (viewer, other person)
  pair, entirely local to the viewer (an unfriend/block doesn't touch this).
  Now declared in `schema.sql` (it was missing entirely before this audit).
- Messages carry two optional reference columns beyond plain text:
  `hotpost_reply_id` (a story reply, renders as a mini story-preview card) and
  `shared_post_id` (a post shared into the chat, renders as a mini post-card).
  `content` is `NOT NULL` with a non-empty check, so both of these still
  carry a fallback string in `content` even though the UI never displays it
  for these message types.

## Event posts (participation model)

`post_type = 'event'` posts have a one-to-one `post_events` row
(`post_id, event_date, event_location, event_image_url, enable_rsvp,
rsvp_list_visibility, show_register_btn, register_url,
register_button_text, register_open_in_app`) and a one-to-many
`post_event_rsvps(post_id, user_id, status)` for who's attending.

**Participation Model is a single mutually-exclusive choice, not independent
toggles.** An event post is exactly one of:
1. **Announcement only** — `enable_rsvp = false`, `show_register_btn = false`. No action button, just date/location.
2. **In-app RSVP** — `enable_rsvp = true`. Viewers tap "RSVP Now" on the card (`window.handleRSVP` in `feed.js`, writes `post_event_rsvps`), and `rsvp_list_visibility` (`public`/`hidden`) controls who can open the attendee list.
3. **External registration link** — `show_register_btn = true` + `register_url`. The card shows a button instead of RSVP, opened via `window.openServiceLink(url, register_open_in_app, title)` — the same native-WebView-or-system-browser router the Services feature uses (see `main.js`), not a one-off link handler.

This is enforced at creation time by a radio group
(`input[name="event-participation-mode"]`, values `none`/`rsvp`/`external`)
in `index.html`'s Event Details form, read by `feed.js`'s `submitPost()` —
**not** by two checkboxes, which is what the form originally had. The
rendering in `post-card.js` still checks `show_register_btn` before
`enable_rsvp` (register wins if a row somehow has both set), purely to keep
old rows from before this fix rendering sensibly; new posts can't produce
that combination.

Rendering logic (`post-card.js`, inside `renderPostCardsHtml`'s
`post_type === 'event'` branch):
- Register mode: button label is `register_button_text` if set, else
  "Register Now"; `register_open_in_app` picks in-app WebView vs. system
  browser via `openServiceLink`.
- RSVP mode: below the RSVP button, an attendee line reads the joined
  `post_event_rsvps`. If `rsvp_list_visibility = 'public'` **or** the viewer
  is the post's own author, it's a tappable "`N` going · See who's
  attending" that opens `window.openEventRsvps(postId)` (a modal querying
  `post_event_rsvps` joined to `users`). Otherwise (hidden, viewer isn't the
  organizer) it's a plain, non-tappable count with a lock icon — the
  organizer can always check their own guest list regardless of the
  visibility setting they chose for everyone else.

**What this fixed (2026-09-25 session):** the create-post form already had
inputs for a custom register-button label (`event-button-text`) and RSVP
visibility, and `feed.js`/`post-card.js` already had `openEventRsvps()` and
its modal fully built — but none of it was wired together. Specifically:
the button-text input was never read or saved (button always said "View
Link"); there was no in-app-vs-external choice for the register link, so it
always forced an external open via `openChatLink`; and `openEventRsvps()`
had zero callers anywhere in the app, so a "public" attendee list was
never actually visible to anyone, organizer included. Two DB columns closed
the gap: `register_button_text` and `register_open_in_app`. A later diff
against a real schema dump (see the schema-verification bullet in "Known
housekeeping items") confirmed both already exist on the live `post_events`
table, so the migration that added them had in fact already been run.

Open questions, not yet decided:
- Whether participation settings are editable after publish, or fixed at
  creation (currently: fixed — there's no edit-event-post flow at all).
- Whether the organizer needs a persistent attendee-count affordance
  outside the feed card (e.g. in the post-options menu) for hidden-list
  events.
- No attendee cap / waitlist concept exists — RSVP is open-ended.

## BAFS exam widget (Android home-screen widget)

An Android home-screen widget showing a live countdown to the next BAFS
exam — added entirely inside `.github/workflows/android-build.yml` (see
the File map entry above for why that's the only place native Android code
can live in this repo). New files, all written by the "Add BAFS Exam
Countdown Widget" step:

- `ExamWidgetProvider.java` — the `AppWidgetProvider`. Renders instantly
  from cached `SharedPreferences` (`exam_widget_prefs`), then enqueues a
  `ExamWidgetUpdateWorker` background fetch. Also handles `BOOT_COMPLETED`
  manually (`AppWidgetProvider.onReceive` only auto-dispatches
  `APPWIDGET_*` actions, not arbitrary ones), since a `Chronometer`'s
  countdown base is measured from `SystemClock.elapsedRealtime()`, which
  resets to 0 at boot.
- `ExamWidgetUpdateWorker.java` — a `androidx.work.Worker` that hits the
  BAFS Study Planner's **own, separate** Supabase project directly over
  REST (`https://bhapahazfsxtozpuftvm.supabase.co/rest/v1/exams`, same
  public anon key already shipped in `www/bafs-study-planner.html` — not a
  new secret), replicates that page's `parseTime()`/`getNext()` logic in
  Java to find the first not-yet-passed exam, and caches the result.
- `res/layout/exam_widget.xml`, `res/xml/exam_widget_info.xml`,
  `res/drawable/exam_widget_background.xml`,
  `res/values/exam_widget_strings.xml` — the widget's view, its
  `AppWidgetProviderInfo` metadata, a plain rounded-card background, and
  its two strings.

**Why it points at a separate, temporary Supabase project:** the only
exam data anywhere in the app is the BAFS Study Planner's, which is
explicitly scoped to one course and slated for deletion once exam season
ends (see the removal note in `www/search.js`). The person who asked for
this widget chose to build it against that data anyway, accepting that
tradeoff, rather than build a new general "my exams" feature first — **so
when `bafs-study-planner.html` and its `search.js` iframe branch get
deleted, this widget (both native files above and the CI step that writes
them) should be deleted in the same pass**, or it'll keep quietly polling
a Supabase project nobody's using anymore.

**Why a widget can "tick live" at all without a running process:** Android
widgets don't run continuously — `RemoteViews` can't execute a JS-style
`setInterval`. The trick is `RemoteViews.setChronometer(viewId, base,
format, isCountDown=true)`, which hands off to the same native
`Chronometer` view stopwatch/timer apps use — it ticks on its own once
set, driven by the OS, not by this code. That only works well for a
single day's countdown, though (`Chronometer`'s format has no "days"
component, and showing raw triple-digit hours is unreadable), so the
widget shows a static "N days to go" (refreshed periodically, not
per-second) whenever the exam is more than 24h out, and only switches to
the live ticking `Chronometer` inside the final 24 hours.

**Refresh cadence and its real-world limits:** `exam_widget_info.xml`'s
`updatePeriodMillis` is set to 1,800,000 (30 minutes) — the *minimum*
Android will honor regardless of a lower value, and even that is
best-effort under Doze/battery optimization, not guaranteed-on-time. This
is fine for a "days to go" number but means the moment a countdown crosses
the 24h boundary and should start ticking live, it might sit as a stale
"Tomorrow" for up to ~30 minutes (worst case, longer under Doze) before
the next `onUpdate` notices and switches it over to the `Chronometer`.
Nobody's asked for tighter precision than that yet.

**Scope choices made without asking further, worth revisiting if wrong:**
- Widget shows only the *next* exam, no list — matches what was asked for.
- Tapping the widget just opens the app to wherever it normally lands
  (`MainActivity`'s default launch) — it does **not** deep-link into the
  BAFS Study Planner tab specifically. Wiring that up would mean reading a
  launch-intent extra somewhere in `index.html`'s startup code and routing
  to `search.js`'s BAFS iframe branch; skipped for this pass as an
  independent, separable piece of scope.
- Devices below Android 7.0 (API 24, `setChronometer`'s `isCountDown`
  overload) fall back to a static "N hours to go" instead of a live tick,
  guarded by `Build.VERSION.SDK_INT`, rather than crashing.
- A failed fetch never blanks an already-showing countdown — only the
  very first-ever fetch (nothing cached yet) shows an error state.

**Build-plumbing changes that came with this** (all in the same workflow
file): a `RECEIVE_BOOT_COMPLETED` permission and a `<receiver>` block in
the `AndroidManifest.xml` heredoc; an `androidx.work:work-runtime`
dependency spliced into `android/app/build.gradle`'s `dependencies {}`
block via `sed`, in a new step right after "Sync Capacitor Changes"; two
`-keep` rules in `proguard-rules.pro` for `ExamWidgetProvider` and
`ExamWidgetUpdateWorker` (R8 would otherwise rename/strip both — one's
found by the manifest via class name, the other by WorkManager via
reflection, and neither failure mode would crash, the widget would just
silently stop updating); and `@layout/*` added to the resource-shrinker's
`tools:keep` list in `keep.xml`, since `exam_widget.xml` is referenced
from an XML attribute (`exam_widget_info.xml`'s `android:initialLayout`),
not a code reference the shrinker traces as reliably.

**Not verified against an actual device or emulator build** — there's no
Android toolchain available in this working environment (no `javac`, no
emulator), so this was written and reviewed carefully against the real
Android/WorkManager APIs and stub-compiled against hand-written class
stubs to catch typos, but the very first real CI build of this is the
first time it's touched an actual Gradle/R8 toolchain. Watch that build's
output before assuming this is done.

## Known housekeeping items (not yet done)

- `supabase/event_post_participation_fix.sql`, `allow_anonymous_post_type.sql`,
  and `app_version_control.sql` have been deleted — the 2026-09-25 schema
  verification below confirmed their contents (the `post_events` columns,
  the `posts.post_type` CHECK, and the `app_version_control` table) are all
  already live in the actual database, so `schema.sql` alone is now the
  complete, accurate record of all three.
- `discover.js` is dead code (see above) — delete it, or find out why it's
  still there before assuming.
- The orphaned functions listed under "Other dead/orphaned database objects"
  above (a duplicate `notify_page_followers` overload, `trg_post_like`,
  `trg_post_unlike`, `trg_post_comment`) are still sitting in the database,
  just documented now rather than dropped — dropping them wasn't asked for
  and touches live database objects beyond what this pass covered.
- **`schema.sql`'s CREATE TABLE statements are now verified** (2026-09-25),
  not a reconstruction — the user pasted the actual live-database schema
  dump and every table was diffed against it column-for-column. That pass
  fixed several real inaccuracies the earlier "best-effort reconstruction"
  had introduced, worth knowing about since old assumptions may still be
  floating around in heads or other docs:
  - `posts.is_reported` — genuinely exists (`NOT NULL DEFAULT false`); the
    previous note calling it a "known gap" was itself wrong. `flag_post_on_report()`
    and `clear_report_flag_on_verify()` reference a real column.
  - `users.last_active_at` was missing entirely — added.
  - `message_reactions` (message-level emoji reactions, backing the reaction
    UI in `messages.js`) was missing **as a whole table** — added.
  - `conversation_settings` does **not** have a surrogate `id` column — the
    real primary key is the composite `(user_id, partner_id)`, which is also
    what `upsertChatSetting()` in `messages.js` already targets via
    `onConflict: 'user_id,partner_id'`. The previous version invented an
    `id` column with a separate `UNIQUE(user_id, partner_id)` — structurally
    wrong, even though no client code happened to depend on the mistake.
  - `messages.hotpost_reply_id` and `messages.shared_post_id` have **no**
    `ON DELETE` behavior on their foreign keys (confirmed against the real
    dump) — the previous version guessed `ON DELETE SET NULL` for both. In
    reality, deleting a hotpost or a shared post that's still referenced by
    a message will fail with a foreign-key violation, not silently null the
    column. Worth knowing before writing any hotpost/post deletion code.
  - `campus_updates` was a fully invented table (never referenced anywhere
    in `www/*.js`, and absent from the real dump) — removed.
  - `post_events` and `posts` column *order* was slightly off (cosmetic
    only) — reordered to match the real dump exactly.

  The "Functions & Triggers" section and the `messages` RLS policies are
  still only verified as of the earlier 2026-09-18 database audit (see that
  section's own header) — this pass only covered CREATE TABLE statements.
  If the person doing this wants full confidence in the rest too, an actual
  `supabase db dump --schema public --schema-only` remains the way to get it
  in one shot instead of table-by-table pasting.
- Two `cast_poll_vote` overloads exist with meaningfully different behavior
  (see "Other dead/orphaned database objects") — worth confirming which one
  the client actually calls before assuming poll voting restrictions are
  enforced.
- The `migration_*_vN.sql` files under `supabase/` have been superseded by
  `schema.sql` for everything they contain (their function/trigger/policy
  content is now folded into schema.sql's verified sections) and deleted,
  per an explicit request to do so once schema.sql was brought up to date
  enough to make that safe.
