import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { expireGuestWords } from "@/lib/guest-expiry";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Daily guest-word expiry, called by the Vercel cron in vercel.json.
 *
 * Secured by CRON_SECRET. When that variable is set on the project, Vercel
 * sends it on every cron invocation as `Authorization: Bearer <secret>`, so
 * this checks that header rather than inventing a custom one.
 *
 * There is no user session here — a cron has none — so it runs with the
 * service-role client. That is why the secret matters: without it this route
 * would let anyone on the internet delete guest words on demand.
 *
 * The response carries counts only. No address, label or transcript ever
 * reaches the response body or Vercel's logs.
 */
export const dynamic = "force-dynamic";

function authorised(request: NextRequest, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;

  // Constant-time, so the secret cannot be recovered a byte at a time from
  // how long a wrong guess takes to reject.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;

  // Fail closed: an unset secret must not mean "no check".
  if (!secret || secret.length < 16) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured on this deployment." },
      { status: 500 },
    );
  }

  if (!authorised(request, secret)) {
    return NextResponse.json({ ok: false, error: "Unauthorised." }, { status: 401 });
  }

  try {
    const result = await expireGuestWords(createAdminClient());

    return NextResponse.json({
      ok: true,
      expired: result.expired.length,
      clipsDeleted: result.clipsDeleted,
      markersCleared: result.markersCleared,
      rowsDeleted: result.rowsDeleted,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Expiry failed." },
      { status: 500 },
    );
  }
}
