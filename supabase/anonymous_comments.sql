-- Anonymous comments (any post type, no expiry).
--
-- A comment can be posted as "Anonymous": the app shows a fixed name/avatar instead of the
-- author. post_comments.user_id is still stored (the author needs to delete their own comment,
-- and admins need to moderate), exactly like posts.user_id for post_type = 'anonymous'.
--
-- Safe to re-run. Run it BEFORE shipping the app build that offers the toggle:
-- until then the toggle answers "Anonymous comments need the latest database update."
-- and normal comments keep working (the client only sends is_anonymous when it is true).

-- 1. The flag, on the comment and on the notification it produces.
ALTER TABLE public.post_comments
  ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;

-- 2. The comment-notification trigger sends NOTHING for an anonymous comment (no bell row, no
--    push). The flag is still passed on the inserts below so any notification row created
--    before this rule existed keeps rendering as "Anonymous" in the bell.
--    Logic is otherwise identical to the version in schema.sql.
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
-- TRIGGER on_post_comment already exists (AFTER INSERT ON public.post_comments) and picks up the
-- new function body automatically; nothing to re-create.
