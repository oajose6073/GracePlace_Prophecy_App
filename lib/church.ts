/**
 * How the church refers to itself in anything a non-member reads.
 *
 * A constant rather than an env var: unlike RESEND_FROM, which changes when
 * the pilot moves to the church's own domain, this does not vary by
 * deployment. One place to change it if the name ever does.
 *
 * The app's own chrome stays short ("GracePlace") — the full name is for
 * people who are not members and need to know who is writing to them.
 */
export const CHURCH_NAME = "GracePlace Winnipeg";

/**
 * Where the meetings happen. Vercel's servers run in UTC, and so does
 * `toISOString()` everywhere, so any "today" or clock time computed without
 * this is UTC's — which in Winnipeg is tomorrow from 7pm (CDT) or 6pm (CST),
 * right when evening meetings start.
 */
export const CHURCH_TIME_ZONE = "America/Winnipeg";

/** Today's date in Winnipeg, as YYYY-MM-DD. */
export function todayInChurchTimeZone(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape a <input
  // type="date"> and the meeting.date column both want.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CHURCH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** "7:04 p.m." for a timestamp, on Winnipeg's clock rather than the server's. */
export function formatTimeInChurchTimeZone(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: CHURCH_TIME_ZONE,
  });
}

/** "Oct 5, 2026" for a timestamp, on Winnipeg's calendar. */
export function formatDateTimeStampInChurchTimeZone(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: CHURCH_TIME_ZONE,
  });
}

/**
 * "5 October 2026" — for people, not machines.
 *
 * `date` is a plain YYYY-MM-DD from Postgres. Parsing it as UTC avoids the
 * off-by-one day that local-time parsing causes west of Greenwich, which is
 * every timezone Winnipeg has ever been in.
 */
export function formatDateForPeople(date: string | null | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
