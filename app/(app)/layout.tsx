import Link from "next/link";

import { requirePerson } from "@/lib/auth";
import { canWrite, ROLE_LABELS } from "@/lib/types";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const person = await requirePerson();
  const writer = canWrite(person.role);

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
          <Link href="/feed" className="text-base font-semibold tracking-tight">
            GracePlace
          </Link>

          <nav className="flex items-center gap-4 text-sm">
            <Link href="/feed" className="text-muted hover:text-ink">
              Feed
            </Link>
            <Link
              href={`/profile/${person.id}`}
              className="text-muted hover:text-ink"
            >
              My words
            </Link>
            {writer ? (
              <>
                <Link href="/review" className="text-muted hover:text-ink">
                  Review queue
                </Link>
                <Link href="/members" className="text-muted hover:text-ink">
                  Members
                </Link>
              </>
            ) : null}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-muted sm:inline">
              {person.name} · {ROLE_LABELS[person.role]}
            </span>
            <form method="post" action="/auth/signout">
              <button
                type="submit"
                className="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition hover:text-ink"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-8">{children}</main>
    </div>
  );
}
