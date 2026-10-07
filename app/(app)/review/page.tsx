import { requireWriter } from "@/lib/auth";
import { todayInChurchTimeZone } from "@/lib/church";
import { signAudioPaths } from "@/lib/audio";
import { createClient } from "@/lib/supabase/server";
import { fetchWords } from "@/lib/words";
import { canDelete } from "@/lib/types";

import { ConfirmButton } from "@/components/confirm-button";
import type { GuestWord } from "@/lib/types";

import { AddWordForm } from "./add-word-form";
import { GuestSection } from "./guest-section";
import {
  addSegment,
  approveWord,
  createMeeting,
  createWord,
  deleteWord,
  removeSegment,
  unapproveWord,
  updateWord,
} from "./actions";

export const metadata = { title: "Review queue — GracePlace" };
export const dynamic = "force-dynamic";

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

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { ok, error } = await searchParams;
  const person = await requireWriter();
  const supabase = await createClient();

  const [{ data: meetings }, { data: people }, pending, { data: guestRows }] =
    await Promise.all([
      supabase.from("meeting").select("id, date, format").order("date", { ascending: false }),
        supabase
        .from("person")
        .select("id, name, removed_at, is_congregation")
        .order("name"),
      fetchWords({ status: "pending" }),
      // RLS keeps these to editors and admins; members get nothing.
      supabase
        .from("guest_word")
        .select("*, meeting:meeting!guest_word_meeting_id_fkey ( date )")
        .order("expires_at"),
    ]);

  const guests = (guestRows ?? []) as unknown as (GuestWord & {
    meeting: { date: string } | null;
  })[];

  const signed = await signAudioPaths([
    ...pending.map((w) => w.audio_clip_path),
    ...guests.map((g) => g.audio_clip_path),
  ]);
  const editor = canDelete(person.role);

  // A removed member can no longer receive a new word, but one already
  // assigned to them must stay selectable - dropping them from the options
  // would silently blank the recipient on the next save.
  const allPeople = (people ?? []).map((p) => ({
    id: p.id,
    label: p.removed_at ? `${p.name} (removed)` : p.name,
  }));
  const activePeople = (people ?? [])
    .filter((p) => !p.removed_at)
    .map((p) => ({ id: p.id, name: p.name }));

  // The whole church can receive a word but never gives one.
  const givers = (people ?? [])
    .filter((p) => !p.removed_at && !p.is_congregation)
    .map((p) => ({ id: p.id, name: p.name }));
  const giverOptions = (people ?? [])
    .filter((p) => !p.is_congregation)
    .map((p) => ({ id: p.id, label: p.removed_at ? `${p.name} (removed)` : p.name }));
  const today = todayInChurchTimeZone();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Review queue</h1>
        <p className="mt-1 text-sm text-muted">
          Nothing reaches the feed until it is approved here.
        </p>
      </div>

      {ok ? (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {/* Meetings must exist before a word can hang off one. */}
      <form
        action={createMeeting}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-white p-4"
      >
        <div>
          <label htmlFor="date" className="mb-1 block text-xs font-medium text-muted">
            New meeting date
          </label>
          <input
            id="date"
            name="date"
            type="date"
            required
            defaultValue={today}
            className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        <div>
          <label htmlFor="format" className="mb-1 block text-xs font-medium text-muted">
            Format
          </label>
          <select
            id="format"
            name="format"
            defaultValue="hybrid"
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
          >
            <option value="hybrid">Hybrid</option>
            <option value="in-person">In person</option>
            <option value="zoom">Zoom</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium transition hover:bg-stone-50"
        >
          Add meeting
        </button>
        <p className="text-xs text-muted">
          {(meetings ?? []).length} meeting
          {(meetings ?? []).length === 1 ? "" : "s"} on file
        </p>
      </form>

      <AddWordForm
        meetings={meetings ?? []}
        people={activePeople}
        givers={givers}
        createWord={createWord}
      />

      <section className="space-y-4">
        <h2 className="text-base font-semibold">
          Pending ({pending.length})
        </h2>

        {pending.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line bg-white px-5 py-10 text-center text-sm text-muted">
            Nothing waiting. Words you add above show up here.
          </p>
        ) : null}

        {pending.map((word) => {
          const audioUrl = word.audio_clip_path
            ? (signed[word.audio_clip_path] ?? null)
            : null;
          const segments = [...(word.segment ?? [])].sort(
            (a, b) => a.position - b.position,
          );

          // Everything that has to be true before this word can be published.
          // The same rules are enforced by word_reviewed_is_complete and
          // word_approval_guard in the database; these are the sentences.
          const blankSegments = segments.filter(
            (s) => s.transcript.trim() === "",
          ).length;
          const audioSegmentCount = segments.filter(
            (s) => s.audio_clip_path,
          ).length;

          const blockers: string[] = [];
          if (!word.recipient_id) blockers.push("assign a recipient");
          if (!word.audio_clip_path) blockers.push("attach the audio clip");
          if (segments.length === 0) {
            blockers.push("add a segment with its transcript");
          } else if (blankSegments > 0) {
            blockers.push(
              blankSegments === segments.length
                ? segments.length === 1
                  ? "fill in the transcript"
                  : "fill in every transcript"
                : `fill in ${blankSegments} empty transcript${blankSegments === 1 ? "" : "s"}`,
            );
          }

          // Saving edits is what clears the blockers, so the hint points there.
          const blockedReason =
            blockers.length === 0
              ? null
              : `To approve, ${blockers.join(", then ")} — and Save changes.`;

          return (
            <article
              key={word.id}
              className="space-y-4 rounded-xl border border-line bg-white p-5"
            >
              <header className="flex flex-wrap items-baseline gap-2">
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                  Pending
                </span>
                <span className="text-sm text-muted">
                  {formatDate(word.meeting?.date)}
                </span>
                {!word.recipient ? (
                  <span className="text-sm font-medium text-amber-800">
                    Recipient to be confirmed
                  </span>
                ) : null}
              </header>

              {audioUrl ? (
                <div>
                  <audio controls preload="none" src={audioUrl} />
                  {audioSegmentCount > 1 ? (
                    <p className="mt-1 text-xs text-muted">
                      One clip joined from {audioSegmentCount} segments, in order,
                      with a short gap between each.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted">
                  No audio attached — add it before approving.
                </p>
              )}

              {/* Transcript beside its audio, with the start and end the
                  reviewer can drag back when the operator tapped late. */}
              <form action={updateWord} className="space-y-4">
                <input type="hidden" name="word_id" value={word.id} />

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-muted">
                      Recipient
                    </span>
                    <select
                      name="recipient_id"
                      defaultValue={word.recipient_id ?? ""}
                      className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
                    >
                      <option value="">To be confirmed</option>
                      {allPeople.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-muted">
                      Giver
                    </span>
                    <select
                      name="giver_id"
                      defaultValue={word.giver_id ?? ""}
                      className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
                    >
                      <option value="">Not recorded</option>
                      {giverOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {segments.map((segment, index) => (
                  <div
                    key={segment.id}
                    className="rounded-lg border border-line bg-parchment p-3"
                  >
                    <div className="mb-2 flex flex-wrap items-end gap-3">
                      <span className="text-xs font-medium text-muted">
                        Segment {index + 1}
                      </span>
                      {segment.audio_clip_path ? (
                        <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900">
                          has audio
                        </span>
                      ) : (
                        <span className="rounded bg-stone-100 px-2 py-0.5 text-xs text-muted">
                          transcript only
                        </span>
                      )}
                      <label className="text-xs text-muted">
                        Start (s)
                        <input
                          name={`start__${segment.id}`}
                          type="number"
                          step="0.1"
                          min="0"
                          defaultValue={segment.start_sec ?? 0}
                          className="ml-2 w-24 rounded border border-line px-2 py-1 text-sm text-ink outline-none focus:border-brand"
                        />
                      </label>
                      <label className="text-xs text-muted">
                        End (s)
                        <input
                          name={`end__${segment.id}`}
                          type="number"
                          step="0.1"
                          min="0"
                          defaultValue={segment.end_sec ?? ""}
                          className="ml-2 w-24 rounded border border-line px-2 py-1 text-sm text-ink outline-none focus:border-brand"
                        />
                      </label>
                    </div>
                    <textarea
                      name={`transcript__${segment.id}`}
                      rows={4}
                      defaultValue={segment.transcript}
                      aria-invalid={segment.transcript.trim() === ""}
                      placeholder="Transcript required before this word can be approved"
                      className={`w-full rounded border px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand ${
                        segment.transcript.trim() === ""
                          ? "border-amber-400 bg-amber-50"
                          : "border-line"
                      }`}
                    />
                    {editor ? (
                      // The segment id is bound into the action rather than
                      // sent as a form field. React overwrites the `name` and
                      // `value` of any button whose formAction is a function —
                      // it needs them to encode which action to run — so a
                      // `name="segment_id"` here never reached the server.
                      <ConfirmButton
                        formAction={removeSegment.bind(null, segment.id)}
                        formNoValidate
                        message={`Remove segment ${index + 1}? Its audio and transcript will be deleted and can't be recovered.`}
                        className="mt-2 rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 transition hover:bg-red-50 disabled:opacity-40"
                      >
                        Remove segment
                      </ConfirmButton>
                    ) : null}
                  </div>
                ))}

                <button
                  type="submit"
                  className="rounded-lg border border-line px-4 py-2 text-sm font-medium transition hover:bg-stone-50"
                >
                  Save changes
                </button>
              </form>

              {blockedReason ? (
                <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {blockedReason}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                <form action={addSegment}>
                  <input type="hidden" name="word_id" value={word.id} />
                  <button
                    type="submit"
                    className="rounded-lg border border-line px-3 py-2 text-sm transition hover:bg-stone-50"
                  >
                    Add segment
                  </button>
                </form>

                <form action={approveWord}>
                  <input type="hidden" name="word_id" value={word.id} />
                  <button
                    type="submit"
                    disabled={blockers.length > 0}
                    title={blockedReason ?? undefined}
                    className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Approve
                  </button>
                </form>

                {editor ? (
                  <form action={deleteWord} className="ml-auto">
                    <input type="hidden" name="word_id" value={word.id} />
                    <ConfirmButton
                      message={`Delete the word for ${word.recipient?.name ?? "an unconfirmed recipient"}? Its audio and transcript will be deleted and can't be recovered.`}
                      className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 transition hover:bg-red-50 disabled:opacity-40"
                    >
                      Delete
                    </ConfirmButton>
                  </form>
                ) : (
                  <p className="ml-auto self-center text-xs text-muted">
                    Deleting is an editor-only action.
                  </p>
                )}
              </div>
            </article>
          );
        })}
      </section>

      <GuestSection guests={guests} signedUrls={signed} editor={editor} />

      <ApprovedSection unapproveWord={unapproveWord} editor={editor} deleteWord={deleteWord} />
    </div>
  );
}

/** A short tail of approved words, so a mistake can be pulled back. */
async function ApprovedSection({
  unapproveWord,
  deleteWord,
  editor,
}: {
  unapproveWord: (formData: FormData) => Promise<void>;
  deleteWord: (formData: FormData) => Promise<void>;
  editor: boolean;
}) {
  const approved = (await fetchWords({ status: "reviewed" })).slice(0, 10);
  if (approved.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Recently approved</h2>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
        {approved.map((word) => (
          <li
            key={word.id}
            className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
          >
            <span className="font-medium">
              {word.recipient?.name ?? "Unassigned"}
            </span>
            <span className="text-muted">{formatDate(word.meeting?.date)}</span>
            <form action={unapproveWord} className="ml-auto">
              <input type="hidden" name="word_id" value={word.id} />
              <button
                type="submit"
                className="rounded border border-line px-2.5 py-1 text-xs text-muted transition hover:text-ink"
              >
                Unapprove
              </button>
            </form>
            {editor ? (
              <form action={deleteWord}>
                <input type="hidden" name="word_id" value={word.id} />
                <ConfirmButton
                  message={`Delete the approved word for ${word.recipient?.name ?? "an unconfirmed recipient"}? It will disappear from the feed and their profile. Its audio and transcript will be deleted and can't be recovered.`}
                  className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 transition hover:bg-red-50 disabled:opacity-40"
                >
                  Delete
                </ConfirmButton>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
