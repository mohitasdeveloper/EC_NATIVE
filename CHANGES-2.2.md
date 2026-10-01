# 2.2 changes

## BAFs App: PDFs cached for offline use
- `www/sw.js`: new permanent `ecampus-pdf-cache-v1` Cache Storage bucket, separate from the versioned
  app-shell cache so app updates never wipe it. Any request that looks like a PDF is served cache-first
  from there; on a miss it's fetched once and cached forever — keyed purely by URL, so a cached copy is
  only ever replaced when the link itself changes (a different `pdf_url` is just a fresh cache miss under
  a new key). No domain allow-list needed since `pdf_url` can point anywhere.
- `www/bafs-study-planner.html`: new `warmPdfCache()` — after `notes` / `qbank` / `pyqs` load from Supabase,
  quietly downloads every `pdf_url` not already cached (3 at a time, so it doesn't hammer the connection) so
  the whole library is available offline, not just PDFs a student has actually opened. Runs after the initial
  data load and again the moment a student's verification status flips to `verified`. Skipped entirely for
  locked-out users so it never spends their data before they have access.
- Service worker cache bumped to v10.

## Post comments: Instagram-style layout + missing verified ticks
- `www/feed.js` (`renderSingleComment()` — the single function every comment view in the app renders
  through: feed, notifications, saved posts, profile):
  - Verified tick was never rendered next to a commenter's name. Now calls `window.getTickHtml(comment.users.tick_type)`,
    the same badge used everywhere else in the app.
  - Name and comment text used to be jammed into one line. Now the bold username (+ tick) sits on its own
    line, with the comment text on the line below and the time/Reply row underneath — matching Instagram's
    comment-card layout instead of a single run-on line.

## Event posts: redesigned card
- `www/post-card.js` (`renderPostCardsHtml()`, `post_type === 'event'`): event posts now render as one cohesive,
  rounded card instead of a full-bleed image sitting above a separate flat details strip.
  - Cover photo (or a themed placeholder banner when none was uploaded, so the card never looks bare) carries a
    small Facebook-style date badge (month + day) floated over its top-left corner.
  - The caption the organizer wrote is now promoted into the card as the event's title (same "absorb the
    caption" pattern already used for text/anonymous posts), instead of floating above the card as an ordinary
    caption line.
  - Status pill now reflects the actual event date — "Upcoming Event" vs. "Past Event" (previously always said
    "Upcoming Event", even for events that had already happened).
  - Date/time line now shows weekday + time (e.g. "Sat, 12 Oct · 6:00 PM") instead of a generic medium/short
    locale string.
  - Register/RSVP button and the "who's going" row are unchanged functionally, just restyled (shadow, spacing)
    to sit inside the new card instead of a flat strip.

## Version
- versionName 2.2 (versionCode still = GitHub run number + 100, same scheme as 2.1 — no reset needed).

