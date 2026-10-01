# ECampus — Project Structure

One-page map of the whole repo: what every file is, how the app boots, how it is built and
shipped, what lives in the database, and how the in-app Admin Panel fits in. For the deeper
"why is it like this" notes (notifications, page messaging, events, the exam widget) see
`ARCHITECTURE.md`.

> **Confidence key.** Statements here come from reading the code in this repo. Things that could
> only be confirmed against your live Supabase project (row-level security, grants, what the
> triggers do in production) are marked **unverified**.

---

## 1. What this is

A campus social app for a single college: feed, polls, events, stories ("hotposts"), direct
messages, pages (official accounts) with services, student-ID verification, and now an in-app
admin panel. Vanilla JavaScript ES modules in a WebView, packaged for Android with Capacitor,
backed by Supabase (Postgres + Auth + Realtime) and Cloudinary (media). The app is **bundled**
(`capacitor.config.ts` has no `server.url`), so web changes reach users only through a new APK/AAB.

## 2. Repository layout

```
EC_NATIVE-main/
├── .github/
│   └── workflows/
│       └── android-build.yml                       # CI: the entire native Android project (there is no android/ folder) + build + signing. Runs on push to main.
├── docs/
│   └── PROJECT_STRUCTURE.md                        # This file.
├── scripts/
│   └── vendor.js                                   # Copies third-party browser libs from node_modules into www/vendor (part of `npm run build`).
├── supabase/
│   ├── study_time.sql                              # Study-time tracking + leaderboard: tables, record_study_time / study_leaderboard / study_set_name_hidden. Run once in the SQL editor. See docs/STUDY_TIME.md.
│   ├── admin_panel.sql                             # Admin panel migration: is_admin/is_suspended columns, guard trigger, all admin_* RPCs. Run once in the SQL editor.
│   └── schema.sql                                  # Verified dump of tables + hand-documented functions/triggers (does NOT yet include the admin_panel.sql additions).
├── tests/
│   ├── README.md                                   # What the tests cover and, importantly, what they do not.
│   ├── admin-panel.test.mjs                        # Drives every admin tab against a fake DOM + mocked RPCs.
│   └── rpc-contract.test.mjs                       # Fails if admin.js and admin_panel.sql disagree on names/params/columns.
├── www/
│   ├── auth/
│   │   ├── auth.js                                 # Login/signup logic. Blocks deleted + suspended accounts; lets deactivated users reactivate.
│   │   ├── login.html                              # Login screen (also runs the forced-update gate).
│   │   └── signup.html                             # Signup screen (everyone signs up as role=student).
│   ├── fonts/
│   │   ├── README.md                               # How the self-hosted font files are obtained.
│   │   ├── courgette-400.woff2                     # Self-hosted font.
│   │   ├── fonts.css                               # @font-face rules for the self-hosted fonts.
│   │   ├── get-fonts.py                            # Downloads/subsets the fonts (`--subset` keeps only icons in icons-used.txt).
│   │   ├── icons-used.txt                          # Manifest of Material Symbols icons the app uses (admin panel icons added).
│   │   ├── inter-300.woff2                         # Self-hosted font.
│   │   ├── inter-400.woff2                         # Self-hosted font.
│   │   ├── inter-500.woff2                         # Self-hosted font.
│   │   ├── inter-600.woff2                         # Self-hosted font.
│   │   ├── inter-700.woff2                         # Self-hosted font.
│   │   ├── inter-800.woff2                         # Self-hosted font.
│   │   └── material-symbols-outlined.woff2         # Icon font.
│   ├── admin.js                                    # In-app Admin Panel UI + logic. Dynamically imported; admin-only.
│   ├── bafs.js                                     # BAFs App (notes / question bank / PYQ / syllabus), mounted natively in Search — no iframe.
│   ├── bafs.css                                    # Its styles, all scoped under #bafs-root.
│   ├── config.js                                   # Cloudinary cloud name + upload presets.
│   ├── data-layer.js                               # Cached shared fetchers + cache invalidation hooks + createNotification().
│   ├── discover.js                                 # Dead code (no references anywhere) — see ARCHITECTURE.md.
│   ├── favicon.svg                                 # Favicon.
│   ├── feed.js                                     # Main feed, post creation, likes, comments, saves.
│   ├── hotposts.js                                 # Stories ("Hotposts"): tray, upload, viewer, likes, replies.
│   ├── index.html                                  # All markup for every screen and modal (incl. the admin panel shell #settings-admin-panel).
│   ├── main.js                                     # Bootstrap, tab switching, profile, connections, settings, back-button router, admin entry point.
│   ├── messages.js                                 # Direct messages.
│   ├── notifications.js                            # Notification bell, realtime, push permission + tap routing.
│   ├── offline.html                                # Offline fallback page.
│   ├── pdf-viewer.js                               # Shared in-app PDF viewer (pdf.js on canvas) + on-device PDF store (IndexedDB).
│   ├── post-card.js                                # Shared post-card template (text/image/poll/event).
│   ├── search.js                                   # Search tab + Discover view.
│   ├── screen-privacy.js                           # Admin "Full Privacy" mode: blocks screenshots/recording app-wide via the AndroidSecure (FLAG_SECURE) bridge; cached, live over Realtime. Also owns window.ScreenSecure (hold/release) shared with the PDF viewer.
│   ├── study-time.js                               # Counts time spent in the in-app PDF viewer and reports it (listens to pdf-viewer.js events).
│   ├── style.css                                   # Custom CSS (safe-area, animations, shimmer, hide-scrollbar).
│   ├── supabase.js                                 # Supabase client init.
│   ├── sw.js                                       # Service worker (app-shell caching; legacy PDF cache is read-only).
│   ├── tailwind-src.css                            # Tailwind input; compiled to www/tailwind.css by CI (not committed).
│   ├── ui.js                                       # showToast, popupMenuItem.
│   ├── utils.js                                    # timeAgo, image compression, IndexedDB cache + offline queue.
│   ├── verification.js                             # Student-ID verification flow (dynamically imported).
│   └── version-gate.js                             # Forced-update gate (min_version_code from app_version_control).
├── ARCHITECTURE.md                                 # Deep "why it works this way" notes: notifications, page messaging, events, widget, admin panel. Living doc.
├── CHANGES-2.1.md                                  # Release notes for 2.1.
├── CHANGES-2.2.md                                  # Release notes for 2.2.
├── CHANGES-2.3.md                                  # Release notes for the admin panel change (this work).
├── capacitor.config.ts                             # Capacitor config: appId com.mohit.ecampus, webDir www, bundled (no server.url) so the app boots offline.
├── package.json                                    # npm scripts: build:css, vendor, build (CI runs `npm run build`), test.
└── tailwind.config.js                              # Tailwind config; scans www/**/*.html and www/**/*.js for class names.
```

Not committed, generated by CI on every build: `www/tailwind.css` (from `tailwind-src.css`),
`www/vendor/` (from `scripts/vendor.js`), and the whole `android/` project (from
`npx cap add android` plus the customisations inside `android-build.yml`).

## 3. How the app runs

**Boot** (`www/main.js`, on `DOMContentLoaded`):

1. `version-gate.js` — if the installed build's versionCode is below `app_version_control.min_version_code`,
   show the undismissable "Update Required" screen and stop.
2. Session check (with an offline fallback to the stored session).
3. Load the caller's `users` row (`select('*')`, so new columns such as `is_admin` / `is_suspended`
   arrive with no client change), falling back to the offline cache.
4. **If `is_suspended`, sign out and go to the login page** (new).
5. `verification.js` is dynamically imported and initialised in the background.
6. `initializeApp(profile)` → `initHotposts`, `initFeed`, `initSearch`, `initNotifications`,
   `initMessages`, profile UI, back-button router, pull-to-refresh, and **`setupAdminEntryPoint`**
   (reveals the sidebar "Admin Panel" button only when `profile.is_admin`).

**Dynamically imported modules** (easy to mistake for dead code if you only grep for static imports):
`verification.js`, `version-gate.js`, and `admin.js`.

**UI conventions** the admin panel reuses: full-screen panels slide in by toggling `translate-x-full`
via `openSettingsSubPanel` / `closeSettingsSubPanel`; the hardware back button walks a hierarchy array in
`setupAppBackButton`; destructive confirmations use the shared `#modal-confirm-action`; toasts come from
`ui.js`. Tailwind is precompiled, so class names must be **literal strings** in a scanned file.

## 4. Build and deploy

`.github/workflows/android-build.yml` runs on every push to `main` (and manually):

1. `npm install`
2. `npm run build` → `build:css` (Tailwind → `www/tailwind.css`) then `vendor`
3. `npx cap add android`, generate icons/splash, write all native customisations
4. `npx cap sync android`
5. Gradle `assembleDebug`, `assembleRelease`, `bundleRelease`

`versionCode = GitHub run number + 100`. You never run `build:css` by hand for a release — CI does.
Locally, `npm test` runs the admin tests (Node 18+, no installs).

## 5. Database

Source of truth: `supabase/schema.sql` (tables were diffed against the live database on 2026‑09‑25) plus
the hand-documented functions/triggers in the same file.

| Domain | Tables |
|---|---|
| Accounts | `users` (role `student`/`page`, `tick_type`, `special_post`, `is_volunteer`, `verification_status`, `is_deactivated`, `is_deleted`, plus **`is_admin`, `is_suspended` added by `admin_panel.sql`**), `student_verifications` |
| Social graph | `connections`, `page_followers`, `page_services` |
| Posts | `posts`, `post_polls`, `post_poll_votes`, `post_events`, `post_event_rsvps`, `post_likes`, `post_comments`, `comment_likes`, `saved_posts` |
| Stories | `hotposts`, `hotpost_views`, `hotpost_replies`, `hotpost_likes` |
| Messaging | `messages`, `message_reactions`, `conversation_settings` |
| Moderation / support | `reports`, `user_feedbacks` |
| Platform | `notifications`, `app_version_control`, `colleges` (**unused by the client**) |

Existing triggers that the admin panel deliberately relies on instead of re-implementing:

| Trigger | Effect |
|---|---|
| `trigger_sync_verification_status` (AFTER UPDATE OF `status` ON `student_verifications`) | `approved` → `users.verification_status='verified'`; `rejected` → `'rejected'` |
| `auto_delete_verification_data` (on `users.verification_status`) | sends the approved/rejected notification; on approval **deletes the user's `student_verifications` row** (so approved requests can't be listed — the Verify tab has no "Approved" filter). It removes the database row only; whether the image files stay in Cloudinary is outside this repo (**unverified**) |
| `trg_flag_post_on_report` | sets `posts.is_reported` when a report arrives |
| `trg_clear_report_flag_on_verify` | setting `posts.is_verified=true` clears `is_reported` (used by "Mark post as fine & protect") |

## 6. Admin Panel

**Where:** Settings sidebar → **Admin Panel** (visible only if `users.is_admin`).
**Code:** `www/admin.js` (UI + logic), shell `#settings-admin-panel` in `www/index.html`,
entry/back wiring in `www/main.js`, database side in `supabase/admin_panel.sql`.

### Access model
- `users.is_admin` (not `role` — that means account *type*).
- Hiding the button is convenience only. **Every** `admin_*` function is `SECURITY DEFINER` and starts with
  `_require_admin()`, so a non-admin calling it directly is rejected by Postgres.
- Trigger `guard_is_admin_column` stops a non-admin changing `is_admin`, `is_suspended`, `role`, `tick_type`,
  `special_post` or `is_volunteer` on their own row (the client updates its own `users` row directly). The SQL
  editor / service role (no user JWT) bypasses it, which is how you make the first admin.
- You can't remove your own admin access or suspend yourself; the UI also hides Suspend/Delete on your own row.

### Tabs
| Tab | What you can do | RPCs (`admin_panel.sql`) |
|---|---|---|
| Overview | counts of pending verifications/reports, open tickets, reported posts, users, suspended | `admin_get_dashboard_stats` |
| Verify | view ID card + selfie; approve, or reject with a reason (filters: Pending / Rejected / All) | `admin_list_verifications`, `admin_review_verification` |
| Reports | delete a reported post, or mark it fine and protect it; suspend a reported user; dismiss/resolve | `admin_list_reports`, `admin_set_report_status`, `admin_moderate_post`, `admin_update_user` |
| Tickets | read tickets, reply, set status (reply appears in the user's Support History) | `admin_list_feedback`, `admin_reply_feedback` |
| Users | search; account type (Student/Page); verification status; tick colour; poll/event permission; volunteer; admin; suspend; soft-delete | `admin_search_users`, `admin_update_user` |
| App Config | edit forced-update version code + message per platform | `admin_update_app_version` (reads `app_version_control` directly) |

### Suspend vs. deactivate vs. delete
| State | Set by | Enforced | Reversible by |
|---|---|---|---|
| `is_deactivated` | the user (self-service pause) | hides them from lists; `auth.js` offers "Reactivate" at login | **the user, themselves** — so it can't be used to ban |
| `is_suspended` | admin only | `auth.js` login check + `main.js` boot check (signs out) | admin only |
| `is_deleted` | user (delete account) or admin | `auth.js` login check | admin (Restore) |

### Adding a new admin tab
1. Add a `SECURITY DEFINER` function to `admin_panel.sql` that begins `PERFORM public._require_admin();`, plus `GRANT EXECUTE`.
2. In `admin.js`: add an entry to `TABS`, a `render…` function, and a branch in `renderActiveTab` (use `return await`).
3. Use literal Tailwind class strings, escape user text with `esc()`, and pass `danger = true` to `confirmAction` for destructive actions.
4. Add its icons to `www/fonts/icons-used.txt`.
5. Extend the tests; `npm test` will catch JS/SQL name drift.

## 7. Setup and first-run checklist

1. Supabase SQL editor → run all of `supabase/admin_panel.sql` (safe to re-run).
2. Make yourself admin: `UPDATE public.users SET is_admin = true WHERE email = 'you@example.com';`
3. Copy the changed files into your repo, commit, push to `main`. Wait for the Action to go green.
4. Install the new build, sign out and back in, open Settings → Admin Panel.
5. Smoke test with throwaway accounts (this is the part nobody has run yet):
   - Overview loads without an error card.
   - Submit a verification from a second account → Approve → that account shows verified and gets the notification.
   - File a report and a support ticket → act on them; confirm the ticket reply shows in that user's Support History.
   - Suspend the second account → login is refused with the "suspended" message → Unsuspend → login works.
   - Delete a post from a report; confirm it disappears from the feed.
6. After the release is out, raise **Min Version Code** (App Config) to that build's versionCode so old installs that lack the
   suspension check can't keep using the app.

## 8. Testing

`npm test` — see `tests/README.md`. Covers the admin UI logic and the JS↔SQL contract. Does **not** execute the SQL, render on a
device, or check your live RLS.

## 9. Known limitations

- **Suspension is enforced by the app, not the database.** A suspended user's existing session token still works against the API
  until they reopen the app or it expires; a modified client could ignore the check. Database-level enforcement would need RLS changes,
  which can't be written safely without seeing your live policies (**unverified**).
- **Old app versions** don't have the suspension check until the forced-update gate (step 6 above) moves them.
- **No audit log** of admin actions is kept. Admins can see user emails and ID-card images.
- `supabase/schema.sql` does not yet list `is_admin` / `is_suspended` (kept as a verified live dump); `admin_panel.sql` is their record.
- `public.colleges` and `www/discover.js` are unused (see `ARCHITECTURE.md`).
- The SQL has been reviewed and contract-checked against the JS but **has not been executed** on Postgres.
