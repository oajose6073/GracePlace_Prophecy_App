"use client";

import { useRef, useState } from "react";

import {
  AUDIO_ACCEPT_ATTRIBUTE,
  MAX_AUDIO_BYTES,
  describeAllowedFormats,
  resolveAudioType,
} from "@/lib/audio-formats";
import { createClient } from "@/lib/supabase/client";
import type { Meeting, Person } from "@/lib/types";

import { AUDIO_BUCKET } from "@/lib/storage";

function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function AddWordForm({
  meetings,
  people,
  givers,
  createWord,
}: {
  meetings: Pick<Meeting, "id" | "date" | "format">[];
  /** Possible recipients, including the whole church. */
  people: Pick<Person, "id" | "name">[];
  /** Possible givers. The whole church never gives a word. */
  givers: Pick<Person, "id" | "name">[];
  createWord: (formData: FormData) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    const meetingId = String(data.get("meeting_id") ?? "");
    const file = data.get("audio") as File | null;

    if (!meetingId) {
      setError("Choose which meeting this word belongs to.");
      return;
    }

    setBusy(true);
    try {
      // The file goes straight from the browser to the private bucket, so it
      // never passes through a server action's request body size limit.
      // Storage RLS allows this only for editors and admins.
      if (file && file.size > 0) {
        // Checked here as well as on the bucket, so the reviewer finds out
        // before waiting through the upload.
        if (file.size > MAX_AUDIO_BYTES) {
          setError(
            `That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. The limit is 100 MB — trim the clip first.`,
          );
          setBusy(false);
          return;
        }

        const contentType = resolveAudioType(file);
        if (!contentType) {
          setError(
            `${file.name} is not a format the player can use. Upload ${describeAllowedFormats()}.`,
          );
          setBusy(false);
          return;
        }

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${meetingId}/${crypto.randomUUID()}-${safeName}`;

        const supabase = createClient();
        const { error: uploadError } = await supabase.storage
          .from(AUDIO_BUCKET)
          .upload(path, file, {
            contentType,
            upsert: false,
          });

        if (uploadError) {
          setError(`Upload failed: ${uploadError.message}`);
          setBusy(false);
          return;
        }

        data.set("audio_clip_path", path);
      }

      data.delete("audio");
      await createWord(data);
      form.reset();
    } catch (err) {
      // A redirect from the server action surfaces here as a thrown value that
      // Next re-throws; anything else is a genuine failure.
      if (err && typeof err === "object" && "digest" in err) throw err;
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-line bg-white p-5"
    >
      <h2 className="text-base font-semibold">Add a word</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Meeting</span>
          <select
            name="meeting_id"
            required
            defaultValue=""
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
          >
            <option value="" disabled>
              Choose a meeting…
            </option>
            {meetings.map((m) => (
              <option key={m.id} value={m.id}>
                {formatDate(m.date)} · {m.format}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            Audio clip
          </span>
          <input
            type="file"
            name="audio"
            accept={AUDIO_ACCEPT_ATTRIBUTE}
            className="w-full rounded-lg border border-line bg-white px-3 py-1.5 text-sm file:mr-3 file:rounded file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-xs file:text-brand"
          />
          <span className="mt-1 block text-xs text-muted">
            {describeAllowedFormats()}, up to 100 MB. WhatsApp voice notes work.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            Recipient
          </span>
          <select
            name="recipient_id"
            defaultValue=""
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
          >
            <option value="">To be confirmed</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Giver</span>
          <select
            name="giver_id"
            defaultValue=""
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
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

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Transcript</span>
        <textarea
          name="transcript"
          rows={4}
          placeholder="Type or paste the transcript…"
          className="w-full rounded-lg border border-line px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand"
        />
      </label>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Add to queue"}
      </button>
    </form>
  );
}
