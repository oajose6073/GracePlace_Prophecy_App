/**
 * Turns console markers into the markers-file shape.
 *
 * Deliberately free of Node imports: the console's export button runs this in
 * the browser, and the transcribe script runs it on the server. One mapping,
 * so a file exported from the console and a `--meeting <id>` run produce
 * identical input to the cutter.
 */
import type { MarkerKind } from "./types";

export type ExportMarker = {
  at: string;
  recipient?: string | null;
  giver?: string | null;
  addendum?: boolean;
  guest?: boolean;
  end?: boolean;
  note?: string;
};

export type ExportFile = {
  meeting: { date: string; format: "zoom" | "in-person" | "hybrid" };
  recording: string;
  markers: ExportMarker[];
};

export type MarkerForExport = {
  kind: MarkerKind;
  at_sec: number;
  guest_email: string | null;
  guest_label: string | null;
  note: string | null;
  recipientName: string | null;
  giverName: string | null;
};

export function formatAt(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const whole = Math.floor(s);
  const ms = Math.round((s - whole) * 1000);

  const base = [h, m, whole].map((n) => String(n).padStart(2, "0")).join(":");
  return ms > 0 ? `${base}.${String(ms).padStart(3, "0")}` : base;
}

/** mm:ss for the console's own marker list, where hours are noise. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function toExportMarker(marker: MarkerForExport): ExportMarker {
  const at = formatAt(marker.at_sec);
  const note = marker.note?.trim() ? marker.note.trim() : undefined;

  switch (marker.kind) {
    case "end":
      return { at, end: true, ...(note ? { note } : {}) };

    case "guest":
      // Deliberately bare. The address and the label are the guest's, and a
      // markers file gets copied around, mailed and kept - so neither is
      // written into one. The script reads them from the database instead,
      // where they are cleared once the word has been sent.
      return { at, guest: true };

    case "addendum":
      return {
        at,
        recipient: marker.recipientName,
        giver: marker.giverName,
        addendum: true,
        ...(note ? { note } : {}),
      };

    case "to_confirm":
      return {
        at,
        recipient: null,
        giver: marker.giverName,
        ...(note ? { note } : { note: "To be confirmed in the console." }),
      };

    case "word":
    default:
      return {
        at,
        // A 'word' marker with no recipient is one the operator never named.
        // It exports as null, which the script publishes as "to be confirmed".
        recipient: marker.recipientName,
        giver: marker.giverName,
        ...(note ? { note } : {}),
      };
  }
}

export function buildExportFile(options: {
  date: string;
  format: "zoom" | "in-person" | "hybrid";
  recording: string;
  markers: MarkerForExport[];
}): ExportFile {
  return {
    meeting: { date: options.date, format: options.format },
    recording: options.recording,
    markers: [...options.markers]
      .sort((a, b) => a.at_sec - b.at_sec)
      .map(toExportMarker),
  };
}
