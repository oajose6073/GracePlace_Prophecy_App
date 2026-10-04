import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/types";

/**
 * Service-role client. Bypasses row-level security entirely.
 *
 * `import "server-only"` above makes the build fail if a client component ever
 * pulls this in, and the key is read from SUPABASE_SECRET_KEY, which has no
 * NEXT_PUBLIC_ prefix and so is never inlined into the browser bundle.
 *
 * Only two things legitimately need it:
 *   - the auth callback, to tell "not invited" apart from a real auth failure
 *   - the seed and cleanup scripts, which create and remove auth users
 *
 * Everything else uses the session-scoped client in ./server.ts so that RLS
 * does the enforcing.
 */
export function createAdminClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY is not set. It belongs in .env.local, server-side only.",
    );
  }

  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    secretKey,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
