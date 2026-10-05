-- =============================================================================
-- Per-segment audio
--
-- A word is one or more segments, and an addendum adds a segment to an
-- existing word. Until now only the first segment's clip was uploaded, so a
-- word's audio stopped before its addendum: the transcript was there, the
-- audio was not.
--
-- Each segment now keeps its own clip, and `word.audio_clip_path` holds what
-- members actually play:
--
--   0 segments with audio  ->  null
--   1 segment with audio   ->  that segment's clip, reused as-is
--   2 or more              ->  a joined clip, rebuilt whenever the set changes
--
-- Keeping the per-segment clips is what makes the rebuild possible later,
-- when a reviewer removes a segment and the local files are long gone.
-- =============================================================================

alter table public.segment
  add column if not exists audio_clip_path text;

comment on column public.segment.audio_clip_path is
  'This segment''s own clip in the word-audio bucket. The source of truth for '
  'rebuilding word.audio_clip_path; null for a segment typed in by a reviewer.';

comment on column public.word.audio_clip_path is
  'What members play: a single segment''s clip when there is only one, or a '
  'joined clip built from every segment''s audio. Rebuilt by syncWordAudio '
  'whenever the segment set changes.';

-- Looked up when deleting a word, to clear every object it owns.
create index if not exists segment_audio_clip_path_idx
  on public.segment (audio_clip_path)
  where audio_clip_path is not null;
