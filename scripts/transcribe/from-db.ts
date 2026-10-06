import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { formatAt } from "../../lib/marker-export";
import type { Database } from "../../lib/types";
import { MarkersError } from "./markers";
import type { MarkersFile, RawMarker } from "./types";

/**
 * Builds the same markers structure the file format produces, straight from
 * the console's markers.
 *
 * Going through the identical shape is deliberate: `--meeting <id>` and a
 * markers file exported from the console give the cutter byte-identical input,
 * so there is only ever one code path to reason about.
 */
export async function loadMarkersFromDatabase(
  db: SupabaseClient<Database>,
  options: { meetingId: string; recording: string },
): Promise<{ file: MarkersFile; recordingPath: string }> {
  const { meetingId, recording } = options;

  const { data: meeting, error: meetingError } = await db
    .from("meeting")
    .select("id, date, format, recording_started_at")
    .eq("id", meetingId)
    .maybeSingle();

  if (meetingError) throw new MarkersError(`Loading the meeting failed: ${meetingError.message}`);
  if (!meeting) throw new MarkersError(`No meeting with id ${meetingId}.`);

  if (!meeting.recording_started_at) {
    throw new MarkersError(
      `Meeting ${meeting.date} has no recording start time, so marker times mean nothing.\n` +
        `The console sets it when the operator taps "Recording started".`,
    );
  }

  const { data: rows, error } = await db
    .from("marker")
    .select(
      `client_id, kind, at_sec, guest_email, guest_label, guest_sent_at, note, auto_confirmed,
       recipient:person!marker_recipient_id_fkey ( name ),
       giver:person!marker_giver_id_fkey ( name )`,
    )
    .eq("meeting_id", meetingId)
    .order("at_sec");

  if (error) throw new MarkersError(`Loading markers failed: ${error.message}`);

  type Row = {
    client_id: string;
    kind: "word" | "addendum" | "guest" | "to_confirm" | "end";
    at_sec: number;
    guest_email: string | null;
    guest_label: string | null;
    guest_sent_at: string | null;
    note: string | null;
    auto_confirmed: boolean;
    recipient: { name: string } | null;
    giver: { name: string } | null;
  };

  const markers = (rows ?? []) as unknown as Row[];
  if (markers.length === 0) {
    throw new MarkersError(
      `Meeting ${meeting.date} has no markers. Run the operator console first, or pass --markers with a file.`,
    );
  }

  const raw: RawMarker[] = markers.map((m) => {
    const at = formatAt(Number(m.at_sec));
    const note = m.note?.trim() || undefined;

    if (m.kind === "end") return { at, clientId: m.client_id, end: true, note };

    if (m.kind === "guest") {
      return {
        at,
        clientId: m.client_id,
        guest: true,
        guestEmail: m.guest_email,
        guestLabel: m.guest_label,
        guestSentAt: m.guest_sent_at,
        note,
      };
    }

    // A 'word' with no recipient and 'to_confirm' both mean nobody is named
    // yet: an explicit null, which publishes as "to be confirmed".
    return {
      at,
      clientId: m.client_id,
      recipient: m.recipient?.name ?? null,
      giver: m.giver?.name ?? null,
      ...(m.kind === "addendum" ? { addendum: true } : {}),
      note:
        note ??
        (m.auto_confirmed
          ? "Name was not caught in the console — confirm the recipient."
          : undefined),
    };
  });

  const candidates = isAbsolute(recording)
    ? [recording]
    : [resolve(process.cwd(), recording)];

  const recordingPath = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (!recordingPath) {
    throw new MarkersError(`Recording not found. Looked in:\n  ${candidates.join("\n  ")}`);
  }

  return {
    file: {
      meeting: { date: meeting.date, format: meeting.format },
      recording,
      markers: raw,
    },
    recordingPath,
  };
}
