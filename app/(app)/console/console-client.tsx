"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildExportFile,
  formatClock,
  type MarkerForExport,
} from "@/lib/marker-export";
import type { Marker, MarkerKind, Meeting, MeetingFormat } from "@/lib/types";

import {
  deleteMarker,
  endMeeting,
  reopenMeeting,
  markRecordingStarted,
  nudgeMarker,
  saveMarker,
  setGuestEmail,
  setMarkerRecipient,
  shiftMarkers,
  startMeeting,
} from "./actions";

/** An operator taps after hearing the name, so the word began before the tap. */
const TAP_LEAD_SECONDS = 2;

type ConsolePerson = {
  id: string;
  name: string;
  is_congregation: boolean;
  name_spellings: string[];
};

type LocalMarker = {
  clientId: string;
  /** Set once the row exists in the database. */
  id: string | null;
  kind: MarkerKind;
  atSec: number;
  recipientId: string | null;
  giverId: string | null;
  guestEmail: string | null;
  guestLabel: string | null;
  note: string | null;
  autoConfirmed: boolean;
  synced: boolean;
  /**
   * Set when the database refused this tap outright — the meeting was ended
   * before it synced. Retrying would never succeed, so the queue stops and
   * the operator is told.
   */
  rejected?: string;
};

type Props = {
  meeting: Pick<Meeting, "id" | "date" | "format" | "recording_started_at" | "status"> | null;
  people: ConsolePerson[];
  initialMarkers: Marker[];
  today: string;
};

function storageKey(meetingId: string) {
  return `graceplace.console.${meetingId}`;
}

function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Private windows and blocked site data both land here. The console still
    // works; it just loses its offline buffer across reloads.
    return null;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* nothing we can do, and nothing that should stop a tap */
  }
}

/**
 * What may be written to browser storage.
 *
 * A guest's address and label are theirs, and local storage outlives the
 * meeting, the tab and any amount of forgetting. Once a guest tap has reached
 * the database there is no reason to keep a second copy on the device, so the
 * offline buffer keeps only what it needs to retry: unsynced taps keep their
 * details, synced ones do not.
 */
function forStorage(markers: LocalMarker[]): LocalMarker[] {
  return markers.map((m) =>
    m.kind === "guest" && m.synced
      ? { ...m, guestEmail: null, guestLabel: null }
      : m,
  );
}

function fromRow(row: Marker): LocalMarker {
  return {
    clientId: row.client_id,
    id: row.id,
    kind: row.kind,
    atSec: Number(row.at_sec),
    recipientId: row.recipient_id,
    giverId: row.giver_id,
    guestEmail: row.guest_email,
    guestLabel: row.guest_label,
    note: row.note,
    autoConfirmed: row.auto_confirmed,
    synced: true,
  };
}

const KIND_LABEL: Record<MarkerKind, string> = {
  word: "Word",
  addendum: "Addendum",
  guest: "Guest",
  to_confirm: "To be confirmed",
  end: "End of last word",
};

export function ConsoleClient({ meeting, people, initialMarkers, today }: Props) {
  const router = useRouter();
  const [meetingId, setMeetingId] = useState(meeting?.id ?? null);
  const [meetingDate, setMeetingDate] = useState(meeting?.date ?? today);
  const [meetingFormat, setMeetingFormat] = useState<MeetingFormat>(
    meeting?.format ?? "hybrid",
  );
  const [serverStartedAt, setServerStartedAt] = useState(
    meeting?.recording_started_at ?? null,
  );
  const [ended, setEnded] = useState(meeting?.status === "complete");

  const [markers, setMarkers] = useState<LocalMarker[]>(() =>
    initialMarkers.map(fromRow),
  );
  const [giverId, setGiverId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [guestEmailDraft, setGuestEmailDraft] = useState("");
  const [guestLabelDraft, setGuestLabelDraft] = useState("");
  const [guestPromptOpen, setGuestPromptOpen] = useState(false);
  const [shiftBy, setShiftBy] = useState("-5");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  /**
   * Offsets are measured against the device's own clock, captured when
   * "Recording started" was tapped on this device. Mixing the server's
   * timestamp with the device's `Date.now()` would fold any clock skew
   * between them into every marker time.
   */
  const localStartRef = useRef<number | null>(null);
  const [hasStart, setHasStart] = useState(false);

  const congregation = useMemo(
    () => people.find((p) => p.is_congregation) ?? null,
    [people],
  );
  const givers = useMemo(
    () => people.filter((p) => !p.is_congregation),
    [people],
  );

  const recipients = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return people;
    return people.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        p.name_spellings.some((s) => s.toLowerCase().includes(term)),
    );
  }, [people, search]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of people) map.set(p.id, p.name);
    return map;
  }, [people]);

  const sorted = useMemo(
    () => [...markers].sort((a, b) => a.atSec - b.atSec),
    [markers],
  );

  const pendingCount = markers.filter((m) => !m.synced && !m.rejected).length;

  /**
   * Guests nobody has an address for yet. Surfaced once the meeting ends,
   * because that is the one moment they are still in the room.
   */
  const guestsAwaitingEmail = useMemo(
    () => sorted.filter((m) => m.kind === "guest" && !m.guestEmail),
    [sorted],
  );
  const rejectedCount = markers.filter((m) => m.rejected).length;

  /** The marker waiting for a name, if the operator just tapped Next recipient. */
  const awaiting = useMemo(() => {
    const candidates = markers.filter(
      (m) => m.kind === "word" && m.recipientId === null && !m.autoConfirmed,
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((latest, m) => (m.atSec > latest.atSec ? m : latest));
  }, [markers]);

  /** Who an addendum would attach to: the most recent named recipient. */
  const lastNamedRecipient = useMemo(() => {
    const named = sorted.filter((m) => m.recipientId && m.kind !== "guest");
    return named.length > 0 ? named[named.length - 1].recipientId : null;
  }, [sorted]);

  // ---- startup: restore the device clock reference and any queued taps -----
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    if (!meetingId) return;

    const stored = readStored<{ localStartMs: number | null; markers: LocalMarker[] }>(
      storageKey(meetingId),
    );

    if (stored?.localStartMs) {
      localStartRef.current = stored.localStartMs;
      setHasStart(true);
    } else if (serverStartedAt) {
      // Started on another device, or this one lost its storage. The server
      // timestamp is the best available reference.
      localStartRef.current = Date.parse(serverStartedAt);
      setHasStart(true);
    }

    if (stored?.markers?.length) {
      setMarkers((current) => {
        const seen = new Set(current.map((m) => m.clientId));
        const extra = stored.markers.filter((m) => !seen.has(m.clientId));
        return extra.length > 0 ? [...current, ...extra] : current;
      });
    }
  }, [meetingId, serverStartedAt]);

  // ---- persist every change, so a reload or a crash loses nothing ---------
  useEffect(() => {
    if (!meetingId) return;
    writeStored(storageKey(meetingId), {
      localStartMs: localStartRef.current,
      markers: forStorage(markers),
    });
  }, [meetingId, markers]);

  // ---- the sync loop ------------------------------------------------------
  const syncing = useRef(false);

  const sync = useCallback(async () => {
    if (!meetingId || syncing.current) return;
    const queued = markers.filter((m) => !m.synced && !m.rejected);
    if (queued.length === 0) return;

    syncing.current = true;
    try {
      for (const marker of queued) {
        const result = await saveMarker(meetingId, {
          clientId: marker.clientId,
          kind: marker.kind,
          atSec: marker.atSec,
          recipientId: marker.recipientId,
          giverId: marker.giverId,
          guestEmail: marker.guestEmail,
          guestLabel: marker.guestLabel,
          note: marker.note,
        });

        if (!result.ok) {
          if (result.code === "meeting_ended" || result.code === "duplicate_end") {
            // Permanent: mark it and move on, rather than retrying forever.
            setMarkers((current) =>
              current.map((m) =>
                m.clientId === marker.clientId
                  ? { ...m, rejected: result.error, synced: false }
                  : m,
              ),
            );
            setError(result.error);
            continue;
          }

          setError(`Could not save a tap: ${result.error}`);
          break;
        }

        const saved = result.data.marker;
        setMarkers((current) =>
          current.map((m) =>
            m.clientId === saved.client_id
              ? { ...m, id: saved.id, synced: true, kind: saved.kind, autoConfirmed: saved.auto_confirmed }
              : m,
          ),
        );
        setError(null);
      }
    } catch {
      // Offline, or the request failed outright. The queue stays put and the
      // retry below picks it up — a tap is never dropped.
      setOnline(false);
    } finally {
      syncing.current = false;
    }
  }, [meetingId, markers]);

  useEffect(() => {
    void sync();
  }, [sync]);

  useEffect(() => {
    if (pendingCount === 0) return;
    const timer = window.setInterval(() => void sync(), 8000);
    return () => window.clearInterval(timer);
  }, [pendingCount, sync]);

  useEffect(() => {
    if (online) void sync();
  }, [online, sync]);

  // ---- dropping a marker --------------------------------------------------
  const drop = useCallback(
    (partial: {
      kind: MarkerKind;
      recipientId?: string | null;
      guestEmail?: string | null;
      guestLabel?: string | null;
      note?: string | null;
    }) => {
      if (ended) {
        setError(
          "This meeting has ended. Reopen it below if you need to keep tagging.",
        );
        return;
      }

      if (localStartRef.current === null) {
        setError('Tap "Recording started" first — marker times are measured from it.');
        return;
      }

      if (partial.kind === "end" && markers.some((m) => m.kind === "end")) {
        setError("This meeting already has an end marker.");
        return;
      }

      const elapsed = (Date.now() - localStartRef.current) / 1000;
      const atSec = Math.max(0, elapsed - TAP_LEAD_SECONDS);

      const marker: LocalMarker = {
        clientId: crypto.randomUUID(),
        id: null,
        kind: partial.kind,
        atSec,
        recipientId: partial.recipientId ?? null,
        giverId: partial.kind === "end" ? null : giverId,
        guestEmail: partial.kind === "guest" ? (partial.guestEmail ?? null) : null,
        guestLabel: partial.kind === "guest" ? (partial.guestLabel ?? null) : null,
        note: partial.note ?? null,
        autoConfirmed: false,
        synced: false,
      };

      setMarkers((current) => {
        // Mirrors the database trigger: an earlier marker still waiting for a
        // name settles as soon as the operator moves on, so it never blocks.
        const settled = current.map((m) =>
          m.kind === "word" && m.recipientId === null && m.atSec <= atSec
            ? { ...m, kind: "to_confirm" as MarkerKind, autoConfirmed: true, synced: false }
            : m,
        );
        return [...settled, marker];
      });

      setMessage(`${KIND_LABEL[marker.kind]} marked at ${formatClock(atSec)}`);
      setError(null);
    },
    [ended, giverId, markers],
  );

  const tapName = useCallback(
    (personId: string) => {
      if (ended) {
        setError(
          "This meeting has ended. Reopen it below if you need to keep tagging.",
        );
        return;
      }

      // A name tap fills in the marker left by "Next recipient" rather than
      // adding a second one.
      if (awaiting) {
        const target = awaiting;
        setMarkers((current) =>
          current.map((m) =>
            m.clientId === target.clientId
              ? { ...m, recipientId: personId, kind: "word", synced: false }
              : m,
          ),
        );

        if (target.id) {
          void setMarkerRecipient(target.id, personId).then((r) => {
            if (r.ok) {
              setMarkers((current) =>
                current.map((m) =>
                  m.clientId === target.clientId ? { ...m, synced: true } : m,
                ),
              );
            }
          });
        }

        setMessage(`${nameById.get(personId) ?? "Name"} filled in`);
        return;
      }

      drop({ kind: "word", recipientId: personId });
    },
    [awaiting, drop, ended, nameById],
  );

  // ---- controls -----------------------------------------------------------
  async function onStartMeeting() {
    setError(null);
    const result = await startMeeting(meetingDate, meetingFormat);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setMeetingId(result.data.meetingId);
    setMessage("Meeting started. Tap “Recording started” when the recorder is rolling.");

    // Put the new meeting in the URL so a reload comes back to it rather than
    // to the start form, and so the recent list highlights the right row.
    router.replace(`/console?meeting=${result.data.meetingId}`);
  }

  async function onRecordingStarted() {
    if (!meetingId) return;
    setError(null);

    // The device clock reference is taken first, so it matches the tap even
    // if the request is slow or fails.
    localStartRef.current = Date.now();
    setHasStart(true);
    writeStored(storageKey(meetingId), {
      localStartMs: localStartRef.current,
      markers: forStorage(markers),
    });

    const result = await markRecordingStarted(meetingId);
    if (!result.ok) {
      setError(`${result.error} Tapping still works — times are kept on this device.`);
      return;
    }
    setServerStartedAt(result.data.recordingStartedAt);
    setMessage("Recording start saved. Marker times are offsets from now.");
  }

  async function onUndo() {
    const last = sorted[sorted.length - 1];
    if (!last) return;

    setMarkers((current) => current.filter((m) => m.clientId !== last.clientId));
    setMessage(`Undid the ${KIND_LABEL[last.kind].toLowerCase()} at ${formatClock(last.atSec)}`);

    if (last.id) {
      const result = await deleteMarker(last.id);
      if (!result.ok) setError(result.error);
    }
  }

  async function onNudge(marker: LocalMarker, delta: number) {
    setMarkers((current) =>
      current.map((m) =>
        m.clientId === marker.clientId
          ? { ...m, atSec: Math.max(0, m.atSec + delta), synced: m.id ? m.synced : false }
          : m,
      ),
    );

    if (marker.id) {
      const result = await nudgeMarker(marker.id, delta);
      if (!result.ok) setError(result.error);
    }
  }

  async function onAssign(marker: LocalMarker, personId: string | null) {
    setMarkers((current) =>
      current.map((m) =>
        m.clientId === marker.clientId
          ? {
              ...m,
              recipientId: personId,
              kind: personId ? "word" : "to_confirm",
              autoConfirmed: false,
              synced: m.id ? m.synced : false,
            }
          : m,
      ),
    );

    if (marker.id) {
      const result = await setMarkerRecipient(marker.id, personId);
      if (!result.ok) setError(result.error);
    }
  }

  async function onShift() {
    if (!meetingId) return;
    const delta = Number(shiftBy);
    if (!Number.isFinite(delta) || delta === 0) {
      setError("Enter how many seconds to shift by, e.g. -5.");
      return;
    }

    if (pendingCount > 0) {
      setError("Some taps have not synced yet. Wait for the queue to clear, then shift.");
      return;
    }

    const result = await shiftMarkers(meetingId, delta);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMarkers(result.data.markers.map(fromRow));
    setMessage(`All markers shifted by ${delta > 0 ? "+" : ""}${delta}s.`);
  }

  async function onEndMeeting() {
    if (!meetingId) return;
    if (pendingCount > 0) {
      setError("Some taps have not synced yet. Stay on this page until the queue clears.");
      return;
    }

    const result = await endMeeting(meetingId);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setMarkers(result.data.markers.map(fromRow));
    setEnded(true);
    setMessage(
      result.data.settled > 0
        ? `Meeting ended. ${result.data.settled} marker${result.data.settled === 1 ? "" : "s"} still waiting for a name became “to be confirmed”.`
        : "Meeting ended.",
    );
  }

  async function onReopen() {
    if (!meetingId) return;
    if (
      !window.confirm(
        "Reopen this meeting? Tapping starts again and new markers will be accepted. Only do this if it was ended by mistake.",
      )
    ) {
      return;
    }

    const result = await reopenMeeting(meetingId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEnded(false);
    setError(null);
    setMessage("Meeting reopened. Tapping is live again.");
  }

  async function onRemoveMarker(marker: LocalMarker) {
    if (
      !window.confirm(
        `Remove the marker at ${formatClock(marker.atSec)}? It cannot be recovered.`,
      )
    ) {
      return;
    }

    setMarkers((current) => current.filter((m) => m.clientId !== marker.clientId));

    if (marker.id) {
      const result = await deleteMarker(marker.id);
      if (!result.ok) setError(result.error);
    }
    setMessage(`Removed the marker at ${formatClock(marker.atSec)}.`);
  }

  async function onSaveGuestEmail(marker: LocalMarker, email: string) {
    setMarkers((current) =>
      current.map((m) =>
        m.clientId === marker.clientId
          ? { ...m, guestEmail: email.trim() || null, synced: m.id ? m.synced : false }
          : m,
      ),
    );

    // A tap still in the offline queue has no row to update yet; the address
    // rides along when it syncs.
    if (!marker.id) {
      setMessage("Saved on this device. It will sync with the tap.");
      return;
    }

    const result = await setGuestEmail(marker.id, email);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setMessage(
      result.data.email
        ? `Saved ${result.data.email}.`
        : "Email cleared. Still waiting for one.",
    );
  }

  function onExport() {
    const forExport: MarkerForExport[] = sorted.map((m) => ({
      kind: m.kind,
      at_sec: m.atSec,
      guest_email: m.guestEmail,
      guest_label: m.guestLabel,
      note: m.note,
      recipientName: m.recipientId ? (nameById.get(m.recipientId) ?? null) : null,
      giverName: m.giverId ? (nameById.get(m.giverId) ?? null) : null,
    }));

    const file = buildExportFile({
      date: meetingDate,
      format: meetingFormat,
      recording: `recordings/${meetingDate}-meeting.m4a`,
      markers: forExport,
    });

    const blob = new Blob([`${JSON.stringify(file, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = meetingId
      ? `${meetingDate}-${meetingId.slice(0, 8)}.markers.json`
      : `${meetingDate}.markers.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // ---- screens ------------------------------------------------------------
  if (!meetingId) {
    return (
      <div className="space-y-4">
        <Banner message={message} error={error} />
        <div className="space-y-4 rounded-xl border border-line bg-white p-5">
          <h2 className="text-base font-semibold">Start a meeting</h2>
          <p className="text-sm text-muted">
            This always creates a new meeting. More than one on the same date is
            fine — a test run and the real one are told apart by their start
            time in the list below.
          </p>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Date</span>
            <input
              type="date"
              value={meetingDate}
              onChange={(e) => setMeetingDate(e.target.value)}
              className="w-full rounded-lg border border-line px-3 py-3 text-base outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Format</span>
            <select
              value={meetingFormat}
              onChange={(e) => setMeetingFormat(e.target.value as MeetingFormat)}
              className="w-full rounded-lg border border-line bg-white px-3 py-3 text-base outline-none focus:border-brand"
            >
              <option value="hybrid">Hybrid</option>
              <option value="in-person">In person</option>
              <option value="zoom">Zoom</option>
            </select>
          </label>
          <button
            onClick={onStartMeeting}
            className="w-full rounded-xl bg-brand px-4 py-4 text-base font-semibold text-white"
          >
            Start meeting
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      <Banner message={message} error={error} />

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-4 py-3 text-sm">
        <span className="font-medium">{meetingDate}</span>
        <span className="text-muted">{meetingFormat}</span>
        {ended ? (
          <span className="rounded bg-stone-100 px-2 py-0.5 text-xs text-muted">ended</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-xs">
          <span
            className={`inline-block h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-amber-500"}`}
            aria-hidden
          />
          {online ? "online" : "offline"}
          {pendingCount > 0 ? (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900">
              {pendingCount} tap{pendingCount === 1 ? "" : "s"} queued
            </span>
          ) : (
            <span className="text-muted">all saved</span>
          )}
        </span>
      </div>

      {ended ? (
        <div className="rounded-xl border border-stone-300 bg-stone-50 px-4 py-4 text-sm">
          <p className="font-medium">This meeting has ended — it is read-only.</p>
          <p className="mt-1 text-muted">
            You can still correct marker times, assign names and export. Reopen it
            if it was ended by mistake.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/console?new=1"
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
            >
              Start a new meeting
            </Link>
            <button
              onClick={onReopen}
              className="rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium"
            >
              Reopen this one
            </button>
          </div>
        </div>
      ) : null}

      {rejectedCount > 0 ? (
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {rejectedCount} tap{rejectedCount === 1 ? " was" : "s were"} refused
          because the meeting had already ended. {rejectedCount === 1 ? "It is" : "They are"}{" "}
          marked below and {rejectedCount === 1 ? "was" : "were"} not saved. Reopen
          the meeting and re-tap if {rejectedCount === 1 ? "it" : "they"} should
          count.
        </p>
      ) : null}

      {ended ? null : !hasStart ? (
        <button
          onClick={onRecordingStarted}
          className="w-full rounded-2xl bg-brand px-4 py-10 text-xl font-bold text-white shadow-sm"
        >
          Recording started
        </button>
      ) : (
        <>
          <div className="rounded-xl border border-line bg-white p-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                Giver — stays until you change it
              </span>
              <select
                value={giverId ?? ""}
                onChange={(e) => setGiverId(e.target.value || null)}
                className="w-full rounded-lg border border-line bg-white px-3 py-3 text-base outline-none focus:border-brand"
              >
                <option value="">Not recorded</option>
                {givers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {awaiting ? (
            <p className="rounded-lg border border-brand bg-brand-soft px-4 py-3 text-sm">
              Waiting for a name for the marker at {formatClock(awaiting.atSec)} — tap
              who it was for. If you move on instead, it becomes “to be confirmed”.
            </p>
          ) : null}

          <div className="rounded-xl border border-line bg-white p-4">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search names…"
              className="mb-3 w-full rounded-lg border border-line px-3 py-3 text-base outline-none focus:border-brand"
            />

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {recipients.map((p) => (
                <button
                  key={p.id}
                  onClick={() => tapName(p.id)}
                  className={`min-h-16 rounded-xl px-3 py-4 text-base font-semibold leading-tight active:scale-95 ${
                    p.is_congregation
                      ? "col-span-2 bg-brand text-white sm:col-span-3"
                      : "border border-line bg-parchment text-ink"
                  }`}
                >
                  {p.name}
                </button>
              ))}
              {recipients.length === 0 ? (
                <p className="col-span-full py-4 text-center text-sm text-muted">
                  Nobody matches “{search}”.
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setGuestPromptOpen((v) => !v)}
              className="min-h-16 rounded-xl border border-amber-300 bg-amber-50 px-3 py-4 text-base font-semibold text-amber-900"
            >
              Guest
            </button>
            <button
              onClick={() => drop({ kind: "to_confirm" })}
              className="min-h-16 rounded-xl border border-line bg-white px-3 py-4 text-base font-semibold"
            >
              To be confirmed
            </button>
            <button
              onClick={() => drop({ kind: "word" })}
              className="min-h-16 rounded-xl border border-line bg-white px-3 py-4 text-base font-semibold"
            >
              Next recipient
              <span className="block text-xs font-normal text-muted">same giver</span>
            </button>
            <button
              onClick={() =>
                lastNamedRecipient
                  ? drop({ kind: "addendum", recipientId: lastNamedRecipient })
                  : setError("There is no earlier named word to add to yet.")
              }
              disabled={!lastNamedRecipient}
              className="min-h-16 rounded-xl border border-line bg-white px-3 py-4 text-base font-semibold disabled:opacity-40"
            >
              Add to previous
              <span className="block text-xs font-normal text-muted">
                {lastNamedRecipient
                  ? (nameById.get(lastNamedRecipient) ?? "addendum")
                  : "no word yet"}
              </span>
            </button>
          </div>

          {guestPromptOpen ? (
            <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-amber-900">
                  Who was it? A first name or a description
                </span>
                <input
                  value={guestLabelDraft}
                  onChange={(e) => setGuestLabelDraft(e.target.value)}
                  placeholder="man in grey, front row"
                  className="w-full rounded-lg border border-amber-300 px-3 py-3 text-base outline-none"
                />
                <span className="mt-1 block text-xs text-amber-900">
                  Never emailed. It is only so you know who to ask for an
                  address afterwards.
                </span>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-amber-900">
                  Guest email — leave blank and add it in review
                </span>
                <input
                  type="email"
                  value={guestEmailDraft}
                  onChange={(e) => setGuestEmailDraft(e.target.value)}
                  placeholder="guest@example.com"
                  className="w-full rounded-lg border border-amber-300 px-3 py-3 text-base outline-none"
                />
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    drop({
                      kind: "guest",
                      guestEmail: guestEmailDraft.trim() || null,
                      guestLabel: guestLabelDraft.trim() || null,
                    });
                    setGuestEmailDraft("");
                    setGuestLabelDraft("");
                    setGuestPromptOpen(false);
                  }}
                  className="flex-1 rounded-lg bg-amber-900 px-4 py-3 text-base font-semibold text-white"
                >
                  Mark guest word
                </button>
                <button
                  onClick={() => setGuestPromptOpen(false)}
                  className="rounded-lg border border-amber-300 px-4 py-3 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onUndo}
              disabled={sorted.length === 0}
              className="rounded-xl border border-line bg-white px-3 py-3 text-sm font-medium disabled:opacity-40"
            >
              Undo last marker
            </button>
            <button
              onClick={() => drop({ kind: "end" })}
              disabled={markers.some((m) => m.kind === "end")}
              className="rounded-xl border border-line bg-white px-3 py-3 text-sm font-medium disabled:opacity-40"
            >
              {markers.some((m) => m.kind === "end")
                ? "End already marked"
                : "Mark end of last word"}
            </button>
          </div>
        </>
      )}

      {ended && guestsAwaitingEmail.length > 0 ? (
        <GuestsAwaitingEmail guests={guestsAwaitingEmail} onSave={onSaveGuestEmail} />
      ) : null}

      {/* Nudging, assigning and removing stay available after the meeting
          ends: tidying up the times is exactly what happens afterwards. */}
      <MarkerList
        markers={sorted}
        people={people}
        nameById={nameById}
        onNudge={onNudge}
        onAssign={onAssign}
        onRemove={onRemoveMarker}
      />

      <div className="space-y-3 rounded-xl border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">After the meeting</h2>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            Shift every marker by
            <input
              value={shiftBy}
              onChange={(e) => setShiftBy(e.target.value)}
              inputMode="numeric"
              className="ml-2 w-20 rounded border border-line px-2 py-2 text-sm text-ink"
            />
          </label>
          <span className="text-xs text-muted">seconds</span>
          <button
            onClick={onShift}
            className="rounded-lg border border-line px-3 py-2 text-sm"
          >
            Shift
          </button>
          <p className="w-full text-xs text-muted">
            For when “Recording started” was tapped late. Shifting back by the same
            amount undoes it.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <button
            onClick={onExport}
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium"
          >
            Export markers JSON
          </button>
          {ended ? (
            <Link
              href="/console?new=1"
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
            >
              Start a new meeting
            </Link>
          ) : (
            <button
              onClick={onEndMeeting}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
            >
              End meeting
            </button>
          )}
        </div>

        {meetingId ? (
          <p className="border-t border-line pt-3 font-mono text-xs break-all text-muted">
            npm run transcribe -- --meeting {meetingId} --recording recordings/
            {meetingDate}-meeting.m4a
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Banner({ message, error }: { message: string | null; error: string | null }) {
  if (!message && !error) return null;
  return (
    <div className="space-y-2">
      {error ? (
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function GuestsAwaitingEmail({
  guests,
  onSave,
}: {
  guests: LocalMarker[];
  onSave: (marker: LocalMarker, email: string) => void;
}) {
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <h2 className="text-sm font-semibold text-amber-900">
        Guests waiting for an email ({guests.length})
      </h2>
      <p className="mt-1 text-xs text-amber-900">
        Collect these now, before people leave. Without an address the word
        cannot be sent, and it is deleted after seven days either way.
      </p>

      <ul className="mt-3 space-y-3">
        {guests.map((guest) => (
          <li key={guest.clientId} className="rounded-lg bg-white p-3">
            <div className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
              <span className="font-mono">{formatClock(guest.atSec)}</span>
              <span className="font-medium">
                {guest.guestLabel ?? "no description given"}
              </span>
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                const input = event.currentTarget.elements.namedItem(
                  "email",
                ) as HTMLInputElement | null;
                if (input) onSave(guest, input.value);
              }}
              className="flex gap-2"
            >
              <input
                name="email"
                type="email"
                defaultValue={guest.guestEmail ?? ""}
                placeholder="guest@example.com"
                className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-base outline-none focus:border-brand"
              />
              <button
                type="submit"
                className="rounded-lg bg-amber-900 px-4 py-2 text-sm font-medium text-white"
              >
                Save
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MarkerList({
  markers,
  people,
  nameById,
  onNudge,
  onAssign,
  onRemove,
}: {
  markers: LocalMarker[];
  people: ConsolePerson[];
  nameById: Map<string, string>;
  onNudge: (marker: LocalMarker, delta: number) => void;
  onAssign: (marker: LocalMarker, personId: string | null) => void;
  onRemove: (marker: LocalMarker) => void;
}) {
  return (
    <section className="rounded-xl border border-line bg-white">
      <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">
        Markers ({markers.length})
      </h2>

      {markers.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          No taps yet.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {markers.map((marker) => {
            const unassigned =
              marker.recipientId === null &&
              marker.kind !== "end" &&
              marker.kind !== "guest";

            return (
              <li key={marker.clientId} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-base">{formatClock(marker.atSec)}</span>

                  <span className="font-medium">
                    {marker.kind === "end"
                      ? "End of last word"
                      : marker.kind === "guest"
                        ? `Guest${marker.guestLabel ? ` · ${marker.guestLabel}` : ""}${marker.guestEmail ? ` · ${marker.guestEmail}` : " · no email yet"}`
                        : marker.recipientId
                          ? (nameById.get(marker.recipientId) ?? "Unknown")
                          : "No name yet"}
                  </span>

                  {marker.kind === "addendum" ? (
                    <span className="rounded bg-brand-soft px-2 py-0.5 text-xs text-brand">
                      addendum
                    </span>
                  ) : null}

                  {marker.autoConfirmed ? (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                      name not caught — assign below
                    </span>
                  ) : null}

                  {marker.rejected ? (
                    <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">
                      refused — not saved
                    </span>
                  ) : !marker.synced ? (
                    <span className="rounded bg-stone-100 px-2 py-0.5 text-xs text-muted">
                      queued
                    </span>
                  ) : null}

                  <span className="ml-auto flex gap-1">
                    <button
                      onClick={() => onNudge(marker, -2)}
                      className="rounded border border-line px-2 py-1 text-xs"
                      aria-label="Move this marker 2 seconds earlier"
                    >
                      −2s
                    </button>
                    <button
                      onClick={() => onNudge(marker, 2)}
                      className="rounded border border-line px-2 py-1 text-xs"
                      aria-label="Move this marker 2 seconds later"
                    >
                      +2s
                    </button>
                    <button
                      onClick={() => onRemove(marker)}
                      className="rounded border border-red-300 px-2 py-1 text-xs text-red-700"
                      aria-label="Remove this marker"
                    >
                      Remove
                    </button>
                  </span>
                </div>

                {unassigned ? (
                  <select
                    value={marker.recipientId ?? ""}
                    onChange={(e) => onAssign(marker, e.target.value || null)}
                    className="mt-2 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Still to be confirmed</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
