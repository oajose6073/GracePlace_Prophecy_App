import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  projectRefFromUrl,
} from "../lib/environments";
import type { Database } from "../lib/types";

// ---------------------------------------------------------------------------
// Which project are we talking to?
//
// Decided here, at import time, before any other module reads process.env.
// `--prod` loads .env.prod; otherwise .env.local. The chosen file wins over
// anything already in the shell (`override`), so a stray exported variable can
// never quietly redirect a run to the other project.
//
// .env.prod rather than .env.production.local on purpose: Next.js loads the
// latter automatically for `next build` and `next start`, so a local build
// would silently target production. Next never loads .env.prod; only these
// scripts do, and only when asked.
// ---------------------------------------------------------------------------
export const PROD = process.argv.includes("--prod");
export const ENV_FILE = PROD ? ".env.prod" : ".env.local";

if (!existsSync(ENV_FILE)) {
  console.error(
    PROD
      ? `\n--prod needs ${ENV_FILE} with the production project's keys. It does not exist.\n`
      : `\n${ENV_FILE} is missing. Copy .env.example and fill in the dev project's keys.\n`,
  );
  process.exit(1);
}

config({ path: ENV_FILE, override: true });

export const PROJECT_REF = projectRefFromUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);

// The file and the flag have to agree. Either mismatch is a misconfiguration
// that would otherwise write to the wrong place without a word.
if (PROD && PROJECT_REF !== PROD_PROJECT_REF) {
  console.error(
    `\n--prod loaded ${ENV_FILE}, but it points at "${PROJECT_REF ?? "an unrecognised URL"}", ` +
      `not the production project (${PROD_PROJECT_REF}). Refusing to run.\n`,
  );
  process.exit(1);
}
if (!PROD && PROJECT_REF === PROD_PROJECT_REF) {
  console.error(
    `\n${ENV_FILE} points at the PRODUCTION project (${PROD_PROJECT_REF}).\n` +
      `Local runs should use the dev project (${DEV_PROJECT_REF}). If you meant to touch\n` +
      `production, keep its keys in .env.prod and pass --prod.\n`,
  );
  process.exit(1);
}

export { AUDIO_BUCKET } from "../lib/storage";
export const SEED_DOMAIN = "example.com";

export function admin(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in ${ENV_FILE}.`);
    process.exit(1);
  }

  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Production guard rails
// ---------------------------------------------------------------------------

const RULE = "!".repeat(68);
let bannerShown = false;

/**
 * One line in dev; impossible to miss in production. Call it first thing in
 * main(), before any read, so nobody spends even a moment looking at
 * production data without knowing it. Prints once, however often it is called.
 */
export function printEnvironmentBanner(): void {
  if (bannerShown) return;
  bannerShown = true;

  if (!PROD) {
    console.log(`(dev project ${PROJECT_REF}, keys from ${ENV_FILE})`);
    return;
  }

  console.log(`\n${RULE}`);
  console.log("!!");
  console.log(`!!   PRODUCTION   -   project ${PROJECT_REF}`);
  console.log(`!!   keys from ${ENV_FILE}`);
  console.log("!!");
  console.log("!!   This is the live database and storage real members use.");
  console.log("!!   Anything written or deleted here has no undo.");
  console.log("!!");
  console.log(`${RULE}\n`);
}

/**
 * Stops a production run before its first write unless a person confirms it
 * by typing the project ref back.
 *
 * Typing the ref rather than "y" is deliberate: "y" is muscle memory, and the
 * point is to make someone read which project they are about to change. There
 * is no flag to skip it — a production write always has a person at the
 * keyboard — and with no terminal to ask, it refuses.
 */
export async function confirmProductionWrite(what: string): Promise<void> {
  if (!PROD) return;

  printEnvironmentBanner();
  console.log(`!! PRODUCTION (${PROJECT_REF}) — confirm before anything is written.`);

  if (!process.stdin.isTTY) {
    console.error(
      "Refusing: this would write to production, and there is no terminal to confirm it.\n",
    );
    process.exit(1);
  }

  console.log(`About to: ${what}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(`Type the project ref (${PROJECT_REF}) to continue: `)
    ).trim();
    if (answer !== PROJECT_REF) {
      console.log("\nThat did not match. Nothing was changed.\n");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
  console.log("");
}

/** For scripts that must never touch production at all. */
export function refuseProduction(script: string, reason: string): void {
  if (!PROD) return;
  console.error(`\n${script} refuses --prod. ${reason}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

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
