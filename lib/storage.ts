/**
 * The private audio bucket.
 *
 * Its own module with no imports, so anything can name the bucket without
 * pulling in what lives next to it. It used to sit in lib/word-audio.ts,
 * which imports ffmpeg — so the feed, the cron route and the browser upload
 * form all dragged ffmpeg-static along just to spell "word-audio".
 */
export const AUDIO_BUCKET = "word-audio";
