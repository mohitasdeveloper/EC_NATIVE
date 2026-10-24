-- ============================================================================
-- migration_page_v14_channel_course_dedupe.sql
--
-- Page fix, run once in the Supabase SQL editor (safe to re-run):
--
--   Followers got every Page post notification TWICE.
--
-- (This migration originally also added course-targeted Page broadcasts and made
-- Pages read-only chat channels. Both lived on the Messages feature, which has been
-- removed from the app — see supabase/cleanup_hotposts_messages.sql — so those two
-- parts are gone from this file. The notification de-duplication below still applies
-- to Page posts.)
--
-- Optional pre-check — confirms how many fan-out triggers exist on each table
-- (expect exactly one per table; more means a second source of duplicates that
-- the unique index in step 1 would still absorb):
--   SELECT tgrelid::regclass AS tbl, tgname
--   FROM pg_trigger
--   WHERE NOT tgisinternal
--     AND tgfoid = 'public.notify_page_followers()'::regprocedure;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. DUPLICATE PAGE NOTIFICATIONS
--
-- Root cause: a Page post fired the trigger notify_page_followers() (0-arg,
-- AFTER INSERT on posts) AND the client then called the 4-arg
-- notify_page_followers(page_id, type, message, target_id) RPC itself
-- (feed.js). Two rows per follower -> two bell entries, two pushes.
-- The client call is removed in the app; the steps below make sure it
-- can never happen again, including from older installed app builds.
-- ----------------------------------------------------------------------------

-- 1a. Remove the duplicates already in the table (keep the earliest of each set).
DELETE FROM public.notifications n
USING public.notifications d
WHERE n.type = 'page_new_post'
  AND d.type      = n.type
  AND d.user_id   = n.user_id
  AND d.sender_id = n.sender_id
  AND d.target_id = n.target_id
  AND (d.created_at < n.created_at
       OR (d.created_at = n.created_at AND d.id < n.id));

-- 1b. At most one such notification per (follower, page, post).
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_page_fanout
  ON public.notifications (user_id, sender_id, type, target_id)
  WHERE type = 'page_new_post';

-- 1c. The trigger function now tolerates the conflict instead of erroring.
--     (ON CONFLICT DO NOTHING also skips the push trigger for the dropped row.)
CREATE OR REPLACE FUNCTION public.notify_page_followers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    poster_role text;
BEGIN
    SELECT role INTO poster_role FROM public.users WHERE id = NEW.user_id;
    IF poster_role IS DISTINCT FROM 'page' THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.notifications (user_id, sender_id, type, target_id)
    SELECT follower_id, NEW.user_id, 'page_new_post', NEW.id
    FROM public.page_followers
    WHERE page_id = NEW.user_id
      AND receive_notifications = true
      AND follower_id != NEW.user_id
    ON CONFLICT (user_id, sender_id, type, target_id)
      WHERE type = 'page_new_post'
    DO NOTHING;

    RETURN NEW;
END;
$function$;

-- 1d. The 4-arg overload becomes a no-op. Older installed app builds still call
--     it after publishing; with the trigger already fanning out, that call must
--     not insert anything. (It also had no auth check at all — any signed-in user
--     could pass any page_id and spam its followers.) Kept, rather than dropped,
--     so those old builds don't log an RPC error.
CREATE OR REPLACE FUNCTION public.notify_page_followers(p_page_id uuid, p_type text, p_message text, p_target_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Deprecated: followers are notified by the trg_notify_followers_on_* triggers.
  RETURN;
END;
$function$;
