import { requirePerson } from "@/lib/auth";
import { signAudioPaths } from "@/lib/audio";
import { fetchWords } from "@/lib/words";
import { WordCard } from "@/components/word-card";

export const metadata = { title: "Feed — GracePlace" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  q?: string;
  from?: string;
  to?: string;
  denied?: string;
}>;

export default async function FeedPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { q, from, to, denied } = await searchParams;
  await requirePerson();

  // Approved words only, for every role - a pastor browsing the feed sees
  // what the congregation sees. Pending words live in the review queue.
  const words = await fetchWords({ name: q, from, to, status: "reviewed" });
  const signed = await signAudioPaths(words.map((w) => w.audio_clip_path));

  const filtered = Boolean(q || from || to);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Feed</h1>
        <p className="mt-1 text-sm text-muted">
          Every approved word, newest meeting first.
        </p>
      </div>

      {denied ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          That page is for editors and pastors only.
        </p>
      ) : null}

      <form className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-white p-4">
        <div className="min-w-48 flex-1">
          <label htmlFor="q" className="mb-1 block text-xs font-medium text-muted">
            Name
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Recipient or giver"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        <div>
          <label htmlFor="from" className="mb-1 block text-xs font-medium text-muted">
            From
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={from ?? ""}
            className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs font-medium text-muted">
            To
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={to ?? ""}
            className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        <button
          type="submit"
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          Search
        </button>
        {filtered ? (
          <a
            href="/feed"
            className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-ink"
          >
            Clear
          </a>
        ) : null}
      </form>

      {words.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-white px-5 py-10 text-center text-sm text-muted">
          {filtered
            ? "No words match that search."
            : "No approved words yet. Once a pastor approves a word it appears here."}
        </p>
      ) : (
        <div className="space-y-4">
          {words.map((word) => (
            <WordCard
              key={word.id}
              word={word}
              audioUrl={
                word.audio_clip_path ? (signed[word.audio_clip_path] ?? null) : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
