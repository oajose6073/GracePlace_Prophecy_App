import { NextResponse, type NextRequest } from "next/server";

import { DEV_LOGIN_ENABLED } from "@/lib/dev-login";
import { createClient } from "@/lib/supabase/server";

/**
 * Password sign-in for the seeded @example.com accounts.
 *
 * Answers 404 unless NODE_ENV=development and ENABLE_DEV_LOGIN=true, so the
 * endpoint is inert in any deployed build even if the file ships.
 */
export async function POST(request: NextRequest) {
  if (!DEV_LOGIN_ENABLED) {
    return new NextResponse("Not found", { status: 404 });
  }

  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const { origin } = request.nextUrl;

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return NextResponse.redirect(new URL("/login?error=dev", origin), {
      status: 303,
    });
  }

  return NextResponse.redirect(new URL("/feed", origin), { status: 303 });
}
