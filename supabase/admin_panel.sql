-- ============================================================
-- ADMIN PANEL — schema + RPCs backing www/admin.js
-- ============================================================
-- Run this once against the live database (Supabase SQL Editor).
-- Idempotent: safe to re-run (CREATE OR REPLACE / IF NOT EXISTS throughout).
--
-- Design choice: every admin read AND write goes through a SECURITY DEFINER
-- RPC that checks public.is_admin() itself, rather than through new RLS
-- policies on the underlying tables. Two reasons:
--   1. This repo's schema.sql explicitly documents that RLS on most tables
--      (users, posts, reports, student_verifications, user_feedbacks) was
--      never verified against the live DB — writing new policies against
--      an unknown existing policy set risks silently widening access in a
--      way nobody can review from this repo alone.
--   2. It matches the pattern already used everywhere else in this app for
--      privileged writes (manage_connection, broadcast_page_message,
--      create_report) — a single checked entry point instead of relying on
--      row-level policy math.
-- A SECURITY DEFINER function runs with its owner's privileges and bypasses
-- RLS entirely, so this works regardless of what RLS currently looks like.
--
-- After running this, make yourself an admin (replace the email):
--   UPDATE public.users SET is_admin = true WHERE email = 'you@example.com';
-- ============================================================

-- ------------------------------------------------------------
-- 1. Column + helper
-- ------------------------------------------------------------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
-- is_suspended is the admin-imposed ban. It is separate from is_deactivated,
-- which is a self-service pause: auth.js lets a deactivated user tap
-- "Reactivate" at login, so deactivation can't be used to enforce anything.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_suspended boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT is_admin FROM public.users WHERE auth_user_id = auth.uid()), false);
$function$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- Small internal helper so every RPC below fails the same way instead of
-- repeating the same three lines. Postgres has no early-return "guard
-- clause" shorthand across functions, so this is just RAISE EXCEPTION,
-- called at the top of every admin_* function.
CREATE OR REPLACE FUNCTION public._require_admin()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;
END;
$function$;

-- Privileged-column guard. The client updates its own users row directly
-- (main.js: supabase.from('users').update(...).eq('id', me)), so unless
-- something stops it, any signed-in user could set is_admin, is_suspended,
-- role, tick_type, special_post or is_volunteer on themselves. This trigger
-- rejects changes to those columns unless the caller is already an admin, or
-- there is no end-user JWT at all (SQL editor / service role -- which is how
-- you bootstrap the first admin). admin_update_user() is SECURITY DEFINER but
-- auth.uid() still reflects the calling admin, so it passes normally.
-- Verified against the repo: no client flow and no server trigger writes
-- these columns as a non-admin (edit-profile only sends name/course/bio/etc,
-- triggers only touch connection_count and verification_status).
CREATE OR REPLACE FUNCTION public.guard_is_admin_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_admin IS TRUE OR NEW.is_suspended IS TRUE THEN
      RAISE EXCEPTION 'Not allowed to set privileged columns';
    END IF;
  ELSIF NEW.is_admin IS DISTINCT FROM OLD.is_admin
     OR NEW.is_suspended IS DISTINCT FROM OLD.is_suspended
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.tick_type IS DISTINCT FROM OLD.tick_type
     OR NEW.special_post IS DISTINCT FROM OLD.special_post
     OR NEW.is_volunteer IS DISTINCT FROM OLD.is_volunteer THEN
    RAISE EXCEPTION 'Not allowed to change privileged columns';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_is_admin_column ON public.users;
CREATE TRIGGER trg_guard_is_admin_column
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_is_admin_column();

-- ------------------------------------------------------------
-- 2. Dashboard
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_dashboard_stats()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  RETURN json_build_object(
    'pending_verifications', (SELECT count(*) FROM public.student_verifications WHERE status = 'pending'),
    'pending_reports', (SELECT count(*) FROM public.reports WHERE status = 'pending_review'),
    'open_tickets', (SELECT count(*) FROM public.user_feedbacks WHERE status IN ('pending', 'in_progress')),
    'total_users', (SELECT count(*) FROM public.users WHERE is_deleted = false),
    'reported_posts', (SELECT count(*) FROM public.posts WHERE is_reported = true AND is_deleted = false),
    'suspended_users', (SELECT count(*) FROM public.users WHERE is_suspended = true AND is_deleted = false)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_get_dashboard_stats() TO authenticated;

-- ------------------------------------------------------------
-- 3. Student verifications
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_verifications(p_status text DEFAULT 'pending')
 RETURNS TABLE (
   id uuid, user_id uuid, legal_name text, student_id text, course text,
   id_card_url text, selfie_url text, status text, rejection_reason text,
   created_at timestamptz, full_name text, email text, profile_img_url text
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  RETURN QUERY
  SELECT sv.id, sv.user_id, sv.legal_name, sv.student_id, sv.course,
         sv.id_card_url, sv.selfie_url, sv.status, sv.rejection_reason,
         sv.created_at, u.full_name, u.email, u.profile_img_url
  FROM public.student_verifications sv
  JOIN public.users u ON u.id = sv.user_id
  WHERE (p_status IS NULL OR sv.status = p_status)
  ORDER BY sv.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_list_verifications(text) TO authenticated;

-- p_approve = true -> status 'approved' (existing triggers cascade: syncs
-- users.verification_status, fires the verification_approved notification,
-- deletes the student_verifications row, ID images included). p_approve = false -> 'rejected' + reason,
-- fires verification_rejected. Nothing else needs to be written here.
CREATE OR REPLACE FUNCTION public.admin_review_verification(p_verification_id uuid, p_approve boolean, p_rejection_reason text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  IF p_approve THEN
    UPDATE public.student_verifications SET status = 'approved' WHERE id = p_verification_id;
  ELSE
    UPDATE public.student_verifications SET status = 'rejected', rejection_reason = p_rejection_reason WHERE id = p_verification_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verification request not found';
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_review_verification(uuid, boolean, text) TO authenticated;

-- ------------------------------------------------------------
-- 4. Reports
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_list_reports(text);
CREATE OR REPLACE FUNCTION public.admin_list_reports(p_status text DEFAULT 'pending_review')
 RETURNS TABLE (
   id uuid, reporter_id uuid, reporter_name text,
   reported_user_id uuid, reported_user_name text, reported_user_suspended boolean,
   reported_post_id uuid, reported_post_content text, reported_post_author_id uuid, reported_post_author_name text, reported_post_deleted boolean,
   reason text, description text, status text, created_at timestamptz
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  RETURN QUERY
  SELECT r.id, r.reporter_id, ru.full_name,
         r.reported_user_id, tu.full_name, tu.is_suspended,
         r.reported_post_id, p.content, p.user_id, pu.full_name, p.is_deleted,
         r.reason, r.description, r.status, r.created_at
  FROM public.reports r
  JOIN public.users ru ON ru.id = r.reporter_id
  LEFT JOIN public.users tu ON tu.id = r.reported_user_id
  LEFT JOIN public.posts p ON p.id = r.reported_post_id
  LEFT JOIN public.users pu ON pu.id = p.user_id
  WHERE (p_status IS NULL OR r.status = p_status)
  ORDER BY r.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_list_reports(text) TO authenticated;

-- Just resolves the report row itself (status: 'resolved' or 'dismissed').
-- Taking action on the reported user/post is a separate call
-- (admin_update_user / admin_moderate_post below) so the two stay composable
-- instead of one giant function trying to branch on every combination.
CREATE OR REPLACE FUNCTION public.admin_set_report_status(p_report_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  IF p_status NOT IN ('resolved', 'dismissed', 'pending_review') THEN
    RAISE EXCEPTION 'Invalid report status: %', p_status;
  END IF;
  UPDATE public.reports SET status = p_status WHERE id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_set_report_status(uuid, text) TO authenticated;

-- p_verify = true sets posts.is_verified = true, which the existing
-- trg_clear_report_flag_on_verify trigger reads to clear is_reported, and
-- which report_post() reads to block any future report on this post — an
-- explicit "reviewed, this is fine, don't ask again" action distinct from
-- just leaving it alone.
CREATE OR REPLACE FUNCTION public.admin_moderate_post(p_post_id uuid, p_delete boolean DEFAULT false, p_verify boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  IF p_delete THEN
    UPDATE public.posts SET is_deleted = true WHERE id = p_post_id;
  ELSIF p_verify THEN
    UPDATE public.posts SET is_verified = true WHERE id = p_post_id;
  ELSE
    RAISE EXCEPTION 'Specify delete or verify';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post not found';
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_moderate_post(uuid, boolean, boolean) TO authenticated;

-- ------------------------------------------------------------
-- 5. Feedback / support tickets
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_feedback(p_status text DEFAULT NULL)
 RETURNS TABLE (
   id uuid, user_id uuid, full_name text, email text, type text,
   description text, media_url text, status text, admin_reply text, created_at timestamptz
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  RETURN QUERY
  SELECT f.id, f.user_id, u.full_name, u.email, f.type, f.description,
         f.media_url, f.status, f.admin_reply, f.created_at
  FROM public.user_feedbacks f
  LEFT JOIN public.users u ON u.id = f.user_id
  WHERE (p_status IS NULL OR f.status = p_status)
  ORDER BY f.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_list_feedback(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_reply_feedback(p_feedback_id uuid, p_reply text, p_status text DEFAULT 'resolved')
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  IF p_status NOT IN ('pending', 'in_progress', 'resolved') THEN
    RAISE EXCEPTION 'Invalid ticket status: %', p_status;
  END IF;
  UPDATE public.user_feedbacks SET admin_reply = p_reply, status = p_status WHERE id = p_feedback_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_reply_feedback(uuid, text, text) TO authenticated;

-- ------------------------------------------------------------
-- 6. Users
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_search_users(text);
CREATE OR REPLACE FUNCTION public.admin_search_users(p_query text)
 RETURNS TABLE (
   id uuid, full_name text, email text, student_id text, course text, college text,
   role text, tick_type text, is_admin boolean, is_volunteer boolean, special_post boolean,
   is_private boolean, is_deactivated boolean, is_suspended boolean, is_deleted boolean, verification_status text,
   connection_count integer, profile_img_url text, created_at timestamptz, last_active_at timestamptz
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  RETURN QUERY
  SELECT u.id, u.full_name, u.email, u.student_id::text, u.course, u.college,
         u.role, u.tick_type, u.is_admin, u.is_volunteer, u.special_post,
         u.is_private, u.is_deactivated, u.is_suspended, u.is_deleted, u.verification_status,
         u.connection_count, u.profile_img_url, u.created_at, u.last_active_at
  FROM public.users u
  WHERE p_query IS NULL OR p_query = ''
     OR u.full_name ILIKE '%' || p_query || '%'
     OR u.email ILIKE '%' || p_query || '%'
     OR u.student_id ILIKE '%' || p_query || '%'
  ORDER BY u.created_at DESC
  LIMIT 50;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_search_users(text) TO authenticated;

-- One flexible "patch" RPC: every parameter left NULL is left untouched.
-- Booleans use NULL-means-"don't touch" (not false), so callers only pass
-- the fields they're actually changing.
DROP FUNCTION IF EXISTS public.admin_update_user(uuid, boolean, boolean, text, text, boolean, boolean, text, boolean);
CREATE OR REPLACE FUNCTION public.admin_update_user(
  p_user_id uuid,
  p_is_deactivated boolean DEFAULT NULL,
  p_is_deleted boolean DEFAULT NULL,
  p_role text DEFAULT NULL,
  p_tick_type text DEFAULT NULL,
  p_special_post boolean DEFAULT NULL,
  p_is_volunteer boolean DEFAULT NULL,
  p_verification_status text DEFAULT NULL,
  p_is_admin boolean DEFAULT NULL,
  p_is_suspended boolean DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();

  -- Guard rail: never let an admin strip their own admin access this way —
  -- a mis-click here would lock them out of the panel with no other way in
  -- short of the Supabase dashboard.
  IF p_user_id = public.current_user_id() AND p_is_admin = false THEN
    RAISE EXCEPTION 'You cannot remove your own admin access from here.';
  END IF;

  IF p_user_id = public.current_user_id() AND p_is_suspended = true THEN
    RAISE EXCEPTION 'You cannot suspend yourself.';
  END IF;

  IF p_role IS NOT NULL AND p_role NOT IN ('student', 'page') THEN
    RAISE EXCEPTION 'Invalid role: %', p_role;
  END IF;
  IF p_verification_status IS NOT NULL AND p_verification_status NOT IN ('unverified', 'pending', 'verified', 'rejected') THEN
    RAISE EXCEPTION 'Invalid verification_status: %', p_verification_status;
  END IF;
  -- The colour-ring picker in the admin panel sends #RRGGBB; 'none' removes the tick.
  IF p_tick_type IS NOT NULL AND p_tick_type <> 'none' AND p_tick_type !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'Invalid tick colour (use #RRGGBB or none): %', p_tick_type;
  END IF;

  UPDATE public.users SET
    is_deactivated      = COALESCE(p_is_deactivated, is_deactivated),
    is_deleted          = COALESCE(p_is_deleted, is_deleted),
    role                = COALESCE(p_role, role),
    tick_type           = COALESCE(p_tick_type, tick_type),
    special_post        = COALESCE(p_special_post, special_post),
    is_volunteer        = COALESCE(p_is_volunteer, is_volunteer),
    verification_status = COALESCE(p_verification_status, verification_status),
    is_admin            = COALESCE(p_is_admin, is_admin),
    is_suspended        = COALESCE(p_is_suspended, is_suspended)
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_update_user(uuid, boolean, boolean, text, text, boolean, boolean, text, boolean, boolean) TO authenticated;

-- ------------------------------------------------------------
-- 7. (removed) Colleges
-- ------------------------------------------------------------
-- An earlier draft of this file had admin_*_college functions. Nothing in the
-- app reads public.colleges (signup uses a fixed COLLEGE_NAME constant), so
-- the admin tab and RPCs were removed. These drops clean up any copies left
-- by a previous run; they do not touch the colleges table itself.
DROP FUNCTION IF EXISTS public.admin_list_colleges();
DROP FUNCTION IF EXISTS public.admin_upsert_college(text, boolean);
DROP FUNCTION IF EXISTS public.admin_delete_college(uuid);

-- ------------------------------------------------------------
-- 8. App version control (forced-update gate, www/version-gate.js)
-- ------------------------------------------------------------
-- Reads go through the existing public "app_version_control_select_all"
-- policy (already open to anon+authenticated) — no new read RPC needed.
-- Only the write was previously dashboard-only; this opens it to admins.
CREATE OR REPLACE FUNCTION public.admin_update_app_version(p_platform text, p_min_version_code integer, p_update_message text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  INSERT INTO public.app_version_control (platform, min_version_code, update_message, updated_at)
  VALUES (p_platform, p_min_version_code, p_update_message, now())
  ON CONFLICT (platform) DO UPDATE SET
    min_version_code = EXCLUDED.min_version_code,
    update_message = EXCLUDED.update_message,
    updated_at = now();
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_update_app_version(text, integer, text) TO authenticated;

-- ------------------------------------------------------------
-- 9. App settings (global switches) + admin audit log
-- ------------------------------------------------------------
-- app_settings holds app-wide on/off switches. Right now there is one:
--   screen_privacy  -> when enabled, every device blocks screenshots and screen
--                      recording in the whole app (www/screen-privacy.js).
-- Like app_version_control, SELECT is open to anon + authenticated, because the
-- login screen needs to read it before any session exists. Nobody can write to
-- it directly; the only way in is admin_set_app_setting() below.
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_settings_select_all" ON public.app_settings;
CREATE POLICY "app_settings_select_all"
  ON public.app_settings
  FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON public.app_settings TO anon, authenticated;

INSERT INTO public.app_settings (key, enabled) VALUES ('screen_privacy', false)
ON CONFLICT (key) DO NOTHING;

-- Lets already-open apps hear about a change straight away (best effort: the
-- client also re-checks every time the app comes back to the foreground).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'app_settings'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;
  END IF;
END
$do$;

-- Who did what. RLS is on with NO policies, so the app (anon / authenticated)
-- can neither read nor write it; only the SECURITY DEFINER functions below
-- insert into it, and you read it from the SQL editor:
--   SELECT * FROM public.admin_audit_log ORDER BY created_at DESC;
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id             bigserial PRIMARY KEY,
  admin_user_id  uuid,
  action         text NOT NULL,
  target_user_id uuid,
  details        text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_audit_log FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_app_settings()
 RETURNS TABLE (key text, enabled boolean, updated_at timestamptz, updated_by_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  RETURN QUERY
  SELECT s.key, s.enabled, s.updated_at, u.full_name
  FROM public.app_settings s
  LEFT JOIN public.users u ON u.id = s.updated_by
  ORDER BY s.key;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_get_app_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_app_setting(p_key text, p_enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_admin();
  IF p_key IS NULL OR p_key NOT IN ('screen_privacy') THEN
    RAISE EXCEPTION 'Unknown setting: %', p_key;
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled must be true or false';
  END IF;

  INSERT INTO public.app_settings (key, enabled, updated_at, updated_by)
  VALUES (p_key, p_enabled, now(), public.current_user_id())
  ON CONFLICT (key) DO UPDATE SET
    enabled    = EXCLUDED.enabled,
    updated_at = now(),
    updated_by = EXCLUDED.updated_by;

  INSERT INTO public.admin_audit_log (admin_user_id, action, details)
  VALUES (public.current_user_id(), 'set_app_setting', p_key || '=' || p_enabled::text);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_set_app_setting(text, boolean) TO authenticated;

-- ------------------------------------------------------------
-- 10. Reset a user's password
-- ------------------------------------------------------------
-- The browser can never change someone else's password (that needs the
-- service-role key, which must not ship in the app), so this does it inside
-- Postgres: it writes a bcrypt hash straight into auth.users, which is exactly
-- what Supabase Auth stores, then deletes the user's sessions so every device
-- they were signed in on has to log in again with the new password.
-- Guard rails: admins only; 8+ characters; admin accounts are refused (an
-- admin who forgets their password uses the normal change-password flow, and
-- one compromised admin can't take over the others); every reset is written to
-- admin_audit_log (who reset whose password, never the password itself).
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.admin_reset_user_password(p_user_id uuid, p_new_password text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_auth_id uuid;
  v_target_is_admin boolean;
BEGIN
  PERFORM public._require_admin();

  IF p_new_password IS NULL OR char_length(p_new_password) < 8 THEN
    RAISE EXCEPTION 'Password must be at least 8 characters.';
  END IF;
  IF octet_length(p_new_password) > 72 THEN
    RAISE EXCEPTION 'Password is too long (72 bytes max).';
  END IF;

  SELECT u.auth_user_id, u.is_admin INTO v_auth_id, v_target_is_admin
  FROM public.users u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'This account has no login to reset.';
  END IF;
  IF v_target_is_admin THEN
    RAISE EXCEPTION 'Admin passwords cannot be reset from the panel.';
  END IF;

  UPDATE auth.users
  SET encrypted_password = crypt(p_new_password, gen_salt('bf')),
      updated_at = now()
  WHERE id = v_auth_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No login found for this user.';
  END IF;

  -- Sign the user out everywhere (refresh tokens go with their session).
  BEGIN
    DELETE FROM auth.sessions WHERE user_id = v_auth_id;
  EXCEPTION WHEN undefined_table THEN
    NULL;
  END;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_user_id)
  VALUES (public.current_user_id(), 'reset_password', p_user_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_reset_user_password(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reset_user_password(uuid, text) TO authenticated;

-- ============================================================
-- Done. Now grant yourself admin access, e.g.:
--   UPDATE public.users SET is_admin = true WHERE email = 'you@example.com';
-- ============================================================
