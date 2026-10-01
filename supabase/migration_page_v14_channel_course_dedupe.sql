-- ============================================================================
-- migration_page_v14_channel_course_dedupe.sql
--
-- Three Page fixes, run once in the Supabase SQL editor (safe to re-run):
--
--   1. Followers got every Page post / hotpost notification TWICE.
--   2. Page broadcasts can be targeted by course (not only "everyone").
--   3. Pages are read-only channels: users can no longer message a Page.
--
-- Run this BEFORE (or together with) shipping the matching app build — the new
-- app only sends the new `p_courses` argument when courses are selected, and
-- calls count_page_broadcast_recipients() for the live "Will reach N people"
-- preview (which silently stays blank until this has been run).
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
-- AFTER INSERT on posts / hotposts) AND the client then called the 4-arg
-- notify_page_followers(page_id, type, message, target_id) RPC itself
-- (feed.js / hotposts.js). Two rows per follower -> two bell entries, two pushes.
-- The client calls are removed in the app; the three steps below make sure it
-- can never happen again, including from older installed app builds.
-- ----------------------------------------------------------------------------

-- 1a. Remove the duplicates already in the table (keep the earliest of each set).
DELETE FROM public.notifications n
USING public.notifications d
WHERE n.type IN ('page_new_post', 'page_new_hotpost')
  AND d.type      = n.type
  AND d.user_id   = n.user_id
  AND d.sender_id = n.sender_id
  AND d.target_id = n.target_id
  AND (d.created_at < n.created_at
       OR (d.created_at = n.created_at AND d.id < n.id));

-- 1b. At most one such notification per (follower, page, type, post).
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_page_fanout
  ON public.notifications (user_id, sender_id, type, target_id)
  WHERE type IN ('page_new_post', 'page_new_hotpost');

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
    notif_type text;
BEGIN
    SELECT role INTO poster_role FROM public.users WHERE id = NEW.user_id;
    IF poster_role IS DISTINCT FROM 'page' THEN
        RETURN NEW;
    END IF;

    notif_type := CASE TG_TABLE_NAME
        WHEN 'posts' THEN 'page_new_post'
        WHEN 'hotposts' THEN 'page_new_hotpost'
    END;

    INSERT INTO public.notifications (user_id, sender_id, type, target_id)
    SELECT follower_id, NEW.user_id, notif_type, NEW.id
    FROM public.page_followers
    WHERE page_id = NEW.user_id
      AND receive_notifications = true
      AND follower_id != NEW.user_id
    ON CONFLICT (user_id, sender_id, type, target_id)
      WHERE type IN ('page_new_post', 'page_new_hotpost')
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


-- ----------------------------------------------------------------------------
-- 2. BROADCAST BY COURSE
--
-- broadcast_page_message(p_content, p_courses): NULL / empty p_courses = everyone
-- (previous behaviour). Otherwise only users whose users.course is one of the
-- given strings (exact match — the values are stored verbatim from the course
-- picker, e.g. 'FY B.Com (Financial Markets)', 'SY B.A.').
--
-- The recipient set is computed once and used for both the messages and the
-- notifications in a single statement, so the two can never disagree.
-- The old 1-arg signature is dropped first: leaving both would make a call
-- with only p_content ambiguous.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.broadcast_page_message(text);

CREATE OR REPLACE FUNCTION public.broadcast_page_message(p_content text, p_courses text[] DEFAULT NULL)
RETURNS integer AS $$
DECLARE
    v_sender_id uuid;
    v_sender_role text;
    v_recipient_count integer;
BEGIN
    SELECT id, role INTO v_sender_id, v_sender_role FROM public.users WHERE auth_user_id = auth.uid();
    IF v_sender_id IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
    IF v_sender_role != 'page' THEN RAISE EXCEPTION 'Only Page accounts can broadcast messages'; END IF;
    IF p_content IS NULL OR btrim(p_content) = '' THEN RAISE EXCEPTION 'Message cannot be empty'; END IF;

    WITH recipients AS (
        SELECT u.id
        FROM public.users u
        WHERE u.id != v_sender_id
          AND u.is_deleted = false
          AND u.is_deactivated = false
          AND NOT public.dm_is_blocked(v_sender_id, u.id)
          AND (p_courses IS NULL OR cardinality(p_courses) = 0 OR u.course = ANY (p_courses))
    ),
    ins_messages AS (
        INSERT INTO public.messages (sender_id, receiver_id, content)
        SELECT v_sender_id, r.id, p_content FROM recipients r
        RETURNING 1
    ),
    ins_notifications AS (
        INSERT INTO public.notifications (user_id, sender_id, type, message)
        SELECT r.id, v_sender_id, 'page_message', p_content FROM recipients r
        RETURNING 1
    )
    SELECT count(*) INTO v_recipient_count FROM ins_messages;

    RETURN v_recipient_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Live "Will reach N people" preview for the composer. Same filter as above,
-- Page-only, read-only.
CREATE OR REPLACE FUNCTION public.count_page_broadcast_recipients(p_courses text[] DEFAULT NULL)
RETURNS integer AS $$
DECLARE
    v_sender_id uuid;
    v_sender_role text;
    v_count integer;
BEGIN
    SELECT id, role INTO v_sender_id, v_sender_role FROM public.users WHERE auth_user_id = auth.uid();
    IF v_sender_id IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
    IF v_sender_role != 'page' THEN RAISE EXCEPTION 'Only Page accounts can broadcast messages'; END IF;

    SELECT count(*) INTO v_count
    FROM public.users u
    WHERE u.id != v_sender_id
      AND u.is_deleted = false
      AND u.is_deactivated = false
      AND NOT public.dm_is_blocked(v_sender_id, u.id)
      AND (p_courses IS NULL OR cardinality(p_courses) = 0 OR u.course = ANY (p_courses));

    RETURN v_count;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.broadcast_page_message(text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_page_broadcast_recipients(text[]) TO authenticated;


-- ----------------------------------------------------------------------------
-- 3. PAGES ARE READ-ONLY CHANNELS
--
-- Before: messages_insert_page_bypass let anyone message a Page (and a Page
-- message anyone) without a connection. Now it only lets a PAGE send.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "messages_insert_page_bypass" ON public.messages;
CREATE POLICY "messages_insert_page_bypass" ON public.messages
FOR INSERT
WITH CHECK (
    sender_id = (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
    AND NOT public.dm_is_blocked(sender_id, receiver_id)
    AND (SELECT role FROM public.users WHERE id = messages.sender_id) = 'page'
);

-- Belt and braces: the two connection-based INSERT policies don't look at the
-- receiver's role, so a restrictive policy (AND-ed with every permissive one)
-- guarantees nobody but a Page can insert a message addressed to a Page, however
-- the row got past the permissive ones. SECURITY DEFINER functions (the broadcast
-- RPC) are unaffected — they bypass RLS and only ever send Page -> user.
DROP POLICY IF EXISTS "messages_no_user_to_page" ON public.messages;
CREATE POLICY "messages_no_user_to_page" ON public.messages
AS RESTRICTIVE
FOR INSERT
WITH CHECK (
    (SELECT role FROM public.users WHERE id = messages.sender_id) = 'page'
    OR (SELECT role FROM public.users WHERE id = messages.receiver_id) IS DISTINCT FROM 'page'
);
