-- =============================================================================
-- Phase 2 - pending words are invisible outside the review queue
--
-- A word reaches members only after an admin approves it. That holds for the
-- word row, its segments, and its audio object.
--
-- The `word` select policy from 20261004000100 was already correct - a member
-- has only ever been able to select status = 'reviewed'. The pending word
-- showing up on the feed was the page not filtering, which is fixed in
-- lib/words.ts. Two things here are real gaps though:
--
--   1. The storage policy allowed any member to read any object in the
--      word-audio bucket, including a pending word's clip. The path is hard to
--      guess, but nothing actually stopped it.
--
--   2. segment_select leaned on the `word` policy being re-applied inside its
--      own subquery. That does hold in Postgres, but it is an implicit
--      dependency; the rule is spelled out here instead.
-- =============================================================================

-- Used by the storage policy below to find the word a clip belongs to.
create index if not exists word_audio_clip_path_idx
  on public.word (audio_clip_path);

-- -----------------------------------------------------------------------------
-- 1. word - restated unchanged, so the rule is readable in one place
-- -----------------------------------------------------------------------------
drop policy if exists word_select on public.word;
create policy word_select on public.word
  for select to authenticated
  using (
    -- Editors and admins review, so they see pending words too.
    app.can_write()
    -- Members see approved words only.
    or (app.is_member() and status = 'reviewed')
  );

-- -----------------------------------------------------------------------------
-- 2. segment - now says the rule itself rather than inheriting it
-- -----------------------------------------------------------------------------
drop policy if exists segment_select on public.segment;
create policy segment_select on public.segment
  for select to authenticated
  using (
    exists (
      select 1
      from public.word w
      where w.id = segment.word_id
        and (app.can_write() or (app.is_member() and w.status = 'reviewed'))
    )
  );

-- -----------------------------------------------------------------------------
-- 3. audio - a signed URL is minted by reading the object, so the same rule
--    has to live here. Without this a member could fetch a signed URL for a
--    pending clip by path alone.
-- -----------------------------------------------------------------------------
drop policy if exists word_audio_select on storage.objects;
create policy word_audio_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'word-audio'
    and (
      app.can_write()
      or (
        app.is_member()
        and exists (
          select 1
          from public.word w
          where w.audio_clip_path = objects.name
            and w.status = 'reviewed'
        )
      )
    )
  );
