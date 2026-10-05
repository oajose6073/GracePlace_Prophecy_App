import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../lib/types";
import type { PersonRow } from "./types";

export type NameIndex = {
  people: PersonRow[];
  /** Lowercased name or spelling -> the people it could mean. */
  byName: Map<string, PersonRow[]>;
};

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function loadPeople(
  db: SupabaseClient<Database>,
): Promise<NameIndex> {
  const { data, error } = await db
    .from("person")
    .select("id, name, name_spellings, removed_at")
    .order("name");

  if (error) throw new Error(`Could not load the member list: ${error.message}`);

  const people = (data ?? []) as PersonRow[];
  const byName = new Map<string, PersonRow[]>();

  // Removed members are indexed too: a recording from before someone left
  // still needs their name to resolve.
  for (const person of people) {
    for (const label of [person.name, ...person.name_spellings]) {
      if (!label?.trim()) continue;
      const key = normalise(label);
      const bucket = byName.get(key);
      if (bucket) {
        if (!bucket.some((p) => p.id === person.id)) bucket.push(person);
      } else {
        byName.set(key, [person]);
      }
    }
  }

  return { people, byName };
}

export type MatchResult =
  | { kind: "matched"; person: PersonRow }
  | { kind: "unmatched" }
  | { kind: "ambiguous"; candidates: PersonRow[] };

export function matchName(index: NameIndex, name: string): MatchResult {
  const candidates = index.byName.get(normalise(name));

  if (!candidates || candidates.length === 0) return { kind: "unmatched" };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "matched", person: candidates[0] };
}

/**
 * Every name and spelling variant on the member list, passed to the
 * transcription model as `keywords` so it spells them right.
 *
 * The API requires each keyword to be a single line and to contain no angle
 * brackets, so anything odd is dropped rather than sent and rejected.
 */
export function transcriptionKeywords(index: NameIndex): string[] {
  const seen = new Set<string>();

  for (const person of index.people) {
    for (const label of [person.name, ...person.name_spellings]) {
      const cleaned = label?.replace(/[<>\r\n]/g, " ").trim().replace(/\s+/g, " ");
      if (cleaned) seen.add(cleaned);
    }
  }

  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** "Ada Okonkwo (Ada, Adaeze)" — for the unmatched-name error message. */
export function describePerson(person: PersonRow): string {
  const extras = person.name_spellings.filter((s) => s?.trim());
  const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  const removed = person.removed_at ? " [removed]" : "";
  return `${person.name}${suffix}${removed}`;
}
