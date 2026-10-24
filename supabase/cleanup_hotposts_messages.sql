-- ============================================================================
-- cleanup_hotposts_messages.sql
--
-- Removes the Hotposts (stories) and Messages (direct chat + Page broadcast)
-- features from the live database. Run ONCE in the Supabase SQL editor.
-- Idempotent: safe to re-run (everything is IF EXISTS / guarded).
--
-- THIS PERMANENTLY DELETES DATA. Read "0. BEFORE YOU RUN" first.
--
-- ----------------------------------------------------------------------------
-- 0. BEFORE YOU RUN
-- ----------------------------------------------------------------------------
-- RUN ORDER (matters — see why below):
--   1. Ship the new app build and force the update (raise
--      app_version_control.min_version_code — snippet at the very bottom).
--      Old app builds call tables this script drops; they would error on the
--      Messages tab / Hotposts tray until they update.
--   2. Deploy the new edge function:
--        supabase functions deploy send-push-notification
--      (supabase/functions/send-push-notification/index.ts)
--   3. Run the UPDATED supabase/insights.sql, then supabase/admin_insights.sql.
--      They no longer read hotposts / messages. If you drop the tables first,
--      the old versions of those functions fail at runtime until re-run.
--   4. Run THIS file.
--
-- OPTIONAL BACKUP — remove the leading "--" from the block below to keep a copy
-- of everything this script deletes, in a private schema (not exposed through
-- the API). Drop it later with:  DROP SCHEMA archive_removed_features CASCADE;
--
--   CREATE SCHEMA IF NOT EXISTS archive_removed_features;
--   CREATE TABLE archive_removed_features.messages              AS SELECT * FROM public.messages;
--   CREATE TABLE archive_removed_features.message_reactions     AS SELECT * FROM public.message_reactions;
--   CREATE TABLE archive_removed_features.conversation_settings AS SELECT * FROM public.conversation_settings;
--   CREATE TABLE archive_removed_features.hotposts              AS SELECT * FROM public.hotposts;
--   CREATE TABLE archive_removed_features.hotpost_views         AS SELECT * FROM public.hotpost_views;
--   CREATE TABLE archive_removed_features.hotpost_likes         AS SELECT * FROM public.hotpost_likes;
--   CREATE TABLE archive_removed_features.hotpost_replies       AS SELECT * FROM public.hotpost_replies;
--   CREATE TABLE archive_removed_features.removed_notifications AS
--     SELECT * FROM public.notifications
--     WHERE type IN ('hotpost_like', 'hotpost_reply', 'page_new_hotpost', 'new_message', 'page_message');
--
-- NOT covered by SQL: the images/videos people uploaded as hotposts live in
-- Cloudinary, not in this database. Delete them there (Media Library → the
-- hotposts upload preset / folder) if you want the storage back, and delete the
-- unused upload presets in the Cloudinary dashboard.
--
-- WHAT THIS SCRIPT DOES
--   1. Deletes notification rows of the removed types.
--   2. Insights: deletes recorded story events, tightens the insight_events
--      CHECK constraint, drops the story-only functions.
--   3. Narrows the Page fan-out index/trigger to Page posts only.
--   4. Drops the tables (CASCADE removes their policies, triggers, indexes,
--      foreign keys and dependent views).
--   5. Drops the now-orphaned functions (never with CASCADE: if something else
--      still depends on one, it is KEPT and a NOTICE says so).
--   6. Removes the stale "messages" key from users.push_settings.
--   7. Final check — the LAST statement returns anything that still references
--      the removed tables. Zero rows = clean.
--
-- OPTIONAL PREVIEW — run this alone first to see what will be affected beyond
-- what this repo knows about (functions / policies on other tables that
-- mention the removed tables):
--
--   SELECT 'function' AS kind, p.oid::regprocedure::text AS name
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prokind = 'f'
--     AND p.prosrc ~* '\m(hotposts|hotpost_views|hotpost_likes|hotpost_replies|message_reactions|conversation_settings)\M|(public\.|from |join |into |update )messages\M'
--   UNION ALL
--   SELECT 'policy', pol.polname || ' on ' || pol.polrelid::regclass::text
--   FROM pg_policy pol
--   WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
--         ~* '\m(hotposts|hotpost_views|hotpost_likes|hotpost_replies|message_reactions|conversation_settings)\M|(public\.|from |join |into |update )messages\M';
-- ============================================================================

BEGIN;

-- Helper: drop a function, but never take dependent objects with it.
CREATE OR REPLACE FUNCTION pg_temp.drop_fn_safe(p_signature text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP FUNCTION IF EXISTS %s', p_signature);
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE 'KEPT % — other objects still depend on it', p_signature;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. Notifications of the removed types
-- ----------------------------------------------------------------------------
DELETE FROM public.notifications
WHERE type IN ('hotpost_like', 'hotpost_reply', 'page_new_hotpost', 'new_message', 'page_message');

-- ----------------------------------------------------------------------------
-- 2. Insights: story events, CHECK constraint, story-only functions
-- ----------------------------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
  IF to_regclass('public.insight_events') IS NOT NULL THEN
    DELETE FROM public.insight_events WHERE event_type LIKE 'story\_%';

    -- The CHECK on event_type was created inline, so its name is auto-generated:
    -- find it by definition rather than guessing.
    FOR c IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.insight_events'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%event_type%'
    LOOP
      EXECUTE format('ALTER TABLE public.insight_events DROP CONSTRAINT %I', c.conname);
    END LOOP;

    ALTER TABLE public.insight_events
      ADD CONSTRAINT insight_events_event_type_check
      CHECK (event_type IN ('post_impression', 'post_share', 'post_link_click', 'profile_visit'));
  END IF;
END;
$$;

SELECT pg_temp.drop_fn_safe('public._insights_story_rows(uuid, timestamptz, timestamptz)');
SELECT pg_temp.drop_fn_safe('public.insights_story_detail(uuid)');
SELECT pg_temp.drop_fn_safe('public.admin_story_viewers(uuid, integer, integer)');

-- ----------------------------------------------------------------------------
-- 3. Page fan-out: Page posts only
--    (the unique index used to also cover 'page_new_hotpost')
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.uq_notifications_page_fanout;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_page_fanout
  ON public.notifications (user_id, sender_id, type, target_id)
  WHERE type = 'page_new_post';

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

-- ----------------------------------------------------------------------------
-- 4. Tables (children first). CASCADE also removes their RLS policies,
--    triggers, indexes, foreign keys, dependent views and realtime membership.
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.message_reactions     CASCADE;
DROP TABLE IF EXISTS public.conversation_settings CASCADE;
DROP TABLE IF EXISTS public.messages              CASCADE;
DROP TABLE IF EXISTS public.hotpost_views         CASCADE;
DROP TABLE IF EXISTS public.hotpost_likes         CASCADE;
DROP TABLE IF EXISTS public.hotpost_replies       CASCADE;
DROP TABLE IF EXISTS public.hotposts              CASCADE;

-- ----------------------------------------------------------------------------
-- 5. Orphaned functions (their triggers/policies went with the tables above)
-- ----------------------------------------------------------------------------
-- Hotpost notification triggers
SELECT pg_temp.drop_fn_safe('public.trg_hotpost_like()');
SELECT pg_temp.drop_fn_safe('public.trg_hotpost_reply()');
-- Chat: unsend-window trigger, Page broadcast RPCs (current + pre-v14 signature)
SELECT pg_temp.drop_fn_safe('public.enforce_unsend_window()');
SELECT pg_temp.drop_fn_safe('public.broadcast_page_message(text, text[])');
SELECT pg_temp.drop_fn_safe('public.broadcast_page_message(text)');
SELECT pg_temp.drop_fn_safe('public.count_page_broadcast_recipients(text[])');
-- Chat-only permission helpers. (The generic is_blocked() / current_user_id() /
-- auth_profile_id() stay: other features use them.) If a policy on some other
-- table still uses one of these, it is kept and a NOTICE says so.
SELECT pg_temp.drop_fn_safe('public.dm_is_blocked(uuid, uuid)');
SELECT pg_temp.drop_fn_safe('public.dm_is_connected(uuid, uuid)');
SELECT pg_temp.drop_fn_safe('public.dm_current_user_id()');

-- ----------------------------------------------------------------------------
-- 6. Stale push preference: the "Messages" toggle no longer exists
-- ----------------------------------------------------------------------------
UPDATE public.users
SET push_settings = push_settings - 'messages'
WHERE jsonb_exists(push_settings, 'messages');

COMMIT;

-- ----------------------------------------------------------------------------
-- 7. FINAL CHECK — should return ZERO rows.
--    Anything listed is an object (not in this repo's schema.sql) that still
--    mentions a removed table; review it, then drop or rewrite it.
-- ----------------------------------------------------------------------------
SELECT 'function' AS kind, p.oid::regprocedure::text AS name
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
  AND p.prosrc ~* '\m(hotposts|hotpost_views|hotpost_likes|hotpost_replies|message_reactions|conversation_settings)\M|(public\.|from |join |into |update )messages\M'
UNION ALL
SELECT 'policy', pol.polname || ' on ' || pol.polrelid::regclass::text
FROM pg_policy pol
WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
      ~* '\m(hotposts|hotpost_views|hotpost_likes|hotpost_replies|message_reactions|conversation_settings)\M|(public\.|from |join |into |update )messages\M'
UNION ALL
SELECT 'table', c.oid::regclass::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('hotposts', 'hotpost_views', 'hotpost_likes', 'hotpost_replies',
                    'messages', 'message_reactions', 'conversation_settings')
UNION ALL
SELECT 'notification_type', type || ' (' || count(*) || ' rows)'
FROM public.notifications
WHERE type IN ('hotpost_like', 'hotpost_reply', 'page_new_hotpost', 'new_message', 'page_message')
GROUP BY type;

-- ----------------------------------------------------------------------------
-- STEP 1 of the run order — force the app update (run it SEPARATELY, when the
-- new build is live in the store; replace 0 with the new build's versionCode):
--
--   UPDATE public.app_version_control
--   SET min_version_code = 0   -- <-- new versionCode
--   WHERE platform = 'android';
-- ----------------------------------------------------------------------------
