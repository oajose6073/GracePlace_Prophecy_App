import { spawn } from "node:child_process";
import { statSync } from "node:fs";

import ffmpegPath from "ffmpeg-static";

/**
 * Clip settings from the spec's cost model: mono, 64 kbps, which works out at
 * roughly 0.5 MB per minute.
 */
export const CLIP_CHANNELS = 1;
export const CLIP_BITRATE = "64k";
export const CLIP_EXTENSION = "m4a";
/** .m4a is AAC in an MP4 container, which is on the bucket's allow-list. */
export const CLIP_CONTENT_TYPE = "audio/mp4";

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

  args.push(
    "-i",
    input,
    "-vn",
    "-ac",
    String(CLIP_CHANNELS),
    "-c:a",
    "aac",
    "-b:a",
    CLIP_BITRATE,
    "-movflags",
    "+faststart",
    output,
  );

  const { code, stderr } = await run(args);
  if (code !== 0) {
    throw new Error(`ffmpeg failed cutting ${output}:\n${stderr.trim()}`);
  }

  const size = statSync(output).size;
  if (size === 0) {
    throw new Error(`ffmpeg produced an empty clip at ${output}.`);
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
