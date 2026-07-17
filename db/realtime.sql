-- db/realtime.sql — add the app tables to the supabase_realtime publication.
-- Enables postgres_changes (Realtime) on the per-user tables so the browser
-- can subscribe to INSERT/UPDATE/DELETE and live-refresh the course list.
--
-- Apply AFTER db/rls.sql (RLS is the isolation boundary — a subscriber only
-- receives events for rows its role can read, i.e. its own user_id):
--   psql "$DATABASE_URL" -f db/realtime.sql
--   (or `supabase db execute --file db/realtime.sql`)
-- Idempotent: tolerates tables that are already publication members.

do $$
declare t text;
begin
  foreach t in array array[
    'course','scene','chat_session','generated_agent','media_file'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      -- 42710: table is already a member of this publication — ignore.
      when duplicate_object then null;
    end;
  end loop;
end $$;
