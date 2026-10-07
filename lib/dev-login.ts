import "server-only";

import { isProductionUrl } from "@/lib/environments";

/**
 * The seeded password accounts are a testing convenience and nothing more.
 *
 * Three conditions, each closing a different door:
 *
 *   NODE_ENV === "development"
 *     Inlined at build time. In any `next build` this folds to false and the
 *     whole expression compiles to a literal — verified: a production build
 *     made with ENABLE_DEV_LOGIN=true ships `let d=!1` and never reads either
 *     variable at runtime, so setting them on Vercel changes nothing.
 *
 *   ENABLE_DEV_LOGIN === "true"
 *     Opt-in even in development, so it is never on by accident.
 *
 *   not the production Supabase project
 *     The case a build cannot cover: `next dev` run against production keys
 *     (after `vercel env pull`, say). Password sign-in must never reach the
 *     real member list, whatever else is set.
 *
 * The sign-in form is rendered server-side only when this is true, so no
 * dev-login markup or JavaScript is emitted otherwise, and /auth/dev-login
 * answers 404 under the same condition.
 */
export const DEV_LOGIN_ENABLED =
  process.env.NODE_ENV === "development" &&
  process.env.ENABLE_DEV_LOGIN === "true" &&
  !isProductionUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
