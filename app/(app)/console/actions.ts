"use server";

import { revalidatePath } from "next/cache";

import { requireWriter } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Marker, MarkerKind, MeetingFormat } from "@/lib/types";
import { zeroRowReason } from "@/lib/write-guards";

/**
 * Console actions.
 *
 * Every one of these returns a result rather than redirecting: the console is
 * a live tool on a phone, and losing the operator's place mid-meeting to
 * follow a redirect would be worse than any error message. The client keeps
 * its own copy of the marker list and reconciles against what comes back.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: ActionErrorCode };

/**
 * `meeting_ended` and `duplicate_end` are the two refusals the console has to
 * act on rather than retry: both mean the tap will never be accepted, so the
 * queue must stop trying and say so.
 */
export type ActionErrorCode = "meeting_ended" | "duplicate_end";

function fail(error: string, code?: ActionErrorCode): ActionResult<never> {
  return { ok: false, error, code };
}

/** Maps the database's refusals onto something the console can act on. */
function classify(message: string): ActionErrorCode | undefined {
  if (message.includes("MEETING_ENDED")) return "meeting_ended";
  if (message.includes("marker_one_end_per_meeting")) return "duplicate_end";
  return undefined;
}

export async function startMeeting(
  date: string,
  format: MeetingFormat,
): Promise<ActionResult<{ meetingId: string }>> {
  await requireWriter();
  const supabase = await createClient();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return fail("Pick a meeting date.");
  }

  // Always a new row, never a reuse of whatever shares this date. Two
  // meetings on one day — a test run and the real one — are ordinary, and a
  // meeting is identified by its id everywhere that matters: marker rows,
  // clip paths and the transcribe script's --meeting flag.
  const { data, error } = await supabase
    .from("meeting")
    .insert({ date, format, status: "scheduled" })
    .select("id")
    .single();

  if (error || !data) return fail(error?.message ?? "Could not start the meeting.");

  revalidatePath("/console");
  return { ok: true, data: { meetingId: data.id } };
}

/**
 * Stores the instant the recording started. Every marker is an offset from
 * this, so it is the one thing that must be right before tapping begins.
 */
export async function markRecordingStarted(
  meetingId: string,
): Promise<ActionResult<{ recordingStartedAt: string }>> {
  await requireWriter();
  const supabase = await createClient();

  const startedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("meeting")
    .update({ recording_started_at: startedAt, status: "recorded" })
    .eq("id", meetingId)
    .select("recording_started_at");

  if (error) return fail(error.message);
  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "meeting", meetingId);
    return fail(
      reason === "forbidden"
        ? "You do not have permission to run the console for that meeting."
        : "That meeting no longer exists. Reload the console.",
    );
  }

  revalidatePath("/console");
  return { ok: true, data: { recordingStartedAt: startedAt } };
}

export type MarkerDraft = {
  clientId: string;
  kind: MarkerKind;
  atSec: number;
  recipientId: string | null;
  giverId: string | null;
  guestEmail: string | null;
  guestLabel: string | null;
  note: string | null;
};

/**
 * Saves one tap.
 *
 * Idempotent on (meeting_id, client_id): the offline queue retries freely,
 * and a tap that did land cannot be stored twice. A conflict is a success —
 * it means this tap is already saved.
 */
export async function saveMarker(
  meetingId: string,
  draft: MarkerDraft,
): Promise<ActionResult<{ marker: Marker }>> {
  const person = await requireWriter();
  const supabase = await createClient();

  if (!draft.clientId) return fail("That tap has no id, so it cannot be saved safely.");

  const { data, error } = await supabase
    .from("marker")
    .upsert(
      {
        meeting_id: meetingId,
        client_id: draft.clientId,
        kind: draft.kind,
        at_sec: Math.max(0, draft.atSec),
        recipient_id: draft.recipientId,
        giver_id: draft.giverId,
        guest_email: draft.kind === "guest" ? draft.guestEmail : null,
        guest_label: draft.kind === "guest" ? draft.guestLabel : null,
        note: draft.note,
        created_by: person.id,
      },
      { onConflict: "meeting_id,client_id", ignoreDuplicates: false },
    )
    .select("*")
    .single();

  if (error || !data) {
    const message = error?.message ?? "Could not save that tap.";
    const code = classify(message);

    if (code === "meeting_ended") {
      return fail(
        "That meeting has been ended, so this tap was not saved. Reopen the meeting if it was closed by mistake.",
        code,
      );
    }
    if (code === "duplicate_end") {
      return fail("That meeting already has an end marker.", code);
    }
    return fail(message);
  }

  return { ok: true, data: { marker: data as Marker } };
}

/** Fills in the name on an awaiting marker, or corrects one afterwards. */
export async function setMarkerRecipient(
  markerId: string,
  recipientId: string | null,
): Promise<ActionResult<{ marker: Marker }>> {
  await requireWriter();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("marker")
    .update({
      recipient_id: recipientId,
      // Naming it makes it a word again, and no longer auto-settled.
      kind: recipientId ? "word" : "to_confirm",
      auto_confirmed: false,
    })
    .eq("id", markerId)
    .select("*")
    .single();

  if (error || !data) return fail(error?.message ?? "Could not set that recipient.");
  return { ok: true, data: { marker: data as Marker } };
}

/**
 * Records a guest's address after the meeting, while they are still in the
 * room. Updates the marker and, if the transcribe script has already run, the
 * guest_word built from it — so the address is there either way round.
 */
export async function setGuestEmail(
  markerId: string,
  email: string,
): Promise<ActionResult<{ email: string | null }>> {
  await requireWriter();
  const supabase = await createClient();

  const trimmed = email.trim().toLowerCase();
  if (trimmed && !trimmed.includes("@")) {
    return fail("That does not look like an email address.");
  }
  const value = trimmed || null;

  const { data, error } = await supabase
    .from("marker")
    .update({ guest_email: value })
    .eq("id", markerId)
    .select("id, meeting_id, client_id");

  if (error) return fail(error.message);
  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "marker", markerId);
    return fail(
      reason === "forbidden"
        ? "You do not have permission to change that marker."
        : "That marker no longer exists.",
    );
  }

  // Best effort: there is only a guest_word once the transcribe script has
  // run, and not having one yet is the normal case right after a meeting.
  await supabase
    .from("guest_word")
    .update({ guest_email: value, send_status: "pending", send_error: null })
    .eq("meeting_id", data[0].meeting_id)
    .eq("marker_client_id", data[0].client_id);

  revalidatePath("/console");
  revalidatePath("/review");
  return { ok: true, data: { email: value } };
}

/** Nudges a marker's time. The operator taps late more often than early. */
export async function nudgeMarker(
  markerId: string,
  deltaSec: number,
): Promise<ActionResult<{ atSec: number }>> {
  await requireWriter();
  const supabase = await createClient();

  const { data: marker } = await supabase
    .from("marker")
    .select("at_sec")
    .eq("id", markerId)
    .maybeSingle();

  if (!marker) return fail("That marker no longer exists.");

  const next = Math.max(0, Number(marker.at_sec) + deltaSec);
  const { data, error } = await supabase
    .from("marker")
    .update({ at_sec: next })
    .eq("id", markerId)
    .select("at_sec");

  if (error) return fail(error.message);
  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "marker", markerId);
    return fail(
      reason === "forbidden"
        ? "You do not have permission to change that marker."
        : "That marker no longer exists.",
    );
  }

  return { ok: true, data: { atSec: next } };
}

export async function deleteMarker(markerId: string): Promise<ActionResult> {
  await requireWriter();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("marker")
    .delete()
    .eq("id", markerId)
    .select("id");

  if (error) return fail(error.message);
  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "marker", markerId);
    // An already-deleted marker is the outcome the operator wanted.
    if (reason === "forbidden") {
      return fail("You do not have permission to undo that marker.");
    }
  }

  return { ok: true, data: undefined };
}

/**
 * Shifts every marker in the meeting, for when "Recording started" was tapped
 * late. Shifting back by the same amount undoes it.
 */
export async function shiftMarkers(
  meetingId: string,
  deltaSec: number,
): Promise<ActionResult<{ markers: Marker[] }>> {
  await requireWriter();
  const supabase = await createClient();

  if (!Number.isFinite(deltaSec) || deltaSec === 0) {
    return fail("Enter how many seconds to shift by.");
  }

  const { data: markers, error: readError } = await supabase
    .from("marker")
    .select("id, at_sec")
    .eq("meeting_id", meetingId);

  if (readError) return fail(readError.message);
  if (!markers || markers.length === 0) return fail("There are no markers to shift.");

  // Done one row at a time because each is clamped at zero individually;
  // at this volume (tens of markers a meeting) that is not worth optimising.
  for (const marker of markers) {
    const next = Math.max(0, Number(marker.at_sec) + deltaSec);
    const { error } = await supabase
      .from("marker")
      .update({ at_sec: next })
      .eq("id", marker.id);
    if (error) return fail(error.message);
  }

  const { data: updated, error } = await supabase
    .from("marker")
    .select("*")
    .eq("meeting_id", meetingId)
    .order("at_sec");

  if (error) return fail(error.message);
  return { ok: true, data: { markers: (updated ?? []) as Marker[] } };
}

/**
 * Ends the meeting and settles any marker still waiting for a name, so
 * nothing is left dangling. The same rule is enforced by a database trigger
 * whenever a later marker arrives.
 */
/**
 * Reopens a meeting closed by mistake, so tapping can continue. Deliberately
 * explicit rather than implied by any other action: ending is the point at
 * which stray taps stop being accepted, and undoing that should be a decision.
 */
export async function reopenMeeting(
  meetingId: string,
): Promise<ActionResult<{ status: string }>> {
  await requireWriter();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("meeting")
    .update({ status: "recorded" })
    .eq("id", meetingId)
    .select("status");

  if (error) return fail(error.message);
  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "meeting", meetingId);
    return fail(
      reason === "forbidden"
        ? "You do not have permission to reopen that meeting."
        : "That meeting no longer exists.",
    );
  }

  revalidatePath("/console");
  return { ok: true, data: { status: "recorded" } };
}

export async function endMeeting(
  meetingId: string,
): Promise<ActionResult<{ settled: number; markers: Marker[] }>> {
  await requireWriter();
  const supabase = await createClient();

  const { data: settled, error: settleError } = await supabase.rpc(
    "settle_awaiting_markers",
    { p_meeting_id: meetingId },
  );

  if (settleError) return fail(settleError.message);

  const { error } = await supabase
    .from("meeting")
    .update({ status: "complete" })
    .eq("id", meetingId);

  if (error) return fail(error.message);

  const { data: markers } = await supabase
    .from("marker")
    .select("*")
    .eq("meeting_id", meetingId)
    .order("at_sec");

  revalidatePath("/console");
  revalidatePath("/review");

  return {
    ok: true,
    data: { settled: Number(settled ?? 0), markers: (markers ?? []) as Marker[] },
  };
}
