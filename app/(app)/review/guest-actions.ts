"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AUDIO_BUCKET } from "@/lib/audio";
import { requireWriter } from "@/lib/auth";
import { sendGuestWordEmail } from "@/lib/guest-email";
import { createClient } from "@/lib/supabase/server";
import { zeroRowReason } from "@/lib/write-guards";

/**
 * Guest words are temporary by design: emailed once, then deleted. Nothing
 * about a guest is kept (spec), so a successful send removes the clip from
 * storage and the row from the database. A failure keeps both, so an admin can
 * correct the address and try again.
 */

function back(message: string, kind: "ok" | "error" = "ok"): never {
  redirect(`/review?${kind === "ok" ? "ok" : "error"}=${encodeURIComponent(message)}`);
}

/**
 * Wipes the guest's details from the console marker the word came from.
 *
 * Deleting the guest_word row is not enough on its own: the marker kept the
 * address and the label, so a record of the guest survived the email that
 * promised none would. guest_sent_at stays, so a later transcribe run knows
 * to skip this marker instead of rebuilding what was deleted.
 */
async function forgetGuestOnMarker(
  supabase: Awaited<ReturnType<typeof createClient>>,
  meetingId: string,
  markerClientId: string | null,
): Promise<void> {
  if (!markerClientId) return;

  await supabase
    .from("marker")
    .update({
      guest_email: null,
      guest_label: null,
      guest_sent_at: new Date().toISOString(),
    })
    .eq("meeting_id", meetingId)
    .eq("client_id", markerClientId);
}

export async function updateGuestWord(guestWordId: string, formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const email = String(formData.get("guest_email") ?? "").trim().toLowerCase();
  const transcript = String(formData.get("transcript") ?? "");

  const { data, error } = await supabase
    .from("guest_word")
    .update({
      guest_email: email,
      transcript,
      // Editing after a failure clears the stale reason.
      send_status: "pending",
      send_error: null,
    })
    .eq("id", guestWordId)
    .select("id");

  if (error) back(error.message, "error");
  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "guest_word", guestWordId);
    back(
      reason === "forbidden"
        ? "You do not have permission to edit guest words."
        : "That guest word is gone — it was either sent or it expired.",
      "error",
    );
  }

  revalidatePath("/review");
  back("Guest word saved.");
}

/**
 * Approve and send. This is the only thing that emails a guest, and on
 * success it is also the only thing that erases them.
 */
export async function sendGuestWord(guestWordId: string, _formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const { data: guest } = await supabase
    .from("guest_word")
    .select(
      "id, meeting_id, marker_client_id, guest_email, transcript, audio_clip_path, meeting:meeting!guest_word_meeting_id_fkey ( date )",
    )
    .eq("id", guestWordId)
    .maybeSingle();

  if (!guest) back("That guest word no longer exists.", "error");

  const email = guest.guest_email?.trim() ?? "";
  if (!email.includes("@")) {
    back("Add the guest's email address before sending.", "error");
  }
  if (!guest.transcript?.trim()) {
    back("Add the transcript before sending.", "error");
  }

  // Downloaded with the admin's own session, so the storage policies decide
  // whether they may read it.
  let clip: { filename: string; content: Buffer } | null = null;
  if (guest.audio_clip_path) {
    const { data: file, error } = await supabase.storage
      .from(AUDIO_BUCKET)
      .download(guest.audio_clip_path);

    if (error || !file) {
      back(
        `Could not read the guest's audio clip: ${error?.message ?? "no data"}. Nothing was sent.`,
        "error",
      );
    }

    const extension = guest.audio_clip_path.split(".").pop() ?? "m4a";
    clip = {
      filename: `your-word.${extension}`,
      content: Buffer.from(await file.arrayBuffer()),
    };
  }

  // The raw YYYY-MM-DD; the email module formats it for a person to read.
  const meetingDate =
    (guest as unknown as { meeting: { date: string } | null }).meeting?.date ?? null;

  const result = await sendGuestWordEmail({
    to: email,
    transcript: guest.transcript,
    meetingDate,
    clip,
  });

  if (!result.ok) {
    // Kept, with the reason, so the address can be fixed and retried.
    await supabase
      .from("guest_word")
      .update({
        send_status: "failed",
        send_error: result.error.slice(0, 500),
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", guestWordId);

    revalidatePath("/review");
    back(`Sending failed: ${result.error} The guest word has been kept so you can retry.`, "error");
  }

  // Sent. Now erase it: the clip first, because a deleted row would leave no
  // record of which object to remove.
  if (guest.audio_clip_path) {
    const { error } = await supabase.storage
      .from(AUDIO_BUCKET)
      .remove([guest.audio_clip_path]);

    if (error) {
      await supabase
        .from("guest_word")
        .update({
          send_status: "sent",
          send_error: `Sent, but the clip could not be deleted: ${error.message}`,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", guestWordId);

      revalidatePath("/review");
      back(
        `Sent to ${email}, but the audio clip could not be deleted. An editor should remove it.`,
        "error",
      );
    }
  }

  await forgetGuestOnMarker(supabase, guest.meeting_id, guest.marker_client_id);

  const { error: deleteError } = await supabase
    .from("guest_word")
    .delete()
    .eq("id", guestWordId);

  if (deleteError) {
    revalidatePath("/review");
    back(
      `Sent to ${email}, but the record could not be deleted: ${deleteError.message}`,
      "error",
    );
  }

  revalidatePath("/review");
  back(`Sent to ${email}. The clip, transcript and address have been deleted.`);
}

/** Discards a guest word without sending it. */
export async function deleteGuestWord(guestWordId: string, _formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const { data: guest } = await supabase
    .from("guest_word")
    .select("audio_clip_path, meeting_id, marker_client_id")
    .eq("id", guestWordId)
    .maybeSingle();

  const { data, error } = await supabase
    .from("guest_word")
    .delete()
    .eq("id", guestWordId)
    .select("id");

  if (error) back(error.message, "error");
  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "guest_word", guestWordId);
    back(
      reason === "forbidden"
        ? "You do not have permission to delete guest words."
        : "That guest word is already gone.",
      "error",
    );
  }

  if (guest?.audio_clip_path) {
    await supabase.storage.from(AUDIO_BUCKET).remove([guest.audio_clip_path]);
  }

  // Discarded is as final as sent, so the marker is cleared the same way.
  if (guest) {
    await forgetGuestOnMarker(supabase, guest.meeting_id, guest.marker_client_id);
  }

  revalidatePath("/review");
  back("Guest word deleted without sending.");
}
