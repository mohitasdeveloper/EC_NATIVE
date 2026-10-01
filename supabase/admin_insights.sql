-- ============================================================
-- ADMIN ACTIVITY & INSIGHTS — detailed, identity-level analytics for admins only
-- ============================================================
-- Run this once against the live database (Supabase SQL Editor), AFTER both
-- supabase/admin_panel.sql and supabase/insights.sql have been run — this file
-- reuses is_admin()/_require_admin() from the former and insight_events /
-- _insights_post_rows / _insights_story_rows from the latter. Idempotent: safe
-- to re-run.
--
-- WHAT THIS IS, AND HOW IT DIFFERS FROM supabase/insights.sql
-- -------------------------------------------------------------
-- insights.sql deliberately never tells a post/story OWNER who looked at their
-- content — only counts. That's the right default for regular users: Instagram
-- doesn't show you who viewed your posts either.
--
-- This file is the other side of that decision: admins doing moderation (a
-- harassment report, a stalking complaint, investigating a fake account) often
-- need the identity-level view insights.sql intentionally withholds — who
-- visited whose profile, who rewatched a story and how many times, a specific
-- user's full activity. Every function here is admin-gated the same way as
-- supabase/admin_panel.sql (PERFORM public._require_admin(); at the top of
-- every function body) and grants EXECUTE to `authenticated` only — Postgres
-- still checks is_admin() itself on every call, so a non-admin token gets
-- "Unauthorized: admin access required", never data.
--
-- WHAT'S DELIBERATELY LEFT OUT
-- -------------------------------------------------------------
-- Message CONTENT is never exposed here. The activity feed below records that
-- a DM was sent, to whom, and when — never the message body. Reading a
-- student's private conversations is a much bigger step than seeing that they
-- sent one, and isn't needed for the moderation cases this is built for; if
-- your college needs that for a specific investigation, that's a legal/policy
-- decision to make deliberately, not a side effect of an analytics feature.
-- Comment and post text IS included, because that's the user's own public (or
-- connections-visible) content, same as what admin_moderate_post already lets
-- admins read.
--
-- Because this makes identity-level browsing behaviour visible to admin
-- accounts, treat admin access itself as sensitive: keep the admin list short,
-- and say in your privacy policy that admins can see this for moderation.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Look up one user by id, admin-only equivalent of admin_search_users
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_user(p_user_id uuid)
 RETURNS TABLE (
   id uuid, full_name text, email text, student_id text, course text, college text,
   role text, tick_type text, is_admin boolean, is_volunteer boolean, special_post boolean,
   is_private boolean, is_deactivated boolean, is_suspended boolean, is_deleted boolean, verification_status text,
   connection_count integer, profile_img_url text, created_at timestamptz, last_active_at timestamptz
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  RETURN QUERY
  SELECT u.id, u.full_name, u.email, u.student_id::text, u.course, u.college,
         u.role, u.tick_type, u.is_admin, u.is_volunteer, u.special_post,
         u.is_private, u.is_deactivated, u.is_suspended, u.is_deleted, u.verification_status,
         u.connection_count, u.profile_img_url, u.created_at, u.last_active_at
  FROM public.users u WHERE u.id = p_user_id;
END;
$function$;

-- ------------------------------------------------------------
-- 2. Quick stat tiles for a user's activity hub
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_user_activity_summary(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_has_insights boolean := to_regclass('public.insight_events') IS NOT NULL;
  v jsonb;
BEGIN
  PERFORM public._require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  SELECT jsonb_build_object(
    'posts',                   (SELECT count(*) FROM public.posts WHERE user_id = p_user_id AND COALESCE(is_deleted, false) = false),
    'stories',                 (SELECT count(*) FROM public.hotposts WHERE user_id = p_user_id AND COALESCE(is_deleted, false) = false),
    'comments_made',           (SELECT count(*) FROM public.post_comments WHERE user_id = p_user_id AND COALESCE(is_deleted, false) = false),
    'likes_given',             (SELECT count(*) FROM public.post_likes WHERE user_id = p_user_id)
                                + (SELECT count(*) FROM public.hotpost_likes WHERE user_id = p_user_id AND COALESCE(is_deleted, false) = false),
    'saves_made',              (SELECT count(*) FROM public.saved_posts WHERE user_id = p_user_id),
    'messages_sent',           (SELECT count(*) FROM public.messages WHERE sender_id = p_user_id AND COALESCE(is_unsent, false) = false),
    'connections',             (SELECT count(*) FROM public.connections WHERE status = 'accepted' AND (user_one_id = p_user_id OR user_two_id = p_user_id)),
    'joined_at',               (SELECT created_at FROM public.users WHERE id = p_user_id),
    'last_active_at',          (SELECT last_active_at FROM public.users WHERE id = p_user_id),
    'insights_ready',          v_has_insights,
    'profile_visits_made',     CASE WHEN v_has_insights THEN (SELECT count(*) FROM public.insight_events WHERE viewer_id = p_user_id AND event_type = 'profile_visit') ELSE 0 END,
    'profile_visits_received', CASE WHEN v_has_insights THEN (SELECT count(DISTINCT viewer_id) FROM public.insight_events WHERE owner_id = p_user_id AND event_type = 'profile_visit') ELSE 0 END,
    'story_watches_given',     CASE WHEN v_has_insights THEN (SELECT count(*) FROM public.insight_events WHERE viewer_id = p_user_id AND event_type = 'story_impression') ELSE 0 END
  ) INTO v;
  RETURN v;
END;
$function$;

-- ------------------------------------------------------------
-- 3. Who visited this user's profile (identity-level — the point of this file)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_profile_visitors(p_user_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE (
   visitor_id uuid, full_name text, profile_img_url text, role text,
   visit_count integer, first_visited_at timestamptz, last_visited_at timestamptz, last_source text
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  IF to_regclass('public.insight_events') IS NULL THEN
    RAISE EXCEPTION 'Insights is not set up yet (run supabase/insights.sql first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  RETURN QUERY
  SELECT u.id, u.full_name, u.profile_img_url, u.role,
         count(e.*)::int, min(e.created_at), max(e.created_at),
         (array_agg(e.source ORDER BY e.created_at DESC))[1]
  FROM public.insight_events e
  JOIN public.users u ON u.id = e.viewer_id
  WHERE e.event_type = 'profile_visit' AND e.owner_id = p_user_id
  GROUP BY u.id, u.full_name, u.profile_img_url, u.role
  ORDER BY max(e.created_at) DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$function$;

-- ------------------------------------------------------------
-- 4. A user's own content (any user, not just yourself) — reuses the exact
--    lifetime-metric helpers insights.sql already built, just without the
--    "only your own content" restriction those wrappers apply.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_content_rows(p_user_id uuid, p_kind text DEFAULT 'posts', p_days integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz;
  v_to   timestamptz := now() + interval '1 minute';
  v_out  jsonb;
BEGIN
  PERFORM public._require_admin();
  IF to_regclass('public.insight_events') IS NULL THEN
    RAISE EXCEPTION 'Insights is not set up yet (run supabase/insights.sql first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF COALESCE(p_days, 0) <= 0 THEN v_from := 'epoch'::timestamptz;
  ELSE v_from := now() - make_interval(days => LEAST(p_days, 365)); END IF;

  IF p_kind = 'stories' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_out
    FROM public._insights_story_rows(p_user_id, v_from, v_to) r;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_out
    FROM public._insights_post_rows(p_user_id, v_from, v_to) r;
  END IF;
  RETURN v_out;
END;
$function$;

-- ------------------------------------------------------------
-- 5. Per-viewer breakdown for one post — who saw it, how many times, what they did
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_post_viewers(p_post_id uuid, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS TABLE (
   viewer_id uuid, full_name text, profile_img_url text, role text,
   impression_count integer, first_seen_at timestamptz, last_seen_at timestamptz,
   liked boolean, commented boolean, saved boolean, shared boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id) THEN
    RAISE EXCEPTION 'Post not found';
  END IF;

  RETURN QUERY
  WITH imp AS (
    SELECT e.viewer_id AS uid, count(*)::int AS n, min(e.created_at) AS first_ts, max(e.created_at) AS last_ts
    FROM public.insight_events e
    WHERE e.event_type = 'post_impression' AND e.subject_id = p_post_id
    GROUP BY e.viewer_id
  ), lk AS (SELECT user_id AS uid FROM public.post_likes WHERE post_id = p_post_id),
     cm AS (SELECT DISTINCT user_id AS uid FROM public.post_comments WHERE post_id = p_post_id AND COALESCE(is_deleted, false) = false),
     sv AS (SELECT user_id AS uid FROM public.saved_posts WHERE post_id = p_post_id),
     sh AS (SELECT DISTINCT viewer_id AS uid FROM public.insight_events WHERE event_type = 'post_share' AND subject_id = p_post_id),
     everyone AS (
       SELECT uid FROM imp UNION SELECT uid FROM lk UNION SELECT uid FROM cm UNION SELECT uid FROM sv UNION SELECT uid FROM sh
     )
  SELECT u.id, u.full_name, u.profile_img_url, u.role,
         COALESCE(imp.n, 0), imp.first_ts, imp.last_ts,
         lk.uid IS NOT NULL, cm.uid IS NOT NULL, sv.uid IS NOT NULL, sh.uid IS NOT NULL
  FROM everyone ev
  JOIN public.users u ON u.id = ev.uid
  LEFT JOIN imp ON imp.uid = ev.uid
  LEFT JOIN lk  ON lk.uid  = ev.uid
  LEFT JOIN cm  ON cm.uid  = ev.uid
  LEFT JOIN sv  ON sv.uid  = ev.uid
  LEFT JOIN sh  ON sh.uid  = ev.uid
  ORDER BY COALESCE(imp.last_ts, '-infinity'::timestamptz) DESC, COALESCE(imp.n, 0) DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 300) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$function$;

-- ------------------------------------------------------------
-- 6. Per-viewer breakdown for one story — THE rewatch view. view_count > 1
--    means that viewer opened this exact story more than once (each replay
--    more than 5s after the last is a fresh row in insight_events — see
--    record_insight_events()'s per-type dedupe window in insights.sql).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_story_viewers(p_story_id uuid, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS TABLE (
   viewer_id uuid, full_name text, profile_img_url text, role text,
   view_count integer, first_viewed_at timestamptz, last_viewed_at timestamptz,
   liked boolean, replied boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.hotposts WHERE id = p_story_id) THEN
    RAISE EXCEPTION 'Story not found';
  END IF;

  RETURN QUERY
  WITH imp AS (
    SELECT e.viewer_id AS uid, count(*)::int AS n, min(e.created_at) AS first_ts, max(e.created_at) AS last_ts
    FROM public.insight_events e
    WHERE e.event_type = 'story_impression' AND e.subject_id = p_story_id
    GROUP BY e.viewer_id
  ), hv AS ( -- pre-insights fallback: a hotpost_views row with no matching event counts as exactly one view
    SELECT v.viewer_id AS uid, min(v.viewed_at) AS ts
    FROM public.hotpost_views v
    WHERE v.hotpost_id = p_story_id AND COALESCE(v.is_deleted, false) = false
      AND NOT EXISTS (SELECT 1 FROM public.insight_events e2
                        WHERE e2.event_type = 'story_impression' AND e2.subject_id = p_story_id AND e2.viewer_id = v.viewer_id)
    GROUP BY v.viewer_id
  ), lk AS (SELECT user_id AS uid FROM public.hotpost_likes WHERE hotpost_id = p_story_id AND COALESCE(is_deleted, false) = false),
     rp AS (SELECT DISTINCT sender_id AS uid FROM public.messages WHERE hotpost_reply_id = p_story_id AND COALESCE(is_unsent, false) = false),
     everyone AS (
       SELECT uid FROM imp UNION SELECT uid FROM hv UNION SELECT uid FROM lk UNION SELECT uid FROM rp
     )
  SELECT u.id, u.full_name, u.profile_img_url, u.role,
         GREATEST(COALESCE(imp.n, 0), CASE WHEN hv.uid IS NOT NULL THEN 1 ELSE 0 END),
         LEAST(imp.first_ts, hv.ts), GREATEST(imp.last_ts, hv.ts),
         lk.uid IS NOT NULL, rp.uid IS NOT NULL
  FROM everyone ev
  JOIN public.users u ON u.id = ev.uid
  LEFT JOIN imp ON imp.uid = ev.uid
  LEFT JOIN hv  ON hv.uid  = ev.uid
  LEFT JOIN lk  ON lk.uid  = ev.uid
  LEFT JOIN rp  ON rp.uid  = ev.uid
  ORDER BY GREATEST(COALESCE(imp.n, 0), CASE WHEN hv.uid IS NOT NULL THEN 1 ELSE 0 END) DESC,
           GREATEST(imp.last_ts, hv.ts) DESC NULLS LAST
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$function$;

-- ------------------------------------------------------------
-- 7. Full activity timeline for one user — "everything, in order"
-- ------------------------------------------------------------
-- Every branch has exactly the same 8 columns/types so the UNION ALL lines up:
--   ts timestamptz, kind text, other_id uuid, other_name text, other_avatar text,
--   target_id uuid, preview text, meta jsonb
-- Adding a new kind later: copy a branch, keep those 8 columns, add it to the
-- UNION ALL list below.
--
-- message_sent carries the recipient and timestamp only — see the file header
-- for why message bodies are deliberately never included.
-- p_include_views (default false) adds post_viewed/story_watched rows — every
-- post scrolled past and every story opened. Off by default because on an
-- active account these can dwarf everything else; the per-item viewer lists
-- (admin_post_viewers/admin_story_viewers) are usually the better tool for
-- "did X see this", while this flag is for "show genuinely everything".
CREATE OR REPLACE FUNCTION public.admin_user_activity_feed(
    p_user_id uuid, p_before timestamptz DEFAULT NULL, p_limit integer DEFAULT 50, p_include_views boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_before timestamptz := COALESCE(p_before, now() + interval '1 minute');
  v_has_insights boolean := to_regclass('public.insight_events') IS NOT NULL;
  v_out jsonb;
BEGIN
  PERFORM public._require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  WITH events AS (
    SELECT u.created_at AS ts, 'account_created'::text AS kind,
           NULL::uuid AS other_id, NULL::text AS other_name, NULL::text AS other_avatar,
           NULL::uuid AS target_id, NULL::text AS preview, '{}'::jsonb AS meta
    FROM public.users u WHERE u.id = p_user_id

    UNION ALL
    SELECT p.created_at, 'post_created',
           NULL, NULL, NULL,
           p.id, left(p.content, 140), jsonb_build_object('post_type', p.post_type)
    FROM public.posts p WHERE p.user_id = p_user_id AND COALESCE(p.is_deleted, false) = false

    UNION ALL
    SELECT h.created_at, 'story_created',
           NULL, NULL, NULL,
           h.id, NULL, jsonb_build_object('media_type', h.media_type)
    FROM public.hotposts h WHERE h.user_id = p_user_id AND COALESCE(h.is_deleted, false) = false

    UNION ALL
    SELECT c.created_at, 'comment_made',
           NULL, NULL, NULL,
           c.post_id, left(c.content, 140), '{}'::jsonb
    FROM public.post_comments c WHERE c.user_id = p_user_id AND COALESCE(c.is_deleted, false) = false

    UNION ALL
    SELECT pl.created_at, 'like_given',
           p2.user_id, u2.full_name, u2.profile_img_url,
           pl.post_id, NULL, '{}'::jsonb
    FROM public.post_likes pl
    JOIN public.posts p2 ON p2.id = pl.post_id
    JOIN public.users u2 ON u2.id = p2.user_id
    WHERE pl.user_id = p_user_id

    UNION ALL
    SELECT hl.created_at, 'story_like_given',
           h2.user_id, u3.full_name, u3.profile_img_url,
           hl.hotpost_id, NULL, '{}'::jsonb
    FROM public.hotpost_likes hl
    JOIN public.hotposts h2 ON h2.id = hl.hotpost_id
    JOIN public.users u3 ON u3.id = h2.user_id
    WHERE hl.user_id = p_user_id AND COALESCE(hl.is_deleted, false) = false

    UNION ALL
    SELECT sp.created_at, 'save_made',
           NULL, NULL, NULL,
           sp.post_id, NULL, '{}'::jsonb
    FROM public.saved_posts sp WHERE sp.user_id = p_user_id

    UNION ALL
    SELECT pv.created_at, 'poll_voted',
           NULL, NULL, NULL,
           pv.post_id, NULL, jsonb_build_object('option_id', pv.option_id)
    FROM public.post_poll_votes pv WHERE pv.user_id = p_user_id

    UNION ALL
    SELECT r.created_at, 'event_rsvp',
           NULL, NULL, NULL,
           r.post_id, NULL, jsonb_build_object('status', r.status)
    FROM public.post_event_rsvps r WHERE r.user_id = p_user_id

    UNION ALL
    SELECT c.updated_at, 'connection_accepted',
           other.id, other.full_name, other.profile_img_url,
           NULL, NULL, '{}'::jsonb
    FROM public.connections c
    JOIN public.users other ON other.id = (CASE WHEN c.user_one_id = p_user_id THEN c.user_two_id ELSE c.user_one_id END)
    WHERE (c.user_one_id = p_user_id OR c.user_two_id = p_user_id) AND c.status = 'accepted'

    UNION ALL
    -- Message sent: WHO and WHEN only. Never the message body — see file header.
    SELECT m.created_at, 'message_sent',
           m.receiver_id, u4.full_name, u4.profile_img_url,
           NULL, NULL, '{}'::jsonb
    FROM public.messages m
    JOIN public.users u4 ON u4.id = m.receiver_id
    WHERE m.sender_id = p_user_id AND COALESCE(m.is_unsent, false) = false AND COALESCE(m.deleted_for_sender, false) = false

    UNION ALL
    SELECT e.created_at, 'share_made',
           NULL, NULL, NULL,
           e.subject_id, NULL, jsonb_build_object('source', e.source)
    FROM public.insight_events e
    WHERE v_has_insights AND e.viewer_id = p_user_id AND e.event_type = 'post_share'

    UNION ALL
    SELECT e.created_at, 'profile_visit_made',
           e.owner_id, u5.full_name, u5.profile_img_url,
           NULL, NULL, jsonb_build_object('source', e.source)
    FROM public.insight_events e
    JOIN public.users u5 ON u5.id = e.owner_id
    WHERE v_has_insights AND e.viewer_id = p_user_id AND e.event_type = 'profile_visit'

    UNION ALL
    SELECT e.created_at, 'profile_visit_received',
           e.viewer_id, u6.full_name, u6.profile_img_url,
           NULL, NULL, jsonb_build_object('source', e.source)
    FROM public.insight_events e
    JOIN public.users u6 ON u6.id = e.viewer_id
    WHERE v_has_insights AND e.owner_id = p_user_id AND e.event_type = 'profile_visit'

    UNION ALL
    SELECT e.created_at, 'post_viewed',
           e.owner_id, u7.full_name, u7.profile_img_url,
           e.subject_id, NULL, '{}'::jsonb
    FROM public.insight_events e
    JOIN public.users u7 ON u7.id = e.owner_id
    WHERE v_has_insights AND p_include_views AND e.viewer_id = p_user_id AND e.event_type = 'post_impression'

    UNION ALL
    SELECT e.created_at, 'story_watched',
           e.owner_id, u8.full_name, u8.profile_img_url,
           e.subject_id, NULL, '{}'::jsonb
    FROM public.insight_events e
    JOIN public.users u8 ON u8.id = e.owner_id
    WHERE v_has_insights AND p_include_views AND e.viewer_id = p_user_id AND e.event_type = 'story_impression'
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.ts DESC), '[]'::jsonb) INTO v_out
  FROM (SELECT * FROM events WHERE ts < v_before ORDER BY ts DESC LIMIT v_limit) t;

  RETURN v_out;
END;
$function$;

-- ------------------------------------------------------------
-- 8. Grants: authenticated only. is_admin() is still checked inside every
--    function body above — this only saves a non-admin the network round trip
--    of a call Postgres would reject anyway. anon gets nothing, ever.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_get_user(uuid)                                        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_user_activity_summary(uuid)                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_profile_visitors(uuid, integer, integer)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_content_rows(uuid, text, integer)                       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_post_viewers(uuid, integer, integer)                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_story_viewers(uuid, integer, integer)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_user_activity_feed(uuid, timestamptz, integer, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_get_user(uuid)                                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_activity_summary(uuid)                            TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_profile_visitors(uuid, integer, integer)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_content_rows(uuid, text, integer)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_post_viewers(uuid, integer, integer)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_story_viewers(uuid, integer, integer)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_activity_feed(uuid, timestamptz, integer, boolean) TO authenticated;
