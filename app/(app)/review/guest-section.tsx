import { ConfirmButton } from "@/components/confirm-button";
import type { GuestWord } from "@/lib/types";

import { deleteGuestWord, sendGuestWord, updateGuestWord } from "./guest-actions";

type GuestRow = GuestWord & { meeting: { date: string } | null };

function formatDate(date: string | undefined): string {
  if (!date) return "Date unknown";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function daysLeft(expiresAt: string): number {
  return Math.ceil((Date.parse(expiresAt) - Date.now()) / (24 * 60 * 60 * 1000));
}

export function GuestSection({
  guests,
  signedUrls,
  editor,
}: {
  guests: GuestRow[];
  signedUrls: Record<string, string>;
  editor: boolean;
}) {
  if (guests.length === 0) return null;

  const awaiting = guests.filter((g) => !g.guest_email).length;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
          Guest words ({guests.length})
          {awaiting > 0 ? (
            <span className="rounded bg-amber-200 px-2 py-0.5 text-xs font-medium text-amber-900">
              {awaiting} waiting for an email
            </span>
          ) : null}
        </h2>
        <p className="mt-1 text-sm text-muted">
          Emailed once to the guest, then deleted — the clip, the transcript and
          the address. Members never see these, and anything not sent within
          seven days is deleted anyway.
        </p>
      </div>

      {guests.map((guest) => {
        const url = guest.audio_clip_path
          ? (signedUrls[guest.audio_clip_path] ?? null)
          : null;
        const left = daysLeft(guest.expires_at);
        const ready =
          Boolean(guest.guest_email?.includes("@")) && guest.transcript.trim() !== "";

        return (
          <article
            key={guest.id}
            className="space-y-4 rounded-xl border border-amber-300 bg-amber-50/40 p-5"
          >
            <header className="flex flex-wrap items-baseline gap-2">
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                Guest
              </span>
              <span className="text-sm text-muted">
                {formatDate(guest.meeting?.date)}
              </span>
              {guest.guest_label ? (
                <span className="rounded bg-white px-2 py-0.5 text-xs text-ink ring-1 ring-amber-200">
                  {guest.guest_label}
                </span>
              ) : null}
              {!guest.guest_email ? (
                <span className="rounded bg-amber-200 px-2 py-0.5 text-xs text-amber-900">
                  no email yet
                </span>
              ) : null}
              <span
                className={`text-xs ${left <= 2 ? "font-medium text-red-700" : "text-muted"}`}
              >
                {left <= 0
                  ? "past its expiry — will be deleted"
                  : `${left} day${left === 1 ? "" : "s"} before it is deleted`}
              </span>
              {guest.send_status === "failed" ? (
                <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">
                  send failed
                </span>
              ) : null}
            </header>

            {guest.send_error ? (
              <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
                {guest.send_error}
              </p>
            ) : null}

            {url ? (
              <audio controls preload="none" src={url} />
            ) : guest.audio_clip_path ? (
              <p className="text-sm text-muted">
                Audio could not be loaded. Refresh for a new link.
              </p>
            ) : (
              <p className="text-sm text-muted">No audio attached.</p>
            )}

            <form action={updateGuestWord.bind(null, guest.id)} className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">
                  Guest email
                </span>
                <input
                  name="guest_email"
                  type="email"
                  defaultValue={guest.guest_email ?? ""}
                  placeholder="guest@example.com"
                  className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">
                  Transcript
                </span>
                <textarea
                  name="transcript"
                  rows={5}
                  defaultValue={guest.transcript}
                  placeholder="The guest's word, as transcribed"
                  className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand"
                />
              </label>

              <button
                type="submit"
                className="rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium transition hover:bg-stone-50"
              >
                Save
              </button>
            </form>

            <div className="flex flex-wrap items-center gap-2 border-t border-amber-200 pt-4">
              <form action={sendGuestWord.bind(null, guest.id)}>
                <ConfirmButton
                  message={`Send this word to ${guest.guest_email ?? "the guest"} and delete it? The clip, transcript and email address are deleted on success and cannot be recovered. Save any edits first.`}
                  className="rounded-lg bg-amber-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  Approve and send
                </ConfirmButton>
              </form>

              {!ready ? (
                <p className="text-xs text-amber-900">
                  {guest.guest_email?.includes("@")
                    ? "Add the transcript before sending."
                    : "Add the guest's email before sending."}{" "}
                  Save your edits first — sending uses what is stored, not what is
                  typed above.
                </p>
              ) : (
                <p className="text-xs text-muted">
                  Sending emails the transcript with the clip attached, then deletes
                  all three.
                </p>
              )}

              {editor ? (
                <form action={deleteGuestWord.bind(null, guest.id)} className="ml-auto">
                  <ConfirmButton
                    message={`Discard this guest word without sending it? Its audio and transcript will be deleted and can't be recovered.`}
                    className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 transition hover:bg-red-50 disabled:opacity-40"
                  >
                    Discard
                  </ConfirmButton>
                </form>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}
