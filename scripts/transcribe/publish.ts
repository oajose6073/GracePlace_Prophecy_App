import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../lib/types";
import { AUDIO_BUCKET } from "../lib";
import { CLIP_CONTENT_TYPE } from "./audio";

/**
 * created_at and updated_at are set from the same now() on insert, but allow
 * a little slack so clock precision never reads as a human edit.
 */
const EDIT_TOLERANCE_MS = 1000;

export type PendingWord = {
  id: string;
  recipientName: string;
  source: "script" | "manual" | "seed";
  edited: boolean;
  audioClipPath: string | null;
  segmentCount: number;
};

export async function findOrCreateMeeting(
  db: SupabaseClient<Database>,
  date: string,
  format: "zoom" | "in-person" | "hybrid",
): Promise<{ id: string; created: boolean }> {
  const { data: existing, error } = await db
    .from("meeting")
    .select("id")
    .eq("date", date)
    .maybeSingle();

  if (error) throw new Error(`Looking up the meeting failed: ${error.message}`);
  if (existing) return { id: existing.id, created: false };

  const { data, error: insertError } = await db
    .from("meeting")
    .insert({ date, format, status: "processing" })
    .select("id")
    .single();

  if (insertError || !data) {
    throw new Error(`Creating the meeting failed: ${insertError?.message}`);
  }
  return { id: data.id, created: true };
}

export async function inspectMeeting(
  db: SupabaseClient<Database>,
  meetingId: string,
): Promise<{ pending: PendingWord[]; reviewedCount: number }> {
  const { data, error } = await db
    .from("word")
    .select(
      `id, status, source, created_at, updated_at, audio_clip_path,
       recipient:person!word_recipient_id_fkey ( name ),
       segment ( created_at, updated_at )`,
    )
    .eq("meeting_id", meetingId);

  if (error) throw new Error(`Looking up existing words failed: ${error.message}`);

  type Row = {
    id: string;
    status: "pending" | "reviewed";
    source: "script" | "manual" | "seed";
    created_at: string;
    updated_at: string;
    audio_clip_path: string | null;
    recipient: { name: string } | null;
    segment: { created_at: string; updated_at: string }[];
  };

  const rows = (data ?? []) as unknown as Row[];
  const reviewedCount = rows.filter((r) => r.status === "reviewed").length;

  const pending = rows
    .filter((r) => r.status === "pending")
    .map<PendingWord>((r) => {
      const wordEdited =
        Date.parse(r.updated_at) - Date.parse(r.created_at) > EDIT_TOLERANCE_MS;
      const segmentEdited = (r.segment ?? []).some(
        (s) => Date.parse(s.updated_at) - Date.parse(s.created_at) > EDIT_TOLERANCE_MS,
      );

      return {
        id: r.id,
        recipientName: r.recipient?.name ?? "(to be confirmed)",
        source: r.source,
        edited: wordEdited || segmentEdited,
        audioClipPath: r.audio_clip_path,
        segmentCount: (r.segment ?? []).length,
      };
    });

  return { pending, reviewedCount };
}

export function describePendingWord(word: PendingWord): string {
  const flags: string[] = [];
  if (word.source !== "script") flags.push(`added ${word.source === "seed" ? "by the seed script" : "manually"}`);
  if (word.edited) flags.push("edited in review");

  const detail = flags.length > 0 ? `  <-- ${flags.join(", ")}` : "";
  const segments = `${word.segmentCount} segment${word.segmentCount === 1 ? "" : "s"}`;
  return `  ${word.recipientName.padEnd(26)} ${segments.padEnd(12)}${detail}`;
}

/** Hand-made or hand-edited work that --replace-pending would destroy. */
export function riskyPendingWords(pending: PendingWord[]): PendingWord[] {
  return pending.filter((w) => w.source !== "script" || w.edited);
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "This step needs a yes/no answer but stdin is not a terminal. Run it in an interactive shell.",
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (y/N) `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Deletes every pending word in the meeting, its segments (by cascade) and
 * its audio objects. Reviewed words are never selected, so they cannot be
 * caught up in this.
 */
export async function deletePendingWords(
  db: SupabaseClient<Database>,
  pending: PendingWord[],
): Promise<{ wordsDeleted: number; objectsDeleted: number }> {
  if (pending.length === 0) return { wordsDeleted: 0, objectsDeleted: 0 };

  const paths = pending
    .map((w) => w.audioClipPath)
    .filter((p): p is string => Boolean(p));

  let objectsDeleted = 0;
  if (paths.length > 0) {
    const { error } = await db.storage.from(AUDIO_BUCKET).remove(paths);
    if (error) {
      throw new Error(`Deleting old clips failed: ${error.message}`);
    }
    objectsDeleted = paths.length;
  }

  const { data, error } = await db
    .from("word")
    .delete()
    .in(
      "id",
      pending.map((w) => w.id),
    )
    .select("id");

  if (error) throw new Error(`Deleting old pending words failed: ${error.message}`);

  return { wordsDeleted: (data ?? []).length, objectsDeleted };
}

/**
 * Uploads one clip. The guard is deliberate: the full meeting recording must
 * never reach the bucket, so anything outside the run's own clips folder is
 * refused outright rather than trusted to the caller.
 */
export async function uploadClip(
  db: SupabaseClient<Database>,
  options: {
    clipPath: string;
    clipsDir: string;
    meetingId: string;
    objectName: string;
  },
): Promise<string> {
  const { clipPath, clipsDir, meetingId, objectName } = options;

  const absoluteClip = resolve(clipPath);
  const absoluteClipsDir = resolve(clipsDir);
  if (!absoluteClip.startsWith(absoluteClipsDir)) {
    throw new Error(
      `Refusing to upload ${clipPath}: only files cut into ${clipsDir} may be uploaded, never the source recording.`,
    );
  }

  const storagePath = `${meetingId}/${objectName}`;
  const { error } = await db.storage
    .from(AUDIO_BUCKET)
    .upload(storagePath, readFileSync(absoluteClip), {
      contentType: CLIP_CONTENT_TYPE,
      upsert: false,
    });

  if (error) throw new Error(`Uploading ${objectName} failed: ${error.message}`);
  return storagePath;
}

export async function createWord(
  db: SupabaseClient<Database>,
  options: {
    meetingId: string;
    recipientId: string | null;
    giverId: string | null;
    storagePath: string;
  },
): Promise<string> {
  const { data, error } = await db
    .from("word")
    .insert({
      meeting_id: options.meetingId,
      recipient_id: options.recipientId,
      giver_id: options.giverId,
      audio_clip_path: options.storagePath,
      status: "pending",
      source: "script",
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Creating a word failed: ${error?.message}`);
  return data.id;
}

export async function addSegment(
  db: SupabaseClient<Database>,
  options: {
    wordId: string;
    startSec: number;
    endSec?: number;
    transcript: string;
  },
): Promise<void> {
  const { count } = await db
    .from("segment")
    .select("id", { count: "exact", head: true })
    .eq("word_id", options.wordId);

  const { error } = await db.from("segment").insert({
    word_id: options.wordId,
    position: count ?? 0,
    start_sec: options.startSec,
    end_sec: options.endSec ?? null,
    transcript: options.transcript,
  });

  if (error) throw new Error(`Adding a segment failed: ${error.message}`);
}

export async function markMeetingRecorded(
  db: SupabaseClient<Database>,
  meetingId: string,
): Promise<void> {
  // The full recording is never uploaded, so recording_path stays null.
  await db.from("meeting").update({ status: "recorded" }).eq("id", meetingId);
}
