/**
 * Phase 1 - cut a meeting recording into one clip per word, transcribe each
 * one with the member names as keyword hints, and either write the results to
 * a local folder (--dry-run) or publish them as pending words for review.
 *
 * The full recording is never uploaded. Only the cut clips reach storage.
 *
 *   npm run transcribe:dry -- --markers recordings/2026-05-08.markers.json
 *   npm run transcribe     -- --markers recordings/2026-05-08.markers.json
 *   npm run transcribe     -- --meeting <id> --recording recordings/2026-05-08.m4a
 *
 * Flags:
 *   --markers <path>     a markers file
 *   --meeting <id>       read the console's markers from the database instead
 *   --recording <path>   the recording, required with --meeting
 *   --dry-run            no database or storage writes
 *   --replace-pending    rebuild this meeting's pending words (asks first)
 *   --force              with --replace-pending, also discard hand-made work
 *   --yes                skip the y/N prompt (for non-interactive runs)
 *   --prod               use .env.prod; asks you to type the
 *                        project ref before the first write
 *   --out <dir>          output folder (default transcribe-output/)
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  CLIP_EXTENSION,
  assertUploadable,
  cutClip,
  probeDurationSeconds,
} from "../../lib/ffmpeg";
import { syncWordAudio } from "../../lib/word-audio";
import { admin, confirmProductionWrite, PROD, printEnvironmentBanner } from "../lib";
import { loadMarkersFromDatabase } from "./from-db";
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
  createGuestWord,
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

/**
 * What this run has actually written so far.
 *
 * A run that dies halfway leaves real rows and real objects behind, and the
 * operator needs to know exactly what, so they can judge whether to re-run
 * with --replace-pending or fix something first. Module scope so the failure
 * handler at the bottom can read it after main() has thrown.
 */
const created = {
  meetingId: "",
  meetingWasCreated: false,
  words: [] as string[],
  addenda: [] as string[],
  /** Only "marker N at mm:ss" - never a label, address or transcript. */
  guestWords: [] as string[],
  clips: [] as string[],
  /** Counted, not named: a guest clip path is still about a guest. */
  guestClips: 0,
};

function parseArgs(argv: string[]) {
  const args = {
    markers: "",
    meeting: "",
    recording: "",
    dryRun: false,
    replacePending: false,
    force: false,
    yes: false,
    out: DEFAULT_OUT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--markers":
        args.markers = argv[++i] ?? "";
        break;
      case "--meeting":
        args.meeting = argv[++i] ?? "";
        break;
      case "--recording":
        args.recording = argv[++i] ?? "";
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
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--prod":
        break; // handled in ../lib before anything loads
      default:
        if (arg.startsWith("--")) {
          throw new UserError(`Unknown flag ${arg}.`);
        }
    }
  }

  if (!args.markers && !args.meeting) {
    throw new UserError(
      "Pass either --markers <path> or --meeting <id> --recording <path>. Examples:\n" +
        "  npm run transcribe:dry -- --markers recordings/2026-05-08.markers.json\n" +
        "  npm run transcribe     -- --meeting <id> --recording recordings/2026-05-08.m4a",
    );
  }
  if (args.markers && args.meeting) {
    throw new UserError("Pass --markers or --meeting, not both â€” they are two ways to say the same thing.");
  }
  if (args.meeting && !args.recording) {
    throw new UserError("--meeting also needs --recording <path>: the markers are in the database, the audio is not.");
  }
  if (args.recording && !args.meeting) {
    throw new UserError('--recording only applies with --meeting. A markers file names its own recording.');
  }
  if (args.yes && !args.replacePending) {
    throw new UserError("--yes only means anything alongside --replace-pending.");
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
): { markers: ResolvedMarker[]; warnings: string[] } {
  const unmatched = new Map<string, number[]>();
  const ambiguous: string[] = [];
  const warnings: string[] = [];
  const markers: ResolvedMarker[] = [];

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

    const isGuest = Boolean(marker.guest);

    if (isGuest && !marker.guestEmail?.trim()) {
      warnings.push(
        `marker ${i + 1} at ${formatTime(times[i])}: guest word with no email yet${marker.guestLabel?.trim() ? ` (${marker.guestLabel.trim()})` : ""}. It will wait in the review queue until an admin adds one.`,
      );
    }

    const recipient = isGuest
      ? { id: null, name: null }
      : lookup(marker.recipient, i + 1, "recipient");
    const giver = lookup(marker.giver, i + 1, "giver");

    markers.push({
      index: i + 1,
      clientId: marker.clientId ?? null,
      startSec: times[i],
      // The boundary is the next marker of any kind, including a guest or an
      // end marker. The final marker runs to the end of the recording.
      endSec: i + 1 < times.length ? times[i + 1] : undefined,
      recipientId: recipient.id,
      recipientName: recipient.name,
      giverId: giver.id,
      giverName: giver.name,
      addendum: Boolean(marker.addendum),
      isGuest,
      guestEmail: marker.guestEmail?.trim() || null,
      guestLabel: marker.guestLabel?.trim() || null,
      guestSentAt: marker.guestSentAt ?? null,
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

  return { markers, warnings };
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
  // Before anything reads: --meeting loads markers from the database.
  printEnvironmentBanner();
  const db = admin();

  const { file, recordingPath } = args.meeting
    ? await loadMarkersFromDatabase(db, {
        meetingId: args.meeting,
        recording: args.recording,
      })
    : loadMarkersFile(args.markers);

  console.log(`\nMarkers:   ${args.meeting ? `meeting ${args.meeting} (from the console)` : args.markers}`);
  console.log(`Recording: ${recordingPath}`);
  console.log(`Meeting:   ${file.meeting.date} (${file.meeting.format})`);
  console.log(`Mode:      ${args.dryRun ? "dry run - nothing is written" : "live"}\n`);

  const recordingDuration = await probeDurationSeconds(recordingPath);
  if (recordingDuration === null) {
    console.warn("Could not read the recording's duration; continuing anyway.\n");
  }

  const people = await loadPeople(db);
  if (people.people.length === 0) {
    throw new UserError(
      "The member list is empty, so no name can be matched. Add members first, or run npm run seed.",
    );
  }

  const { markers, warnings } = resolveMarkers(file.markers, people, args.dryRun);

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
  //
  // --meeting names the meeting outright, so there is nothing to resolve: the
  // date lookup exists only for a markers file, which names a date rather than
  // a meeting, and a date can belong to several meetings. Everything
  // downstream â€” clip paths, the output folder, results.json â€” reads this one
  // variable, so this is the only place a meeting is decided.
  let meetingId = args.meeting;
  created.meetingId = meetingId;

  if (!args.dryRun) {
    // Before the first write of any kind. --yes does not skip this; it only
    // answers the --replace-pending prompt below.
    await confirmProductionWrite(
      `transcribe ${markers.length} marker(s) and publish them as pending words in meeting ${file.meeting.date}${args.replacePending ? ", replacing its pending words" : ""}`,
    );

    if (!meetingId) {
      const meeting = await findOrCreateMeeting(
        db,
        file.meeting.date,
        file.meeting.format,
      );
      meetingId = meeting.id;
      created.meetingWasCreated = meeting.created;
      console.log(
        meeting.created
          ? `Created meeting ${file.meeting.date}.`
          : `Using existing meeting ${file.meeting.date}.`,
      );
    } else {
      console.log(`Using meeting ${meetingId} (${file.meeting.date}).`);
    }

    created.meetingId = meetingId;

    const { pending, reviewedCount } = await inspectMeeting(db, meetingId);

    if (reviewedCount > 0) {
      console.log(
        `  ${reviewedCount} reviewed word${reviewedCount === 1 ? "" : "s"} in this meeting â€” never touched by this script.`,
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

      // --yes exists for scripted re-runs, where there is no terminal to
      // answer the prompt. It skips the confirmation only; --replace-pending
      // still refuses hand-made or hand-edited words without --force.
      if (args.yes) {
        console.log("\n--yes: deleting them without asking.");
      } else if (!(await confirm("\nDelete them and rebuild from the markers file?"))) {
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
  // Keyed by meeting, not just date: two meetings on the same day would
  // otherwise overwrite each other's clips and results.json.
  const outputDir = join(
    args.out,
    meetingId ? `${file.meeting.date}-${meetingId.slice(0, 8)}` : file.meeting.date,
  );
  const clipsDir = join(outputDir, "clips");
  mkdirSync(clipsDir, { recursive: true });

  const keywords = transcriptionKeywords(people);
  console.log(
    `Cutting ${markers.length} clip${markers.length === 1 ? "" : "s"}, transcribing with ${TRANSCRIPTION_MODEL} and ${keywords.length} name hints.\n`,
  );

  const results: ClipResult[] = [];
  /** Recipient id -> the word id created for them in this run, for addenda. */
  const wordByRecipient = new Map<string, string>();
  /** Storage path -> the local file, so the join never re-downloads. */
  const localClips = new Map<string, string>();
  /** Words whose audio needs building once all their segments exist. */
  const touchedWordIds = new Set<string>();
  let wordsCreated = 0;
  let addendaAttached = 0;
  let guestWordsCreated = 0;
  let guestsSkipped = 0;

  for (const marker of markers) {
    // That guest word has already been emailed, discarded or expired, and its
    // content deleted. Transcribing the audio again would rebuild exactly what
    // the guest was told had been thrown away.
    if (marker.isGuest && marker.guestSentAt && !args.dryRun) {
      console.log(
        `  marker ${marker.index}: guest word already dealt with on ${marker.guestSentAt.slice(0, 10)} - skipped.`,
      );
      guestsSkipped += 1;
      continue;
    }

    // A guest has no recipient, so slugging the (null) name produced "tbc",
    // which read as an unconfirmed member. Name them as guests, with the
    // operator's label when there is one.
    const label = marker.isGuest
      ? `${String(marker.index).padStart(2, "0")}-guest${
          marker.guestLabel ? `-${slug(marker.guestLabel)}` : ""
        }`
      : `${String(marker.index).padStart(2, "0")}-${slug(marker.recipientName)}`;
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
      // Every clip is uploaded as its own segment's audio, addenda included.
      // That is what was missing before: an addendum had a transcript but no
      // sound, so a word's audio stopped at its first segment.
      const objectName = `${randomUUID()}-${label}.${CLIP_EXTENSION}`;
      const storagePath = await uploadClip(db, {
        clipPath,
        clipsDir,
        meetingId,
        objectName,
      });
      // Remembered so the join below reads the local file instead of
      // downloading back what was just sent.
      localClips.set(storagePath, clipPath);
      if (marker.isGuest) created.guestClips += 1;
      else created.clips.push(storagePath);

      if (marker.isGuest) {
        // A guest word is never a `word` row and never visible to members:
        // the storage policy only grants a clip to a member when it belongs
        // to an approved word, and no word points at this one.
        const guestWordId = await createGuestWord(db, {
          meetingId,
          guestEmail: marker.guestEmail,
          guestLabel: marker.guestLabel,
          transcript,
          storagePath,
          // Links the row back to the console tap, so collecting the address
          // in the console updates this row too.
          markerClientId: marker.clientId,
        });
        result.guestWordId = guestWordId;
        result.storagePath = storagePath;
        created.guestWords.push(
          `marker ${marker.index} at ${formatTime(marker.startSec)}`,
        );
        guestWordsCreated += 1;
      } else if (marker.addendum) {
        const target = marker.recipientId
          ? wordByRecipient.get(marker.recipientId)
          : undefined;

        if (!target) {
          throw new UserError(
            `marker ${marker.index}: addendum for ${marker.recipientName ?? "unknown"} has no earlier word in this run to attach to. An addendum must follow that person's first word in the same markers file.`,
          );
        }

        await addSegment(db, {
          wordId: target,
          startSec: marker.startSec,
          endSec: marker.endSec,
          transcript,
          audioClipPath: storagePath,
        });
        result.attachedToWordId = target;
        result.storagePath = storagePath;
        touchedWordIds.add(target);
        created.addenda.push(marker.recipientName ?? `marker ${marker.index}`);
        addendaAttached += 1;
      } else {
        const wordId = await createWord(db, {
          meetingId,
          recipientId: marker.recipientId,
          giverId: marker.giverId,
        });

        await addSegment(db, {
          wordId,
          startSec: marker.startSec,
          endSec: marker.endSec,
          transcript,
          audioClipPath: storagePath,
        });

        if (marker.recipientId) wordByRecipient.set(marker.recipientId, wordId);
        result.wordId = wordId;
        result.storagePath = storagePath;
        touchedWordIds.add(wordId);
        created.words.push(marker.recipientName ?? `(to be confirmed) marker ${marker.index}`);
        wordsCreated += 1;
      }
    } else if (marker.isGuest) {
      guestWordsCreated += 1;
    } else if (!marker.addendum) {
      wordsCreated += 1;
    } else {
      addendaAttached += 1;
    }

    results.push(result);
    const words = transcript.split(/\s+/).filter(Boolean).length;
    console.log(`${words} words transcribed`);
  }

  // ---- build each word's playable audio -------------------------------------
  // Deferred until now because a word's audio depends on how many segments it
  // ends up with, and an addendum can arrive several markers later.
  let joined = 0;
  if (!args.dryRun && touchedWordIds.size > 0) {
    console.log("");
    for (const wordId of touchedWordIds) {
      const sync = await syncWordAudio(db, wordId, { localClips, meetingId });
      if (sync.strategy === "joined") {
        joined += 1;
        console.log(`  joined a multi-segment word into one clip`);
      }
    }
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
        meeting: { ...file.meeting, id: meetingId || null },
        recording: recordingPath,
        model: TRANSCRIPTION_MODEL,
        keywordCount: keywords.length,
        totals: {
          clips: results.length,
          wordsCreated,
          addendaAttached,
          guestWordsCreated,
          minutesTranscribed: Number(minutes.toFixed(2)),
          estimatedCostUsd: Number(cost.toFixed(4)),
        },
        warnings,
        clips: results.map((r) =>
          // A guest word is emailed once and then deleted, so results.json -
          // which lives on a laptop for up to 30 days - records only that a
          // guest word happened and when. No transcript, label, address or
          // clip path.
          r.marker.isGuest
            ? {
                marker: r.marker.index,
                kind: "guest" as const,
                startSec: r.marker.startSec,
                redacted: "Guest content is not written to disk.",
              }
            : {
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
              },
        ),
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
  if (!args.dryRun) {
    console.log(`Multi-segment      ${joined} word${joined === 1 ? "" : "s"} joined into one clip`);
  }
  console.log(`Guest words        ${guestWordsCreated}`);
  if (guestsSkipped > 0) {
    console.log(`Guests skipped     ${guestsSkipped} already sent, discarded or expired`);
  }
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
    if (guestWordsCreated > 0) {
      console.log(
        `${guestWordsCreated} guest word${guestWordsCreated === 1 ? "" : "s"} too â€” add any missing email, then approve to send. They are deleted after 7 days either way.`,
      );
    }
    console.log(
      `\nReminder: ${resultsPath} holds the full transcripts on this machine.\n` +
        `It is gitignored, but it is still a local copy of what was said.`,
    );

    // The recording is the one copy of guest audio the app never controls.
    // Everything else about a guest is deleted on send; this is not, and
    // nothing removes it but a person.
    console.log(
      `\nDelete the recording when you are done with it:\n` +
        `  ${recordingPath}\n` +
        `It holds every word spoken in the meeting, guests included, and the\n` +
        `clips are now in the private bucket. \`npm run transcribe:clean\` sweeps\n` +
        `recordings and output folders over 30 days old, but nothing deletes it\n` +
        `sooner than that.`,
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

  reportWhatWasCreated();
  process.exit(1);
});

/**
 * A half-finished run is the confusing case: some words exist, some do not,
 * and clips may be in the bucket with nothing pointing at them. Spell it out
 * rather than leaving the operator to go digging.
 */
function reportWhatWasCreated() {
  const total =
    created.words.length + created.addenda.length + created.guestWords.length;

  if (total === 0 && created.clips.length === 0) {
    console.error("Nothing was written to the database or to storage.\n");
    return;
  }

  console.error("Before failing, this run created:\n");

  if (created.meetingWasCreated) {
    console.error(`  meeting      ${created.meetingId} (new)`);
  } else if (created.meetingId) {
    console.error(`  meeting      ${created.meetingId} (already existed)`);
  }

  if (created.words.length > 0) {
    console.error(
      `  ${String(created.words.length).padStart(2)} word(s)   pending, source=script: ${created.words.join(", ")}`,
    );
  }
  if (created.addenda.length > 0) {
    console.error(
      `  ${String(created.addenda.length).padStart(2)} addend(a) attached to: ${created.addenda.join(", ")}`,
    );
  }
  if (created.guestWords.length > 0) {
    console.error(
      `  ${String(created.guestWords.length).padStart(2)} guest word(s): ${created.guestWords.join(", ")}`,
    );
    console.error(
      "       (guest details are not printed - see the review queue)",
    );
  }
  if (created.guestClips > 0) {
    console.error(
      `  ${String(created.guestClips).padStart(2)} guest clip(s) uploaded, paths withheld`,
    );
  }
  if (created.clips.length > 0) {
    console.error(`  ${String(created.clips.length).padStart(2)} clip(s) uploaded:`);
    for (const path of created.clips) console.error(`       ${path}`);
  }
  if (created.guestClips > 0) {
    console.error(
      "\n  The local clips folder was kept so a re-run is cheap, and it contains\n" +
        "  guest audio. Delete it once you no longer need the retry.",
    );
  }

  const orphans = created.clips.length - (total > 0 ? total : 0);
  if (orphans > 0) {
    console.error(
      `\n  ${orphans} clip(s) may have no row pointing at them. \`npm run clips:orphans\` lists those.`,
    );
  }

  console.error(
    "\nRe-run with --replace-pending to clear the pending words above and start over.\n" +
      "Reviewed words are never touched. Guest words are replaced by marker, not duplicated.\n",
  );
}

