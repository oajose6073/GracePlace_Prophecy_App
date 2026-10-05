import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { MarkersFile, RawMarker } from "./types";

const FORMATS = new Set(["zoom", "in-person", "hybrid"]);

export class MarkersError extends Error {}

/**
 * "01:12:33.5" / "12:33" / 753 / "753" all become seconds.
 */
export function parseTime(value: string | number, where: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new MarkersError(`${where}: "at" must be a non-negative number of seconds.`);
    }
    return value;
  }

  const raw = String(value).trim();
  if (raw === "") throw new MarkersError(`${where}: "at" is empty.`);

  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);

  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new MarkersError(
      `${where}: "at" must be seconds, "MM:SS" or "HH:MM:SS" — got "${raw}".`,
    );
  }

  const nums = parts.map((p) => {
    if (!/^\d+(\.\d+)?$/.test(p.trim())) {
      throw new MarkersError(`${where}: "at" has a non-numeric part in "${raw}".`);
    }
    return Number(p);
  });

  const [h, m, s] = nums.length === 3 ? nums : [0, nums[0], nums[1]];
  if (m >= 60 || s >= 60) {
    throw new MarkersError(`${where}: "at" has minutes or seconds of 60+ in "${raw}".`);
  }
  return h * 3600 + m * 60 + s;
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = s.toFixed(s % 1 === 0 ? 0 : 1).padStart(s < 10 ? 2 : 1, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${ss}`;
}

export function loadMarkersFile(path: string): {
  file: MarkersFile;
  recordingPath: string;
} {
  if (!existsSync(path)) {
    throw new MarkersError(`Markers file not found: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new MarkersError(
      `Markers file is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MarkersError(
      'Markers file must be an object with "meeting", "recording" and "markers".',
    );
  }

  const file = parsed as Partial<MarkersFile>;

  if (!file.meeting?.date || !/^\d{4}-\d{2}-\d{2}$/.test(file.meeting.date)) {
    throw new MarkersError('meeting.date must be present and look like "2026-05-08".');
  }
  if (!file.meeting.format || !FORMATS.has(file.meeting.format)) {
    throw new MarkersError(
      `meeting.format must be one of ${[...FORMATS].join(", ")}.`,
    );
  }
  if (typeof file.recording !== "string" || file.recording.trim() === "") {
    throw new MarkersError('"recording" must be a path to the local recording.');
  }
  if (!Array.isArray(file.markers) || file.markers.length === 0) {
    throw new MarkersError('"markers" must be a non-empty array.');
  }

  // Resolve the recording against the cwd, then against the markers file's
  // own folder, so a markers file can sit next to its recording.
  const candidates = isAbsolute(file.recording)
    ? [file.recording]
    : [resolve(process.cwd(), file.recording), resolve(dirname(path), file.recording)];

  const recordingPath = candidates.find((c) => existsSync(c));
  if (!recordingPath) {
    throw new MarkersError(
      `Recording not found. Looked in:\n  ${candidates.join("\n  ")}`,
    );
  }

  validateShape(file.markers);

  return { file: file as MarkersFile, recordingPath };
}

function validateShape(markers: RawMarker[]): void {
  const problems: string[] = [];
  let lastTime = -1;

  markers.forEach((marker, i) => {
    const where = `marker ${i + 1}`;

    if (typeof marker !== "object" || marker === null) {
      problems.push(`${where}: not an object.`);
      return;
    }
    if (marker.at === undefined) {
      problems.push(`${where}: missing "at".`);
      return;
    }

    let time: number;
    try {
      time = parseTime(marker.at, where);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      return;
    }

    // Strictly increasing: two markers at the same instant would produce a
    // zero-length clip.
    if (time <= lastTime) {
      problems.push(
        `${where}: "at" ${formatTime(time)} is not after the previous marker (${formatTime(lastTime)}). Markers must be in order.`,
      );
    }
    lastTime = Math.max(lastTime, time);

    if (marker.end) {
      if (i !== markers.length - 1) {
        problems.push(`${where}: an "end" marker must be the last one.`);
      }
      if (marker.recipient || marker.giver || marker.addendum || marker.guest) {
        problems.push(`${where}: an "end" marker carries only "at".`);
      }
      return;
    }

    if (marker.guest) {
      if (marker.addendum) {
        problems.push(`${where}: a guest marker cannot also be an addendum.`);
      }
      return;
    }

    if (!("recipient" in marker)) {
      problems.push(
        `${where}: missing "recipient". Use null for "to be confirmed", or set "guest": true.`,
      );
    } else if (marker.recipient !== null && typeof marker.recipient !== "string") {
      problems.push(`${where}: "recipient" must be a name or null.`);
    } else if (typeof marker.recipient === "string" && marker.recipient.trim() === "") {
      problems.push(`${where}: "recipient" is blank. Use null for "to be confirmed".`);
    }

    if (
      marker.giver !== undefined &&
      marker.giver !== null &&
      typeof marker.giver !== "string"
    ) {
      problems.push(`${where}: "giver" must be a name or null.`);
    }

    // An addendum attaches to a named person's earlier word, so there has to
    // be a name to attach it to.
    if (marker.addendum && !marker.recipient) {
      problems.push(
        `${where}: an addendum needs a named recipient — it attaches to that person's earlier word.`,
      );
    }
  });

  const words = markers.filter((m) => !m.end && !m.guest);
  if (words.length === 0) {
    problems.push("No word markers found — every marker is a guest or an end marker.");
  }

  if (problems.length > 0) {
    throw new MarkersError(
      `The markers file has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  - ${problems.join("\n  - ")}`,
    );
  }
}
