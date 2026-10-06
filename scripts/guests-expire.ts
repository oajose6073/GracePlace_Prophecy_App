/**
 * Deletes any guest word past its expiry, whatever its send status.
 *
 * The same logic runs daily on Vercel via /api/cron/guests-expire; this is the
 * by-hand version, for the pilot or for checking what the cron would do.
 * Both call lib/guest-expiry.ts, so there is one implementation of the rule.
 *
 *   npm run guests:expire
 *   npm run guests:expire -- --dry-run
 *   npm run guests:expire -- --prod          (asks you to type the project ref)
 */
import { expireGuestWords } from "../lib/guest-expiry";
import { admin, confirmProductionWrite, printEnvironmentBanner } from "./lib";

function parseArgs(argv: string[]) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--prod") continue; // handled in ./lib before anything loads
    else if (arg.startsWith("--")) throw new Error(`Unknown flag ${arg}.`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  printEnvironmentBanner();
  const db = admin();

  // Look first, with nothing written, so the confirmation can say how many.
  const preview = await expireGuestWords(db, { dryRun: true });

  if (preview.expired.length === 0) {
    console.log("Nothing has expired. No guest words to delete.");
    return;
  }

  console.log(
    `\n${preview.expired.length} guest word${preview.expired.length === 1 ? "" : "s"} past expiry:\n`,
  );
  // Row id, status and date only. No address and no label: see
  // lib/guest-expiry.ts for why this output never names a guest.
  for (const guest of preview.expired) {
    console.log(
      `  ${guest.id}  ${guest.sendStatus.padEnd(8)} expired ${guest.expiresAt.slice(0, 10)}`,
    );
  }

  if (args.dryRun) {
    console.log("\n--dry-run: nothing was deleted.");
    return;
  }

  await confirmProductionWrite(
    `delete ${preview.expired.length} expired guest word(s), their clips, and the details on their markers`,
  );

  const result = await expireGuestWords(db);

  console.log("");
  if (result.clipsDeleted > 0) console.log(`  ${result.clipsDeleted} clip(s) deleted`);
  if (result.markersCleared > 0) console.log(`  ${result.markersCleared} console marker(s) cleared`);
  console.log(`  ${result.rowsDeleted} row(s) deleted`);
  console.log("\nDone. Nothing about those guests is kept.");
}

main().catch((err) => {
  console.error(`\nGuest expiry failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
