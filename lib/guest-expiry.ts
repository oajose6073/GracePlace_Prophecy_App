/**
 * Deletes every guest word past its expiry, whatever its send status.
 *
 * "Guest words are emailed to the guest, then deleted. Nothing about guests is
 * kept." A successful send already deletes the row; this is the backstop for
 * the ones that never got sent — a wrong address, a guest who never gave one,
 * a meeting nobody got round to reviewing. Seven days and it goes regardless.
 *
 * Shared by `npm run guests:expire` and the daily Vercel cron, so there is one
 * implementation of the rule. It takes the client rather than making one,
 * because the script and the route build theirs differently, and it prints
 * nothing — the result says what happened and each caller reports it.
 *
 * No `import "server-only"`: the script imports this, and that marker throws
 * outside Next. It needs a service-role client, which only ever exists
 * server-side.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { AUDIO_BUCKET } from "./storage";
import type { Database } from "./types";

export type ExpiredGuest = {
  /** Row id only. Never the address or the label: see below. */
  id: string;
  sendStatus: string;
  expiresAt: string;
};

export type ExpiryResult = {
  expired: ExpiredGuest[];
  dryRun: boolean;
  clipsDeleted: number;
  markersCleared: number;
  rowsDeleted: number;
};

/**
 * Deliberately returns no address and no label. This runs unattended, and its
 * output lands in terminal scrollback and in Vercel's function logs — exactly
 * the kind of lingering record the guest was promised there would not be.
 */
export async function expireGuestWords(
  db: SupabaseClient<Database>,
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<ExpiryResult> {
  const dryRun = options.dryRun ?? false;
  const now = (options.now ?? new Date()).toISOString();

  const { data, error } = await db
    .from("guest_word")
    .select("id, send_status, expires_at, audio_clip_path, meeting_id, marker_client_id")
    .lt("expires_at", now);

  if (error) throw new Error(`Looking up expired guest words failed: ${error.message}`);

  const rows = data ?? [];
  const result: ExpiryResult = {
    expired: rows.map((r) => ({
      id: r.id,
      sendStatus: r.send_status,
      expiresAt: r.expires_at,
    })),
    dryRun,
    clipsDeleted: 0,
    markersCleared: 0,
    rowsDeleted: 0,
  };

  if (rows.length === 0 || dryRun) return result;

  // Clips first. If storage refuses, stop before touching the rows: deleting
  // a row that still has a clip would orphan guest audio with nothing left to
  // say which object it was.
  const paths = rows
    .map((r) => r.audio_clip_path)
    .filter((p): p is string => Boolean(p));

  if (paths.length > 0) {
    const { error: storageError } = await db.storage.from(AUDIO_BUCKET).remove(paths);
    if (storageError) {
      throw new Error(
        `Could not delete ${paths.length} guest clip(s): ${storageError.message}. No rows were deleted — fix this and run again.`,
      );
    }
    result.clipsDeleted = paths.length;
  }

  // Clear the console markers these came from, so no address or label
  // outlives the guest word, and mark them dealt with so a later transcribe
  // run does not rebuild them from the recording.
  for (const row of rows) {
    if (!row.marker_client_id) continue;
    const { data: cleared } = await db
      .from("marker")
      .update({ guest_email: null, guest_label: null, guest_sent_at: now })
      .eq("meeting_id", row.meeting_id)
      .eq("client_id", row.marker_client_id)
      .select("id");
    result.markersCleared += (cleared ?? []).length;
  }

  const { data: deleted, error: deleteError } = await db
    .from("guest_word")
    .delete()
    .in(
      "id",
      rows.map((r) => r.id),
    )
    .select("id");

  if (deleteError) throw new Error(`Deleting guest words failed: ${deleteError.message}`);
  result.rowsDeleted = (deleted ?? []).length;

  return result;
}
