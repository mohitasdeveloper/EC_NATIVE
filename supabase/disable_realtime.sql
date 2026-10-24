-- disable_realtime.sql — turn Supabase Realtime OFF for this app.
--
-- The app no longer subscribes to Realtime (see CHANGES-3.0.md). Run this once in
-- the Supabase SQL editor so the database also stops watching tables for changes.
-- Safe to run more than once. Nothing here deletes data or touches RLS.
--
-- It removes EVERY table from the `supabase_realtime` publication (that list is what
-- Realtime streams). If you want to see what is in it first:
--   SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';

DO $do$
DECLARE
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOR r IN
      SELECT schemaname, tablename
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
    LOOP
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I.%I', r.schemaname, r.tablename);
    END LOOP;
  END IF;
END
$do$;

-- Check: this should now return zero rows.
SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
