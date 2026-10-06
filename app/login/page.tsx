import Link from "next/link";

import { DEV_LOGIN_ENABLED } from "@/lib/dev-login";
import { EmailLinkForm, GoogleButton } from "./login-forms";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">GracePlace</h1>
        <p className="mt-1 text-sm text-muted">
          Prophetic words given in our meetings. Sign in with the address your
          pastor invited.
        </p>
      </div>

      <div className="space-y-5 rounded-xl border border-line bg-white p-6 shadow-sm">
        <GoogleButton />

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs uppercase tracking-wide text-muted">or</span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <EmailLinkForm />
      </div>

      {/*
        Rendered only when NODE_ENV=development and ENABLE_DEV_LOGIN=true.
        A plain form posting to a route handler, so nothing about it is
        compiled into the client bundle.
      */}
      {DEV_LOGIN_ENABLED ? (
        <form
          method="post"
          action="/auth/dev-login"
          className="mt-6 space-y-3 rounded-xl border border-dashed border-amber-400 bg-amber-50 p-5"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">
            Dev sign-in — seeded test accounts
          </p>
          <input
            name="email"
            type="email"
            required
            placeholder="editor@example.com"
            className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm outline-none"
          />
          <input
            name="password"
            type="password"
            required
            placeholder="password printed by npm run seed"
            className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm outline-none"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-amber-900 px-4 py-2 text-sm font-medium text-white"
          >
            Sign in as test user
          </button>
        </form>
      ) : null}

      <p className="mt-8 text-center text-xs text-muted">
        Invite only. There is no public sign-up.
        <span aria-hidden> · </span>
        <Link href="/privacy" className="underline underline-offset-2 hover:text-ink">
          Privacy
        </Link>
      </p>
    </main>
  );
}
