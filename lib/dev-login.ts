import "server-only";

/**
 * The seeded password accounts are a testing convenience and nothing more.
 *
 * Both halves must line up: NODE_ENV is inlined at build time, so a production
 * build can never satisfy this, and ENABLE_DEV_LOGIN must be set deliberately
 * on top of that. The sign-in form is rendered server-side only when this is
 * true, so no dev-login markup or JavaScript is emitted otherwise, and
 * /auth/dev-login answers 404 under the same condition.
 */
export const DEV_LOGIN_ENABLED =
  process.env.NODE_ENV === "development" &&
  process.env.ENABLE_DEV_LOGIN === "true";
