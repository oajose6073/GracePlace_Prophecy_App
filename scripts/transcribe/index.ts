/**
 * Phase 1 - cut a meeting recording into one clip per word, transcribe each
 * one with the member names as keyword hints, and either write the results to
 * a local folder (--dry-run) or publish them as pending words for review.
 *
 * The full recording is never uploaded. Only the cut clips reach storage.
 *
 *   npm run transcribe:dry -- --markers recordings/2026-05-08.markers.json
 *   npm run transcribe     -- --markers recordings/2026-05-08.markers.json
 *
 * Flags:
 *   --markers <path>     the markers file (required)
 *   --dry-run            no database or storage writes
 *   --replace-pending    rebuild this meeting's pending words (asks first)
 *   --force              with --replace-pending, also discard hand-made work
 *   --out <dir>          output folder (default transcribe-output/)
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { admin } from "../lib";
import {
  CLIP_EXTENSION,
  assertUploadable,
  cutClip,
  probeDurationSeconds,
} from "./audio";
import { MarkersError, formatTime, loadMarkersFile, parseTime } from "./markers";
import {
  describePerson,
  loadPeople,
  matchName,
  transcriptionKeywords,
  type NameIndex,
} from "./people";
import {
  addSegment,
  confirm,
  createWord,
  deletePendingWords,
  describePendingWord,
  findOrCreateMeeting,
  inspectMeeting,
  markMeetingRecorded,
  riskyPendingWords,
  uploadClip,
} from "./publish";
import {
  COST_PER_MINUTE_USD,
  TRANSCRIPTION_MODEL,
  estimateCostUsd,
  transcribeClip,
} from "./transcribe";
import type { ClipResult, RawMarker, ResolvedMarker } from "./types";

const DEFAULT_OUT = "transcribe-output";

class UserError extends Error {}

function parseArgs(argv: string[]) {
  const args = {
    markers: "",
    dryRun: false,
    replacePending: false,
    force: false,
    out: DEFAULT_OUT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--markers":
        args.markers = argv[++i] ?? "";
        break;
      case "--out":
        args.out = argv[++i] ?? DEFAULT_OUT;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--replace-pending":
        args.replacePending = true;
        break;
      case "--force":
        args.force = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new UserError(`Unknown flag ${arg}.`);
        }
    }
  }

  if (!args.markers) {
    throw new UserError(
      "Pass --markers <path>. Example:\n  npm run transcribe:dry -- --markers recordings/2026-05-08.markers.json",
    );
  }
  if (args.force && !args.replacePending) {
    throw new UserError("--force only means anything alongside --replace-pending.");
  }
  if (args.dryRun && args.replacePending) {
    throw new UserError("--dry-run writes nothing, so --replace-pending has no effect.");
  }

  return args;
}

/** Resolves names to person ids and works out each clip's start and end. */
function resolveMarkers(
  raw: RawMarker[],
  index: NameIndex,
  dryRun: boolean,
): { markers: ResolvedMarker[]; guestsSkipped: number; warnings: string[] } {
  const unmatched = new Map<string, number[]>();
  const ambiguous: string[] = [];
  const warnings: string[] = [];
  const markers: ResolvedMarker[] = [];
  let guestsSkipped = 0;

  const times = raw.map((m, i) => parseTime(m.at, `marker ${i + 1}`));

  const lookup = (
    name: string | null | undefined,
    position: number,
    role: string,
  ): { id: string | null; name: string | null } => {
    // An explicit null is intentional: "to be confirmed" for a recipient,
    // "not recorded" for a giver. Only a name that matches nobody is a problem.
    if (name === null || name === undefined) return { id: null, name: null };

    const result = matchName(index, name);

    if (result.kind === "matched") {
      if (result.person.removed_at) {
        warnings.push(
          `marker ${position}: ${role} "${name}" matches ${result.person.name}, who has been removed from the member list.`,
        );
      }
      return { id: result.person.id, name: result.person.name };
    }

    if (result.kind === "ambiguous") {
      ambiguous.push(
        `marker ${position}: ${role} "${name}" matches ${result.candidates.length} people - ${result.candidates.map((p) => p.name).join(", ")}. Make the spellings unique on the Members page.`,
      );
      return { id: null, name };
    }

    const seen = unmatched.get(name) ?? [];
    seen.push(position);
    unmatched.set(name, seen);
    return { id: null, name };
  };

  raw.forEach((marker, i) => {
    if (marker.end) return;

    if (marker.guest) {
      guestsSkipped += 1;
      warnings.push(
        `marker ${i + 1} at ${formatTime(times[i])}: guest word skipped. The guest flow is Phase 3.`,
      );
      return;
    }

    const recipient = lookup(marker.recipient, i + 1, "recipient");
    const giver = lookup(marker.giver, i + 1, "giver");

    markers.push({
      index: i + 1,
      startSec: times[i],
      // The boundary is the next marker of any kind, including a guest or an
      // end marker. The final marker runs to the end of the recording.
      endSec: i + 1 < times.length ? times[i + 1] : undefined,
      recipientId: recipient.id,
      recipientName: recipient.name,
      giverId: giver.id,
      giverName: giver.name,
      addendum: Boolean(marker.addendum),
      note: marker.note,
    });
  });

  if (ambiguous.length > 0) {
    throw new UserError(`Ambiguous names:\n  - ${ambiguous.join("\n  - ")}`);
  }

  if (unmatched.size > 0) {
    const lines = [...unmatched.entries()].map(
      ([name, positions]) =>
        `"${name}" (marker${positions.length === 1 ? "" : "s"} ${positions.join(", ")})`,
    );

    if (!dryRun) {
      throw new UserError(
        `${unmatched.size} name${unmatched.size === 1 ? "" : "s"} did not match anyone on the member list:\n` +
          `  - ${lines.join("\n  - ")}\n\n` +
          `Add them on the Members page, or add the spelling as a variant, then run again.\n` +
          `Use null for a recipient who is genuinely to be confirmed.\n\n` +
          `On the member list now:\n  ${index.people.map(describePerson).join("\n  ")}`,
      );
    }

    warnings.push(
      `${unmatched.size} unmatched name${unmatched.size === 1 ? "" : "s"}, allowed because this is a dry run: ${lines.join("; ")}`,
    );
  }

  return { markers, guestsSkipped, warnings };
}

function slug(name: string | null): string {
  if (!name) return "tbc";
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "tbc"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { file, recordingPath } = loadMarkersFile(args.markers);

  console.log(`\nMarkers:   ${args.markers}`);
  console.log(`Recording: ${recordingPath}`);
  console.log(`Meeting:   ${file.meeting.date} (${file.meeting.format})`);
  console.log(`Mode:      ${args.dryRun ? "dry run - nothing is written" : "live"}\n`);

  const recordingDuration = await probeDurationSeconds(recordingPath);
  if (recordingDuration === null) {
    console.warn("Could not read the recording's duration; continuing anyway.\n");
  }

  const db = admin();
  const people = await loadPeople(db);
  if (people.people.length === 0) {
    throw new UserError(
      "The member list is empty, so no name can be matched. Add members first, or run npm run seed.",
    );
  }

  const { markers, guestsSkipped, warnings } = resolveMarkers(
    file.markers,
    people,
    args.dryRun,
  );

  if (recordingDuration !== null) {
    const past = markers.filter((m) => m.startSec >= recordingDuration);
    if (past.length > 0) {
      throw new UserError(
        `${past.length} marker${past.length === 1 ? " starts" : "s start"} at or after the end of the recording (${formatTime(recordingDuration)}): markers ${past.map((m) => m.index).join(", ")}.`,
      );
    }
  }

  for (const warning of warnings) console.warn(`  ! ${warning}`);
  if (warnings.length > 0) console.log("");

  // ---- the meeting, and what is already in it --------------------------------
  let meetingId = "";
  if (!args.dryRun) {
    const meeting = await findOrCreateMeeting(db, file.meeting.date, file.meeting.format);
    meetingId = meeting.id;
    console.log(
      meeting.created
        ? `Created meeting ${file.meeting.date}.`
        : `Using existing meeting ${file.meeting.date}.`,
    );

    const { pending, reviewedCount } = await inspectMeeting(db, meetingId);

    if (reviewedCount > 0) {
      console.log(
        `  ${reviewedCount} reviewed word${reviewedCount === 1 ? "" : "s"} in this meeting — never touched by this script.`,
      );
    }

    if (pending.length > 0) {
      if (!args.replacePending) {
        throw new UserError(
          `This meeting already has ${pending.length} pending word${pending.length === 1 ? "" : "s"}:\n` +
            pending.map(describePendingWord).join("\n") +
            `\n\nRe-running would duplicate them. Pass --replace-pending to rebuild the pending set` +
            ` (reviewed words are never affected).`,
        );
      }

      const risky = riskyPendingWords(pending);
      if (risky.length > 0 && !args.force) {
        throw new UserError(
          `${risky.length} pending word${risky.length === 1 ? " was" : "s were"} added by hand or edited in review, and --replace-pending would discard that work:\n` +
            risky.map(describePendingWord).join("\n") +
            `\n\nIf you really mean to lose those edits, pass --force as well.`,
        );
      }

      console.log(`\nThese ${pending.length} pending words will be deleted:`);
      console.log(pending.map(describePendingWord).join("\n"));
      if (risky.length > 0) {
        console.log(
          `\n  --force is set, so ${risky.length} hand-made or hand-edited word${risky.length === 1 ? "" : "s"} above will be lost.`,
        );
      }

      if (!(await confirm("\nDelete them and rebuild from the markers file?"))) {
        console.log("\nNothing was changed.");
        return;
      }

      const deleted = await deletePendingWords(db, pending);
      console.log(
        `  deleted ${deleted.wordsDeleted} word${deleted.wordsDeleted === 1 ? "" : "s"} and ${deleted.objectsDeleted} clip${deleted.objectsDeleted === 1 ? "" : "s"}\n`,
      );
    }
  }

  // ---- cut, transcribe, publish ---------------------------------------------
  const outputDir = join(args.out, file.meeting.date);
  const clipsDir = join(outputDir, "clips");
  mkdirSync(clipsDir, { recursive: true });

  const keywords = transcriptionKeywords(people);
  console.log(
    `Cutting ${markers.length} clip${markers.length === 1 ? "" : "s"}, transcribing with ${TRANSCRIPTION_MODEL} and ${keywords.length} name hints.\n`,
  );

  const results: ClipResult[] = [];
  /** Recipient id -> the word id created for them in this run, for addenda. */
  const wordByRecipient = new Map<string, string>();
  let wordsCreated = 0;
  let addendaAttached = 0;

  for (const marker of markers) {
    const label = `${String(marker.index).padStart(2, "0")}-${slug(marker.recipientName)}`;
    const clipPath = join(clipsDir, `${label}.${CLIP_EXTENSION}`);
    const span = marker.endSec
      ? `${formatTime(marker.startSec)}-${formatTime(marker.endSec)}`
      : `${formatTime(marker.startSec)}-end`;

    process.stdout.write(`  ${label.padEnd(34)} ${span.padEnd(22)}`);

    await cutClip({
      input: recordingPath,
      output: clipPath,
      startSec: marker.startSec,
      endSec: marker.endSec,
    });
    assertUploadable(clipPath, `Clip ${label}`);

    const durationSec = (await probeDurationSeconds(clipPath)) ?? 0;
    const transcript = await transcribeClip({ file: clipPath, keywords });

    const result: ClipResult = { marker, clipPath, durationSec, transcript };

    if (!args.dryRun) {
      if (marker.addendum) {
        const target = marker.recipientId
          ? wordByRecipient.get(marker.recipientId)
          : undefined;

        if (!target) {
          throw new UserError(
            `marker ${marker.index}: addendum for ${marker.recipientName ?? "unknown"} has no earlier word in this run to attach to. An addendum must follow that person's first word in the same markers file.`,
          );
        }

        // An addendum is a further segment on the same word, so its clip is
        // not uploaded as a separate word's audio.
        await addSegment(db, {
          wordId: target,
          startSec: marker.startSec,
          endSec: marker.endSec,
          transcript,
        });
        result.attachedToWordId = target;
        addendaAttached += 1;
      } else {
        const objectName = `${randomUUID()}-${label}.${CLIP_EXTENSION}`;
        const storagePath = await uploadClip(db, {
          clipPath,
          clipsDir,
          meetingId,
          objectName,
        });

        const wordId = await createWord(db, {
          meetingId,
          recipientId: marker.recipientId,
          giverId: marker.giverId,
          storagePath,
        });

        await addSegment(db, {
          wordId,
          startSec: marker.startSec,
          endSec: marker.endSec,
          transcript,
        });

        if (marker.recipientId) wordByRecipient.set(marker.recipientId, wordId);
        result.wordId = wordId;
        result.storagePath = storagePath;
        wordsCreated += 1;
      }
    } else if (!marker.addendum) {
      wordsCreated += 1;
    } else {
      addendaAttached += 1;
    }

    results.push(result);
    const words = transcript.split(/\s+/).filter(Boolean).length;
    console.log(`${words} words transcribed`);
  }

  if (!args.dryRun) {
    await markMeetingRecorded(db, meetingId);
  }

  // ---- results.json, written for both modes ---------------------------------
  const totalSeconds = results.reduce((sum, r) => sum + r.durationSec, 0);
  const minutes = totalSeconds / 60;
  const cost = estimateCostUsd(totalSeconds);

  const resultsPath = join(outputDir, "results.json");
  writeFileSync(
    resultsPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dryRun: args.dryRun,
        meeting: { ...file.meeting, id: args.dryRun ? null : meetingId },
        recording: recordingPath,
        model: TRANSCRIPTION_MODEL,
        keywordCount: keywords.length,
        totals: {
          clips: results.length,
          wordsCreated,
          addendaAttached,
          guestsSkipped,
          minutesTranscribed: Number(minutes.toFixed(2)),
          estimatedCostUsd: Number(cost.toFixed(4)),
        },
        warnings,
        clips: results.map((r) => ({
          marker: r.marker.index,
          recipient: r.marker.recipientName,
          giver: r.marker.giverName,
          startSec: r.marker.startSec,
          endSec: r.marker.endSec ?? null,
          durationSec: Number(r.durationSec.toFixed(3)),
          addendum: r.marker.addendum,
          note: r.marker.note ?? null,
          transcript: r.transcript,
          wordId: r.wordId ?? null,
          attachedToWordId: r.attachedToWordId ?? null,
          storagePath: r.storagePath ?? null,
          localClip: args.dryRun ? r.clipPath : null,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // On a live run the clips are in the bucket, so the local copies go. They
  // survive a failure above, which is what makes a re-run cheap.
  if (!args.dryRun) {
    rmSync(clipsDir, { recursive: true, force: true });
  }

  // ---- summary --------------------------------------------------------------
  console.log(`\n${"=".repeat(64)}`);
  console.log(`Meeting            ${file.meeting.date} (${file.meeting.format})`);
  console.log(`Mode               ${args.dryRun ? "dry run - nothing written" : "live"}`);
  console.log(`Words created      ${wordsCreated}`);
  console.log(`Addenda attached   ${addendaAttached}`);
  console.log(`Guests skipped     ${guestsSkipped}`);
  console.log(`Clips              ${results.length}`);
  console.log(`Minutes            ${minutes.toFixed(1)}`);
  console.log(
    `Estimated cost     US$${cost.toFixed(4)}  (${results.length} clips x ${COST_PER_MINUTE_USD}/min)`,
  );
  console.log("=".repeat(64));

  if (args.dryRun) {
    console.log(`\nClips and results.json are in ${outputDir}`);
    console.log("Nothing was written to the database or to storage.");
  } else {
    console.log(`\n${wordsCreated} pending word${wordsCreated === 1 ? "" : "s"} are waiting in the review queue.`);
    console.log(
      `\nReminder: ${resultsPath} holds the full transcripts on this machine.\n` +
        `It is gitignored, but it is still a local copy of what was said.\n` +
        `Run npm run transcribe:clean to drop output folders older than 30 days.`,
    );
  }
  console.log("");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof UserError || err instanceof MarkersError) {
    console.error(`\n${message}\n`);
  } else {
    console.error(`\nTranscribe failed: ${message}\n`);
  }
  process.exit(1);
});
