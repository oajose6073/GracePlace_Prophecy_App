import Link from "next/link";

export const metadata = { title: "Not on the member list — GracePlace" };

export default function NotInvitedPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-12">
      <div className="rounded-xl border border-line bg-white p-7 shadow-sm">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-brand-soft">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="h-5 w-5 text-brand"
            aria-hidden
          >
            <path d="M12 9v4m0 4h.01M10.3 3.9 2.4 17.1A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </div>

        <h1 className="text-xl font-semibold tracking-tight">
          You&apos;re not on the member list
        </h1>

        <p className="mt-2 text-sm leading-relaxed text-muted">
          GracePlace is invite only, so an account is created for you only after
          a pastor adds your email address. Ask a pastor to add you, then sign
          in again with the same address.
        </p>

        <p className="mt-4 text-sm leading-relaxed text-muted">
          If you were already added, check that you used the same email — a
          personal Gmail and a church address are two different invitations.
        </p>

        <Link
          href="/login"
          className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
