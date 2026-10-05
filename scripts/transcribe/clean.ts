/**
 * Deletes transcribe output folders older than 30 days.
 *
 * results.json holds the full text of every word that was transcribed, so a
 * stale output folder is a plain-text copy of people's prophetic words
 * sitting on a laptop. Gitignoring it keeps it out of the repository; this
 * keeps it from accumulating.
 *
 *   npm run transcribe:clean
 *   npm run transcribe:clean -- --days 7 --dry-run
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DIR = "transcribe-output";
const DEFAULT_DAYS = 30;

function parseArgs(argv: string[]) {
  const args = { dir: DEFAULT_DIR, days: DEFAULT_DAYS, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--dir":
        args.dir = argv[++i] ?? DEFAULT_DIR;
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
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag ${argv[i]}.`);
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.dir)) {
    console.log(`Nothing to do: ${args.dir} does not exist.`);
    return;
  }

  const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000;
  const entries = readdirSync(args.dir, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  );

  let removed = 0;
  let kept = 0;

  for (const entry of entries) {
    const path = join(args.dir, entry.name);
    // mtime, not the folder's date in its name: a folder re-run yesterday for
    // an old meeting is still a fresh local copy.
    const mtime = statSync(path).mtimeMs;
    const ageDays = Math.floor((Date.now() - mtime) / (24 * 60 * 60 * 1000));

    if (mtime < cutoff) {
      console.log(`  ${args.dryRun ? "would delete" : "deleting"} ${path} (${ageDays} days old)`);
      if (!args.dryRun) rmSync(path, { recursive: true, force: true });
      removed += 1;
    } else {
      kept += 1;
    }
  }

  if (removed === 0) {
    console.log(
      `Nothing older than ${args.days} days in ${args.dir}. ${kept} folder${kept === 1 ? "" : "s"} kept.`,
    );
    return;
  }

  console.log(
    `\n${args.dryRun ? "Would delete" : "Deleted"} ${removed} folder${removed === 1 ? "" : "s"}; ${kept} kept.`,
  );
}

try {
  main();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
