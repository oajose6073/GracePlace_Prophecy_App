import Link from "next/link";

import type { WordWithRelations } from "@/lib/types";

function formatMeetingDate(date: string | undefined): string {
  if (!date) return "Date unknown";
  // `date` is a plain YYYY-MM-DD; parsing it as UTC avoids the off-by-one-day
  // that local-time parsing causes west of Greenwich.
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function WordCard({
  word,
  audioUrl,
  showRecipientLink = true,
}: {
  word: WordWithRelations;
  audioUrl: string | null;
  showRecipientLink?: boolean;
}) {
  const segments = [...(word.segment ?? [])].sort(
    (a, b) => a.position - b.position || a.start_sec - b.start_sec,
  );

  return (
    <article className="rounded-xl border border-line bg-white p-5 shadow-sm">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-base font-semibold">
          {word.recipient ? (
            showRecipientLink ? (
              <Link
                href={`/profile/${word.recipient.id}`}
                className="hover:underline"
              >
                {word.recipient.name}
              </Link>
            ) : (
              word.recipient.name
            )
          ) : (
            <span className="text-muted">To be confirmed</span>
          )}
        </h3>
        <span className="text-sm text-muted">
          from {word.giver?.name ?? "an unnamed giver"}
        </span>
        <span className="ml-auto text-sm text-muted">
          {formatMeetingDate(word.meeting?.date)}
        </span>
      </header>

      {audioUrl ? (
        <audio controls preload="none" src={audioUrl} className="mb-3" />
      ) : word.audio_clip_path ? (
        <p className="mb-3 text-sm text-muted">
          Audio could not be loaded. Refresh the page to get a new link.
        </p>
      ) : (
        <p className="mb-3 text-sm text-muted">No audio attached.</p>
      )}

      {segments.length > 0 ? (
        <div className="space-y-3">
          {segments.map((s) => (
            <p
              key={s.id}
              className="whitespace-pre-wrap text-sm leading-relaxed text-ink"
            >
              {s.transcript || (
                <span className="text-muted">Transcript not added yet.</span>
              )}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">Transcript not added yet.</p>
      )}
    </article>
  );
}
