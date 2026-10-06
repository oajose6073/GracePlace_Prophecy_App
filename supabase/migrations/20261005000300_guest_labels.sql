-- =============================================================================
-- Guests: a label instead of an email, and a blank email that is actually blank
--
-- Two things, both from the same place — the operator often does not have the
-- guest's address at the moment the word is given.
--
--   1. guest_email was NOT NULL with `position('@' in guest_email) > 1`, so
--      "no email yet" had nowhere to go. The transcribe script stored an empty
--      string and the check rejected it outright, aborting the run. The spec
--      is explicit that the address can be added later in review, so the
--      column becomes nullable and the check allows null.
--
--   2. A guest word with neither a name nor an address is impossible to place
--      afterwards. The console can now record a short label instead — "man in
--      grey, front row" — so whoever chases the address knows who to ask.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. "No email yet" is a real state
-- -----------------------------------------------------------------------------
alter table public.guest_word
  alter column guest_email drop not null;

-- Any empty strings already stored become a proper null.
update public.guest_word
   set guest_email = null
 where guest_email is not null and btrim(guest_email) = '';

alter table public.guest_word
  drop constraint if exists guest_word_guest_email_check;

alter table public.guest_word
  add constraint guest_word_guest_email_check
  check (guest_email is null or position('@' in guest_email) > 1);

comment on column public.guest_word.guest_email is
  'Null until somebody collects it. Nothing can be sent without one, and the '
  'row is deleted after seven days either way.';

-- -----------------------------------------------------------------------------
-- 2. A label, so an unknown guest can still be identified
-- -----------------------------------------------------------------------------
alter table public.marker
  add column if not exists guest_label text;

alter table public.guest_word
  add column if not exists guest_label text;

comment on column public.marker.guest_label is
  'What the operator tapped to remember who this was - "man in grey, front '
  'row", or a first name. Never emailed; only an aid to collecting the address.';

comment on column public.guest_word.guest_label is
  'Carried over from the marker, so the review queue can say who is still '
  'waiting for an email.';

-- Mirrors marker_email_only_for_guests: a label belongs to a guest marker.
alter table public.marker
  drop constraint if exists marker_label_only_for_guests;

alter table public.marker
  add constraint marker_label_only_for_guests
  check (kind = 'guest' or guest_label is null);

-- Guests still waiting for an address, shown in the console after the meeting
-- and counted in the review queue.
create index if not exists guest_word_awaiting_email_idx
  on public.guest_word (meeting_id)
  where guest_email is null;

create index if not exists marker_guest_awaiting_email_idx
  on public.marker (meeting_id)
  where kind = 'guest' and guest_email is null;
