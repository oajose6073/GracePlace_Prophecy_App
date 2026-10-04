-- =============================================================================
-- Phase 2 - a word cannot be approved with an empty transcript
--
-- Approving is what publishes a word to the feed and to the recipient's
-- profile. It needs at least one segment, and every segment needs text.
--
-- This cannot be a CHECK constraint: the rule spans two tables, and a check
-- on `word` cannot see its segments. Two triggers instead:
--
--   * word_approval_guard  - blocks the approval itself
--   * segment_text_guard   - stops the text being emptied afterwards, which
--                            would otherwise leave a published word blank
--
-- Unlike the role and removal guards, these are NOT skipped for the service
-- role. The rule is about published content, not about who is acting, so the
-- seed script goes through the same path: it inserts each sample word as
-- pending, adds the segments, then approves it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Approval
-- -----------------------------------------------------------------------------
create or replace function app.enforce_word_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_total integer;
  v_blank integer;
begin
  if new.status <> 'reviewed' then
    return new;
  end if;

  -- Only the moment of approval is checked here. Later edits to an already
  -- published word are segment_text_guard's job, so an unrelated update
  -- (fixing a recipient, say) is never blocked by pre-existing data.
  if tg_op = 'UPDATE' and old.status = 'reviewed' then
    return new;
  end if;

  select count(*), count(*) filter (where btrim(transcript) = '')
    into v_total, v_blank
    from public.segment
   where word_id = new.id;

  if v_total = 0 then
    raise exception
      'This word has no segments yet, so there is nothing to publish. Add a segment with its transcript first.'
      using errcode = '23514';
  end if;

  if v_blank > 0 then
    raise exception
      'Every segment needs transcript text before this word can be approved - % of % % still empty.',
      v_blank, v_total, case when v_blank = 1 then 'is' else 'are' end
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

drop trigger if exists word_approval_guard on public.word;
create trigger word_approval_guard
  before insert or update on public.word
  for each row execute function app.enforce_word_approval();

-- -----------------------------------------------------------------------------
-- 2. Keeping it true afterwards
--
--    Without this, the rule would only hold for the instant of approval:
--    approve with text, then blank it, and the feed shows an empty card.
--
--    DELETE is deliberately not covered. Deleting a word cascades to its
--    segments, and a BEFORE DELETE trigger here would fire during that
--    cascade and block an editor's legitimate word deletion.
-- -----------------------------------------------------------------------------
create or replace function app.enforce_segment_text()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if btrim(new.transcript) <> '' then
    return new;
  end if;

  if exists (
    select 1 from public.word w
     where w.id = new.word_id
       and w.status = 'reviewed'
  ) then
    raise exception
      'This word is already published, so its transcript cannot be left empty. Unapprove it first.'
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

drop trigger if exists segment_text_guard on public.segment;
create trigger segment_text_guard
  before insert or update on public.segment
  for each row execute function app.enforce_segment_text();
