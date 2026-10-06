/**
 * Deletes any guest word past its expiry, whatever its send status.
 *
 * "Guest words are emailed to the guest, then deleted. Nothing about guests is
 * kept." A successful send already deletes the row; this is the backstop for
 * the ones that never got sent — a wrong address, a guest who never gave one,
 * a meeting nobody got round to reviewing. Seven days and it goes regardless.
 *
 *   npm run guests:expire
 *   npm run guests:expire -- --dry-run
 *
 * Worth running on a schedule once the pilot is over.
 */
import { admin, AUDIO_BUCKET } from "./lib";

function parseArgs(argv: string[]) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown flag ${arg}.`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = admin();
  const now = new Date().toISOString();

  const { data: expired, error } = await db
    .from("guest_word")
    .select(
      "id, send_status, expires_at, audio_clip_path, meeting_id, marker_client_id",
    )
    .lt("expires_at", now);

  if (error) throw new Error(`Looking up expired guest words failed: ${error.message}`);

  if (!expired || expired.length === 0) {
    console.log("Nothing has expired. No guest words to delete.");
    return;
  }

  console.log(
    `${expired.length} guest word${expired.length === 1 ? "" : "s"} past expiry:\n`,
  );
  for (const guest of expired) {
    // Deliberately no address and no label. This runs unattended and its
    // output ends up in terminal scrollback and scheduler logs, which is
    // exactly the kind of lingering record the guest was promised there
    // would not be. The review queue is where a human looks before it goes.
    console.log(
      `  ${guest.id}  ${guest.send_status.padEnd(8)} expired ${guest.expires_at.slice(0, 10)}`,
    );
  }

  if (args.dryRun) {
    console.log("\n--dry-run: nothing was deleted.");
    return;
  }

  const paths = expired
    .map((g) => g.audio_clip_path)
    .filter((p): p is string => Boolean(p));

  if (paths.length > 0) {
    const { error: storageError } = await db.storage.from(AUDIO_BUCKET).remove(paths);
    if (storageError) {
      // Deleting the rows anyway would orphan the clips, which is the worse
      // outcome for something meant to leave no trace.
      throw new Error(
        `Could not delete ${paths.length} guest clip(s): ${storageError.message}. No rows were deleted — fix this and run again.`,
      );
    }
    console.log(`\n  ${paths.length} clip${paths.length === 1 ? "" : "s"} deleted`);
  }

  // Clear the console markers these came from, so no address or label
  // outlives the guest word, and mark them dealt with so a later transcribe
  // run does not rebuild them from the recording.
  let markersCleared = 0;
  for (const guest of expired) {
    if (!guest.marker_client_id) continue;
    const { data } = await db
      .from("marker")
      .update({ guest_email: null, guest_label: null, guest_sent_at: now })
      .eq("meeting_id", guest.meeting_id)
      .eq("client_id", guest.marker_client_id)
      .select("id");
    markersCleared += (data ?? []).length;
  }
  if (markersCleared > 0) {
    console.log(`  ${markersCleared} console marker(s) cleared`);
  }

  const { data: deleted, error: deleteError } = await db
    .from("guest_word")
    .delete()
    .in(
      "id",
      expired.map((g) => g.id),
    )
    .select("id");

  if (deleteError) throw new Error(`Deleting guest words failed: ${deleteError.message}`);

  console.log(`  ${(deleted ?? []).length} row${(deleted ?? []).length === 1 ? "" : "s"} deleted`);
  console.log("\nDone. Nothing about those guests is kept.");
}

main().catch((err) => {
  console.error(`\nGuest expiry failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
