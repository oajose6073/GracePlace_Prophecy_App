/**
 * Finds audio objects in the private bucket that nothing points at.
 *
 * A run that dies between uploading a clip and writing its row leaves the
 * object behind with no reference to it. Nothing in the app will ever serve
 * it — a signed URL is only granted for a clip belonging to an approved word —
 * but it still sits there, and for guest audio that matters: a guest word is
 * meant to leave no trace.
 *
 * Lists by default. Deleting is opt-in.
 *
 *   npm run clips:orphans
 *   npm run clips:orphans -- --meeting <id>
 *   npm run clips:orphans -- --delete
 *   npm run clips:orphans -- --prod --delete   (asks you to type the project ref)
 */
import {
  admin,
  AUDIO_BUCKET,
  confirmProductionWrite,
  printEnvironmentBanner,
} from "./lib";

const PAGE = 1000;

function parseArgs(argv: string[]) {
  const args = { meeting: "", del: false };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--meeting":
        args.meeting = argv[++i] ?? "";
        break;
      case "--delete":
        args.del = true;
        break;
      case "--dry-run":
        args.del = false;
        break;
      case "--prod":
        break; // handled in ./lib before anything loads
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag ${argv[i]}.`);
    }
  }

  return args;
}

type Client = ReturnType<typeof admin>;

/** Objects live at `<meetingId>/<name>`, so this walks one folder. */
async function listFolder(db: Client, prefix: string): Promise<string[]> {
  const paths: string[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db.storage
      .from(AUDIO_BUCKET)
      .list(prefix, { limit: PAGE, offset });

    if (error) throw new Error(`Listing ${prefix || "the bucket root"} failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const entry of data) {
      // A folder entry has no id; only real objects do.
      if (entry.id) paths.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }

    if (data.length < PAGE) break;
  }

  return paths;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = admin();
  printEnvironmentBanner();

  // Every path the database considers live.
  const referenced = new Set<string>();

  const [words, segments, guests, meetings] = await Promise.all([
    db.from("word").select("audio_clip_path"),
    db.from("segment").select("audio_clip_path"),
    db.from("guest_word").select("audio_clip_path"),
    db.from("meeting").select("id, date, recording_path"),
  ]);

  for (const source of [words, segments, guests]) {
    if (source.error) throw new Error(source.error.message);
    for (const row of source.data ?? []) {
      const path = (row as { audio_clip_path: string | null }).audio_clip_path;
      if (path) referenced.add(path);
    }
  }
  if (meetings.error) throw new Error(meetings.error.message);
  for (const m of meetings.data ?? []) {
    if (m.recording_path) referenced.add(m.recording_path);
  }

  const folders = args.meeting
    ? [args.meeting]
    : (meetings.data ?? []).map((m) => m.id);

  const dateById = new Map((meetings.data ?? []).map((m) => [m.id, m.date]));

  let found = 0;
  const orphans: string[] = [];

  for (const folder of folders) {
    const objects = await listFolder(db, folder);
    const unreferenced = objects.filter((p) => !referenced.has(p));
    found += objects.length;

    if (unreferenced.length === 0) continue;

    console.log(
      `\n${folder}  (${dateById.get(folder) ?? "unknown date"})  ${unreferenced.length} of ${objects.length} unreferenced:`,
    );
    for (const path of unreferenced) console.log(`  ${path}`);
    orphans.push(...unreferenced);
  }

  // Anything sitting at the bucket root belongs to no meeting at all.
  if (!args.meeting) {
    const loose = (await listFolder(db, "")).filter((p) => !referenced.has(p));
    if (loose.length > 0) {
      console.log(`\n(bucket root)  ${loose.length} unreferenced:`);
      for (const path of loose) console.log(`  ${path}`);
      orphans.push(...loose);
    }
  }

  console.log(
    `\n${found} object(s) checked, ${referenced.size} referenced by the database, ${orphans.length} orphaned.`,
  );

  if (orphans.length === 0) {
    console.log("Nothing to clean up.\n");
    return;
  }

  if (!args.del) {
    console.log("\nListing only. Re-run with --delete to remove them.\n");
    return;
  }

  await confirmProductionWrite(`delete ${orphans.length} orphaned audio object(s)`);

  const { error } = await db.storage.from(AUDIO_BUCKET).remove(orphans);
  if (error) throw new Error(`Deleting orphans failed: ${error.message}`);

  console.log(`Deleted ${orphans.length} orphaned object(s).\n`);
}

main().catch((err) => {
  console.error(`\nOrphan check failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
