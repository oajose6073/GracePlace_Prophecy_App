-- =============================================================================
-- Phase 2 - soft removal, and no implicit deletion of words
--
-- Rule being enforced: a word is only ever removed by an editor's explicit
-- delete on that word. Nothing else may delete one as a side effect.
--
-- Two holes in 20261004000100 are closed here:
--
--   1. `word.meeting_id` was ON DELETE CASCADE, so an editor deleting a
--      meeting deleted every word in it - approved ones included - without
--      going through the word-delete path at all.
--
--   2. Removing a person set `word.recipient_id` to NULL. For an approved
--      word that tripped the word_reviewed_is_complete check and aborted the
--      delete with a raw constraint error; for a pending word it succeeded
--      and quietly stripped the attribution, leaving the word orphaned.
--
-- Removal is now a soft operation: the person row stays, so their words keep
-- their recipient and their profile page still works, but their access is
-- revoked everywhere.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. removed_at
-- -----------------------------------------------------------------------------
alter table public.person
  add column if not exists removed_at timestamptz;

comment on column public.person.removed_at is
  'Set when an editor removes someone from the member list. The row is kept so '
  'their words keep their recipient; access is revoked by app.member_role().';

-- Active people are the common lookup (pickers, the members list).
create index if not exists person_active_idx
  on public.person (name) where removed_at is null;

-- -----------------------------------------------------------------------------
-- 2. Removal revokes access
--
--    member_role() returning null makes is_member(), can_write() and
--    can_delete() all false, so every RLS policy closes at once - including
--    the storage policies, so a removed member cannot mint a signed audio URL
--    even with a session still in their browser.
--
--    Note this gates the *viewer*, not the person being looked at: a removed
--    person's row stays readable to active members, which is what keeps their
--    name on feed cards and their profile page working.
-- -----------------------------------------------------------------------------
create or replace function app.member_role()
returns public.person_role
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.role
  from public.person p
  where p.auth_user_id = auth.uid()
    and p.removed_at is null
  limit 1;
$fn$;

-- A removed person must not be able to sign up again from scratch.
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
    and p.removed_at is null
  limit 1;

  if v_person_id is null then
    raise exception 'NOT_INVITED: % is not on the member list', new.email
      using errcode = '42501';
  end if;

  update public.person
     set auth_user_id = new.id,
         email        = new.email
   where id = v_person_id;

  return new;
end;
$fn$;

-- ...nor claim an existing auth user against a removed row.
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

  if exists (
    select 1 from public.person
    where auth_user_id = auth.uid() and removed_at is null
  ) then
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
    and p.removed_at is null
  limit 1;

  if v_person_id is null then
    return false;
  end if;

  update public.person set auth_user_id = auth.uid() where id = v_person_id;
  return true;
end;
$fn$;

-- -----------------------------------------------------------------------------
-- 3. Nothing deletes a word implicitly
--
--    RESTRICT rather than NO ACTION so the check cannot be deferred past the
--    end of a transaction.
-- -----------------------------------------------------------------------------

-- Deleting a meeting no longer takes its words with it. An editor must delete
-- the words first, one explicit act each.
alter table public.word
  drop constraint if exists word_meeting_id_fkey;
alter table public.word
  add constraint word_meeting_id_fkey
  foreign key (meeting_id) references public.meeting (id) on delete restrict;

alter table public.guest_word
  drop constraint if exists guest_word_meeting_id_fkey;
alter table public.guest_word
  add constraint guest_word_meeting_id_fkey
  foreign key (meeting_id) references public.meeting (id) on delete restrict;

-- A hard delete of a person is now refused outright while any word still
-- points at them. Soft removal is the supported path; this is the backstop
-- that stops a direct API call from orphaning a word. Someone invited by
-- mistake, with no words, can still simply be deleted.
alter table public.word
  drop constraint if exists word_recipient_id_fkey;
alter table public.word
  add constraint word_recipient_id_fkey
  foreign key (recipient_id) references public.person (id) on delete restrict;

alter table public.word
  drop constraint if exists word_giver_id_fkey;
alter table public.word
  add constraint word_giver_id_fkey
  foreign key (giver_id) references public.person (id) on delete restrict;

-- approved_by is an audit field, never displayed. Losing it on a hard delete
-- is acceptable and must not block one.
alter table public.word
  drop constraint if exists word_approved_by_fkey;
alter table public.word
  add constraint word_approved_by_fkey
  foreign key (approved_by) references public.person (id) on delete set null;

-- segment -> word stays CASCADE on purpose: a segment is part of a word, not
-- a thing of its own, so it goes when an editor deletes that word.

-- -----------------------------------------------------------------------------
-- 4. Removal guards
--
--    Removal used to be a DELETE, which the person_delete policy stopped you
--    aiming at yourself. It is an UPDATE now, so that guard no longer covers
--    it and the rule moves here.
-- -----------------------------------------------------------------------------
create or replace function app.enforce_removal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- Service role / direct SQL (migrations, seed, cleanup) are not gated.
  if auth.uid() is null then
    return new;
  end if;

  if new.removed_at is not null and old.removed_at is null then
    if old.auth_user_id = auth.uid() then
      raise exception 'You cannot remove yourself from the member list.'
        using errcode = '42501';
    end if;

    -- Losing the last editor means nobody can delete a word or grant the
    -- editor role again. The spec asks for at least two for this reason.
    if old.role = 'editor' and (
      select count(*) from public.person
      where role = 'editor' and removed_at is null
    ) <= 1 then
      raise exception
        'That is the last remaining editor. Appoint another editor first.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists person_removal_guard on public.person;
create trigger person_removal_guard
  before update on public.person
  for each row execute function app.enforce_removal();
