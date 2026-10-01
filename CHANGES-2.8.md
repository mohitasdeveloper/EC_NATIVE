# 2.8 changes — Admin panel: colour ring, password reset, Full Privacy mode

## Run this first
Re-run `supabase/admin_panel.sql` once in the Supabase SQL editor (it is idempotent). It adds the
`app_settings` and `admin_audit_log` tables, three new RPCs, and tightens `admin_update_user`. Until you do,
the App Config tab shows "Not set up yet" for Full Privacy and Reset Password fails with a clear error;
nothing else breaks.

## 1. Tick colour ring (Users -> a user -> Verified Tick Badge)
- Under the four presets there is now a **Custom colour** card: drag around the hue ring, use the
  Brightness slider, then **Apply colour**. The badge preview in the middle updates live.
- Saves `#RRGGBB` through the existing `admin_update_user`. The SQL now rejects anything that isn't
  `#RRGGBB` or `none` (the client already ignored other values when drawing the tick).

## 2. Reset a user's password (Users -> a user -> Reset Password)
- Type a password or tap the refresh button to generate a 12-character one (no look-alike characters),
  confirm, and it is set. The new password is shown once on that screen with a Copy button.
- `admin_reset_user_password` writes a bcrypt hash into `auth.users` (the browser can't do this with the
  anon key, and the service-role key must never ship in the app) and **deletes the user's sessions**, so
  they are signed out on every device.
- Rules: admins only; 8+ characters; **admin accounts are refused** (no button is shown for them either),
  so one compromised admin can't take over the others — an admin who forgets their password uses
  Forgot/Change password. Every reset is written to `admin_audit_log` (who reset whose; never the password).
- You deliver the password to the user yourself (in person / privately). There is no email step.

## 3. Full Privacy mode (App Config -> Full Privacy Mode)
- One switch in `app_settings` (`screen_privacy`). When on, every device blocks screenshots and screen
  recording in the whole app, **including the login screen**, and the Recent Apps preview is blank.
  It applies to everyone, admins included.
- Uses the `window.AndroidSecure` (FLAG_SECURE) bridge that was already in `MainActivity` for the PDF
  viewer, so **no native change and no new APK plumbing**. New file `www/screen-privacy.js`:
  - last known setting is cached, so the block is on at launch (and offline) before any network call;
  - re-checked on boot, every time the app returns to the foreground, and live over Realtime while signed in;
  - a failed check keeps the last known state (same fail-open stance as the update gate).
- **PDF viewer fix:** it used to call `AndroidSecure.disable()` when closed, which would have switched the
  global block off. It now goes through `window.ScreenSecure.hold/release('pdf')`; the flag only clears
  when no reason to hold it is left.
- Takes effect on a device when it next opens, or within moments for apps that are already open.

### Limits (be honest with users about these)
- Blocks the system screenshot, screen recording and casting. It does **not** stop someone photographing
  the screen with another phone, and rooted/modified devices can bypass `FLAG_SECURE`.
- Builds from before `AndroidSecure` existed have no bridge and can't be blocked. Raise the minimum version
  (App Config) if you need to be sure everyone is covered.
- Pages opened in the **in-app browser** (`@capgo/inappbrowser`, e.g. service links) are a separate native
  view, so the flag on the main window may not cover them. Not verified on a device.

## Housekeeping
- Service worker cache bumped to `ecampus-cache-v16`, `screen-privacy.js` precached.
- New test `tests/screen-privacy.test.mjs`; `admin-panel.test.mjs` and `rpc-contract.test.mjs` extended.

## 4. Anonymous comments send no notification
- `handle_post_comment_notification` now returns immediately when the comment is anonymous, so none of
  `post_comment`, `comment_reply` or `comment_mention` is created: no bell entry and **no push** (the push
  trigger fires on a `notifications` insert, so there is nothing to send). Same behaviour for comments queued
  offline and synced later, since they go through the same trigger.
- Change is in `supabase/anonymous_comments.sql` (re-run it; idempotent) and mirrored in `schema.sql`. No app
  build needed.
- Consequence: a post owner is never told about anonymous comments on their post. Other people's normal
  replies to an anonymous comment still notify the person who wrote it.
- Notifications that already exist for anonymous comments are left alone and still show as "Anonymous" in the
  bell. To clear them: `DELETE FROM public.notifications WHERE is_anonymous = true;`
- This also makes the "push Edge Function must check `is_anonymous`" note in CHANGES-2.7.md moot.

