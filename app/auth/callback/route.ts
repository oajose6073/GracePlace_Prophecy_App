import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * Lands both the Google redirect and the one-time email link.
 *
 * The invite-only trigger aborts the sign-up transaction for anyone who is not
 * on the member list, which Supabase surfaces as a generic
 * "Database error saving new user". Rather than show that, anything that looks
 * like a rejected sign-up is sent to /not-invited.
 */
function looksLikeNotInvited(text: string | null): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("not_invited") ||
    t.includes("database error saving new user") ||
    t.includes("not on the member list")
  );
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = searchParams.get("next") ?? "/feed";

  // Supabase redirects failures back here with error params rather than a code.
  const errorDescription = searchParams.get("error_description");
  if (searchParams.get("error") || errorDescription) {
    return NextResponse.redirect(
      new URL(
        looksLikeNotInvited(errorDescription) ? "/not-invited" : "/login?error=auth",
        origin,
      ),
    );
  }

  const supabase = await createClient();
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  let exchangeError: string | null = null;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    exchangeError = error?.message ?? null;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    exchangeError = error?.message ?? null;
  } else {
    return NextResponse.redirect(new URL("/login?error=missing_code", origin));
  }

  if (exchangeError) {
    return NextResponse.redirect(
      new URL(
        looksLikeNotInvited(exchangeError) ? "/not-invited" : "/login?error=auth",
        origin,
      ),
    );
  }

  // Covers the case where the auth user already existed before the person row
  // was added, so the sign-up trigger never ran for them.
  const { data: claimed } = await supabase.rpc("claim_membership");

  if (!claimed) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/not-invited", origin));
  }

  return NextResponse.redirect(new URL(next, origin));
}
