-- WARNING: Table CREATE statements below are a best-effort reconstruction,
-- NOT a verified pg_dump — column lists may be incomplete or stale (e.g. the
-- posts table below is missing is_reported, which two functions further down
-- reference). Table order and constraints may not be valid for execution.
--
-- The "Functions & Triggers" section (search for that heading) IS verified
-- directly against the live database as of 2026-09-18, and should be treated as
-- authoritative — see the note at the top of that section for what that
-- verification did and didn't cover.
--
-- Hotposts and Messages (direct chat, Page broadcast) were removed from the app
-- entirely; their tables, policies, functions and triggers are gone from this
-- file and are dropped on a live database by supabase/cleanup_hotposts_messages.sql.
--
-- Folded in from standalone migration files under supabase/ (2026-09-25):
--   - allow_anonymous_post_type.sql  -> posts.post_type CHECK now includes 'anonymous'
--   - app_version_control.sql        -> public.app_version_control table + RLS + seed row
--   - event_post_participation_fix.sql -> post_events.register_button_text / register_open_in_app
--   - anonymous_comments.sql          -> post_comments.is_anonymous, notifications.is_anonymous, comment trigger
-- These migration files still exist under supabase/ and haven't been
-- deleted — nobody's confirmed it's safe to remove them yet (same caution
-- this file already applies to the older migration_*_vN.sql files it
-- previously absorbed). Re-running any of them against a database that
-- already has this version of schema.sql applied is harmless either way:
-- all three are written with IF NOT EXISTS / ON CONFLICT / idempotent guards.

CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE,
  student_id character varying NOT NULL UNIQUE,
  full_name text NOT NULL,
  course text,
  email text NOT NULL UNIQUE,
  mobile text,
  gender text,
  profile_img_url text DEFAULT 'https://t4.ftcdn.net/jpg/05/89/93/27/360_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.jpg'::text,
  tick_type text DEFAULT 'none'::text,
  role text DEFAULT 'student'::text,
  is_volunteer boolean DEFAULT false,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  joined_at timestamp with time zone DEFAULT now(),
  college text,
  bio text DEFAULT ''::text,
  social_links jsonb DEFAULT '{}'::jsonb,
  is_private boolean DEFAULT false,
  connection_count integer DEFAULT 0,
  special_post boolean DEFAULT false,
  fcm_token text,
  is_deleted boolean DEFAULT false,
  is_deactivated boolean DEFAULT false,
  mention_privacy text DEFAULT 'connections'::text CHECK (mention_privacy = ANY (ARRAY['connections'::text, 'none'::text])),
  push_settings jsonb DEFAULT '{}'::jsonb,
  verification_status text DEFAULT 'unverified'::text CHECK (verification_status = ANY (ARRAY['unverified'::text, 'pending'::text, 'verified'::text, 'rejected'::text])),
  custom_voters_list ARRAY DEFAULT '{}'::uuid[],
  last_active_at timestamp with time zone,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.colleges (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL UNIQUE,
  is_verified boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT colleges_pkey PRIMARY KEY (id)
);
CREATE TABLE public.reports (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  reporter_id uuid NOT NULL,
  reported_user_id uuid,
  reason text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'pending_review'::text,
  created_at timestamp with time zone DEFAULT now(),
  reported_post_id uuid,
  CONSTRAINT reports_pkey PRIMARY KEY (id),
  CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.users(id),
  CONSTRAINT reports_reported_user_id_fkey FOREIGN KEY (reported_user_id) REFERENCES public.users(id)
);
CREATE TABLE public.connections (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_one_id uuid NOT NULL,
  user_two_id uuid NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'blocked'::text])),
  action_user_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT connections_pkey PRIMARY KEY (id),
  CONSTRAINT connections_user_one_id_fkey FOREIGN KEY (user_one_id) REFERENCES public.users(id),
  CONSTRAINT connections_user_two_id_fkey FOREIGN KEY (user_two_id) REFERENCES public.users(id),
  CONSTRAINT connections_action_user_id_fkey FOREIGN KEY (action_user_id) REFERENCES public.users(id)
);
CREATE TABLE public.notifications (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  type text NOT NULL,
  message text,
  target_id uuid,
  is_read boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  is_anonymous boolean NOT NULL DEFAULT false,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT notifications_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id)
);
CREATE TABLE public.page_followers (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  page_id uuid NOT NULL,
  follower_id uuid NOT NULL,
  receive_notifications boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT page_followers_pkey PRIMARY KEY (id),
  CONSTRAINT page_followers_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.users(id),
  CONSTRAINT page_followers_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.users(id)
);
CREATE TABLE public.posts (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  post_type text NOT NULL CHECK (post_type = ANY (ARRAY['text'::text, 'image'::text, 'event'::text, 'poll'::text, 'anonymous'::text])),
  content text NOT NULL,
  media_url text,
  mentioned_user_ids ARRAY DEFAULT '{}'::uuid[],
  expires_at timestamp with time zone NOT NULL,
  viewers_access text NOT NULL DEFAULT 'all'::text CHECK (viewers_access = ANY (ARRAY['all'::text, 'connections'::text, 'selected'::text])),
  allowed_viewer_ids ARRAY DEFAULT '{}'::uuid[],
  is_verified boolean DEFAULT false,
  is_deleted boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  hide_likes boolean DEFAULT false,
  disable_comments boolean DEFAULT false,
  is_archived boolean DEFAULT false,
  is_anonymous boolean DEFAULT false,
  is_reported boolean NOT NULL DEFAULT false,
  CONSTRAINT posts_pkey PRIMARY KEY (id),
  CONSTRAINT posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.post_polls (
  post_id uuid NOT NULL,
  options jsonb NOT NULL,
  is_multiple_choice boolean DEFAULT false,
  voters_access text NOT NULL DEFAULT 'all'::text CHECK (voters_access = ANY (ARRAY['all'::text, 'connections'::text, 'selected'::text])),
  allowed_voter_ids ARRAY DEFAULT '{}'::uuid[],
  voters_list_visibility text NOT NULL DEFAULT 'public'::text CHECK (voters_list_visibility = ANY (ARRAY['public'::text, 'hidden'::text])),
  deadline_type text NOT NULL DEFAULT 'time'::text CHECK (deadline_type = ANY (ARRAY['time'::text, 'voter_count'::text, 'selected_users_completion'::text])),
  deadline_time timestamp with time zone,
  deadline_count integer,
  can_undo_vote boolean DEFAULT false,
  is_ended_early boolean DEFAULT false,
  extra_info text,
  is_quiz boolean DEFAULT false,
  correct_option_id text,
  CONSTRAINT post_polls_pkey PRIMARY KEY (post_id),
  CONSTRAINT post_polls_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.post_poll_votes (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  option_id text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT post_poll_votes_pkey PRIMARY KEY (id),
  CONSTRAINT post_poll_votes_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT post_poll_votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.post_events (
  post_id uuid NOT NULL,
  event_date timestamp with time zone NOT NULL,
  event_location text,
  event_image_url text,
  show_register_btn boolean DEFAULT false,
  register_url text,
  enable_rsvp boolean DEFAULT false,
  rsvp_list_visibility text NOT NULL DEFAULT 'public'::text CHECK (rsvp_list_visibility = ANY (ARRAY['public'::text, 'hidden'::text])),
  register_button_text text, -- creator-chosen label for the register button; falls back to "Register Now" in the UI when null. Added by supabase/event_post_participation_fix.sql
  register_open_in_app boolean NOT NULL DEFAULT false, -- true = in-app WebView (openServiceLink), false = external/system browser. Added by supabase/event_post_participation_fix.sql
  CONSTRAINT post_events_pkey PRIMARY KEY (post_id),
  CONSTRAINT post_events_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.post_event_rsvps (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['attending'::text, 'maybe'::text])),
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT post_event_rsvps_pkey PRIMARY KEY (id),
  CONSTRAINT post_event_rsvps_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT post_event_rsvps_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.post_likes (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT post_likes_pkey PRIMARY KEY (id),
  CONSTRAINT post_likes_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT post_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.post_comments (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  is_deleted boolean DEFAULT false,
  mentioned_user_ids ARRAY DEFAULT '{}'::uuid[],
  parent_comment_id uuid,
  is_anonymous boolean NOT NULL DEFAULT false,
  CONSTRAINT post_comments_pkey PRIMARY KEY (id),
  CONSTRAINT post_comments_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT post_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT post_comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.post_comments(id)
);
CREATE TABLE public.comment_likes (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  comment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT comment_likes_pkey PRIMARY KEY (id),
  CONSTRAINT comment_likes_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.post_comments(id),
  CONSTRAINT comment_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.saved_posts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  post_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT saved_posts_pkey PRIMARY KEY (id),
  CONSTRAINT saved_posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT saved_posts_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.student_verifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE,
  legal_name text NOT NULL,
  student_id text NOT NULL,
  course text NOT NULL,
  id_card_url text NOT NULL,
  status text DEFAULT 'pending'::text,
  rejection_reason text,
  created_at timestamp with time zone DEFAULT now(),
  selfie_url text,
  CONSTRAINT student_verifications_pkey PRIMARY KEY (id),
  CONSTRAINT student_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_feedbacks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  type text NOT NULL CHECK (type = ANY (ARRAY['feedback'::text, 'issue'::text])),
  description text NOT NULL,
  media_url text,
  status text DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'resolved'::text])),
  admin_reply text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_feedbacks_pkey PRIMARY KEY (id),
  CONSTRAINT user_feedbacks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.page_services (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  icon_name text DEFAULT 'link'::text,
  open_in_app boolean DEFAULT true,
  is_active boolean DEFAULT true,
  order_index integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  description character varying,
  CONSTRAINT page_services_pkey PRIMARY KEY (id),
  CONSTRAINT page_services_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.users(id)
);

-- ============================================================
-- app_version_control — folded in from supabase/app_version_control.sql
--
-- Backs the forced-update gate (www/version-gate.js). One row per platform.
-- Both logged-in and logged-out users must be able to read this (the login
-- screen checks it too, before any session exists), so SELECT is open to
-- anon + authenticated; nobody but the project owner (dashboard /
-- service_role) can write to it. RLS policies alone do NOT grant access —
-- the base Postgres GRANT for the role has to exist too, hence both below.
-- ============================================================

CREATE TABLE public.app_version_control (
  platform text NOT NULL,
  min_version_code integer NOT NULL,
  update_message text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT app_version_control_pkey PRIMARY KEY (platform)
);

ALTER TABLE public.app_version_control ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_version_control_select_all" ON public.app_version_control;
CREATE POLICY "app_version_control_select_all"
  ON public.app_version_control
  FOR SELECT
  TO anon, authenticated
  USING (true);
-- No insert/update/delete policy for anon/authenticated on purpose — this
-- table is only ever changed by the project owner, from the dashboard.

GRANT SELECT ON public.app_version_control TO anon, authenticated;

-- Seed row. min_version_code starts at 0 so nobody is blocked until
-- deliberately raised after a Play Store release.
INSERT INTO public.app_version_control (platform, min_version_code, update_message)
VALUES ('android', 0, 'A new version of ECampus is available. Please update to keep using the app.')
ON CONFLICT (platform) DO NOTHING;

-- ============================================================
-- Functions & Triggers
--
-- Verified directly against the live database on 2026-09-18. This is the
-- part of this app's behavior that's easiest to lose track of, because none
-- of it is visible from reading the client code (or, previously, this file)
-- — see ARCHITECTURE.md's "notification system" section for the full
-- explanation of why that matters and what it cost to discover.
-- ============================================================

-- --- Identity / auth helpers ---
-- Two separate functions doing the same lookup (auth.uid() -> public.users.id):
-- auth_profile_id() and current_user_id(). Redundant but both are live and in use
-- by different policies/functions — left as-is. (A third, dm_current_user_id(),
-- only served the removed Messages feature and is dropped by the cleanup script.)
CREATE OR REPLACE FUNCTION public.auth_profile_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.current_user_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM public.users WHERE auth_user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.is_blocked(user_a_id uuid, user_b_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.connections
    WHERE status = 'blocked'
      AND (
        (user_one_id = user_a_id AND user_two_id = user_b_id) OR
        (user_one_id = user_b_id AND user_two_id = user_a_id)
      )
  );
$function$;

-- --- New account bootstrap ---
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO public.users (
    auth_user_id, student_id, email, full_name, mobile, gender, college,
    course, role, is_volunteer
  )
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'student_id',
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'mobile',
    NEW.raw_user_meta_data->>'gender',
    NEW.raw_user_meta_data->>'college_name',
    NEW.raw_user_meta_data->>'course',
    'student',
    false
  );
  RETURN NEW;
END;
$function$;
-- TRIGGER: on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()

-- --- Connections ---
CREATE OR REPLACE FUNCTION public.manage_connection(p_target_user_id uuid, p_action text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_current_user_id uuid;
    v_user_one_id uuid;
    v_user_two_id uuid;
    v_existing_status text;
    v_existing_action_user_id uuid;
BEGIN
    SELECT id INTO v_current_user_id FROM public.users WHERE auth_user_id = auth.uid();
    IF v_current_user_id IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
    IF v_current_user_id = p_target_user_id THEN RAISE EXCEPTION 'Cannot perform action on yourself'; END IF;

    IF v_current_user_id < p_target_user_id THEN
        v_user_one_id := v_current_user_id;
        v_user_two_id := p_target_user_id;
    ELSE
        v_user_one_id := p_target_user_id;
        v_user_two_id := v_current_user_id;
    END IF;

    SELECT status, action_user_id INTO v_existing_status, v_existing_action_user_id
    FROM public.connections
    WHERE user_one_id = v_user_one_id AND user_two_id = v_user_two_id;

    IF p_action = 'request' THEN
        IF v_existing_status = 'blocked' THEN RAISE EXCEPTION 'Action not permitted'; END IF;
        IF v_existing_status = 'accepted' THEN RAISE EXCEPTION 'Already connected'; END IF;
        IF v_existing_status = 'pending' THEN RAISE EXCEPTION 'Request already exists'; END IF;

        INSERT INTO public.connections (user_one_id, user_two_id, status, action_user_id)
        VALUES (v_user_one_id, v_user_two_id, 'pending', v_current_user_id);
        -- trg_connections (below) fires on this INSERT and creates the notification itself
        RETURN 'request_sent';

    ELSIF p_action = 'accept' THEN
        IF v_existing_status != 'pending' OR v_existing_action_user_id = v_current_user_id THEN
            RAISE EXCEPTION 'No valid request to accept';
        END IF;

        UPDATE public.connections
        SET status = 'accepted', action_user_id = v_current_user_id, updated_at = now()
        WHERE user_one_id = v_user_one_id AND user_two_id = v_user_two_id;
        -- trg_connections (below) fires on this UPDATE and creates the notification itself

        UPDATE public.users SET connection_count = connection_count + 1 WHERE id IN (v_user_one_id, v_user_two_id);
        RETURN 'accepted';

    ELSIF p_action IN ('cancel', 'decline', 'unfriend') THEN
        IF v_existing_status IS NULL THEN RETURN 'success'; END IF;

        DELETE FROM public.connections WHERE user_one_id = v_user_one_id AND user_two_id = v_user_two_id;

        IF v_existing_status = 'accepted' THEN
            UPDATE public.users SET connection_count = GREATEST(0, connection_count - 1) WHERE id IN (v_user_one_id, v_user_two_id);
            RETURN 'unfriended';
        END IF;

        IF p_action = 'cancel' THEN RETURN 'cancelled'; END IF;
        RETURN 'declined';

    ELSIF p_action = 'block' THEN
        IF v_existing_status = 'accepted' THEN
            UPDATE public.users SET connection_count = GREATEST(0, connection_count - 1) WHERE id IN (v_user_one_id, v_user_two_id);
        END IF;

        INSERT INTO public.connections (user_one_id, user_two_id, status, action_user_id)
        VALUES (v_user_one_id, v_user_two_id, 'blocked', v_current_user_id)
        ON CONFLICT (user_one_id, user_two_id)
        DO UPDATE SET status = 'blocked', action_user_id = v_current_user_id, updated_at = now();
        RETURN 'blocked';

    ELSIF p_action = 'unblock' THEN
        IF v_existing_status != 'blocked' OR v_existing_action_user_id != v_current_user_id THEN
            RAISE EXCEPTION 'Cannot unblock';
        END IF;

        DELETE FROM public.connections WHERE user_one_id = v_user_one_id AND user_two_id = v_user_two_id;
        RETURN 'unblocked';

    ELSE
        RAISE EXCEPTION 'Invalid action';
    END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_connections()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_receiver uuid;
BEGIN
    IF NEW.action_user_id = NEW.user_one_id THEN v_receiver := NEW.user_two_id; ELSE v_receiver := NEW.user_one_id; END IF;

    IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
        INSERT INTO public.notifications (user_id, sender_id, type) VALUES (v_receiver, NEW.action_user_id, 'connection_request');
    ELSIF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'accepted' THEN
        DELETE FROM public.notifications WHERE type = 'connection_request' AND user_id = NEW.action_user_id AND sender_id = v_receiver;
        INSERT INTO public.notifications (user_id, sender_id, type) VALUES (v_receiver, NEW.action_user_id, 'connection_accepted');
    END IF; RETURN NEW;
END; $function$;
-- TRIGGER: on_connection_upsert AFTER INSERT OR UPDATE ON public.connections FOR EACH ROW EXECUTE FUNCTION trg_connections()

CREATE OR REPLACE FUNCTION public.trg_connections_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    DELETE FROM public.notifications WHERE type IN ('connection_request', 'connection_accepted') AND ((user_id = OLD.user_one_id AND sender_id = OLD.user_two_id) OR (user_id = OLD.user_two_id AND sender_id = OLD.user_one_id));
    RETURN OLD;
END; $function$;
-- TRIGGER: on_connection_delete AFTER DELETE ON public.connections FOR EACH ROW EXECUTE FUNCTION trg_connections_delete()

CREATE OR REPLACE FUNCTION public.update_connection_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status = 'accepted') OR (TG_OP = 'UPDATE' AND NEW.status = 'accepted' AND OLD.status != 'accepted') THEN
    UPDATE public.users SET connection_count = connection_count + 1 WHERE id IN (NEW.user_one_id, NEW.user_two_id);
  ELSIF (TG_OP = 'DELETE' AND OLD.status = 'accepted') OR (TG_OP = 'UPDATE' AND OLD.status = 'accepted' AND NEW.status != 'accepted') THEN
    UPDATE public.users SET connection_count = connection_count - 1 WHERE id IN (OLD.user_one_id, OLD.user_two_id);
  END IF;
  RETURN NULL;
END;
$function$;
-- NOTE: this function's connection_count bookkeeping overlaps with what
-- manage_connection already does inline above — not confirmed here whether
-- both are actually wired to a live trigger simultaneously (which would
-- double-count) or whether this is a superseded/orphaned duplicate, same
-- pattern as the dead trg_post_like/trg_post_comment functions below. Worth
-- checking pg_trigger for a trigger calling this specific function before
-- relying on connection_count being accurate.

CREATE OR REPLACE FUNCTION public.increment_connection_count(user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.users SET connection_count = COALESCE(connection_count, 0) + 1 WHERE id = user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_connection_count(user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.users SET connection_count = GREATEST(COALESCE(connection_count, 0) - 1, 0) WHERE id = user_id;
END;
$function$;

-- --- Likes / comments / mentions notifications ---
-- These four are the ones a full trigger audit found already creating
-- notifications for post_like, comment_like, post_comment, comment_reply,
-- comment_mention, and post_mention — see ARCHITECTURE.md for the story of
-- how these were discovered and why several rounds of client-side
-- "notification never worked" code had to be removed once they were found.
CREATE OR REPLACE FUNCTION public.handle_post_like_notification()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_post_owner uuid;
BEGIN
    SELECT user_id INTO v_post_owner FROM public.posts WHERE id = NEW.post_id;
    IF v_post_owner != NEW.user_id THEN
        INSERT INTO public.notifications (user_id, sender_id, type, target_id)
        VALUES (v_post_owner, NEW.user_id, 'post_like', NEW.post_id);
    END IF;
    RETURN NEW;
END;
$function$;
-- TRIGGER: on_post_like AFTER INSERT ON public.post_likes FOR EACH ROW EXECUTE FUNCTION handle_post_like_notification()

CREATE OR REPLACE FUNCTION public.handle_comment_like_notification()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_comment_owner uuid;
    v_post_id uuid;
BEGIN
    SELECT user_id, post_id INTO v_comment_owner, v_post_id FROM public.post_comments WHERE id = NEW.comment_id;
    IF v_comment_owner != NEW.user_id THEN
        INSERT INTO public.notifications (user_id, sender_id, type, target_id)
        VALUES (v_comment_owner, NEW.user_id, 'comment_like', v_post_id);
    END IF;
    RETURN NEW;
END;
$function$;
-- TRIGGER: on_comment_like AFTER INSERT ON public.comment_likes FOR EACH ROW EXECUTE FUNCTION handle_comment_like_notification()

CREATE OR REPLACE FUNCTION public.handle_post_comment_notification()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_post_owner uuid;
    v_parent_comment_owner uuid;
    v_mentioned_id uuid;
BEGIN
    -- Anonymous comments notify nobody: no bell row, and therefore no push (the push
    -- trigger fires on notifications INSERT, so there is nothing for it to send).
    -- Covers all three kinds below: post_comment, comment_reply, comment_mention.
    IF COALESCE(NEW.is_anonymous, false) THEN
        RETURN NEW;
    END IF;

    IF NEW.parent_comment_id IS NULL THEN
        SELECT user_id INTO v_post_owner FROM public.posts WHERE id = NEW.post_id;
        IF v_post_owner != NEW.user_id THEN
            INSERT INTO public.notifications (user_id, sender_id, type, message, target_id, is_anonymous)
            VALUES (v_post_owner, NEW.user_id, 'post_comment', NEW.content, NEW.post_id, NEW.is_anonymous);
        END IF;
    ELSE
        SELECT user_id INTO v_parent_comment_owner FROM public.post_comments WHERE id = NEW.parent_comment_id;
        IF v_parent_comment_owner != NEW.user_id THEN
            INSERT INTO public.notifications (user_id, sender_id, type, message, target_id, is_anonymous)
            VALUES (v_parent_comment_owner, NEW.user_id, 'comment_reply', NEW.content, NEW.post_id, NEW.is_anonymous);
        END IF;
    END IF;

    IF NEW.mentioned_user_ids IS NOT NULL THEN
        FOREACH v_mentioned_id IN ARRAY NEW.mentioned_user_ids
        LOOP
            IF v_mentioned_id != NEW.user_id THEN
                INSERT INTO public.notifications (user_id, sender_id, type, message, target_id, is_anonymous)
                VALUES (v_mentioned_id, NEW.user_id, 'comment_mention', NEW.content, NEW.post_id, NEW.is_anonymous);
            END IF;
        END LOOP;
    END IF;

    RETURN NEW;
END;
$function$;
-- TRIGGER: on_post_comment AFTER INSERT ON public.post_comments FOR EACH ROW EXECUTE FUNCTION handle_post_comment_notification()

CREATE OR REPLACE FUNCTION public.handle_new_post_mentions()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_mentioned_id uuid;
BEGIN
    IF NEW.mentioned_user_ids IS NOT NULL THEN
        FOREACH v_mentioned_id IN ARRAY NEW.mentioned_user_ids
        LOOP
            IF v_mentioned_id != NEW.user_id THEN
                INSERT INTO public.notifications (user_id, sender_id, type, message, target_id)
                VALUES (v_mentioned_id, NEW.user_id, 'post_mention', NEW.content, NEW.id);
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$function$;
-- TRIGGER: on_new_post AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION handle_new_post_mentions()

-- --- Page fan-out ---
-- v14: one notification per (follower, page, post), enforced by a unique index, so a
-- Page post can never notify the same follower twice (it used to: this trigger AND a client-side
-- call to the 4-arg overload below both inserted).
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
-- TRIGGER: trg_notify_followers_on_post AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION notify_page_followers()

CREATE OR REPLACE FUNCTION public.toggle_page_notifications(p_page_id uuid, p_follower_id uuid, p_notify boolean)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE public.page_followers SET receive_notifications = p_notify WHERE page_id = p_page_id AND follower_id = p_follower_id;
END;
$function$;

-- DEPRECATED no-op (v14). This 4-arg overload used to insert a notification per follower; the
-- app also called it right after publishing a Page post, on top of the trigger above,
-- which is what delivered every Page post twice. Older installed app builds still call it, so
-- it stays — but it must not insert anything. (It also had no auth check.)
CREATE OR REPLACE FUNCTION public.notify_page_followers(p_page_id uuid, p_type text, p_message text, p_target_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN;
END;
$function$;

-- --- Also orphaned (not attached to any trigger, confirmed via pg_trigger) ---
-- Same pattern as above: earlier or alternate versions of the like/comment
-- notification functions above, superseded by handle_post_like_notification
-- / handle_post_comment_notification but never dropped.
CREATE OR REPLACE FUNCTION public.trg_post_like()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_owner uuid;
BEGIN
    SELECT user_id INTO v_owner FROM public.posts WHERE id = NEW.post_id;
    IF v_owner != NEW.user_id THEN
        INSERT INTO public.notifications (user_id, sender_id, type, target_id) VALUES (v_owner, NEW.user_id, 'post_like', NEW.post_id);
    END IF; RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_post_unlike()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    DELETE FROM public.notifications WHERE sender_id = OLD.user_id AND type = 'post_like' AND target_id = OLD.post_id;
    RETURN OLD;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_post_comment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_owner uuid;
BEGIN
    SELECT user_id INTO v_owner FROM public.posts WHERE id = NEW.post_id;
    IF v_owner != NEW.user_id THEN
        INSERT INTO public.notifications (user_id, sender_id, type, target_id, message) VALUES (v_owner, NEW.user_id, 'post_comment', NEW.post_id, NEW.content);
    END IF; RETURN NEW;
END; $function$;

-- --- Polls ---
CREATE OR REPLACE FUNCTION public.cast_poll_vote(p_post_id uuid, p_option_id text, p_is_undo boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User must be authenticated to vote.';
  END IF;

  IF p_is_undo THEN
    DELETE FROM public.post_poll_votes
    WHERE post_id = p_post_id AND user_id = v_user_id AND option_id = p_option_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.post_polls WHERE post_id = p_post_id AND is_multiple_choice = false) THEN
      DELETE FROM public.post_poll_votes WHERE post_id = p_post_id AND user_id = v_user_id;
    END IF;
    INSERT INTO public.post_poll_votes (post_id, user_id, option_id)
    VALUES (p_post_id, v_user_id, p_option_id)
    ON CONFLICT (post_id, user_id, option_id) DO NOTHING;
  END IF;
END;
$function$;
-- NOTE: a second cast_poll_vote(p_post_id, p_user_id, p_option_id, p_is_undo)
-- overload also exists live, with real deadline/permission-checking logic
-- (custom voter list, connections-only voting) that this simpler one lacks.
-- Not confirmed which one the client code actually calls — check before
-- assuming poll voting enforces those restrictions.

CREATE OR REPLACE FUNCTION public.end_poll_early(p_post_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized: Only the author can end this poll.';
  END IF;
  UPDATE public.post_polls SET is_ended_early = true WHERE post_id = p_post_id;
END;
$function$;

-- --- Reports / verification / misc ---
CREATE OR REPLACE FUNCTION public.create_report(p_reported_user_id uuid, p_reason text, p_description text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO public.reports(reporter_id, reported_user_id, reason, description)
  VALUES (public.current_user_id(), p_reported_user_id, p_reason, p_description);
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_post(p_reported_post_id uuid, p_reason text, p_description text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_is_verified boolean;
BEGIN
  SELECT is_verified INTO v_is_verified FROM public.posts WHERE id = p_reported_post_id;
  IF v_is_verified THEN
    RAISE EXCEPTION 'Verified posts cannot be reported.';
  END IF;
  INSERT INTO public.reports(reporter_id, reported_post_id, reason, description)
  VALUES (public.current_user_id(), p_reported_post_id, p_reason, p_description);
END;
$function$;

CREATE OR REPLACE FUNCTION public.flag_post_on_report()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NEW.reported_post_id IS NOT NULL THEN
    UPDATE public.posts SET is_reported = true WHERE id = NEW.reported_post_id;
  END IF;
  RETURN NEW;
END;
$function$;
-- TRIGGER: trg_flag_post_on_report AFTER INSERT ON public.reports FOR EACH ROW EXECUTE FUNCTION flag_post_on_report()

CREATE OR REPLACE FUNCTION public.clear_report_flag_on_verify()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.is_verified = true AND OLD.is_verified IS DISTINCT FROM true THEN
    NEW.is_reported := false;
  END IF;
  RETURN NEW;
END;
$function$;
-- TRIGGER: trg_clear_report_flag_on_verify BEFORE UPDATE ON public.posts FOR EACH ROW EXECUTE FUNCTION clear_report_flag_on_verify()
-- NOTE: posts.is_reported is referenced by the two functions above but not
-- present in this file's posts CREATE TABLE above — that column list is
-- unverified/incomplete, same caveat as every other table in this file.

CREATE OR REPLACE FUNCTION public.search_mentionable_users(p_search_term text, p_current_user_id uuid)
 RETURNS TABLE(id uuid, full_name text, profile_img_url text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT u.id, u.full_name, u.profile_img_url
  FROM public.users u
  WHERE u.is_deleted = false
    AND u.is_deactivated = false
    AND u.full_name ILIKE '%' || p_search_term || '%'
    AND u.mention_privacy = 'connections'
    AND EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.status = 'accepted'
        AND ((c.user_one_id = p_current_user_id AND c.user_two_id = u.id)
          OR (c.user_one_id = u.id AND c.user_two_id = p_current_user_id))
    )
  LIMIT 10;
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_delete_verification_data()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.verification_status = 'verified' AND OLD.verification_status != 'verified' THEN
    DELETE FROM public.student_verifications WHERE user_id = NEW.id;
    INSERT INTO public.notifications (user_id, sender_id, type, message)
    VALUES (NEW.id, NEW.id, 'verification_approved', 'has successfully verified your student identity! Welcome to ECampus.');
  END IF;
  IF NEW.verification_status = 'rejected' AND OLD.verification_status != 'rejected' THEN
    INSERT INTO public.notifications (user_id, sender_id, type, message)
    VALUES (NEW.id, NEW.id, 'verification_rejected', 'has rejected your student verification. Please check the reason and try again.');
  END IF;
  RETURN NEW;
END;
$function$;
-- Fires on public.users, on verification_status changing.

CREATE OR REPLACE FUNCTION public.sync_verification_status_to_users()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
    UPDATE public.users SET verification_status = 'verified' WHERE id = NEW.user_id;
  END IF;
  IF NEW.status = 'rejected' AND OLD.status != 'rejected' THEN
    UPDATE public.users SET verification_status = 'rejected' WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$function$;
-- TRIGGER: trigger_sync_verification_status AFTER UPDATE OF status ON public.student_verifications FOR EACH ROW EXECUTE FUNCTION sync_verification_status_to_users()
-- Together with auto_delete_verification_data above: admin approves/rejects
-- in student_verifications -> this trigger syncs users.verification_status
-- -> that in turn fires auto_delete_verification_data on users, which sends
-- the notification and deletes the sensitive ID/selfie data once verified.

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;
-- Generic "bump updated_at" trigger function — not confirmed here which
-- table(s) it's actually attached to.

