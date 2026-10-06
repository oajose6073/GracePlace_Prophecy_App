-- =============================================================================
-- An ended meeting stops accepting markers
--
-- The console disabled nothing when a meeting ended, so taps kept landing
-- afterwards — including a second "end" marker. The page is fixed, but the
-- rule belongs here too: a tap queued offline can sync minutes later, long
-- after the meeting was closed, and must be refused rather than quietly
-- appended.
--
-- Only INSERT is blocked. Nudging a marker and shifting the whole set are
-- exactly what an operator does after the meeting, so UPDATE stays open.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tidy up the duplicate end markers already in the database
--
--    An end marker is a pure boundary — no recipient, no giver, no transcript
--    — so a duplicate carries nothing worth keeping. The earliest one is where
--    the last word actually stopped; anything later is a stray tap after the
--    meeting was closed.
-- -----------------------------------------------------------------------------
do $cleanup$
declare
  v_removed integer;
begin
  with ranked as (
    select id,
           meeting_id,
           at_sec,
           row_number() over (partition by meeting_id order by at_sec, created_at) as rn
      from public.marker
     where kind = 'end'
  ),
  deleted as (
    delete from public.marker m
     using ranked r
     where m.id = r.id and r.rn > 1
    returning m.meeting_id, r.at_sec
  )
  select count(*) into v_removed from deleted;

  if v_removed > 0 then
    raise notice 'Removed % duplicate end marker(s), keeping the earliest in each meeting.', v_removed;
  end if;
end;
$cleanup$;

-- One end marker per meeting, from here on.
create unique index if not exists marker_one_end_per_meeting
  on public.marker (meeting_id) where kind = 'end';

-- -----------------------------------------------------------------------------
-- 2. No new markers once the meeting is closed
-- -----------------------------------------------------------------------------
create or replace function app.reject_marker_after_end()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_status public.meeting_status;
begin
  select status into v_status from public.meeting where id = new.meeting_id;

  if v_status = 'complete' then
    -- A retry of a tap that was already stored before the meeting ended is
    -- not a new marker. The console upserts on (meeting_id, client_id), and
    -- Postgres fires this BEFORE INSERT trigger even when the row resolves to
    -- an update — so without this, a tap whose response was lost would be
    -- reported back as "refused" despite having been saved.
    if exists (
      select 1 from public.marker m
       where m.meeting_id = new.meeting_id
         and m.client_id = new.client_id
    ) then
      return new;
    end if;

    -- The prefix is what the console matches on to tell the operator their
    -- queued tap was refused, rather than retrying it forever.
    raise exception
      'MEETING_ENDED: that meeting has been ended, so no new markers can be added. Reopen it first.'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;

drop trigger if exists marker_reject_after_end on public.marker;
create trigger marker_reject_after_end
  before insert on public.marker
  for each row execute function app.reject_marker_after_end();
