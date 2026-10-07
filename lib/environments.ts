/**
 * The two Supabase projects, by ref.
 *
 * Project refs are not secrets — they are the subdomain of the public API URL
 * every browser already sees — so naming them here is fine. What they buy is
 * a hard check that a script or a dev-only feature is talking to the project
 * it thinks it is, rather than trusting whichever .env file happened to load.
 *
 * No `import "server-only"`: the scripts in scripts/ import this, and that
 * marker throws outside Next.
 */
export const DEV_PROJECT_REF = "qiwztvumbmrecjlbhrvn";
export const PROD_PROJECT_REF = "nlanzwavfsocxijjvigf";

/** "https://abcd.supabase.co" -> "abcd". Null for anything unrecognised. */
export function projectRefFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i.exec(url.trim());
  return match ? match[1].toLowerCase() : null;
}

export function isProductionUrl(url: string | undefined | null): boolean {
  return projectRefFromUrl(url) === PROD_PROJECT_REF;
}
