-- =============================================================================
-- Phase 2 - App core
-- Tables, grants, row-level security, invite-only auth, audio bucket.
--
-- Project settings assumed: auto-expose OFF, automatic RLS ON.
-- Therefore every privilege is granted explicitly, only ever to `authenticated`,
-- and every table gets RLS plus policies. `anon` is granted nothing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Helper schema
--    Lives outside `public` so it is never exposed over the REST API.
-- -----------------------------------------------------------------------------
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated;

-- -----------------------------------------------------------------------------
-- 1. Enums
-- -----------------------------------------------------------------------------
do $enum$ begin
  create type public.person_role as enum ('editor', 'admin', 'member');
exception when duplicate_object then null; end $enum$;

do $enum$ begin
  create type public.meeting_format as enum ('zoom', 'in-person', 'hybrid');
exception when duplicate_object then null; end $enum$;

do $enum$ begin
  create type public.meeting_status as enum ('scheduled', 'recorded', 'processing', 'complete');
exception when duplicate_object then null; end $enum$;

do $enum$ begin
  create type public.word_status as enum ('pending', 'reviewed');
exception when duplicate_object then null; end $enum$;

do $enum$ begin
  create type public.guest_send_status as enum ('pending', 'sent', 'failed');
exception when duplicate_object then null; end $enum$;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------

-- person - members only. Guests are never stored here (spec, Data model).
-- A row exists BEFORE the person ever signs in: that row IS the invitation.
create table if not exists public.person (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid unique references auth.users (id) on delete set null,
  name           text not null check (length(btrim(name)) > 0),
  email          text not null check (position('@' in email) > 1),
  role           public.person_role not null default 'member',
  name_spellings text[] not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Case-insensitive uniqueness: the allowlist must not care about capitalisation.
create unique index if not exists person_email_lower_key
  on public.person (lower(email));
create index if not exists person_role_idx on public.person (role);

create table if not exists public.meeting (
  id             uuid primary key default gen_random_uuid(),
  date           date not null,
  format         public.meeting_format not null default 'hybrid',
  status         public.meeting_status not null default 'recorded',
  -- Full recording is deleted once all clips are cut and approved (spec).
  recording_path text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists meeting_date_idx on public.meeting (date desc);

create table if not exists public.word (
  id              uuid primary key default gen_random_uuid(),
  meeting_id      uuid not null references public.meeting (id) on delete cascade,
  -- null while "to be confirmed" (spec).
  recipient_id    uuid references public.person (id) on delete set null,
  giver_id        uuid references public.person (id) on delete set null,
  status          public.word_status not null default 'pending',
  audio_clip_path text,
  approved_at     timestamptz,
  approved_by     uuid references public.person (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A word only reaches members once it is approved, and approval needs a
  -- recipient and a clip to play.
  constraint word_reviewed_is_complete check (
    status <> 'reviewed'
    or (recipient_id is not null and audio_clip_path is not null)
  )
);
create index if not exists word_meeting_idx   on public.word (meeting_id);
create index if not exists word_recipient_idx on public.word (recipient_id);
create index if not exists word_status_idx    on public.word (status);

-- segment - one per marker. Addenda add a segment to an existing word (spec).
create table if not exists public.segment (
  id         uuid primary key default gen_random_uuid(),
  word_id    uuid not null references public.word (id) on delete cascade,
  start_sec  numeric(10, 3) not null default 0 check (start_sec >= 0),
  end_sec    numeric(10, 3) check (end_sec is null or end_sec >= start_sec),
  transcript text not null default '',
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists segment_word_idx on public.segment (word_id, position);

-- guest_word - temporary. Deleted on successful send, or 7 days after
-- creation regardless (spec). The send/purge flow itself is Phase 3.
create table if not exists public.guest_word (
  id              uuid primary key default gen_random_uuid(),
  meeting_id      uuid not null references public.meeting (id) on delete cascade,
  guest_email     text not null check (position('@' in guest_email) > 1),
  audio_clip_path text,
  transcript      text not null default '',
  send_status     public.guest_send_status not null default 'pending',
  expires_at      timestamptz not null default now() + interval '7 days',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists guest_word_expires_idx on public.guest_word (expires_at);

-- -----------------------------------------------------------------------------
-- 3. updated_at
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

do $mk$
declare t text;
begin
  foreach t in array array['person', 'meeting', 'word', 'segment', 'guest_word'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function app.touch_updated_at()',
      t || '_touch', t
    );
  end loop;
end $mk$;

-- -----------------------------------------------------------------------------
-- 4. Role helpers
--    SECURITY DEFINER so RLS on `person` cannot recurse into itself.
-- -----------------------------------------------------------------------------
create or replace function app.current_person_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id from public.person p where p.auth_user_id = auth.uid() limit 1;
$fn$;

create or replace function app.member_role()
returns public.person_role
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.role from public.person p where p.auth_user_id = auth.uid() limit 1;
$fn$;

-- Signed in AND on the member list. An auth user with no person row has nothing.
create or replace function app.is_member()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $fn$ select app.member_role() is not null; $fn$;

-- Editors and admins both edit, review and approve (Roles and permissions table).
create or replace function app.can_write()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $fn$ select app.member_role() in ('editor', 'admin'); $fn$;

-- "Delete words and audio" - Editor only.
create or replace function app.can_delete()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $fn$ select app.member_role() = 'editor'; $fn$;

grant execute on function
  app.current_person_id(), app.member_role(),
  app.is_member(), app.can_write(), app.can_delete()
to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Invite-only sign-in
--    Supabase Auth has no invite-only mode, so the database enforces it:
--    an auth user may only be created if an editor/admin already put that
--    email on the member list. Matching is case-insensitive.
-- -----------------------------------------------------------------------------
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_person_id uuid;
begin
  select p.id into v_person_id
  from public.person p
  where lower(p.email) = lower(new.email)
  limit 1;

  if v_person_id is null then
    -- Aborts the sign-up transaction. The app maps this to /not-invited.
    raise exception 'NOT_INVITED: % is not on the member list', new.email
      using errcode = '42501';
  end if;

  update public.person
     set auth_user_id = new.id,
         -- Keep the stored spelling in step with the verified address.
         email        = new.email
   where id = v_person_id;

  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- Links an already-existing auth user to a person row added afterwards
-- (invited today, but signed in to the project yesterday).
-- Called from the auth callback. Returns false if they are not on the list.
create or replace function public.claim_membership()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_email text;
  v_person_id uuid;
begin
  if auth.uid() is null then
    return false;
  end if;

  if exists (select 1 from public.person where auth_user_id = auth.uid()) then
    return true;
  end if;

  select u.email into v_email from auth.users u where u.id = auth.uid();
  if v_email is null then
    return false;
  end if;

  select p.id into v_person_id
  from public.person p
  where lower(p.email) = lower(v_email)
    and p.auth_user_id is null
  limit 1;

  if v_person_id is null then
    return false;
  end if;

  update public.person set auth_user_id = auth.uid() where id = v_person_id;
  return true;
end;
$fn$;

revoke all on function public.claim_membership() from public;
grant execute on function public.claim_membership() to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Role-assignment rules (trigger, because they compare OLD to NEW)
--
--    * Admins may add people and edit name spellings, but may only create or
--      set the role 'member', and may not touch a row that is already an
--      editor or an admin.
--    * Only editors may assign or change the admin and editor roles.
--    * Nobody may change their own role - editors included.
-- -----------------------------------------------------------------------------
create or replace function app.enforce_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor_role public.person_role := app.member_role();
begin
  -- Service role / direct SQL (migrations, seed script) have no auth.uid().
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if v_actor_role = 'admin' and new.role <> 'member' then
      raise exception 'Admins may only add people as members. Ask an editor to grant the % role.', new.role
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if v_actor_role = 'admin' and old.role <> 'member' then
    raise exception 'Only an editor may change an existing % account.', old.role
      using errcode = '42501';
  end if;

  if new.role is distinct from old.role then
    if new.auth_user_id = auth.uid() or old.auth_user_id = auth.uid() then
      raise exception 'You cannot change your own role. Ask another editor.'
        using errcode = '42501';
    end if;

    if v_actor_role = 'admin' and new.role <> 'member' then
      raise exception 'Only an editor may assign the % role.', new.role
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists person_role_guard on public.person;
create trigger person_role_guard
  before insert or update on public.person
  for each row execute function app.enforce_role_assignment();

-- -----------------------------------------------------------------------------
-- 7. Grants - explicit, `authenticated` only, never `anon`
--    These are coarse table privileges; RLS below decides per row and per role.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;

grant select, insert, update, delete on public.person     to authenticated;
grant select, insert, update, delete on public.meeting    to authenticated;
grant select, insert, update, delete on public.word       to authenticated;
grant select, insert, update, delete on public.segment    to authenticated;
grant select, insert, update, delete on public.guest_word to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Row-level security
-- -----------------------------------------------------------------------------
alter table public.person     enable row level security;
alter table public.meeting    enable row level security;
alter table public.word       enable row level security;
alter table public.segment    enable row level security;
alter table public.guest_word enable row level security;

-- --- person ------------------------------------------------------------------
-- Everyone signed in reads the member list: the feed shows recipient and giver
-- names, and the profile pages are per person.
drop policy if exists person_select on public.person;
create policy person_select on public.person
  for select to authenticated
  using (app.is_member());

-- "Manage the member list" - Editor: Yes, Admin: Yes.
-- Which roles each may hand out is enforced by person_role_guard above.
drop policy if exists person_insert on public.person;
create policy person_insert on public.person
  for insert to authenticated
  with check (app.can_write());

drop policy if exists person_update on public.person;
create policy person_update on public.person
  for update to authenticated
  using (app.can_write())
  with check (app.can_write());

drop policy if exists person_delete on public.person;
create policy person_delete on public.person
  for delete to authenticated
  using (app.can_write() and id <> app.current_person_id());

-- --- meeting -----------------------------------------------------------------
drop policy if exists meeting_select on public.meeting;
create policy meeting_select on public.meeting
  for select to authenticated
  using (app.is_member());

drop policy if exists meeting_insert on public.meeting;
create policy meeting_insert on public.meeting
  for insert to authenticated
  with check (app.can_write());

drop policy if exists meeting_update on public.meeting;
create policy meeting_update on public.meeting
  for update to authenticated
  using (app.can_write())
  with check (app.can_write());

drop policy if exists meeting_delete on public.meeting;
create policy meeting_delete on public.meeting
  for delete to authenticated
  using (app.can_delete());

-- --- word --------------------------------------------------------------------
-- Members see approved words only: a word reaches members after an admin
-- approves it. Editors and admins see the pending ones too, to review them.
drop policy if exists word_select on public.word;
create policy word_select on public.word
  for select to authenticated
  using (app.can_write() or (app.is_member() and status = 'reviewed'));

drop policy if exists word_insert on public.word;
create policy word_insert on public.word
  for insert to authenticated
  with check (app.can_write());

drop policy if exists word_update on public.word;
create policy word_update on public.word
  for update to authenticated
  using (app.can_write())
  with check (app.can_write());

drop policy if exists word_delete on public.word;
create policy word_delete on public.word
  for delete to authenticated
  using (app.can_delete());

-- --- segment -----------------------------------------------------------------
-- A segment is visible exactly when its word is: the subquery is itself
-- filtered by word_select above.
drop policy if exists segment_select on public.segment;
create policy segment_select on public.segment
  for select to authenticated
  using (exists (select 1 from public.word w where w.id = segment.word_id));

drop policy if exists segment_insert on public.segment;
create policy segment_insert on public.segment
  for insert to authenticated
  with check (app.can_write());

drop policy if exists segment_update on public.segment;
create policy segment_update on public.segment
  for update to authenticated
  using (app.can_write())
  with check (app.can_write());

drop policy if exists segment_delete on public.segment;
create policy segment_delete on public.segment
  for delete to authenticated
  using (app.can_delete());

-- --- guest_word --------------------------------------------------------------
-- "Nothing about guests is kept" beyond the send. Members never see these;
-- only the people who run the console and the review queue do.
drop policy if exists guest_word_select on public.guest_word;
create policy guest_word_select on public.guest_word
  for select to authenticated
  using (app.can_write());

drop policy if exists guest_word_insert on public.guest_word;
create policy guest_word_insert on public.guest_word
  for insert to authenticated
  with check (app.can_write());

drop policy if exists guest_word_update on public.guest_word;
create policy guest_word_update on public.guest_word
  for update to authenticated
  using (app.can_write())
  with check (app.can_write());

drop policy if exists guest_word_delete on public.guest_word;
create policy guest_word_delete on public.guest_word
  for delete to authenticated
  using (app.can_delete());

-- -----------------------------------------------------------------------------
-- 9. Audio storage - private bucket, signed URLs only
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'word-audio', 'word-audio', false, 524288000,
  array['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
        'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/aac',
        'audio/flac']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Reading an object is what mints a signed URL, so the same role rules apply.
drop policy if exists word_audio_select on storage.objects;
create policy word_audio_select on storage.objects
  for select to authenticated
  using (bucket_id = 'word-audio' and app.is_member());

drop policy if exists word_audio_insert on storage.objects;
create policy word_audio_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'word-audio' and app.can_write());

drop policy if exists word_audio_update on storage.objects;
create policy word_audio_update on storage.objects
  for update to authenticated
  using (bucket_id = 'word-audio' and app.can_write())
  with check (bucket_id = 'word-audio' and app.can_write());

-- "Delete words and audio" - Editor only.
drop policy if exists word_audio_delete on storage.objects;
create policy word_audio_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'word-audio' and app.can_delete());
