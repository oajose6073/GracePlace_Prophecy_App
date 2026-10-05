"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireWriter } from "@/lib/auth";
import { AUDIO_BUCKET } from "@/lib/audio";
import { syncWordAudio, wordAudioObjects } from "@/lib/audio-join";
import { createClient } from "@/lib/supabase/server";
import { zeroRowReason } from "@/lib/write-guards";

/**
 * Every action here runs through the member's own session, so row-level
 * security is what actually permits or refuses the write. The role checks in
 * this file only decide which message the reviewer sees.
 */

function back(message: string, kind: "ok" | "error" = "ok"): never {
  redirect(`/review?${kind === "ok" ? "ok" : "error"}=${encodeURIComponent(message)}`);
}

function optionalId(value: FormDataEntryValue | null): string | null {
  const v = String(value ?? "").trim();
  return v === "" ? null : v;
}

export async function createMeeting(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const date = String(formData.get("date") ?? "").trim();
  const format = String(formData.get("format") ?? "hybrid");

  if (!date) back("Pick a meeting date.", "error");

  const { error } = await supabase
    .from("meeting")
    .insert({ date, format: format as "zoom" | "in-person" | "hybrid" });

  if (error) back(error.message, "error");

  revalidatePath("/review");
  back("Meeting added.");
}

/**
 * Adds a word by hand. The audio file is uploaded straight from the browser to
 * the private bucket first; this receives the resulting object path.
 */
export async function createWord(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const meetingId = optionalId(formData.get("meeting_id"));
  const audioPath = optionalId(formData.get("audio_clip_path"));
  const transcript = String(formData.get("transcript") ?? "").trim();

  if (!meetingId) back("Choose which meeting this word belongs to.", "error");

  const { data: word, error } = await supabase
    .from("word")
    .insert({
      meeting_id: meetingId,
      recipient_id: optionalId(formData.get("recipient_id")),
      giver_id: optionalId(formData.get("giver_id")),
      audio_clip_path: audioPath,
      status: "pending",
      // Explicit, though it is also the column default: this is the
      // hand-made path that --replace-pending refuses to discard.
      source: "manual",
    })
    .select("id")
    .single();

  if (error || !word) back(error?.message ?? "Could not add the word.", "error");

  const { error: segmentError } = await supabase.from("segment").insert({
    word_id: word.id,
    transcript,
    start_sec: 0,
    position: 0,
    // The clip belongs to the segment; the word's own audio is derived from
    // its segments by syncWordAudio below.
    audio_clip_path: audioPath,
  });

  if (segmentError) back(segmentError.message, "error");

  try {
    await syncWordAudio(supabase, word.id);
  } catch (err) {
    back(err instanceof Error ? err.message : "Could not set the word's audio.", "error");
  }

  revalidatePath("/review");
  revalidatePath("/feed");
  back("Word added to the queue.");
}

/** Saves recipient, giver and the transcript edits for one word. */
export async function updateWord(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const wordId = String(formData.get("word_id") ?? "");
  if (!wordId) back("Missing word.", "error");

  const { error: wordError } = await supabase
    .from("word")
    .update({
      recipient_id: optionalId(formData.get("recipient_id")),
      giver_id: optionalId(formData.get("giver_id")),
    })
    .eq("id", wordId);

  if (wordError) back(wordError.message, "error");

  // One transcript box, one start/end pair per segment.
  for (const [key, value] of formData.entries()) {
    const match = /^transcript__(.+)$/.exec(key);
    if (!match) continue;
    const segmentId = match[1];

    const start = String(formData.get(`start__${segmentId}`) ?? "").trim();
    const end = String(formData.get(`end__${segmentId}`) ?? "").trim();

    const { error } = await supabase
      .from("segment")
      .update({
        transcript: String(value),
        start_sec: start === "" ? 0 : Number(start),
        end_sec: end === "" ? null : Number(end),
      })
      .eq("id", segmentId);

    if (error) back(error.message, "error");
  }

  revalidatePath("/review");
  revalidatePath("/feed");
  back("Changes saved.");
}

/**
 * Adds a later addendum as a further segment on the same word (spec).
 *
 * A segment added here is transcript-only: there is no clip to go with it, so
 * the word's audio is left exactly as it was. syncWordAudio is deliberately
 * not called — it would download and re-encode every existing clip to produce
 * the identical result.
 */
export async function addSegment(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const wordId = String(formData.get("word_id") ?? "");
  if (!wordId) back("Missing word.", "error");

  const { count } = await supabase
    .from("segment")
    .select("id", { count: "exact", head: true })
    .eq("word_id", wordId);

  const { error } = await supabase.from("segment").insert({
    word_id: wordId,
    position: count ?? 0,
    transcript: "",
    start_sec: 0,
    audio_clip_path: null,
  });

  if (error) back(error.message, "error");

  revalidatePath("/review");
  back("Segment added. It has no audio of its own — type its transcript in.");
}

/**
 * Removes a segment and rebuilds the word's audio from what is left.
 *
 * Deleting is editor-only, so RLS refuses this for an admin. The rebuild
 * drops the removed segment's clip and the now-stale joined clip, so nothing
 * is orphaned in the bucket.
 */
export async function removeSegment(segmentId: string, _formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  if (!segmentId) back("Missing segment.", "error");

  const { data: segment } = await supabase
    .from("segment")
    .select("id, word_id, audio_clip_path, word:word!segment_word_id_fkey ( status )")
    .eq("id", segmentId)
    .maybeSingle();

  if (!segment) back("That segment no longer exists.", "error");

  const status = (segment as unknown as { word: { status: string } | null }).word?.status;
  if (status === "reviewed") {
    back(
      "That word is already published. Unapprove it before changing which segments it has.",
      "error",
    );
  }

  const removedPath = segment.audio_clip_path;

  const { data: deleted, error } = await supabase
    .from("segment")
    .delete()
    .eq("id", segmentId)
    .select("id");

  if (error) back(error.message, "error");
  if (!deleted || deleted.length === 0) {
    const reason = await zeroRowReason(supabase, "segment", segmentId);
    back(
      reason === "forbidden"
        ? "Only an editor can remove a segment. Ask one of the editors."
        : "That segment has already been removed. Reload the page to see the word as it is now.",
      "error",
    );
  }

  try {
    const sync = await syncWordAudio(supabase, segment.word_id);

    // sync clears the word's previous clip when it is no longer referenced,
    // but the removed segment's own clip is its to tidy up.
    if (
      removedPath &&
      removedPath !== sync.audioClipPath &&
      !sync.removedObjects.includes(removedPath)
    ) {
      await supabase.storage.from(AUDIO_BUCKET).remove([removedPath]);
    }
  } catch (err) {
    back(
      `Segment removed, but rebuilding the audio failed: ${err instanceof Error ? err.message : err}`,
      "error",
    );
  }

  revalidatePath("/review");
  revalidatePath("/feed");
  back("Segment removed and the word's audio rebuilt.");
}

export async function approveWord(formData: FormData) {
  const person = await requireWriter();
  const supabase = await createClient();

  const wordId = String(formData.get("word_id") ?? "");
  if (!wordId) back("Missing word.", "error");

  const { data: word } = await supabase
    .from("word")
    .select("recipient_id, audio_clip_path")
    .eq("id", wordId)
    .maybeSingle();

  if (!word) back("That word no longer exists.", "error");

  // Mirrors the word_reviewed_is_complete check constraint, so the reviewer
  // gets a sentence instead of a Postgres error.
  if (!word.recipient_id) {
    back("Assign a recipient before approving — it is still to be confirmed.", "error");
  }
  if (!word.audio_clip_path) {
    back("Attach the audio clip before approving.", "error");
  }

  // Mirrors word_approval_guard. The trigger is the real gate; this is only
  // so the message reads like a sentence.
  const { data: segments } = await supabase
    .from("segment")
    .select("transcript")
    .eq("word_id", wordId);

  if (!segments || segments.length === 0) {
    back("Add a segment with its transcript before approving.", "error");
  }

  const blank = segments.filter((s) => s.transcript.trim() === "").length;
  if (blank > 0) {
    back(
      `Every segment needs transcript text before approving — ${blank} of ${segments.length} ${blank === 1 ? "is" : "are"} still empty.`,
      "error",
    );
  }

  const { error } = await supabase
    .from("word")
    .update({
      status: "reviewed",
      approved_at: new Date().toISOString(),
      approved_by: person.id,
    })
    .eq("id", wordId);

  if (error) back(error.message, "error");

  revalidatePath("/review");
  revalidatePath("/feed");
  back("Approved. It is now in the feed and on the member's profile.");
}

export async function unapproveWord(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const wordId = String(formData.get("word_id") ?? "");
  const { error } = await supabase
    .from("word")
    .update({ status: "pending", approved_at: null, approved_by: null })
    .eq("id", wordId);

  if (error) back(error.message, "error");

  revalidatePath("/review");
  revalidatePath("/feed");
  back("Pulled back into the queue.");
}

/**
 * Deleting words and audio is an editor-only action. The attempt is made
 * regardless of the caller's role: RLS refuses it for an admin, and the empty
 * result is reported back as a permission message.
 */
export async function deleteWord(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const wordId = String(formData.get("word_id") ?? "");
  if (!wordId) back("Missing word.", "error");

  // Collected before the row goes: once the word is deleted its segments
  // cascade away, and with them any record of which objects they owned.
  const { data: segments } = await supabase
    .from("segment")
    .select("audio_clip_path")
    .eq("word_id", wordId);

  const { data: word } = await supabase
    .from("word")
    .select("audio_clip_path")
    .eq("id", wordId)
    .maybeSingle();

  const objects = wordAudioObjects(word?.audio_clip_path ?? null, segments ?? []);

  const { data: deleted, error } = await supabase
    .from("word")
    .delete()
    .eq("id", wordId)
    .select("id");

  if (error) back(error.message, "error");

  if (!deleted || deleted.length === 0) {
    const reason = await zeroRowReason(supabase, "word", wordId);
    back(
      reason === "forbidden"
        ? "Only an editor can delete a word. Ask one of the editors."
        : "That word has already been deleted. Reload the page.",
      "error",
    );
  }

  if (objects.length > 0) {
    // Every clip the word owned: the joined one and each segment's. Storage
    // delete is likewise editor-only; if it is refused the row is already
    // gone and the objects can be cleaned up separately.
    await supabase.storage.from(AUDIO_BUCKET).remove(objects);
  }

  revalidatePath("/review");
  revalidatePath("/feed");
  back("Word and audio deleted.");
}
