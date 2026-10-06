-- =============================================================================
-- Phase 3 - operator console and guests
--
--   * person.is_congregation  - the church itself as a recipient
--   * meeting.recording_started_at - marker times are offsets from this
--   * marker                  - one row per tap in the live console
--   * guest_word              - failure detail, so a bad address can be fixed
--
-- Same conventions as the earlier migrations: auto-expose is off, so every
-- privilege is granted explicitly and only ever to `authenticated`, and every
-- table gets RLS plus policies. `anon` is granted nothing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The congregation as a recipient
--
--    A word given to the whole church needs a recipient like any other, so it
--    is a person row.
-- -----------------------------------------------------------------------------
alter table public.person
  add column if not exists is_congregation boolean not null default false;

comment on column public.person.is_congregation is
  'True for the single row standing for the whole church. Pinned first in the '
  'console and the recipient pickers; never a giver, never invited, never '
  'removed, and excluded from transcription name hints.';

-- Exactly one, ever.
create unique index if not exists person_one_congregation
  on public.person (is_congregation) where is_congregation;

-- The existing "GracePlace" row already has words against it, so it is
-- converted in place: same id, so every word keeps its recipient. Its email
-- is replaced with an unusable .invalid address (RFC 2606) and any auth link
-- dropped, because the congregation is not a person and must never sign in.
do $convert$
declare
  v_id uuid;
  v_auth uuid;
  v_words integer;
begin
  if exists (select 1 from public.person where is_congregation) then
    raise notice 'Congregation row already set; leaving it alone.';
    return;
  end if;

  select p.id, p.auth_user_id into v_id, v_auth
  from public.person p
  where lower(btrim(p.name)) in ('graceplace', 'graceplace (whole church)')
  order by p.created_at
  limit 1;

  if v_id is null then
    -- Fresh database: nothing to convert, so create it.
    insert into public.person (name, email, role, is_congregation, name_spellings)
    values (
      'GracePlace (whole church)',
      'congregation@graceplace.invalid',
      'member',
      true,
      array['GracePlace', 'the church', 'everyone', 'the congregation']
    );
    raise notice 'Created the whole-church recipient.';
    return;
  end if;

  select count(*) into v_words from public.word where recipient_id = v_id;

  update public.person
     set name            = 'GracePlace (whole church)',
         email           = 'congregation@graceplace.invalid',
         auth_user_id    = null,
         role            = 'member',
         removed_at      = null,
         is_congregation = true,
         name_spellings  = array['GracePlace', 'the church', 'everyone', 'the congregation']
   where id = v_id;

  raise notice 'Converted person % into the whole-church recipient, keeping % word(s).',
    v_id, v_words;

  if v_auth is not null then
    raise warning 'That row was linked to auth user % — the link has been removed, so that account can no longer sign in as it. If that was somebody''s real account, add them again on the Members page.', v_auth;
  end if;
end;
$convert$;

-- -----------------------------------------------------------------------------
-- 2. When the recording started
--
--    The console records the moment the operator taps "Recording started", so
--    marker times line up with the audio file (spec).
-- -----------------------------------------------------------------------------
alter table public.meeting
  add column if not exists recording_started_at timestamptz;

comment on column public.meeting.recording_started_at is
  'Set when the operator taps "Recording started". Every marker''s at_sec is '
  'an offset from this instant.';

-- -----------------------------------------------------------------------------
-- 3. Markers
-- -----------------------------------------------------------------------------
do $enum$ begin
  create type public.marker_kind as enum (
    'word',        -- a new word; recipient_id null means the name is still coming
    'addendum',    -- a further segment on that recipient's earlier word
    'guest',       -- a guest word; emailed once, then deleted
    'to_confirm',  -- unassigned, sorted out in review
    'end'          -- where the last word stops
  );
exception when duplicate_object then null; end $enum$;

create table if not exists public.marker (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meeting (id) on delete cascade,

  -- Generated on the device before the tap is ever sent. It is what makes
  -- the offline queue safe to retry: a marker that did reach the database
  -- cannot be inserted twice, however many times the sync runs.
  client_id    text not null check (length(btrim(client_id)) > 0),

  kind         public.marker_kind not null default 'word',

  -- Seconds from recording_started_at. The console already subtracts the
  -- two-second lead, because an operator taps after hearing the name.
  at_sec       numeric(10, 3) not null default 0 check (at_sec >= 0),

  recipient_id uuid references public.person (id) on delete set null,
  giver_id     uuid references public.person (id) on delete set null,
  guest_email  text,
  note         text,

  -- True when an awaiting-name marker was settled for the operator rather
  -- than by them, so the console can say which taps still want a name.
  auto_confirmed boolean not null default false,

  created_by   uuid references public.person (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint marker_client_id_unique unique (meeting_id, client_id),

  -- An end marker is only a boundary; it carries nothing else.
  constraint marker_end_is_bare check (
    kind <> 'end'
    or (recipient_id is null and giver_id is null and guest_email is null)
  ),
  -- Only a guest marker carries an email.
  constraint marker_email_only_for_guests check (
    kind = 'guest' or guest_email is null
  ),
  -- An addendum attaches to a named person's earlier word.
  constraint marker_addendum_is_named check (
    kind <> 'addendum' or recipient_id is not null
  )
);

create index if not exists marker_meeting_idx on public.marker (meeting_id, at_sec);

drop trigger if exists marker_touch on public.marker;
create trigger marker_touch before update on public.marker
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 3a. Awaiting-name markers settle themselves
--
--     "Next recipient" drops a marker with no name yet, expecting the next
--     name tap to fill it in. If the operator moves on instead, the marker
--     must not hold anything up: it becomes 'to_confirm' and is sorted out in
--     review. Enforced here rather than in the console so a dropped network,
--     a closed tab or a reload cannot leave one dangling.
-- -----------------------------------------------------------------------------
-- In `public` and not `app`, because the console calls it over PostgREST and
-- only `public` is exposed. Security invoker on purpose: the UPDATE runs under
-- the caller's own policies, so a member calling it settles nothing.
create or replace function public.settle_awaiting_markers(p_meeting_id uuid)
returns integer
language sql
set search_path = public, pg_temp
as $fn$
  with settled as (
    update public.marker
       set kind = 'to_confirm',
           auto_confirmed = true
     where meeting_id = p_meeting_id
       and kind = 'word'
       and recipient_id is null
    returning 1
  )
  select count(*)::integer from settled;
$fn$;

revoke all on function public.settle_awaiting_markers(uuid) from public;
grant execute on function public.settle_awaiting_markers(uuid) to authenticated;

create or replace function app.settle_before_new_marker()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  update public.marker
     set kind = 'to_confirm',
         auto_confirmed = true
   where meeting_id = new.meeting_id
     and kind = 'word'
     and recipient_id is null
     and at_sec <= new.at_sec
     and client_id <> new.client_id;

  return new;
end;
$fn$;

drop trigger if exists marker_settle_awaiting on public.marker;
create trigger marker_settle_awaiting
  before insert on public.marker
  for each row execute function app.settle_before_new_marker();

-- -----------------------------------------------------------------------------
-- 4. Guest send failures
--
--    A successful send deletes the row outright - nothing about guests is
--    kept (spec). A failure has to survive, with enough detail to fix the
--    address and try again.
-- -----------------------------------------------------------------------------
alter table public.guest_word
  add column if not exists send_error text,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists marker_client_id text;

comment on column public.guest_word.marker_client_id is
  'The console marker this came from, so re-running the transcribe script '
  'replaces the right row instead of adding a second one.';

create unique index if not exists guest_word_marker_unique
  on public.guest_word (meeting_id, marker_client_id)
  where marker_client_id is not null;

-- -----------------------------------------------------------------------------
-- 5. Guards on the congregation row
-- -----------------------------------------------------------------------------
create or replace function app.protect_congregation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- Service role / direct SQL keeps an escape hatch, as with the other guards.
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.is_congregation then
      raise exception 'The whole-church recipient cannot be deleted. Rename it instead.'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if old.is_congregation then
    if new.is_congregation = false then
      raise exception 'The whole-church recipient cannot be turned into an ordinary member.'
        using errcode = '42501';
    end if;
    if new.removed_at is not null then
      raise exception 'The whole-church recipient cannot be removed from the member list.'
        using errcode = '42501';
    end if;
    if new.role <> old.role then
      raise exception 'The whole-church recipient has no role to change — it never signs in.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists person_congregation_guard on public.person;
create trigger person_congregation_guard
  before update or delete on public.person
  for each row execute function app.protect_congregation();

-- -----------------------------------------------------------------------------
-- 6. Grants - explicit, `authenticated` only, never `anon`
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on public.marker to authenticated;
grant all privileges on public.marker to service_role;

-- -----------------------------------------------------------------------------
-- 7. Row-level security
-- -----------------------------------------------------------------------------
alter table public.marker enable row level security;

-- Running the operator console is Editor and Admin only; members get nothing,
-- not even read. There is no member-facing policy here on purpose.
drop policy if exists marker_select on public.marker;
create policy marker_select on public.marker
  for select to authenticated
  using (app.can_write());

drop policy if exists marker_insert on public.marker;
create policy marker_insert on public.marker
  for insert to authenticated
  with check (app.can_write());

drop policy if exists marker_update on public.marker;
create policy marker_update on public.marker
  for update to authenticated
  using (app.can_write())
  with check (app.can_write());

-- Deliberately can_write, not can_delete. "Undo last marker" is part of
-- operating the console, which admins do, and a marker is not a published
-- word or its audio — the editor-only rule protects those.
drop policy if exists marker_delete on public.marker;
create policy marker_delete on public.marker
  for delete to authenticated
  using (app.can_write());

-- Same reasoning for guest words: the flow is built to delete the row the
-- moment the email sends, and an admin runs that flow. Members still cannot
-- see guest words at all.
drop policy if exists guest_word_delete on public.guest_word;
create policy guest_word_delete on public.guest_word
  for delete to authenticated
  using (app.can_write());
