-- ============================================================
-- INSIGHTS — event log + RPCs backing www/insights.js / insights-track.js
-- ============================================================
-- Run this once against the live database (Supabase SQL Editor).
-- Idempotent: safe to re-run (IF NOT EXISTS / CREATE OR REPLACE throughout).
--
-- What already existed and is reused (nothing here duplicates it):
--   likes ........ post_likes, hotpost_likes
--   comments ..... post_comments
--   saves ........ saved_posts
--   story views .. hotpost_views (unique per story+viewer => "reach")
--   story replies  messages.hotpost_reply_id
--   audience ..... connections (accepted) + page_followers
--
-- What did NOT exist and is added here: a record of who SAW things.
--   post impressions, profile visits, shares, event-link taps, and story
--   impressions / navigation (forward, back, next account, exit).
-- Those go into ONE append-only table, public.insight_events, written only
-- through record_insight_events().
--
-- Access model (same philosophy as admin_panel.sql):
--   * insight_events has RLS on and NO policies, and all table privileges are
--     revoked from anon/authenticated. The only way in or out is a
--     SECURITY DEFINER function.
--   * Every insights_* function derives "who is asking" from auth.uid() via
--     public.users.auth_user_id. It NEVER trusts a user id from the client, and
--     it only ever returns the caller's OWN content. (Note this schema's
--     users.id is a different id space from auth.uid() -- never compare them
--     directly.)
--   * The internal _insights_* helpers take an owner id as a parameter, so they
--     are REVOKED from PUBLIC/anon/authenticated. Only the wrapper functions
--     (which pass the caller's own id) can reach them. Postgres grants EXECUTE
--     to PUBLIC by default, so this REVOKE is load-bearing, not decoration.
--
-- Privacy: viewers are never exposed. Owners only ever see counts. Audience
-- demographics hide any bucket smaller than 3 people (merged into "Other") and
-- are hidden entirely for audiences under 5.
--
-- Known limits (also documented in docs/INSIGHTS.md):
--   * History starts when this is deployed. Post impressions/profile visits
--     before that were never recorded. Story views before that ARE counted
--     (from hotpost_views).
--   * "New connections" uses connections.updated_at for accepted rows. Removed
--     connections are hard-deleted, so unfollows/disconnects can't be shown.
--   * Impressions are counted client-side (>=50% visible for >=1s), so an
--     offline or modified client can under- or over-report a little.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Event table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.insight_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type  text NOT NULL CHECK (event_type IN (
                'post_impression', 'post_share', 'post_link_click',
                'profile_visit',
                'story_impression', 'story_tap_forward', 'story_tap_back',
                'story_next_account', 'story_exit')),
  owner_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, -- whose content it was
  viewer_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, -- who did it
  subject_id  uuid,        -- post id / hotpost id / (for profile_visit) the visited user's id
  source      text,        -- feed | profile | detail | library | chat | external | post | story | other
  from_id     uuid,        -- profile_visit only: the post/story that led to the visit
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS insight_events_owner_type_time_idx
  ON public.insight_events (owner_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS insight_events_subject_type_idx
  ON public.insight_events (subject_id, event_type);
CREATE INDEX IF NOT EXISTS insight_events_viewer_time_idx
  ON public.insight_events (viewer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS insight_events_from_idx
  ON public.insight_events (from_id) WHERE from_id IS NOT NULL;

ALTER TABLE public.insight_events ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: nobody reads or writes this table directly.
REVOKE ALL ON public.insight_events FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Identity helper (auth.uid() -> public.users.id)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._insights_me()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$function$;

-- ------------------------------------------------------------
-- 3. Internal building blocks (NOT callable by clients)
-- ------------------------------------------------------------

-- Everyone who currently counts as the owner's audience: accepted connections
-- (either direction) plus page followers. `since` = when they joined.
CREATE OR REPLACE FUNCTION public._insights_audience(p_owner uuid)
 RETURNS TABLE (uid uuid, since timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.uid, min(a.since) AS since
  FROM (
    SELECT CASE WHEN c.user_one_id = p_owner THEN c.user_two_id ELSE c.user_one_id END AS uid,
           c.updated_at AS since
    FROM public.connections c
    WHERE c.status = 'accepted'
      AND (c.user_one_id = p_owner OR c.user_two_id = p_owner)
    UNION ALL
    SELECT pf.follower_id, pf.created_at
    FROM public.page_followers pf
    WHERE pf.page_id = p_owner
  ) a
  JOIN public.users u ON u.id = a.uid AND COALESCE(u.is_deleted, false) = false
  WHERE a.uid <> p_owner
  GROUP BY a.uid;
$function$;

-- "Someone saw your stuff" rows: post impressions, story impressions, profile
-- visits. Story rows include a synthetic row for every (story, viewer) pair
-- that existed in hotpost_views but has no recorded impression event -- that is
-- how stories viewed BEFORE insights shipped still count.
CREATE OR REPLACE FUNCTION public._insights_exposures(p_owner uuid, p_from timestamptz, p_to timestamptz)
 RETURNS TABLE (kind text, viewer_id uuid, subject_id uuid, source text, from_id uuid, ts timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT e.event_type, e.viewer_id, e.subject_id, e.source, e.from_id, e.created_at
  FROM public.insight_events e
  WHERE e.owner_id = p_owner
    AND e.event_type IN ('post_impression', 'story_impression', 'profile_visit')
    AND e.created_at >= p_from AND e.created_at < p_to
  UNION ALL
  SELECT 'story_impression', hv.viewer_id, hv.hotpost_id, NULL::text, NULL::uuid, hv.viewed_at
  FROM public.hotpost_views hv
  JOIN public.hotposts h ON h.id = hv.hotpost_id
  WHERE h.user_id = p_owner
    AND COALESCE(h.is_deleted, false) = false
    AND COALESCE(hv.is_deleted, false) = false
    AND hv.viewer_id <> p_owner
    AND hv.viewed_at >= p_from AND hv.viewed_at < p_to
    AND NOT EXISTS (
      SELECT 1 FROM public.insight_events e2
      WHERE e2.event_type = 'story_impression'
        AND e2.subject_id = hv.hotpost_id
        AND e2.viewer_id = hv.viewer_id
    );
$function$;

-- "Someone did something with your stuff" rows. Self-interactions excluded.
CREATE OR REPLACE FUNCTION public._insights_interactions(p_owner uuid, p_from timestamptz, p_to timestamptz)
 RETURNS TABLE (kind text, actor_id uuid, subject_id uuid, ts timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT 'like'::text, pl.user_id, pl.post_id, pl.created_at
  FROM public.post_likes pl
  JOIN public.posts p ON p.id = pl.post_id
  WHERE p.user_id = p_owner AND COALESCE(p.is_deleted, false) = false
    AND pl.user_id <> p_owner AND pl.created_at >= p_from AND pl.created_at < p_to
  UNION ALL
  SELECT 'comment', pc.user_id, pc.post_id, pc.created_at
  FROM public.post_comments pc
  JOIN public.posts p ON p.id = pc.post_id
  WHERE p.user_id = p_owner AND COALESCE(p.is_deleted, false) = false
    AND COALESCE(pc.is_deleted, false) = false
    AND pc.user_id <> p_owner AND pc.created_at >= p_from AND pc.created_at < p_to
  UNION ALL
  SELECT 'save', sp.user_id, sp.post_id, sp.created_at
  FROM public.saved_posts sp
  JOIN public.posts p ON p.id = sp.post_id
  WHERE p.user_id = p_owner AND COALESCE(p.is_deleted, false) = false
    AND sp.user_id <> p_owner AND sp.created_at >= p_from AND sp.created_at < p_to
  UNION ALL
  SELECT 'share', e.viewer_id, e.subject_id, e.created_at
  FROM public.insight_events e
  WHERE e.owner_id = p_owner AND e.event_type = 'post_share'
    AND e.created_at >= p_from AND e.created_at < p_to
  UNION ALL
  SELECT 'story_like', hl.user_id, hl.hotpost_id, hl.created_at
  FROM public.hotpost_likes hl
  JOIN public.hotposts h ON h.id = hl.hotpost_id
  WHERE h.user_id = p_owner AND COALESCE(h.is_deleted, false) = false
    AND COALESCE(hl.is_deleted, false) = false
    AND hl.user_id <> p_owner AND hl.created_at >= p_from AND hl.created_at < p_to
  UNION ALL
  SELECT 'story_reply', m.sender_id, m.hotpost_reply_id, m.created_at
  FROM public.messages m
  JOIN public.hotposts h ON h.id = m.hotpost_reply_id
  WHERE h.user_id = p_owner AND COALESCE(h.is_deleted, false) = false
    AND m.sender_id <> p_owner AND COALESCE(m.is_unsent, false) = false
    AND m.created_at >= p_from AND m.created_at < p_to;
$function$;

-- One row per post the owner created in [p_from, p_to), with LIFETIME metrics.
CREATE OR REPLACE FUNCTION public._insights_post_rows(p_owner uuid, p_from timestamptz, p_to timestamptz)
 RETURNS TABLE (
   post_id uuid, post_type text, content text, media_url text,
   created_at timestamptz, expires_at timestamptz, is_archived boolean, is_anonymous boolean,
   reach integer, impressions integer, likes integer, comments integer,
   saves integer, shares integer, link_clicks integer, profile_visits integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.id, p.post_type, left(p.content, 160), p.media_url,
         p.created_at, p.expires_at, COALESCE(p.is_archived, false), COALESCE(p.is_anonymous, false),
         (SELECT count(DISTINCT e.viewer_id)::int FROM public.insight_events e
            WHERE e.event_type = 'post_impression' AND e.subject_id = p.id),
         (SELECT count(*)::int FROM public.insight_events e
            WHERE e.event_type = 'post_impression' AND e.subject_id = p.id),
         (SELECT count(*)::int FROM public.post_likes pl
            WHERE pl.post_id = p.id AND pl.user_id <> p.user_id),
         (SELECT count(*)::int FROM public.post_comments pc
            WHERE pc.post_id = p.id AND COALESCE(pc.is_deleted, false) = false AND pc.user_id <> p.user_id),
         (SELECT count(*)::int FROM public.saved_posts sp
            WHERE sp.post_id = p.id AND sp.user_id <> p.user_id),
         (SELECT count(*)::int FROM public.insight_events e
            WHERE e.event_type = 'post_share' AND e.subject_id = p.id),
         (SELECT count(*)::int FROM public.insight_events e
            WHERE e.event_type = 'post_link_click' AND e.subject_id = p.id),
         (SELECT count(*)::int FROM public.insight_events e
            WHERE e.event_type = 'profile_visit' AND e.from_id = p.id)
  FROM public.posts p
  WHERE p.user_id = p_owner
    AND COALESCE(p.is_deleted, false) = false
    AND p.created_at >= p_from AND p.created_at < p_to
  ORDER BY p.created_at DESC
  LIMIT 300;
$function$;

-- One row per story (hotpost) the owner created in [p_from, p_to), LIFETIME metrics.
CREATE OR REPLACE FUNCTION public._insights_story_rows(p_owner uuid, p_from timestamptz, p_to timestamptz)
 RETURNS TABLE (
   story_id uuid, media_url text, media_type text, created_at timestamptz,
   reach integer, impressions integer, likes integer, replies integer,
   profile_visits integer, forward integer, back integer, next_account integer, exits integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT h.id, h.media_url, h.media_type, h.created_at,
         (SELECT count(DISTINCT x.v)::int FROM (
              SELECT e.viewer_id AS v FROM public.insight_events e
                WHERE e.event_type = 'story_impression' AND e.subject_id = h.id
              UNION
              SELECT hv.viewer_id FROM public.hotpost_views hv
                WHERE hv.hotpost_id = h.id AND hv.viewer_id <> h.user_id
                  AND COALESCE(hv.is_deleted, false) = false
          ) x),
         ((SELECT count(*) FROM public.insight_events e
             WHERE e.event_type = 'story_impression' AND e.subject_id = h.id)
          + (SELECT count(*) FROM public.hotpost_views hv
               WHERE hv.hotpost_id = h.id AND hv.viewer_id <> h.user_id
                 AND COALESCE(hv.is_deleted, false) = false
                 AND NOT EXISTS (SELECT 1 FROM public.insight_events e2
                                   WHERE e2.event_type = 'story_impression'
                                     AND e2.subject_id = h.id AND e2.viewer_id = hv.viewer_id)))::int,
         (SELECT count(*)::int FROM public.hotpost_likes hl
            WHERE hl.hotpost_id = h.id AND COALESCE(hl.is_deleted, false) = false AND hl.user_id <> h.user_id),
         (SELECT count(*)::int FROM public.messages m
            WHERE m.hotpost_reply_id = h.id AND m.sender_id <> h.user_id AND COALESCE(m.is_unsent, false) = false),
         (SELECT count(*)::int FROM public.insight_events e
            WHERE e.event_type = 'profile_visit' AND e.from_id = h.id),
         (SELECT count(*)::int FROM public.insight_events e
            WHERE e.event_type = 'story_tap_forward' AND e.subject_id = h.id),
         (SELECT count(*)::int FROM public.insight_events e
            WHERE e.event_type = 'story_tap_back' AND e.subject_id = h.id),
         (SELECT count(*)::int FROM public.insight_events e
            WHERE e.event_type = 'story_next_account' AND e.subject_id = h.id),
         (SELECT count(*)::int FROM public.insight_events e
            WHERE e.event_type = 'story_exit' AND e.subject_id = h.id)
  FROM public.hotposts h
  WHERE h.user_id = p_owner
    AND COALESCE(h.is_deleted, false) = false
    AND h.created_at >= p_from AND h.created_at < p_to
  ORDER BY h.created_at DESC
  LIMIT 300;
$function$;

-- Headline numbers for one window; called for the current and previous period.
CREATE OR REPLACE FUNCTION public._insights_totals(p_owner uuid, p_from timestamptz, p_to timestamptz)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH ex AS (SELECT * FROM public._insights_exposures(p_owner, p_from, p_to)),
       ix AS (SELECT * FROM public._insights_interactions(p_owner, p_from, p_to))
  SELECT jsonb_build_object(
    'accounts_reached',   (SELECT count(DISTINCT viewer_id) FROM ex),
    'post_reach',         (SELECT count(DISTINCT viewer_id) FROM ex WHERE kind = 'post_impression'),
    'story_reach',        (SELECT count(DISTINCT viewer_id) FROM ex WHERE kind = 'story_impression'),
    'profile_reach',      (SELECT count(DISTINCT viewer_id) FROM ex WHERE kind = 'profile_visit'),
    'impressions',        (SELECT count(*) FROM ex WHERE kind IN ('post_impression', 'story_impression')),
    'post_impressions',   (SELECT count(*) FROM ex WHERE kind = 'post_impression'),
    'story_impressions',  (SELECT count(*) FROM ex WHERE kind = 'story_impression'),
    'profile_visits',     (SELECT count(*) FROM ex WHERE kind = 'profile_visit'),
    'interactions',       (SELECT count(*) FROM ix),
    'likes',              (SELECT count(*) FROM ix WHERE kind = 'like'),
    'comments',           (SELECT count(*) FROM ix WHERE kind = 'comment'),
    'saves',              (SELECT count(*) FROM ix WHERE kind = 'save'),
    'shares',             (SELECT count(*) FROM ix WHERE kind = 'share'),
    'story_likes',        (SELECT count(*) FROM ix WHERE kind = 'story_like'),
    'story_replies',      (SELECT count(*) FROM ix WHERE kind = 'story_reply'),
    'new_audience',       (SELECT count(*) FROM public._insights_audience(p_owner) a
                             WHERE a.since >= p_from AND a.since < p_to)
  );
$function$;

-- Lock the helpers down. (Without this, PUBLIC can EXECUTE them and read anyone's data.)
REVOKE ALL ON FUNCTION public._insights_audience(uuid)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._insights_exposures(uuid, timestamptz, timestamptz)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._insights_interactions(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._insights_post_rows(uuid, timestamptz, timestamptz)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._insights_story_rows(uuid, timestamptz, timestamptz)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._insights_totals(uuid, timestamptz, timestamptz)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._insights_me()                                         FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. WRITE path: record_insight_events
-- ------------------------------------------------------------
-- Called by the client tracker with a small batch. The owner of each event is
-- resolved SERVER-side from the subject, so a client can't attribute an event
-- to someone else's content. Own-content events, unknown subjects and
-- soft-deleted content are silently dropped. Repeats inside a short window are
-- dropped too (a second look at the same post within 30 min is not a new
-- impression), and a viewer is capped at 300 events/minute.
CREATE OR REPLACE FUNCTION public.record_insight_events(p_events jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me       uuid := public._insights_me();
  e          jsonb;
  v_type     text;
  v_subject  uuid;
  v_from     uuid;
  v_source   text;
  v_owner    uuid;
  v_window   interval;
  v_count    integer := 0;
BEGIN
  IF v_me IS NULL OR p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN 0;
  END IF;

  IF (SELECT count(*) FROM public.insight_events WHERE viewer_id = v_me
        AND created_at > now() - interval '1 minute') > 300 THEN
    RETURN 0;
  END IF;

  FOR e IN SELECT value FROM jsonb_array_elements(p_events) LIMIT 60 LOOP
    v_owner := NULL;
    BEGIN
      v_type    := e->>'type';
      v_source  := left(COALESCE(e->>'source', ''), 24);
      v_subject := NULLIF(e->>'subject_id', '')::uuid;
      v_from    := NULLIF(e->>'from_id', '')::uuid;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;

    IF v_type IS NULL OR v_subject IS NULL THEN CONTINUE; END IF;

    IF v_type IN ('post_impression', 'post_share', 'post_link_click') THEN
      SELECT p.user_id INTO v_owner FROM public.posts p
        WHERE p.id = v_subject AND COALESCE(p.is_deleted, false) = false;
    ELSIF v_type IN ('story_impression', 'story_tap_forward', 'story_tap_back',
                     'story_next_account', 'story_exit') THEN
      SELECT h.user_id INTO v_owner FROM public.hotposts h
        WHERE h.id = v_subject AND COALESCE(h.is_deleted, false) = false;
    ELSIF v_type = 'profile_visit' THEN
      SELECT u.id INTO v_owner FROM public.users u
        WHERE u.id = v_subject AND COALESCE(u.is_deleted, false) = false;
    ELSE
      CONTINUE; -- unknown type
    END IF;

    IF v_owner IS NULL OR v_owner = v_me THEN CONTINUE; END IF;

    v_window := CASE v_type
      WHEN 'post_impression'  THEN interval '30 minutes'
      WHEN 'profile_visit'    THEN interval '30 minutes'
      WHEN 'story_impression' THEN interval '5 seconds'
      WHEN 'post_link_click'  THEN interval '5 seconds'
      ELSE interval '0 seconds' END;

    IF v_window > interval '0 seconds' AND EXISTS (
         SELECT 1 FROM public.insight_events x
         WHERE x.event_type = v_type AND x.subject_id = v_subject
           AND x.viewer_id = v_me AND x.created_at > now() - v_window) THEN
      CONTINUE;
    END IF;

    -- from_id is only meaningful for profile visits, and only if it points at
    -- content that really belongs to the visited profile.
    IF v_type = 'profile_visit' AND v_from IS NOT NULL THEN
      IF NOT (EXISTS (SELECT 1 FROM public.posts p WHERE p.id = v_from AND p.user_id = v_owner)
              OR EXISTS (SELECT 1 FROM public.hotposts h WHERE h.id = v_from AND h.user_id = v_owner)) THEN
        v_from := NULL;
      END IF;
    ELSIF v_type <> 'profile_visit' THEN
      v_from := NULL;
    END IF;

    INSERT INTO public.insight_events (event_type, owner_id, viewer_id, subject_id, source, from_id)
    VALUES (v_type, v_owner, v_me, v_subject, NULLIF(v_source, ''), v_from);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- ------------------------------------------------------------
-- 5. READ path (all scoped to the caller's own content)
-- ------------------------------------------------------------

-- Overview tab: headline numbers vs the previous period, a per-day series,
-- reach split, interactions, and top content.
--   p_days: window length in days (1..365). p_tz: viewer's UTC offset in minutes.
CREATE OR REPLACE FUNCTION public.insights_account_overview(p_days integer DEFAULT 7, p_tz integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me        uuid := public._insights_me();
  v_days      integer := LEAST(GREATEST(COALESCE(p_days, 7), 1), 365);
  v_tz        interval := make_interval(mins => LEAST(GREATEST(COALESCE(p_tz, 0), -840), 840));
  v_today     date := ((now() AT TIME ZONE 'UTC') + v_tz)::date;
  v_from      timestamptz := (((v_today - (v_days - 1))::timestamp) - v_tz) AT TIME ZONE 'UTC';
  v_to        timestamptz := now() + interval '1 minute';
  v_prev_from timestamptz;
  v_series    jsonb;
  v_split     jsonb;
  v_top_posts jsonb;
  v_top_stories jsonb;
  v_counts    jsonb;
  v_current   jsonb;
  v_previous  jsonb;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  v_prev_from := v_from - make_interval(days => v_days);

  v_current  := public._insights_totals(v_me, v_from, v_to);
  v_previous := public._insights_totals(v_me, v_prev_from, v_from);

  -- Per-day series (local days, zero-filled).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'd', to_char(d.day, 'YYYY-MM-DD'),
           'reach', COALESCE(r.reach, 0),
           'impressions', COALESCE(r.imp, 0),
           'interactions', COALESCE(i.n, 0)) ORDER BY d.day), '[]'::jsonb)
    INTO v_series
  FROM (SELECT (v_today - (v_days - 1) + g) AS day FROM generate_series(0, v_days - 1) g) d
  LEFT JOIN (
    SELECT ((ts AT TIME ZONE 'UTC') + v_tz)::date AS day,
           count(DISTINCT viewer_id) AS reach,
           count(*) FILTER (WHERE kind IN ('post_impression', 'story_impression')) AS imp
    FROM public._insights_exposures(v_me, v_from, v_to)
    GROUP BY 1
  ) r ON r.day = d.day
  LEFT JOIN (
    SELECT ((ts AT TIME ZONE 'UTC') + v_tz)::date AS day, count(*) AS n
    FROM public._insights_interactions(v_me, v_from, v_to)
    GROUP BY 1
  ) i ON i.day = d.day;

  -- Reach split: audience members vs everyone else.
  SELECT jsonb_build_object(
           'connections', count(*) FILTER (WHERE a.uid IS NOT NULL),
           'others',      count(*) FILTER (WHERE a.uid IS NULL))
    INTO v_split
  FROM (SELECT DISTINCT viewer_id FROM public._insights_exposures(v_me, v_from, v_to)) v
  LEFT JOIN public._insights_audience(v_me) a ON a.uid = v.viewer_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'ord' ORDER BY t.ord), '[]'::jsonb) INTO v_top_posts
  FROM (SELECT r.*, row_number() OVER (ORDER BY r.reach DESC,
                                       (r.likes + r.comments + r.saves + r.shares) DESC,
                                       r.created_at DESC) AS ord
        FROM public._insights_post_rows(v_me, v_from, v_to) r) t
  WHERE t.ord <= 5 AND (t.reach > 0 OR t.likes + t.comments + t.saves + t.shares > 0);

  SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'ord' ORDER BY t.ord), '[]'::jsonb) INTO v_top_stories
  FROM (SELECT r.*, row_number() OVER (ORDER BY r.reach DESC, (r.likes + r.replies) DESC,
                                       r.created_at DESC) AS ord
        FROM public._insights_story_rows(v_me, v_from, v_to) r) t
  WHERE t.ord <= 5 AND (t.reach > 0 OR t.likes + t.replies > 0);

  SELECT jsonb_build_object(
           'posts',   (SELECT count(*) FROM public.posts p WHERE p.user_id = v_me
                         AND COALESCE(p.is_deleted, false) = false
                         AND p.created_at >= v_from AND p.created_at < v_to),
           'stories', (SELECT count(*) FROM public.hotposts h WHERE h.user_id = v_me
                         AND COALESCE(h.is_deleted, false) = false
                         AND h.created_at >= v_from AND h.created_at < v_to))
    INTO v_counts;

  RETURN jsonb_build_object(
    'days', v_days,
    'from', v_from,
    'current', v_current,
    'previous', v_previous,
    'series', v_series,
    'reach_split', v_split,
    'content_counts', v_counts,
    'top_posts', v_top_posts,
    'top_stories', v_top_stories
  );
END;
$function$;

-- Content tab: the caller's posts or stories created in the window, with
-- lifetime metrics, sorted server-side. p_days = 0 means "all time".
CREATE OR REPLACE FUNCTION public.insights_content_list(
    p_kind text DEFAULT 'posts', p_days integer DEFAULT 30, p_sort text DEFAULT 'recent',
    p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me     uuid := public._insights_me();
  v_from   timestamptz;
  v_to     timestamptz := now() + interval '1 minute';
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_out    jsonb;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF COALESCE(p_days, 30) <= 0 THEN
    v_from := 'epoch'::timestamptz;
  ELSE
    v_from := now() - make_interval(days => LEAST(p_days, 365));
  END IF;

  IF p_kind = 'stories' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'ord' ORDER BY t.ord), '[]'::jsonb) INTO v_out
    FROM (SELECT r.*, row_number() OVER (ORDER BY
            CASE p_sort WHEN 'reach' THEN r.reach WHEN 'impressions' THEN r.impressions
                        WHEN 'likes' THEN r.likes WHEN 'replies' THEN r.replies
                        WHEN 'interactions' THEN r.likes + r.replies ELSE 0 END DESC,
            r.created_at DESC) AS ord
          FROM public._insights_story_rows(v_me, v_from, v_to) r
          ORDER BY ord
          LIMIT v_limit OFFSET v_offset) t;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'ord' ORDER BY t.ord), '[]'::jsonb) INTO v_out
    FROM (SELECT r.*, row_number() OVER (ORDER BY
            CASE p_sort WHEN 'reach' THEN r.reach WHEN 'impressions' THEN r.impressions
                        WHEN 'likes' THEN r.likes WHEN 'comments' THEN r.comments
                        WHEN 'saves' THEN r.saves WHEN 'shares' THEN r.shares
                        WHEN 'interactions' THEN r.likes + r.comments + r.saves + r.shares
                        ELSE 0 END DESC,
            r.created_at DESC) AS ord
          FROM public._insights_post_rows(v_me, v_from, v_to) r
          ORDER BY ord
          LIMIT v_limit OFFSET v_offset) t;
  END IF;

  RETURN v_out;
END;
$function$;

-- Post detail. Owner-only: anyone else's post id looks like "not found".
CREATE OR REPLACE FUNCTION public.insights_post_detail(p_post_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me       uuid := public._insights_me();
  v_post     public.posts%ROWTYPE;
  v_row      record;
  v_split    jsonb;
  v_sources  jsonb;
  v_timeline jsonb;
  v_extra    jsonb := '{}'::jsonb;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO v_post FROM public.posts
    WHERE id = p_post_id AND user_id = v_me AND COALESCE(is_deleted, false) = false;
  IF NOT FOUND THEN RAISE EXCEPTION 'Post not found'; END IF;

  SELECT * INTO v_row
    FROM public._insights_post_rows(v_me, v_post.created_at, v_post.created_at + interval '1 second')
    WHERE post_id = p_post_id;

  SELECT jsonb_build_object(
           'connections', count(*) FILTER (WHERE a.uid IS NOT NULL),
           'others',      count(*) FILTER (WHERE a.uid IS NULL))
    INTO v_split
  FROM (SELECT DISTINCT e.viewer_id FROM public.insight_events e
          WHERE e.event_type = 'post_impression' AND e.subject_id = p_post_id) v
  LEFT JOIN public._insights_audience(v_me) a ON a.uid = v.viewer_id;

  SELECT COALESCE(jsonb_object_agg(s.src, s.n), '{}'::jsonb) INTO v_sources
  FROM (SELECT COALESCE(e.source, 'other') AS src, count(*) AS n
          FROM public.insight_events e
          WHERE e.event_type = 'post_impression' AND e.subject_id = p_post_id
          GROUP BY 1) s;

  -- Hour-by-hour since posting (first 48 hours): impressions and interactions.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'h', g.h,
           'impressions', COALESCE(i.n, 0),
           'interactions', COALESCE(xr.n, 0)) ORDER BY g.h), '[]'::jsonb)
    INTO v_timeline
  FROM generate_series(0, 47) AS g(h)
  LEFT JOIN (
    SELECT floor(extract(epoch FROM (e.created_at - v_post.created_at)) / 3600)::int AS h, count(*) AS n
    FROM public.insight_events e
    WHERE e.event_type = 'post_impression' AND e.subject_id = p_post_id
    GROUP BY 1) i ON i.h = g.h
  LEFT JOIN (
    SELECT floor(extract(epoch FROM (ia.ts - v_post.created_at)) / 3600)::int AS h, count(*) AS n
    FROM public._insights_interactions(v_me, v_post.created_at, now() + interval '1 minute') ia
    WHERE ia.subject_id = p_post_id
    GROUP BY 1) xr ON xr.h = g.h;

  IF v_post.post_type = 'poll' THEN
    v_extra := jsonb_build_object(
      'poll_votes', (SELECT count(DISTINCT pv.user_id) FROM public.post_poll_votes pv WHERE pv.post_id = p_post_id));
  ELSIF v_post.post_type = 'event' THEN
    v_extra := jsonb_build_object(
      'rsvp_attending', (SELECT count(*) FROM public.post_event_rsvps r WHERE r.post_id = p_post_id AND r.status = 'attending'),
      'rsvp_maybe',     (SELECT count(*) FROM public.post_event_rsvps r WHERE r.post_id = p_post_id AND r.status = 'maybe'));
  END IF;

  RETURN jsonb_build_object(
    'post_id', v_row.post_id,
    'post_type', v_row.post_type,
    'content', v_row.content,
    'media_url', v_row.media_url,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at,
    'is_archived', v_row.is_archived,
    'is_anonymous', v_row.is_anonymous,
    'reach', v_row.reach,
    'impressions', v_row.impressions,
    'likes', v_row.likes,
    'comments', v_row.comments,
    'saves', v_row.saves,
    'shares', v_row.shares,
    'link_clicks', v_row.link_clicks,
    'profile_visits', v_row.profile_visits,
    'reach_split', v_split,
    'sources', v_sources,
    'timeline', v_timeline,
    'extra', v_extra
  );
END;
$function$;

-- Story detail. Owner-only.
CREATE OR REPLACE FUNCTION public.insights_story_detail(p_story_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me       uuid := public._insights_me();
  v_story    public.hotposts%ROWTYPE;
  v_row      record;
  v_split    jsonb;
  v_timeline jsonb;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO v_story FROM public.hotposts
    WHERE id = p_story_id AND user_id = v_me AND COALESCE(is_deleted, false) = false;
  IF NOT FOUND THEN RAISE EXCEPTION 'Story not found'; END IF;

  SELECT * INTO v_row
    FROM public._insights_story_rows(v_me, v_story.created_at, v_story.created_at + interval '1 second')
    WHERE story_id = p_story_id;

  SELECT jsonb_build_object(
           'connections', count(*) FILTER (WHERE a.uid IS NOT NULL),
           'others',      count(*) FILTER (WHERE a.uid IS NULL))
    INTO v_split
  FROM (SELECT DISTINCT x.v FROM (
            SELECT e.viewer_id AS v FROM public.insight_events e
              WHERE e.event_type = 'story_impression' AND e.subject_id = p_story_id
            UNION
            SELECT hv.viewer_id FROM public.hotpost_views hv
              WHERE hv.hotpost_id = p_story_id AND hv.viewer_id <> v_me
                AND COALESCE(hv.is_deleted, false) = false) x) v
  LEFT JOIN public._insights_audience(v_me) a ON a.uid = v.v;

  -- Views per hour over the story's first 24 hours (uses hotpost_views so it
  -- also covers views from before insights existed).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('h', g.h, 'views', COALESCE(t.n, 0)) ORDER BY g.h), '[]'::jsonb)
    INTO v_timeline
  FROM generate_series(0, 23) AS g(h)
  LEFT JOIN (
    SELECT floor(extract(epoch FROM (hv.viewed_at - v_story.created_at)) / 3600)::int AS h, count(*) AS n
    FROM public.hotpost_views hv
    WHERE hv.hotpost_id = p_story_id AND hv.viewer_id <> v_me AND COALESCE(hv.is_deleted, false) = false
    GROUP BY 1) t ON t.h = g.h;

  RETURN jsonb_build_object(
    'story_id', v_row.story_id,
    'media_url', v_row.media_url,
    'media_type', v_row.media_type,
    'created_at', v_row.created_at,
    'reach', v_row.reach,
    'impressions', v_row.impressions,
    'likes', v_row.likes,
    'replies', v_row.replies,
    'profile_visits', v_row.profile_visits,
    'forward', v_row.forward,
    'back', v_row.back,
    'next_account', v_row.next_account,
    'exits', v_row.exits,
    'reach_split', v_split,
    'timeline', v_timeline
  );
END;
$function$;

-- Audience tab: size, growth, demographics (privacy-thresholded), and when
-- people look at your content.
CREATE OR REPLACE FUNCTION public.insights_audience(p_days integer DEFAULT 30, p_tz integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me        uuid := public._insights_me();
  v_role      text;
  v_days      integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_tz        interval := make_interval(mins => LEAST(GREATEST(COALESCE(p_tz, 0), -840), 840));
  v_today     date := ((now() AT TIME ZONE 'UTC') + v_tz)::date;
  v_from      timestamptz := (((v_today - (v_days - 1))::timestamp) - v_tz) AT TIME ZONE 'UTC';
  v_to        timestamptz := now() + interval '1 minute';
  v_prev_from timestamptz;
  v_act_from  timestamptz := now() - make_interval(days => GREATEST(v_days, 30));
  v_total     integer;
  v_growth    jsonb;
  v_gender    jsonb := '[]'::jsonb;
  v_course    jsonb := '[]'::jsonb;
  v_activity  jsonb;
  v_gained    integer;
  v_gained_prev integer;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  v_prev_from := v_from - make_interval(days => v_days);
  SELECT role INTO v_role FROM public.users WHERE id = v_me;

  SELECT count(*) INTO v_total FROM public._insights_audience(v_me);
  SELECT count(*) INTO v_gained FROM public._insights_audience(v_me) a WHERE a.since >= v_from AND a.since < v_to;
  SELECT count(*) INTO v_gained_prev FROM public._insights_audience(v_me) a WHERE a.since >= v_prev_from AND a.since < v_from;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('d', to_char(d.day, 'YYYY-MM-DD'), 'new', COALESCE(n.c, 0))
                            ORDER BY d.day), '[]'::jsonb)
    INTO v_growth
  FROM (SELECT (v_today - (v_days - 1) + g) AS day FROM generate_series(0, v_days - 1) g) d
  LEFT JOIN (
    SELECT ((a.since AT TIME ZONE 'UTC') + v_tz)::date AS day, count(*) AS c
    FROM public._insights_audience(v_me) a
    WHERE a.since >= v_from AND a.since < v_to
    GROUP BY 1) n ON n.day = d.day;

  -- Demographics only for audiences of 5+, and buckets under 3 fold into "Other".
  IF v_total >= 5 THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('label', b.label, 'count', b.n) ORDER BY (b.label = 'Other'), b.n DESC), '[]'::jsonb)
      INTO v_gender
    FROM (SELECT CASE WHEN g.n >= 3 THEN g.label ELSE 'Other' END AS label, sum(g.n)::int AS n
            FROM (SELECT initcap(COALESCE(NULLIF(btrim(u.gender), ''), 'Not specified')) AS label, count(*) AS n
                    FROM public._insights_audience(v_me) a
                    JOIN public.users u ON u.id = a.uid
                    GROUP BY 1) g
            GROUP BY 1) b;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('label', b.label, 'count', b.n) ORDER BY (b.label = 'Other'), b.n DESC), '[]'::jsonb)
      INTO v_course
    FROM (SELECT CASE WHEN g.n >= 3 THEN g.label ELSE 'Other' END AS label, sum(g.n)::int AS n
            FROM (SELECT left(COALESCE(NULLIF(btrim(u.course), ''), 'Not specified'), 60) AS label, count(*) AS n
                    FROM public._insights_audience(v_me) a
                    JOIN public.users u ON u.id = a.uid
                    GROUP BY 1) g
            GROUP BY 1
            ORDER BY 2 DESC
            LIMIT 8) b;
  END IF;

  -- When people look at your content: 7 (weekday, Sunday=0) x 24 (hour) grid, in the viewer's local time.
  WITH ex AS (
    SELECT extract(dow  FROM ((x.ts AT TIME ZONE 'UTC') + v_tz))::int AS dow,
           extract(hour FROM ((x.ts AT TIME ZONE 'UTC') + v_tz))::int AS h
    FROM public._insights_exposures(v_me, v_act_from, v_to) x
  ), cnt AS (
    SELECT ex.dow, ex.h, count(*) AS n FROM ex GROUP BY 1, 2
  )
  SELECT COALESCE(jsonb_agg(r.row_counts ORDER BY r.dow), '[]'::jsonb) INTO v_activity
  FROM (
    SELECT dw.dow,
           (SELECT jsonb_agg(COALESCE(c.n, 0) ORDER BY hh.h)
              FROM generate_series(0, 23) hh(h)
              LEFT JOIN cnt c ON c.dow = dw.dow AND c.h = hh.h) AS row_counts
    FROM generate_series(0, 6) dw(dow)
  ) r;

  RETURN jsonb_build_object(
    'kind', CASE WHEN v_role = 'page' THEN 'followers' ELSE 'connections' END,
    'total', v_total,
    'gained', v_gained,
    'gained_previous', v_gained_prev,
    'growth', v_growth,
    'gender', v_gender,
    'course', v_course,
    'demographics_hidden', v_total < 5,
    'activity', v_activity,
    'activity_days', GREATEST(v_days, 30)
  );
END;
$function$;

-- ------------------------------------------------------------
-- 6. Grants: signed-in users only, never anon
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_insight_events(jsonb)                              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.insights_account_overview(integer, integer)               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.insights_content_list(text, integer, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.insights_post_detail(uuid)                                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.insights_story_detail(uuid)                               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.insights_audience(integer, integer)                       FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_insight_events(jsonb)                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.insights_account_overview(integer, integer)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.insights_content_list(text, integer, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insights_post_detail(uuid)                                TO authenticated;
GRANT EXECUTE ON FUNCTION public.insights_story_detail(uuid)                               TO authenticated;
GRANT EXECUTE ON FUNCTION public.insights_audience(integer, integer)                       TO authenticated;

-- ------------------------------------------------------------
-- 7. Optional housekeeping (NOT scheduled automatically)
-- ------------------------------------------------------------
-- The event log only grows. Run this by hand now and then, or schedule it with
-- pg_cron if you enable that extension. Not granted to any client role.
CREATE OR REPLACE FUNCTION public.insights_purge_old_events(p_keep_days integer DEFAULT 180)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM public.insight_events
   WHERE created_at < now() - make_interval(days => GREATEST(p_keep_days, 30));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
REVOKE ALL ON FUNCTION public.insights_purge_old_events(integer) FROM PUBLIC, anon, authenticated;
-- Usage (SQL editor):  SELECT public.insights_purge_old_events(180);
