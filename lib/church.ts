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
