-- ============================================================
-- PAGE MINI APPS — backs www/page-mini-apps.js and the Mini Apps tray in
-- www/mini-apps.js
-- ============================================================
-- Run this once against the live database (Supabase SQL Editor) in the MAIN
-- app project. Idempotent: safe to re-run.
--
-- What it stores: the "Mini Apps" a Page (users.role = 'page', an official
-- account) publishes — a name, an optional icon image, the https URL of the
-- Page's own separate web app, whether it opens inside ECampus, and whether
-- it is currently visible (active) or hidden. A Page can keep up to 10.
-- Active mini apps of active Pages show as circles at the top of Home for
-- everyone (except people who blocked / were blocked by that Page).
--
-- Access model (same philosophy as study_time.sql / insights.sql):
--   * The table has RLS on and NO policies, and every table privilege is
--     revoked from anon/authenticated. The only way in or out is a
--     SECURITY DEFINER function.
--   * Every function derives "who is asking" from auth.uid() via
--     public.users.auth_user_id. No function accepts a user/page id from the
--     client for "who am I"; writes only ever touch the caller's own rows.
--   * Only accounts with role = 'page' can create / edit / hide / delete.
--   * The internal helper (_mini_app_page) is REVOKED from PUBLIC. Postgres
--     grants EXECUTE to PUBLIC by default, so that REVOKE is what keeps it
--     private.
--
-- Privacy note: when a student opens a mini app, ECampus appends their
-- student_id (offset, see www/link-params.js), name, course, profile picture
-- URL and theme to the Page's URL. That is the point of the feature, but it
-- means a Page's app receives those details — only approve Pages you trust.
--
-- To show mini apps only to people who FOLLOW the Page instead of everyone,
-- add to the WHERE clause of mini_apps_list():
--   AND EXISTS (SELECT 1 FROM public.page_followers f
--               WHERE f.page_id = m.page_id AND f.follower_id = v_me)
-- (check the column names in schema.sql first).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.page_mini_apps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 20),
  url         text NOT NULL CHECK (url ~* '^https://[^[:space:]]+$' AND char_length(url) <= 500),
  icon_url    text CHECK (icon_url IS NULL OR (icon_url ~* '^https://[^[:space:]]+$' AND char_length(icon_url) <= 500)),
  open_in_app boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_mini_apps_page_idx
  ON public.page_mini_apps (page_id, created_at);
CREATE INDEX IF NOT EXISTS page_mini_apps_active_idx
  ON public.page_mini_apps (created_at) WHERE is_active;

ALTER TABLE public.page_mini_apps ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: nobody reads or writes this table directly.
REVOKE ALL ON public.page_mini_apps FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Internal helper (NOT callable by clients)
-- ------------------------------------------------------------
-- users.id of the caller IF the caller is a live Page account, else NULL.
CREATE OR REPLACE FUNCTION public._mini_app_page()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM public.users
  WHERE auth_user_id = auth.uid()
    AND role = 'page'
    AND COALESCE(is_deleted, false) = false
    AND COALESCE(is_deactivated, false) = false
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public._mini_app_page() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Client-facing functions
-- ------------------------------------------------------------

-- The Home tray: every active mini app of every live Page, oldest first.
CREATE OR REPLACE FUNCTION public.mini_apps_list()
 RETURNS TABLE (
   id          uuid,
   page_id     uuid,
   page_name   text,
   name        text,
   icon_url    text,
   url         text,
   open_in_app boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  SELECT u.id INTO v_me FROM public.users u WHERE u.auth_user_id = auth.uid() LIMIT 1;

  RETURN QUERY
  SELECT m.id, m.page_id, p.full_name, m.name, m.icon_url, m.url, m.open_in_app
  FROM public.page_mini_apps m
  JOIN public.users p ON p.id = m.page_id
  WHERE m.is_active
    AND p.role = 'page'
    AND COALESCE(p.is_deleted, false) = false
    AND COALESCE(p.is_deactivated, false) = false
    AND (v_me IS NULL OR NOT public.is_blocked(v_me, m.page_id))
  ORDER BY m.created_at ASC, m.id ASC
  LIMIT 60;
END;
$function$;

-- The caller's own mini apps (active AND hidden) for the manager screen.
-- Empty for anyone who is not a Page.
CREATE OR REPLACE FUNCTION public.mini_apps_mine()
 RETURNS TABLE (
   id          uuid,
   name        text,
   icon_url    text,
   url         text,
   open_in_app boolean,
   is_active   boolean,
   created_at  timestamptz
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_page uuid := public._mini_app_page();
BEGIN
  IF v_page IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT m.id, m.name, m.icon_url, m.url, m.open_in_app, m.is_active, m.created_at
  FROM public.page_mini_apps m
  WHERE m.page_id = v_page
  ORDER BY m.created_at ASC, m.id ASC;
END;
$function$;

-- Create (p_id NULL) or edit (p_id = one of your own) a mini app. Returns its id.
CREATE OR REPLACE FUNCTION public.mini_app_save(
  p_id          uuid,
  p_name        text,
  p_url         text,
  p_icon_url    text,
  p_open_in_app boolean,
  p_is_active   boolean
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_page uuid := public._mini_app_page();
  v_name text := btrim(COALESCE(p_name, ''));
  v_url  text := btrim(COALESCE(p_url, ''));
  v_icon text := NULLIF(btrim(COALESCE(p_icon_url, '')), '');
  v_id   uuid;
BEGIN
  IF v_page IS NULL THEN
    RAISE EXCEPTION 'Only Pages can have Mini Apps';
  END IF;
  IF char_length(v_name) < 1 OR char_length(v_name) > 20 THEN
    RAISE EXCEPTION 'Name must be 1 to 20 characters';
  END IF;
  IF v_url !~* '^https://[^[:space:]]+$' OR char_length(v_url) > 500 THEN
    RAISE EXCEPTION 'App URL must start with https://';
  END IF;
  IF v_icon IS NOT NULL AND (v_icon !~* '^https://[^[:space:]]+$' OR char_length(v_icon) > 500) THEN
    RAISE EXCEPTION 'Icon URL must start with https://';
  END IF;

  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM public.page_mini_apps WHERE page_id = v_page) >= 10 THEN
      RAISE EXCEPTION 'You can have up to 10 Mini Apps';
    END IF;
    INSERT INTO public.page_mini_apps (page_id, name, url, icon_url, open_in_app, is_active)
    VALUES (v_page, v_name, v_url, v_icon, COALESCE(p_open_in_app, true), COALESCE(p_is_active, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.page_mini_apps
       SET name = v_name, url = v_url, icon_url = v_icon,
           open_in_app = COALESCE(p_open_in_app, true),
           is_active   = COALESCE(p_is_active, true),
           updated_at  = now()
     WHERE id = p_id AND page_id = v_page
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Mini app not found';
    END IF;
  END IF;

  RETURN v_id;
END;
$function$;

-- Show / hide one of your mini apps without deleting it.
CREATE OR REPLACE FUNCTION public.mini_app_set_active(p_id uuid, p_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_page uuid := public._mini_app_page();
BEGIN
  IF v_page IS NULL THEN
    RAISE EXCEPTION 'Only Pages can have Mini Apps';
  END IF;
  UPDATE public.page_mini_apps
     SET is_active = COALESCE(p_active, false), updated_at = now()
   WHERE id = p_id AND page_id = v_page;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mini app not found';
  END IF;
END;
$function$;

-- Delete one of your mini apps.
CREATE OR REPLACE FUNCTION public.mini_app_delete(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_page uuid := public._mini_app_page();
BEGIN
  IF v_page IS NULL THEN
    RAISE EXCEPTION 'Only Pages can have Mini Apps';
  END IF;
  DELETE FROM public.page_mini_apps WHERE id = p_id AND page_id = v_page;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mini app not found';
  END IF;
END;
$function$;

-- ------------------------------------------------------------
-- 4. Grants: signed-in users only
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.mini_apps_list()                                              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mini_apps_mine()                                              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mini_app_save(uuid, text, text, text, boolean, boolean)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mini_app_set_active(uuid, boolean)                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mini_app_delete(uuid)                                         FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.mini_apps_list()                                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.mini_apps_mine()                                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.mini_app_save(uuid, text, text, text, boolean, boolean)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.mini_app_set_active(uuid, boolean)                         TO authenticated;
GRANT EXECUTE ON FUNCTION public.mini_app_delete(uuid)                                      TO authenticated;
