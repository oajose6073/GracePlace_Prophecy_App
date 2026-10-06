-- =============================================================================
-- guest_word: a real unique constraint on the marker it came from
--
-- 20261005000100 created this as a *partial* unique index:
--
--   create unique index guest_word_marker_unique
--     on guest_word (meeting_id, marker_client_id)
--     where marker_client_id is not null;
--
-- Postgres will only use an index for ON CONFLICT inference if it can match
-- the index's predicate, and PostgREST's `on_conflict=` gives no way to supply
-- one. So the upsert failed with "no unique or exclusion constraint matching
-- the ON CONFLICT specification".
--
-- A plain unique constraint is the right shape here anyway. Postgres treats
-- nulls as distinct by default, so rows whose marker_client_id is null — every
-- guest word from a markers file rather than the console — do not collide with
-- each other, while a marker that does have an id can only ever own one row.
-- =============================================================================

-- Safety net: the constraint below would fail on duplicates, and the error
-- would not say which rows. Name them first.
do $check$
declare
  v_dupes integer;
begin
  select count(*) into v_dupes
    from (
      select meeting_id, marker_client_id
        from public.guest_word
       where marker_client_id is not null
       group by meeting_id, marker_client_id
      having count(*) > 1
    ) d;

  if v_dupes > 0 then
    raise exception
      '% marker(s) already own more than one guest_word row. Delete the extras in the review queue, then run this migration again.',
      v_dupes;
  end if;
end;
$check$;

drop index if exists public.guest_word_marker_unique;

alter table public.guest_word
  drop constraint if exists guest_word_marker_unique;

alter table public.guest_word
  add constraint guest_word_marker_unique
  unique (meeting_id, marker_client_id);

comment on constraint guest_word_marker_unique on public.guest_word is
  'One guest word per console marker. Nulls are distinct, so guest words from '
  'a markers file (which has no marker ids) are unaffected.';
