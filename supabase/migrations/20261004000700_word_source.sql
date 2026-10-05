-- =============================================================================
-- Phase 1 support - where a word came from
--
-- The transcribe script can rebuild a meeting's pending words with
-- --replace-pending. Before deleting anything it needs to know which pending
-- words it created itself and which a person added or edited by hand, so it
-- can refuse to throw away someone's work without --force.
--
-- "Was it edited after creation?" is not stored: it is derived by comparing
-- updated_at with created_at on the word and on its segments, which the
-- existing *_touch triggers already maintain.
-- =============================================================================

do $enum$ begin
  create type public.word_source as enum ('script', 'manual', 'seed');
exception when duplicate_object then null; end $enum$;

-- Defaults to 'manual': the review queue's "Add a word" form is the manual
-- path, and it is the only thing that has created words up to now.
--
-- Note for existing data: rows the seed script created before this migration
-- will read 'manual'. Run `npm run seed:clean && npm run seed` to relabel
-- them, or leave them - they are test data either way.
alter table public.word
  add column if not exists source public.word_source not null default 'manual';

comment on column public.word.source is
  'Which path created this word: the transcribe script, a person in the '
  'review queue, or the seed script. Used by --replace-pending to avoid '
  'deleting hand-made work.';

-- --replace-pending looks up one meeting's pending words by source.
create index if not exists word_meeting_source_idx
  on public.word (meeting_id, status, source);
