"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/types";

/**
 * Browser client. Only ever sees the publishable (anon) key - the secret key
 * must never reach this file or anything it imports.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
