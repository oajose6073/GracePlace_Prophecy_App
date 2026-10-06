-- =============================================================================
-- Guests: emailed once, then genuinely gone
--
-- The email tells the guest "we do not keep a record of it afterwards". The
-- guest_word row and its clip were already deleted on send, but the console
-- marker the word came from kept the address and the label, so a record did
-- survive. The app now clears those; this adds the one piece it cannot.
--
--   marker.guest_sent_at
--
-- Why a timestamp is needed at all: a marker stays kind='guest' forever, and
-- the recording is still on the operator's laptop. Re-running the transcribe
-- script over the same meeting would transcribe that guest's audio again and
-- build a fresh guest_word — resurrecting content we promised to delete, and
-- opening the door to emailing them twice. Recording that a send happened is
-- the only way the script can know to skip it.
--
-- This is metadata, not content: the marker already says a guest word
-- happened at that moment. The timestamp adds no new fact about the guest.
-- =============================================================================

alter table public.marker
  add column if not exists guest_sent_at timestamptz;

comment on column public.marker.guest_sent_at is
  'When this guest word was emailed (or discarded/expired). The transcribe '
  'script skips guest markers that carry it, so deleted guest content is '
  'never regenerated from the recording. Metadata only - the address and '
  'label are cleared at the same time.';

comment on column public.marker.guest_email is
  'Collected by the operator after the meeting. Cleared once the guest word '
  'has been sent, discarded or expired - see guest_sent_at.';

comment on column public.marker.guest_label is
  'How the operator remembered who this was. Never emailed, and cleared '
  'alongside guest_email once the guest word is gone.';

-- Guest markers the script still has work to do on.
create index if not exists marker_guest_unsent_idx
  on public.marker (meeting_id)
  where kind = 'guest' and guest_sent_at is null;
