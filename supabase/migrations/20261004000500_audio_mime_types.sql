-- =============================================================================
-- Phase 2 - audio upload formats
--
-- An upload was rejected with "mime type video/mp4 is not supported".
-- WhatsApp and several phone recorders save an audio-only voice note in an
-- MP4 container and report it as video/mp4, so the bucket has to accept it.
--
-- The list below is the whole allow-list, not an addition to the old one.
-- Dropped from 20261004000100: audio/mp3, audio/m4a, audio/aac, audio/flac.
-- The first two are non-standard spellings that some browsers still emit, so
-- add-word-form.tsx normalises them to audio/mpeg and audio/mp4 before upload
-- rather than widening the bucket to accept both spellings of the same thing.
-- =============================================================================

update storage.buckets
   set allowed_mime_types = array[
         'audio/mpeg',   -- .mp3
         'audio/mp4',    -- .m4a, and .mp4 reported as audio
         'audio/x-m4a',  -- .m4a, Apple's spelling
         'audio/wav',
         'audio/x-wav',
         'audio/webm',
         'audio/ogg',
         'video/mp4'     -- audio-only .mp4: WhatsApp voice notes, some phones
       ],
       -- 100 MB. At the 64 kbps mono the spec assumes, that is far longer
       -- than any single word's clip.
       file_size_limit = 104857600
 where id = 'word-audio';
