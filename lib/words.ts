import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { WordStatus, WordWithRelations } from "@/lib/types";

/**
 * Every column a card needs, in one round trip. The foreign-key hints are
 * required because `word` points at `person` twice.
 */
export const WORD_SELECT = `
  *,
  meeting:meeting!word_meeting_id_fkey ( id, date, format ),
  recipient:person!word_recipient_id_fkey ( id, name ),
  giver:person!word_giver_id_fkey ( id, name ),
  segment ( * )
` as const;

export type WordQuery = {
  /** Matches recipient or giver by name, including known spelling variants. */
  name?: string;
  /** Inclusive YYYY-MM-DD bounds on the meeting date. */
  from?: string;
  to?: string;
  /** Only this person's words — used by the profile page. */
  recipientId?: string;
  oldestFirst?: boolean;
  /**
   * Defaults to 'reviewed'. Only the review queue asks for anything else.
   *
   * This defaults closed on purpose. RLS already hides pending words from
   * members, but an editor or admin may select them, so a page that passed no
   * status at all showed pending words to whoever was allowed to see them -
   * which is exactly how one leaked onto the feed.
   */
  status?: WordStatus | "all";
};

/**
 * Words are read through the member's own session, so row-level security
 * decides what comes back: a member gets approved words only, without the app
 * having to ask for that.
 *
 * Sorting happens here rather than in PostgREST because the sort key lives on
 * the embedded meeting row. At this volume (roughly 500 words a year) the
 * whole set is a small fetch.
 */
export async function fetchWords(
  query: WordQuery = {},
): Promise<WordWithRelations[]> {
  const supabase = await createClient();

  let builder = supabase.from("word").select(WORD_SELECT).limit(500);

  const status = query.status ?? "reviewed";
  if (status !== "all") builder = builder.eq("status", status);
  if (query.recipientId) builder = builder.eq("recipient_id", query.recipientId);

  if (query.name?.trim()) {
    // Commas, parentheses and quotes are PostgREST filter syntax, so they are
    // stripped rather than passed into the `or` expression below.
    const term = query.name.trim().replace(/[(),."'\\*]/g, " ").trim();
    if (!term) return [];

    // Resolve names (and spelling variants) to ids first: PostgREST cannot
    // OR across two different embedded relationships in one filter.
    const { data: people } = await supabase
      .from("person")
      .select("id")
      .or(`name.ilike.%${term}%,name_spellings.cs.{${term}}`);

    const ids = (people ?? []).map((p) => p.id);
    if (ids.length === 0) return [];
    builder = builder.or(
      `recipient_id.in.(${ids.join(",")}),giver_id.in.(${ids.join(",")})`,
    );
  }

  const { data, error } = await builder;
  if (error) throw new Error(error.message);

  let words = (data ?? []) as unknown as WordWithRelations[];

  if (query.from) {
    words = words.filter((w) => (w.meeting?.date ?? "") >= query.from!);
  }
  if (query.to) {
    words = words.filter((w) => (w.meeting?.date ?? "") <= query.to!);
  }

  words.sort((a, b) => {
    const da = a.meeting?.date ?? "";
    const db = b.meeting?.date ?? "";
    if (da !== db) return query.oldestFirst ? da.localeCompare(db) : db.localeCompare(da);
    const ca = a.created_at;
    const cb = b.created_at;
    return query.oldestFirst ? ca.localeCompare(cb) : cb.localeCompare(ca);
  });

  return words;
}
