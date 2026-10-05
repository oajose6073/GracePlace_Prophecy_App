import "server-only";

/**
 * The guarded entry point for audio joining. Everything the app touches goes
 * through here, so `import "server-only"` makes the build fail if a client
 * component ever reaches for it.
 *
 * The implementation lives in ./word-audio and ./ffmpeg, unguarded, because
 * the tsx scripts in scripts/ share it and that marker throws outside Next.
 * Those modules spawn ffmpeg and write temp files, so they cannot end up in a
 * browser bundle by accident either way — this is the belt to that's braces.
 */
export {
  AUDIO_BUCKET,
  deleteWordAudio,
  syncWordAudio,
  wordAudioObjects,
  type SegmentAudio,
  type SyncResult,
} from "./word-audio";

export { CLIP_CONTENT_TYPE, CLIP_EXTENSION, JOIN_GAP_SECONDS } from "./ffmpeg";
