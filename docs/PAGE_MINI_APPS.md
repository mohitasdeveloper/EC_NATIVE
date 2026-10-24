# Page Mini Apps

Pages (official accounts, `users.role = 'page'`) can publish their own **Mini Apps**: a circle at the top of Home
that opens the Page's own separate web app, with the student's details added to the URL.

## One-time setup
Run **`supabase/page_mini_apps.sql`** once in the Supabase SQL editor of the **main** app project (idempotent).
It creates `page_mini_apps` and five `SECURITY DEFINER` functions. The table itself is locked (RLS on, no policies,
privileges revoked); everything goes through the functions, which take "who is asking" from `auth.uid()`.

| Function | Who | What |
|---|---|---|
| `mini_apps_list()` | any signed-in user | active apps of live Pages (Home tray); skips blocked relationships |
| `mini_apps_mine()` | Pages | the Page's own apps, active **and** hidden |
| `mini_app_save(p_id, p_name, p_url, p_icon_url, p_open_in_app, p_is_active)` | Pages | create (`p_id` null) or edit |
| `mini_app_set_active(p_id, p_active)` | Pages | show / hide without deleting |
| `mini_app_delete(p_id)` | Pages | delete |

Limits (table checks + function + client all agree): **10 apps per Page**, name **1–20** characters,
URL and icon URL **https only**.

## For a Page account
Home → the dashed **Manage** circle (first in the tray) → **My Mini Apps**:
- **New** → name, your app's URL, optional icon image URL, and two switches:
  - **Open inside ECampus** — on: full-screen in-app window (native WebView on Android); off: the phone's browser.
  - **Visible on Home** — off hides it from students without deleting it.
- Each row has the same visibility switch and an edit button (edit sheet also has Delete).

## What the app receives
`window.openServiceLink(url, openInApp, name, { full: true })` adds (via `www/link-params.js`):

```
https://your-app.example.com/?student_id=5490&name=Mohit%20Mali&course=TYBAF
    &dp_url=https://i.ibb.co/0jDkVxfB/study-icon.png&theme=dark
```

- `student_id` = numeric student id **+ 5489** (the existing scheme the linked apps decode).
- `course`, `dp_url` are only sent when the profile has them; `theme` is `dark` or `light`.
- Anything already in the Page's URL query is kept.
- This is personal data going to a third-party URL: only approve Pages you trust.

## Code map
- `www/page-mini-apps.js` — list + cache (`localStorage`), manager screen, add/edit sheet, validation.
- `www/mini-apps.js` — the tray (built-ins + Pages' apps + Manage) and the full-screen host for built-in apps.
- `www/link-params.js` — the URL parameters.
- Markup: `#modal-manage-mini-apps`, `#modal-mini-app-form` in `www/index.html`. Back button: both are in
  `main.js`'s back router (form → manager → Mini Apps overlay).
- Tests: `page-mini-apps.test.mjs` (behaviour), `page-mini-apps-contract.test.mjs` (SQL ⇄ JS), `link-params.test.mjs`.
