/**
 * Keeps `word.audio_clip_path` in step with its segments' clips.
 *
 * Not marked `import "server-only"` for the same reason as lib/ffmpeg.ts: the
 * tsx scripts have to import it, and that marker throws outside Next. The app
 * imports it through `lib/audio-join.ts`, which does carry the guard. It is
 * server-side by construction anyway — it writes temp files and spawns
 * ffmpeg, so it cannot be bundled for a browser.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { CLIP_CONTENT_TYPE, CLIP_EXTENSION, joinClips } from "./ffmpeg";
import type { Database } from "./types";

import { AUDIO_BUCKET } from "./storage";

export { AUDIO_BUCKET };

type Client = SupabaseClient<Database>;

export type SegmentAudio = {
  id: string;
  position: number;
  audio_clip_path: string | null;
};

export type SyncResult = {
  /** What the word now points at. */
  audioClipPath: string | null;
  /** 'single' reuses a segment's clip; 'joined' built a new object. */
  strategy: "none" | "single" | "joined";
  /** Objects removed because nothing references them any more. */
  removedObjects: string[];
};

/**
 * Every object a word owns: its own clip plus each segment's. Deduplicated,
 * because a single-segment word points at that segment's clip rather than a
 * copy of it.
 */
export function wordAudioObjects(
  wordClipPath: string | null,
  segments: Pick<SegmentAudio, "audio_clip_path">[],
): string[] {
  const paths = new Set<string>();
  if (wordClipPath) paths.add(wordClipPath);
  for (const segment of segments) {
    if (segment.audio_clip_path) paths.add(segment.audio_clip_path);
  }
  return [...paths];
}

async function removeObjects(client: Client, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const { error } = await client.storage.from(AUDIO_BUCKET).remove(paths);
  if (error) {
    throw new Error(`Could not delete ${paths.length} audio object(s): ${error.message}`);
  }
  return paths;
}

/**
 * Rebuilds a word's playable audio from its segments.
 *
 * `localClips` lets the transcribe script hand over the files it has just
 * cut, so a fresh run never downloads what it already has on disk. The
 * review queue passes nothing and the clips are fetched from the bucket.
 */
export async function syncWordAudio(
  client: Client,
  wordId: string,
  options: { localClips?: Map<string, string>; meetingId?: string } = {},
): Promise<SyncResult> {
  const { data: word, error: wordError } = await client
    .from("word")
    .select("id, meeting_id, audio_clip_path")
    .eq("id", wordId)
    .maybeSingle();

  if (wordError) throw new Error(`Loading the word failed: ${wordError.message}`);
  if (!word) throw new Error(`Word ${wordId} no longer exists.`);

  const { data: segmentRows, error: segmentError } = await client
    .from("segment")
    .select("id, position, audio_clip_path")
    .eq("word_id", wordId)
    .order("position");

  if (segmentError) {
    throw new Error(`Loading the segments failed: ${segmentError.message}`);
  }

  const segments = (segmentRows ?? []) as SegmentAudio[];
  const withAudio = segments.filter((s) => s.audio_clip_path);
  const previous = word.audio_clip_path;
  const meetingId = options.meetingId ?? word.meeting_id;

  // Any clip a segment still owns must survive, whatever happens below.
  const keep = new Set(withAudio.map((s) => s.audio_clip_path as string));

  let next: string | null = null;
  let strategy: SyncResult["strategy"] = "none";

  if (withAudio.length === 1) {
    // Re-encoding one clip into a "joined" copy would double the storage for
    // no benefit, so the word simply points at the segment's own object.
    next = withAudio[0].audio_clip_path;
    strategy = "single";
  } else if (withAudio.length > 1) {
    next = await buildJoinedClip(client, {
      meetingId,
      segments: withAudio,
      localClips: options.localClips,
    });
    strategy = "joined";
  }

  if (next !== previous) {
    const { error } = await client
      .from("word")
      .update({ audio_clip_path: next })
      .eq("id", wordId);

    if (error) {
      // The new object exists but nothing references it; clear it rather
      // than leave it behind.
      if (next && !keep.has(next)) await removeObjects(client, [next]);
      throw new Error(`Repointing the word's audio failed: ${error.message}`);
    }
  }

  // The old joined clip is an orphan now — unless a segment still owns it,
  // which is the case when the word previously pointed at a single segment.
  const orphans =
    previous && previous !== next && !keep.has(previous) ? [previous] : [];

  return {
    audioClipPath: next,
    strategy,
    removedObjects: await removeObjects(client, orphans),
  };
}

async function buildJoinedClip(
  client: Client,
  options: {
    meetingId: string;
    segments: SegmentAudio[];
    localClips?: Map<string, string>;
  },
): Promise<string> {
  const { meetingId, segments, localClips } = options;
  const workDir = mkdtempSync(join(tmpdir(), "graceplace-join-"));

  try {
    const inputs: string[] = [];

    for (const [index, segment] of segments.entries()) {
      const storagePath = segment.audio_clip_path as string;
      const local = localClips?.get(storagePath);

      if (local) {
        inputs.push(local);
        continue;
      }

      const { data, error } = await client.storage
        .from(AUDIO_BUCKET)
        .download(storagePath);

      if (error || !data) {
        throw new Error(
          `Could not download ${storagePath} to rebuild the word's audio: ${error?.message ?? "no data"}`,
        );
      }

      const file = join(workDir, `${String(index).padStart(2, "0")}.${CLIP_EXTENSION}`);
      writeFileSync(file, Buffer.from(await data.arrayBuffer()));
      inputs.push(file);
    }

    const output = join(workDir, `joined.${CLIP_EXTENSION}`);
    await joinClips({ inputs, output });

    // A fresh object name every time, so a stale signed URL for the previous
    // join can never resolve to the new audio.
    const storagePath = `${meetingId}/${randomUUID()}-joined.${CLIP_EXTENSION}`;
    const { error } = await client.storage
      .from(AUDIO_BUCKET)
      .upload(storagePath, readFileSync(output), {
        contentType: CLIP_CONTENT_TYPE,
        upsert: false,
      });

    if (error) throw new Error(`Uploading the joined clip failed: ${error.message}`);
    return storagePath;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Removes every audio object a word owns. Used when deleting a word, so its
 * segment clips do not outlive it in the bucket.
 */
export async function deleteWordAudio(
  client: Client,
  wordId: string,
): Promise<string[]> {
  const [{ data: word }, { data: segments }] = await Promise.all([
    client.from("word").select("audio_clip_path").eq("id", wordId).maybeSingle(),
    client.from("segment").select("audio_clip_path").eq("word_id", wordId),
  ]);

  const paths = wordAudioObjects(word?.audio_clip_path ?? null, segments ?? []);
  if (paths.length === 0) return [];

  // Best effort: the row is about to go, and a failed storage delete must not
  // block that. Anything left behind is reported by the caller.
  const { error } = await client.storage.from(AUDIO_BUCKET).remove(paths);
  return error ? [] : paths;
}
