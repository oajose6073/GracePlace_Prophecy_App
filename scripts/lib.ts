import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../lib/types";

config({ path: ".env.local" });

export const AUDIO_BUCKET = "word-audio";
export const SEED_DOMAIN = "example.com";

export function admin(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local.",
    );
    process.exit(1);
  }

  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Walks every page of auth users, since listUsers is paginated. */
export async function listAllAuthUsers(client: SupabaseClient<Database>) {
  const users: { id: string; email?: string }[] = [];
  const perPage = 200;

  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    users.push(...data.users.map((u) => ({ id: u.id, email: u.email ?? undefined })));
    if (data.users.length < perPage) break;
  }

  return users;
}

export function isSeedEmail(email: string | undefined | null): boolean {
  return Boolean(email && email.toLowerCase().endsWith(`@${SEED_DOMAIN}`));
}
