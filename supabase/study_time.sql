-- ============================================================
-- STUDY TIME + LEADERBOARD — backs www/study-time.js and the Leaderboard
-- pill in www/search.js
-- ============================================================
-- Run this once against the live database (Supabase SQL Editor) in the MAIN
-- app project (not the separate BAFs-content project). Idempotent: safe to
-- re-run.
--
-- What it stores: seconds spent with the in-app PDF viewer open, one row per
-- user per calendar day (Asia/Kolkata -- this is a single-college app, so the
-- day boundary is fixed rather than per-device).
--
-- Access model (same philosophy as insights.sql / admin_panel.sql):
--   * Both tables have RLS on and NO policies, and every table privilege is
--     revoked from anon/authenticated. The only way in or out is a
--     SECURITY DEFINER function.
--   * Every function derives "who is asking" from auth.uid() via
--     public.users.auth_user_id. No function accepts a user id from the client.
--   * Internal helpers (_study_*) are REVOKED from PUBLIC/anon/authenticated.
--     Postgres grants EXECUTE to PUBLIC by default, so that REVOKE is
--     load-bearing, not decoration.
--
-- NAME HIDING IS ENFORCED HERE, NOT IN THE UI. When someone hides their name
-- for a period (daily / weekly / all-time), study_leaderboard() returns their
-- row with user_id, full_name, profile_img_url and tick_type all NULL -- the
-- client never receives who it is, so a modified client can't recover it. Their
-- rank and time still count, so the board stays honest. The person themself
-- always sees their own row (flagged is_me). Users you have blocked, or who
-- blocked you, are masked the same way.
--
-- Known limits (also in docs/STUDY_TIME.md):
--   * Time is reported by the client. The caps below stop absurd values but a
--     determined user with a script can still claim up to the daily ceiling.
--   * A retry after a lost response can double-count one small batch.
-- ============================================================

-- Same statement as admin_panel.sql; harmless if that has already been run.
-- Repeated here so this file doesn't depend on run order.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_suspended boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.study_time_daily (
  user_id    uuid    NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  day        date    NOT NULL,                       -- IST calendar day
  seconds    integer NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS study_time_daily_day_idx ON public.study_time_daily (day);

-- One row per user, only created once they touch a switch. Absent row = show name everywhere.
CREATE TABLE IF NOT EXISTS public.study_leaderboard_prefs (
  user_id      uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  hide_daily   boolean NOT NULL DEFAULT false,
  hide_weekly  boolean NOT NULL DEFAULT false,
  hide_alltime boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.study_time_daily        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_leaderboard_prefs ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: nobody reads or writes these tables directly.
REVOKE ALL ON public.study_time_daily        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.study_leaderboard_prefs FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Internal helpers (NOT callable by clients)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._study_me()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$function$;

-- "Today" for the leaderboard. Must match istDay() in www/study-time.js.
CREATE OR REPLACE FUNCTION public._study_today()
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date;
$function$;

-- Everyone with study time in [p_from, p_to], ranked. Ties share a rank.
-- Only accounts that are still active appear; Pages (official accounts) never do.
CREATE OR REPLACE FUNCTION public._study_ranked(p_from date, p_to date)
 RETURNS TABLE (user_id uuid, secs integer, rnk bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.user_id, a.secs, rank() OVER (ORDER BY a.secs DESC)
  FROM (
    SELECT s.user_id, sum(s.seconds)::integer AS secs
    FROM public.study_time_daily s
    JOIN public.users u ON u.id = s.user_id
     AND COALESCE(u.is_deleted, false)     = false
     AND COALESCE(u.is_deactivated, false) = false
     AND COALESCE(u.is_suspended, false)   = false
     AND COALESCE(u.role, 'student') <> 'page'
    WHERE s.day >= p_from AND s.day <= p_to
    GROUP BY s.user_id
    HAVING sum(s.seconds) > 0
  ) a;
$function$;

REVOKE ALL ON FUNCTION public._study_me()                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._study_ranked(date, date)     FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. WRITE path: record_study_time
-- ------------------------------------------------------------
-- Called by the client tracker with the seconds it has accumulated for one IST
-- day. Returns how many seconds were actually credited (0 = dropped).
--   * only today or the previous 2 days (an offline session synced later is
--     fine; anything older or in the future is dropped, not errored, so the
--     client can safely discard it)
--   * at most 4 h per call (a long offline backlog) and 12 h per day in total
--   * deleted / suspended accounts are ignored
CREATE OR REPLACE FUNCTION public.record_study_time(p_day date, p_seconds integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me     uuid := public._study_me();
  v_today  date := public._study_today();
  v_used   integer;
  v_credit integer;
BEGIN
  IF v_me IS NULL OR p_day IS NULL OR p_seconds IS NULL OR p_seconds <= 0 THEN
    RETURN 0;
  END IF;
  IF p_day > v_today OR p_day < v_today - 2 THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = v_me
      AND COALESCE(is_deleted, false)   = false
      AND COALESCE(is_suspended, false) = false
  ) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(sum(seconds), 0) INTO v_used
  FROM public.study_time_daily WHERE user_id = v_me AND day = p_day;

  v_credit := least(p_seconds, 14400, GREATEST(43200 - v_used, 0));
  IF v_credit <= 0 THEN RETURN 0; END IF;

  INSERT INTO public.study_time_daily AS s (user_id, day, seconds)
  VALUES (v_me, p_day, v_credit)
  ON CONFLICT (user_id, day)
  DO UPDATE SET seconds = s.seconds + EXCLUDED.seconds, updated_at = now();

  RETURN v_credit;
END;
$function$;

-- ------------------------------------------------------------
-- 4. READ path: study_leaderboard
-- ------------------------------------------------------------
-- p_period: 'daily' (today, IST) | 'weekly' (Mon-today, IST) | 'alltime'.
-- One round trip returns everything the screen needs:
--   period, participants, entries[], me, totals, prefs
-- entries[] is the top p_limit (max 100). Each entry:
--   rank, seconds, is_me, hidden, user_id, full_name, profile_img_url, tick_type
-- For a hidden/blocked entry (never yourself) the last four identity fields are
-- NULL and hidden = true. For your own entry, hidden is YOUR setting for this
-- period and your identity is always present.
-- me is your row even when you are outside the top p_limit (NULL if you have no
-- time in the period). totals/prefs are always about the caller.
CREATE OR REPLACE FUNCTION public.study_leaderboard(p_period text, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me       uuid := public._study_me();
  v_today    date := public._study_today();
  v_week     date := date_trunc('week', public._study_today()::timestamp)::date;  -- Monday (ISO week)
  v_from     date;
  v_limit    integer := least(greatest(COALESCE(p_limit, 50), 1), 100);
  v_hide     boolean;
  v_entries  jsonb;
  v_me_row   jsonb;
  v_count    integer;
  v_totals   jsonb;
  v_prefs    jsonb;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF p_period IS NULL OR p_period NOT IN ('daily', 'weekly', 'alltime') THEN
    RAISE EXCEPTION 'p_period must be daily, weekly or alltime';
  END IF;

  v_from := CASE p_period
              WHEN 'daily'  THEN v_today
              WHEN 'weekly' THEN v_week
              ELSE DATE '1970-01-01'
            END;

  SELECT count(*) INTO v_count FROM public._study_ranked(v_from, v_today);

  -- Top N. Identity is only included when the row is yours, or it is neither
  -- hidden by its owner for THIS period nor blocked either way with you.
  SELECT COALESCE(jsonb_agg(t.entry ORDER BY t.rnk, t.tie), '[]'::jsonb) INTO v_entries
  FROM (
    SELECT r.rnk, r.user_id AS tie,
           jsonb_build_object(
             'rank',    r.rnk,
             'seconds', r.secs,
             'is_me',   (r.user_id = v_me),
             'hidden',  x.hidden,
             'user_id',         CASE WHEN r.user_id = v_me OR NOT x.masked THEN r.user_id         END,
             'full_name',       CASE WHEN r.user_id = v_me OR NOT x.masked THEN u.full_name       END,
             'profile_img_url', CASE WHEN r.user_id = v_me OR NOT x.masked THEN u.profile_img_url END,
             'tick_type',       CASE WHEN r.user_id = v_me OR NOT x.masked THEN u.tick_type       END
           ) AS entry
    FROM public._study_ranked(v_from, v_today) r
    JOIN public.users u ON u.id = r.user_id
    LEFT JOIN public.study_leaderboard_prefs p ON p.user_id = r.user_id
    CROSS JOIN LATERAL (
      SELECT
        CASE p_period WHEN 'daily'  THEN COALESCE(p.hide_daily,  false)
                      WHEN 'weekly' THEN COALESCE(p.hide_weekly, false)
                      ELSE               COALESCE(p.hide_alltime, false) END AS hidden,
        (
          CASE p_period WHEN 'daily'  THEN COALESCE(p.hide_daily,  false)
                        WHEN 'weekly' THEN COALESCE(p.hide_weekly, false)
                        ELSE               COALESCE(p.hide_alltime, false) END
          OR EXISTS (
            SELECT 1 FROM public.connections c
            WHERE c.status = 'blocked'
              AND ((c.user_one_id = v_me AND c.user_two_id = r.user_id)
                OR (c.user_two_id = v_me AND c.user_one_id = r.user_id))
          )
        ) AS masked
    ) x
    ORDER BY r.rnk, r.user_id
    LIMIT v_limit
  ) t;

  -- The caller's own row, wherever it falls.
  SELECT jsonb_build_object(
           'rank', r.rnk, 'seconds', r.secs,
           'hidden', CASE p_period WHEN 'daily'  THEN COALESCE(p.hide_daily,  false)
                                   WHEN 'weekly' THEN COALESCE(p.hide_weekly, false)
                                   ELSE               COALESCE(p.hide_alltime, false) END)
    INTO v_me_row
  FROM public._study_ranked(v_from, v_today) r
  LEFT JOIN public.study_leaderboard_prefs p ON p.user_id = r.user_id
  WHERE r.user_id = v_me;

  SELECT jsonb_build_object(
           'today',   COALESCE(sum(seconds) FILTER (WHERE day = v_today), 0),
           'week',    COALESCE(sum(seconds) FILTER (WHERE day >= v_week), 0),
           'alltime', COALESCE(sum(seconds), 0))
    INTO v_totals
  FROM public.study_time_daily
  WHERE user_id = v_me AND day <= v_today;

  SELECT jsonb_build_object(
           'daily',   COALESCE(hide_daily,   false),
           'weekly',  COALESCE(hide_weekly,  false),
           'alltime', COALESCE(hide_alltime, false))
    INTO v_prefs
  FROM public.study_leaderboard_prefs WHERE user_id = v_me;

  RETURN jsonb_build_object(
    'period',       p_period,
    'participants', v_count,
    'entries',      v_entries,
    'me',           v_me_row,
    'totals',       v_totals,
    'prefs',        COALESCE(v_prefs, jsonb_build_object('daily', false, 'weekly', false, 'alltime', false))
  );
END;
$function$;

-- ------------------------------------------------------------
-- 5. Name-hiding preference
-- ------------------------------------------------------------
-- Sets ONE period's switch (so two quick taps on different switches can't
-- overwrite each other) and returns all three so the client can re-sync.
CREATE OR REPLACE FUNCTION public.study_set_name_hidden(p_period text, p_hidden boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me    uuid := public._study_me();
  v_prefs jsonb;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF p_period IS NULL OR p_period NOT IN ('daily', 'weekly', 'alltime') THEN
    RAISE EXCEPTION 'p_period must be daily, weekly or alltime';
  END IF;
  IF p_hidden IS NULL THEN
    RAISE EXCEPTION 'p_hidden is required';
  END IF;

  INSERT INTO public.study_leaderboard_prefs AS s (user_id, hide_daily, hide_weekly, hide_alltime)
  VALUES (v_me,
          (p_period = 'daily'   AND p_hidden),
          (p_period = 'weekly'  AND p_hidden),
          (p_period = 'alltime' AND p_hidden))
  ON CONFLICT (user_id) DO UPDATE SET
    hide_daily   = CASE WHEN p_period = 'daily'   THEN p_hidden ELSE s.hide_daily   END,
    hide_weekly  = CASE WHEN p_period = 'weekly'  THEN p_hidden ELSE s.hide_weekly  END,
    hide_alltime = CASE WHEN p_period = 'alltime' THEN p_hidden ELSE s.hide_alltime END,
    updated_at   = now();

  SELECT jsonb_build_object('daily', hide_daily, 'weekly', hide_weekly, 'alltime', hide_alltime)
    INTO v_prefs
  FROM public.study_leaderboard_prefs WHERE user_id = v_me;

  RETURN v_prefs;
END;
$function$;

-- ------------------------------------------------------------
-- 6. Grants (signed-in users only; never anon)
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_study_time(date, integer)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.study_leaderboard(text, integer)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.study_set_name_hidden(text, boolean)    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_study_time(date, integer)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.study_leaderboard(text, integer)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.study_set_name_hidden(text, boolean) TO authenticated;
