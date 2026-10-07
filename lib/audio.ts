import "server-only";

import { createClient } from "@/lib/supabase/server";

// From lib/storage rather than lib/word-audio: the latter imports ffmpeg,
// and the feed has no business carrying it just to name a bucket.
export { AUDIO_BUCKET } from "@/lib/storage";
import { AUDIO_BUCKET } from "@/lib/storage";

/**
 * Signed URLs expire, so a link copied out of the page stops working.
 * One hour is long enough to listen to a 45-minute meeting's clip without
 * the player dying mid-playback.
 */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Mints signed URLs using the *member's own session*, not the secret key, so
 * the storage policies in the migration are what decide who gets a URL.
 */
export async function signAudioPaths(
  paths: (string | null | undefined)[],
): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))];
  if (unique.length === 0) return {};

  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);

  if (error || !data) return {};

  const signed: Record<string, string> = {};
  for (const entry of data) {
    // `path` echoes back the input path; signedUrl is null on a per-file error.
    if (entry.path && entry.signedUrl) signed[entry.path] = entry.signedUrl;
  }
  return signed;
}

export async function signAudioPath(
  path: string | null | undefined,
): Promise<string | null> {
  if (!path) return null;
  const signed = await signAudioPaths([path]);
  return signed[path] ?? null;
}
