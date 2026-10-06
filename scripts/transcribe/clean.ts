/**
 * Deletes transcribe output folders and local recordings older than 30 days.
 *
 * results.json holds the full text of every word that was transcribed, so a
 * stale output folder is a plain-text copy of people's prophetic words
 * sitting on a laptop. A recording is worse: it is the raw audio of the whole
 * meeting, guests included, and nothing else ever deletes it. Gitignoring
 * both keeps them out of the repository; this keeps them from accumulating.
 *
 *   npm run transcribe:clean
 *   npm run transcribe:clean -- --days 7 --dry-run
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DIRS = ["transcribe-output", "recordings"];
const DEFAULT_DAYS = 30;

function parseArgs(argv: string[]) {
  const args = { dirs: DEFAULT_DIRS, days: DEFAULT_DAYS, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--dir":
        args.dirs = [argv[++i] ?? DEFAULT_DIRS[0]];
        break;
      case "--days": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error("--days must be a non-negative number.");
        }
        args.days = value;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--prod":
        // Accepted so it can be passed uniformly, but it changes nothing:
        // this only ever touches files on this machine, never a project.
        console.log("(--prod has no effect here: transcribe:clean only touches local files.)");
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag ${argv[i]}.`);
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000;

  let removed = 0;
  let kept = 0;
  let looked = 0;

  for (const dir of args.dirs) {
    if (!existsSync(dir)) continue;
    looked += 1;

    // Output folders are directories; recordings are files. Both are swept.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);

      // mtime, not the date in the name: a folder re-run yesterday for an old
      // meeting is still a fresh local copy.
      const mtime = statSync(path).mtimeMs;
      const ageDays = Math.floor((Date.now() - mtime) / (24 * 60 * 60 * 1000));

      if (mtime >= cutoff) {
        kept += 1;
        continue;
      }

      console.log(
        `  ${args.dryRun ? "would delete" : "deleting"} ${path} (${ageDays} days old)`,
      );
      if (!args.dryRun) rmSync(path, { recursive: true, force: true });
      removed += 1;
    }
  }

  if (looked === 0) {
    console.log(`Nothing to do: none of ${args.dirs.join(", ")} exist.`);
    return;
  }

  if (removed === 0) {
    console.log(
      `Nothing older than ${args.days} days in ${args.dirs.join(" or ")}. ${kept} item${kept === 1 ? "" : "s"} kept.`,
    );
    return;
  }

  console.log(
    `\n${args.dryRun ? "Would delete" : "Deleted"} ${removed} item${removed === 1 ? "" : "s"}; ${kept} kept.`,
  );
}

try {
  main();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
