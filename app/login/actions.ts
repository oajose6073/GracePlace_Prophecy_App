"use server";

import { headers } from "next/headers";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type MagicLinkState = {
  status: "idle" | "sent" | "not-invited" | "error";
  message: string;
};

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return process.env.NEXT_PUBLIC_SITE_URL ?? `${proto}://${host}`;
}

/**
 * Sends the one-time sign-in link.
 *
 * The allowlist is checked here first, so someone who is not on the member
 * list gets a plain explanation straight away rather than a link that fails
 * at the callback. The database trigger is still the real gate - this only
 * makes the common case friendlier.
 */
export async function sendMagicLink(
  _prev: MagicLinkState,
  formData: FormData,
): Promise<MagicLinkState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();

  if (!email || !email.includes("@")) {
    return { status: "error", message: "Enter the email address you were invited with." };
  }

  // Service-role read: an anonymous visitor has no RLS access to `person`,
  // and this runs only on the server.
  const admin = createAdminClient();
  const { data: invited, error: lookupError } = await admin
    .from("person")
    .select("id, removed_at")
    .ilike("email", email)
    .maybeSingle();

  if (lookupError) {
    return {
      status: "error",
      message: "Something went wrong checking the member list. Try again in a moment.",
    };
  }

  if (invited?.removed_at) {
    return {
      status: "not-invited",
      message:
        "That account was removed from the member list. Ask a pastor to restore it.",
    };
  }

  if (!invited) {
    return {
      status: "not-invited",
      message:
        "You're not on the member list — ask a pastor to add you, then try again.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${await origin()}/auth/callback` },
  });

  if (error) {
    return { status: "error", message: error.message };
  }

  return {
    status: "sent",
    message: `Check ${email} for a sign-in link. It works once and expires shortly.`,
  };
}
