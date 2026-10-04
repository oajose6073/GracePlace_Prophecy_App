import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePerson } from "@/lib/auth";
import { signAudioPaths } from "@/lib/audio";
import { createClient } from "@/lib/supabase/server";
import { fetchWords } from "@/lib/words";
import { WordCard } from "@/components/word-card";

export const metadata = { title: "Member profile — GracePlace" };
export const dynamic = "force-dynamic";

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ personId: string }>;
  searchParams: Promise<{ order?: string }>;
}) {
  const { personId } = await params;
  const { order } = await searchParams;
  const viewer = await requirePerson();

  const supabase = await createClient();
  const { data: person } = await supabase
    .from("person")
    .select("id, name, email, role, removed_at")
    .eq("id", personId)
    .maybeSingle();

  if (!person) notFound();

  const oldestFirst = order === "oldest";
  // Approved words only, for every role. See the note on the feed page.
  const words = await fetchWords({
    recipientId: person.id,
    oldestFirst,
    status: "reviewed",
  });
  const signed = await signAudioPaths(words.map((w) => w.audio_clip_path));

  const isSelf = viewer.id === person.id;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {isSelf ? `${person.name} — your words` : person.name}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {words.length === 1 ? "1 word" : `${words.length} words`}
            {oldestFirst ? ", oldest first" : ", newest first"}
          </p>
        </div>

        <Link
          href={`/profile/${person.id}?order=${oldestFirst ? "newest" : "oldest"}`}
          className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-muted transition hover:text-ink"
        >
          {oldestFirst ? "Show newest first" : "Show oldest first"}
        </Link>
      </div>

      {person.removed_at ? (
        <p className="rounded-lg border border-line bg-stone-50 px-4 py-2.5 text-sm text-muted">
          {person.name} is no longer on the member list and cannot sign in.
          Their words are kept here — removing someone never deletes a word.
        </p>
      ) : null}

      {words.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-white px-5 py-10 text-center text-sm text-muted">
          No approved words for {isSelf ? "you" : person.name} yet.
        </p>
      ) : (
        <div className="space-y-4">
          {words.map((word) => (
            <WordCard
              key={word.id}
              word={word}
              showRecipientLink={false}
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
