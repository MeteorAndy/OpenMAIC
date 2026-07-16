-- db/c2_prereqs.sql — Stage C2 prerequisites.
--
-- BLOCKER for the C2 Dexie->Supabase rewire. Apply on self-hosted Supabase
-- AFTER `drizzle-kit push` (db/schema.ts) and AFTER db/rls.sql:
--     psql "$DATABASE_URL" -f db/rls.sql
--     psql "$DATABASE_URL" -f db/c2_prereqs.sql
-- Idempotent: every trigger / function / constraint is dropped before create.
--
-- Two things the schema migration does NOT give us that the rewire assumes:
--   (1) a set_updated_at() BEFORE UPDATE trigger on course/scene/chat_session,
--       so the optimistic-concurrency GUARD (guardedCourseUpdate's
--       `.eq('updated_at', guard)`) advances on EVERY update. Without it a
--       second guarded write would silently match 0 rows and the lock would be
--       a no-op. (upsertCourse/renameCourse/setCourseOutline also set
--       updated_at explicitly in their patch — the trigger is belt-and-
--       suspenders so any future direct UPDATE still advances the guard.)
--       generated_agent / media_file have NO updated_at column -> no trigger.
--   (2) ON DELETE CASCADE foreign keys from the child tables to course(id), so
--       deleteCourse clears scene / chat_session / generated_agent / media_file
--       rows in the DB. scene/chat_session/generated_agent CASCADEs are load-
--       bearing for C2; media_file CASCADE is added now for C4 readiness (no
--       media_file rows are written this stage).

-- ==================== (1) set_updated_at() trigger ====================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['course', 'scene', 'chat_session']
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I '
      'for each row execute function public.set_updated_at()',
      t
    );
  end loop;
end $$;

-- ==================== (2) ON DELETE CASCADE foreign keys ====================
-- db/schema.ts declares NO foreign keys; add them here so deleting a course
-- cascades its children. Constraint name: <table>_course_id_fk.

do $$
declare
  pair text[];
  child_table text;
  fk_name text;
begin
  foreach pair slice 1 in array array[
    ['scene', 'course_id'],
    ['chat_session', 'course_id'],
    ['generated_agent', 'course_id'],
    ['media_file', 'course_id']
  ]
  loop
    child_table := pair[1];
    fk_name := child_table || '_course_id_fk';
    execute format(
      'alter table public.%I drop constraint if exists %I',
      child_table, fk_name
    );
    execute format(
      'alter table public.%I add constraint %I '
      'foreign key (course_id) references public.course(id) on delete cascade',
      child_table, fk_name
    );
  end loop;
end $$;
