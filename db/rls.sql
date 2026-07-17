-- db/rls.sql — enable Row-Level Security + per-user policies + signup→free subscription.
-- Apply on the Supabase Postgres after Drizzle migrations:
--   psql "$DATABASE_URL" -f db/rls.sql        (or `supabase db execute --file db/rls.sql`)
-- Idempotent (drops policies / trigger before creating).

-- plan: readable by any authenticated user (caps surfaced via /api/quota); no client writes.
alter table public.plan enable row level security;
drop policy if exists "plan read" on public.plan;
create policy "plan read" on public.plan for select to authenticated using (true);

-- per-user tables: owner-only CRUD — user_id = auth.uid().
do $$
declare t text;
begin
  foreach t in array array[
    'course','scene','chat_session','generated_agent','media_file','subscription','usage'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "owner all" on public.%I', t);
    execute format(
      'create policy "owner all" on public.%I for all to authenticated '
      'using (user_id = auth.uid()) with check (user_id = auth.uid())', t
    );
  end loop;
end $$;

-- New signup → free subscription (replaces the old better-auth databaseHook).
-- SECURITY DEFINER so it can write to public.subscription during the auth.users insert.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscription
    (id, user_id, plan_id, status, current_period_start, current_period_end)
  values
    ('sub_' || new.id, new.id, 'free', 'active', now(), now() + interval '100 years')
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ==================== Grants (RLS policies are inert without them) ===========
-- Tables created by the postgres owner; the `authenticated`/`anon` roles that
-- PostgREST connects as need explicit table privileges, else 42501 permission
-- denied even with a matching policy. plan is read-only for both roles.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE course, scene, chat_session, generated_agent, media_file, subscription, usage
  TO authenticated;
GRANT SELECT ON TABLE plan TO authenticated, anon;
-- service_role (server/admin, bypasses RLS) still needs table privileges.
GRANT ALL ON TABLE course, scene, chat_session, generated_agent, media_file, plan, subscription, usage
  TO service_role;
