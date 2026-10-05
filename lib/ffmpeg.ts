/**
 * ffmpeg primitives, shared by the transcribe script and the review queue.
 *
 * Deliberately NOT marked `import "server-only"`. That marker throws under
 * Node's default export condition, so any module carrying it cannot be
 * imported by the tsx scripts in scripts/ — and this code has to run in both
 * places. `lib/audio-join.ts` is the guarded entry point the app imports;
 * this file is the shared implementation behind it.
 *
 * It is server-side by construction regardless: it spawns a child process, so
 * a client bundle referencing it fails to build.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";

import ffmpegPath from "ffmpeg-static";

/** Mono at 64 kbps, the spec's cost basis of ~0.5 MB a minute. */
export const CLIP_CHANNELS = 1;
export const CLIP_BITRATE = "64k";
export const CLIP_SAMPLE_RATE = 44100;
export const CLIP_EXTENSION = "m4a";
/** .m4a is AAC in an MP4 container, which is on the bucket's allow-list. */
export const CLIP_CONTENT_TYPE = "audio/mp4";

/** Silence inserted between joined segments, so they do not run together. */
export const JOIN_GAP_SECONDS = 0.6;

/** The transcription endpoint rejects anything larger. */
export const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function binary(): string {
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg-static did not provide a binary for this platform. Install ffmpeg manually and set FFMPEG_PATH.",
    );
  }
  return process.env.FFMPEG_PATH ?? ffmpegPath;
}

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary(), args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stderr }));
  });
}

const ENCODE_ARGS = [
  "-vn",
  "-ac",
  String(CLIP_CHANNELS),
  "-c:a",
  "aac",
  "-b:a",
  CLIP_BITRATE,
  "-movflags",
  "+faststart",
];

/**
 * ffmpeg-static ships ffmpeg but not ffprobe, so the duration is read from
 * ffmpeg's own report. `ffmpeg -i <file>` with no output exits non-zero by
 * design, which is why the exit code is ignored here.
 */
export async function probeDurationSeconds(file: string): Promise<number | null> {
  const { stderr } = await run(["-hide_banner", "-i", file]);
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export async function cutClip(options: {
  input: string;
  output: string;
  startSec: number;
  /** Omit for the final clip, which runs to the end of the recording. */
  endSec?: number;
}): Promise<void> {
  const { input, output, startSec, endSec } = options;

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    // Seeking before -i is much faster on a long recording. The audio is
    // re-encoded below, so the cut is still sample-accurate.
    "-ss",
    startSec.toFixed(3),
  ];

  // -t (duration) rather than -to, because -to combined with a pre-input -ss
  // is interpreted inconsistently across ffmpeg versions.
  if (endSec !== undefined) {
    const duration = endSec - startSec;
    if (duration <= 0) {
      throw new Error(
        `Refusing to cut a clip of ${duration.toFixed(3)}s at ${startSec}s — markers are out of order.`,
      );
    }
    args.push("-t", duration.toFixed(3));
  }

  args.push("-i", input, ...ENCODE_ARGS, output);

  const { code, stderr } = await run(args);
  if (code !== 0) {
    throw new Error(`ffmpeg failed cutting ${output}:\n${stderr.trim()}`);
  }

  if (statSync(output).size === 0) {
    throw new Error(`ffmpeg produced an empty clip at ${output}.`);
  }
}

/**
 * Joins clips into one, with a short silence between each pair, so a word
 * made of several segments plays as a single piece of audio.
 *
 * Every input is pushed through `aformat` first: the concat filter needs
 * matching sample rates and channel layouts, and clips cut from different
 * recordings will not necessarily agree.
 */
export async function joinClips(options: {
  inputs: string[];
  output: string;
  gapSeconds?: number;
}): Promise<void> {
  const { inputs, output, gapSeconds = JOIN_GAP_SECONDS } = options;

  if (inputs.length === 0) {
    throw new Error("joinClips needs at least one input.");
  }
  if (inputs.length === 1) {
    throw new Error(
      "joinClips was given a single input. Point the word at that clip instead of re-encoding it.",
    );
  }

  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const input of inputs) args.push("-i", input);

  // One silence input per gap. Reusing a single input in several filter
  // branches would need asplit; separate inputs keep the graph simple.
  const gapCount = inputs.length - 1;
  for (let i = 0; i < gapCount; i += 1) {
    args.push(
      "-f",
      "lavfi",
      "-t",
      gapSeconds.toFixed(3),
      "-i",
      `anullsrc=channel_layout=mono:sample_rate=${CLIP_SAMPLE_RATE}`,
    );
  }

  const format = `aformat=sample_fmts=fltp:sample_rates=${CLIP_SAMPLE_RATE}:channel_layouts=mono`;
  const parts: string[] = [];
  const chain: string[] = [];

  inputs.forEach((_, i) => {
    parts.push(`[${i}:a]${format}[c${i}]`);
  });
  for (let i = 0; i < gapCount; i += 1) {
    parts.push(`[${inputs.length + i}:a]${format}[g${i}]`);
  }

  inputs.forEach((_, i) => {
    chain.push(`[c${i}]`);
    if (i < gapCount) chain.push(`[g${i}]`);
  });

  const streamCount = inputs.length + gapCount;
  parts.push(`${chain.join("")}concat=n=${streamCount}:v=0:a=1[out]`);

  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[out]",
    ...ENCODE_ARGS,
    output,
  );

  const { code, stderr } = await run(args);
  if (code !== 0) {
    throw new Error(`ffmpeg failed joining ${inputs.length} clips:\n${stderr.trim()}`);
  }

  if (statSync(output).size === 0) {
    throw new Error(`ffmpeg produced an empty joined clip at ${output}.`);
  }
}

export function assertUploadable(file: string, label: string): void {
  const size = statSync(file).size;
  if (size > OPENAI_MAX_UPLOAD_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    throw new Error(
      `${label} is ${mb} MB, over the 25 MB transcription limit. Split that marker into two.`,
    );
  }
}
