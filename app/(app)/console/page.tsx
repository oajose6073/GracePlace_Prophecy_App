import Link from "next/link";

import { requireWriter } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sortRecipients, type Marker } from "@/lib/types";

import { ConsoleClient } from "./console-client";

export const metadata = { title: "Operator console — GracePlace" };
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 8;

const STATUS_LABEL: Record<string, string> = {
  scheduled: "not started",
  recorded: "recording",
  processing: "processing",
  complete: "ended",
};

function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Two meetings can share a date, so the start time is what tells them apart. */
function formatStartedAt(iso: string | null): string {
  if (!iso) return "never started";
  return new Date(iso).toLocaleTimeString("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function ConsolePage({
  searchParams,
}: {
  searchParams: Promise<{ meeting?: string; new?: string }>;
}) {
  const { meeting: requestedId, new: startNew } = await searchParams;
  await requireWriter();
  const supabase = await createClient();

  const today = new Date().toISOString().slice(0, 10);

  // Several meetings may share a date — a test run and the real one — so each
  // is identified by id, never by date.
  const { data: recent } = await supabase
    .from("meeting")
    .select("id, date, format, status, recording_started_at, created_at, marker(count)")
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(RECENT_LIMIT);

  const recentMeetings = (recent ?? []).map((m) => ({
    id: m.id,
    date: m.date,
    format: m.format,
    status: m.status,
    recording_started_at: m.recording_started_at,
    markerCount:
      (m as unknown as { marker: { count: number }[] }).marker?.[0]?.count ?? 0,
  }));

  // ?new=1 always shows the start form, whatever else is going on.
  // Otherwise: the explicitly requested meeting, then the most recent one that
  // has not been ended, then the most recent of all.
  const meeting = startNew
    ? null
    : ((requestedId
        ? recentMeetings.find((m) => m.id === requestedId)
        : undefined) ??
      recentMeetings.find((m) => m.status !== "complete") ??
      recentMeetings[0] ??
      null);

  const [{ data: people }, { data: markers }] = await Promise.all([
    supabase
      .from("person")
      .select("id, name, is_congregation, name_spellings")
      .is("removed_at", null)
      .order("name"),
    meeting
      ? supabase.from("marker").select("*").eq("meeting_id", meeting.id).order("at_sec")
      : Promise.resolve({ data: [] as Marker[] }),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Operator console</h1>
        <p className="mt-1 text-sm text-muted">
          Tap a name as the giver says who the word is for. Each tap is saved
          straight away, and kept on this device if the network drops.
        </p>
      </div>

      <ConsoleClient
        key={meeting?.id ?? "new"}
        meeting={
          meeting
            ? {
                id: meeting.id,
                date: meeting.date,
                format: meeting.format,
                recording_started_at: meeting.recording_started_at,
                status: meeting.status,
              }
            : null
        }
        // The whole church pins first, then everyone alphabetically.
        people={sortRecipients(people ?? [])}
        initialMarkers={(markers ?? []) as Marker[]}
        today={today}
      />

      {recentMeetings.length > 0 ? (
        <section className="rounded-xl border border-line bg-white">
          <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Recent meetings</h2>
            <p className="text-xs text-muted">
              Open an older one to fix its markers or export them.
            </p>
            <Link
              href="/console?new=1"
              className="ml-auto rounded-lg border border-line px-3 py-1.5 text-xs font-medium transition hover:bg-stone-50"
            >
              Start a new meeting
            </Link>
          </div>

          <ul className="divide-y divide-line">
            {recentMeetings.map((m) => {
              const current = meeting?.id === m.id;

              return (
                <li
                  key={m.id}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm ${
                    current ? "bg-brand-soft" : ""
                  }`}
                >
                  <span className="font-medium">{formatDate(m.date)}</span>
                  <span className="text-muted">{m.format}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      m.status === "complete"
                        ? "bg-stone-100 text-muted"
                        : "bg-emerald-100 text-emerald-900"
                    }`}
                  >
                    {STATUS_LABEL[m.status] ?? m.status}
                  </span>
                  <span className="text-xs text-muted">
                    {formatStartedAt(m.recording_started_at)} ·{" "}
                    {m.markerCount} marker{m.markerCount === 1 ? "" : "s"}
                  </span>

                  {current ? (
                    <span className="ml-auto text-xs font-medium text-brand">open</span>
                  ) : (
                    <Link
                      href={`/console?meeting=${m.id}`}
                      className="ml-auto rounded border border-line px-2.5 py-1 text-xs transition hover:bg-stone-50"
                    >
                      Open
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
