import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/types";

/**
 * Why a write touched no rows.
 *
 * With row-level security, "no rows affected" is ambiguous: the row may never
 * have existed, or it may exist and the policy refused. Telling those apart
 * matters — one means reload the page, the other means ask an editor — and
 * guessing wrong sends the reviewer down the wrong path.
 *
 * Checking after the failed write rather than before also closes the gap
 * where someone else deletes the row in between.
 */
export type ZeroRowReason = "missing" | "forbidden";

export async function zeroRowReason(
  supabase: SupabaseClient<Database>,
  table: "word" | "segment" | "person" | "meeting" | "marker" | "guest_word",
  id: string,
): Promise<ZeroRowReason> {
  const { data } = await supabase.from(table).select("id").eq("id", id).maybeSingle();

  // Editors and admins can select every row in these tables, so a row that
  // comes back here is genuinely present and the write was refused.
  return data ? "forbidden" : "missing";
}
