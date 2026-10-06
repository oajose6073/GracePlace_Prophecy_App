import Link from "next/link";

import { requireWriter } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  ROLE_LABELS,
  canAssignPrivilegedRoles,
  type Person,
  type PersonRole,
} from "@/lib/types";

import { addPerson, removePerson, restorePerson, updatePerson } from "./actions";

export const metadata = { title: "Members — GracePlace" };
export const dynamic = "force-dynamic";

const ALL_ROLES: PersonRole[] = ["member", "admin", "editor"];

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{
    ok?: string;
    error?: string;
    restore?: string;
    name?: string;
  }>;
}) {
  const { ok, error, restore, name: restoreName } = await searchParams;
  const viewer = await requireWriter();
  const supabase = await createClient();

  const { data } = await supabase.from("person").select("*").order("name");
  const people = (data ?? []) as Person[];

  const active = people.filter((p) => !p.removed_at);
  const removed = people.filter((p) => p.removed_at);

  // An editor may hand out any role; an admin may only ever set 'member'.
  const assignable: PersonRole[] = canAssignPrivilegedRoles(viewer.role)
    ? ALL_ROLES
    : ["member"];

  const editorCount = active.filter(
    (p) => p.role === "editor" && !p.is_congregation,
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Members</h1>
        <p className="mt-1 text-sm text-muted">
          Adding someone here is the invitation — nobody can sign in until their
          email is on this list.
        </p>
      </div>

      {ok ? (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {/* Re-adding a removed member's email lands here instead of failing on
          the unique index. */}
      {restore ? (
        <form
          action={restorePerson}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-brand bg-brand-soft px-4 py-3 text-sm"
        >
          <input type="hidden" name="person_id" value={restore} />
          <span>
            <strong>{restoreName ?? "That person"}</strong> was removed from the
            member list earlier. Restore their existing row so their words stay
            attached, rather than creating a second one?
          </span>
          <button
            type="submit"
            className="ml-auto rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            Restore
          </button>
          <Link
            href="/members"
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-muted transition hover:text-ink"
          >
            Cancel
          </Link>
        </form>
      ) : null}

      {editorCount < 2 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          There {editorCount === 1 ? "is 1 editor" : `are ${editorCount} editors`}.
          The spec asks for at least two, so a removal request never waits on one
          person.
        </p>
      ) : null}

      {viewer.role === "admin" ? (
        <p className="rounded-lg border border-line bg-brand-soft px-4 py-2.5 text-sm">
          As a pastor you can add members and fix name spellings. Granting the
          admin or editor role is an editor-only action, and the database
          enforces that, not just this page.
        </p>
      ) : null}

      <form
        action={addPerson}
        className="space-y-4 rounded-xl border border-line bg-white p-5"
      >
        <h2 className="text-base font-semibold">Invite someone</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Name</span>
            <input
              name="name"
              required
              className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Email</span>
            <input
              name="email"
              type="email"
              required
              placeholder="they sign in with exactly this address"
              className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Role</span>
            <select
              name="role"
              defaultValue="member"
              className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            >
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Name spellings (comma separated)
            </span>
            <input
              name="name_spellings"
              placeholder="Oyinda, Oyinkansola"
              className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </label>
        </div>

        <button
          type="submit"
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          Add to member list
        </button>
      </form>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">On the list ({active.length})</h2>

        <div className="space-y-3">
          {active.map((p) => {
            const isSelf = p.id === viewer.id;
            // An admin may not touch a row that is already an editor or admin.
            const lockedForAdmin =
              viewer.role === "admin" && p.role !== "member";
            // The whole-church recipient has no role and never signs in. The
            // database refuses to change or remove it; this just stops the
            // page offering.
            const roleLocked =
              isSelf ||
              lockedForAdmin ||
              p.is_congregation ||
              !canAssignPrivilegedRoles(viewer.role);

            return (
              <form
                key={p.id}
                action={updatePerson}
                className="rounded-xl border border-line bg-white p-4"
              >
                <input type="hidden" name="person_id" value={p.id} />

                <div className="mb-3 flex flex-wrap items-baseline gap-2">
                  <Link
                    href={`/profile/${p.id}`}
                    className="text-sm font-semibold hover:underline"
                  >
                    {p.name}
                  </Link>
                  <span className="text-sm text-muted">{p.email}</span>
                  {p.auth_user_id ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900">
                      Signed in before
                    </span>
                  ) : (
                    <span className="rounded bg-stone-100 px-2 py-0.5 text-xs text-muted">
                      Not signed in yet
                    </span>
                  )}
                  {isSelf ? (
                    <span className="rounded bg-brand-soft px-2 py-0.5 text-xs text-brand">
                      You
                    </span>
                  ) : null}
                  {p.is_congregation ? (
                    <span className="rounded bg-brand-soft px-2 py-0.5 text-xs text-brand">
                      the whole church — pinned first in the console
                    </span>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-muted">
                      Name
                    </span>
                    <input
                      name="name"
                      defaultValue={p.name}
                      disabled={lockedForAdmin}
                      className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand disabled:bg-stone-50 disabled:text-muted"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-muted">
                      Name spellings
                    </span>
                    <input
                      name="name_spellings"
                      defaultValue={p.name_spellings.join(", ")}
                      disabled={lockedForAdmin}
                      className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand disabled:bg-stone-50 disabled:text-muted"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-muted">
                      Role
                    </span>
                    <select
                      name="role"
                      defaultValue={p.role}
                      disabled={roleLocked}
                      className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand disabled:bg-stone-50 disabled:text-muted"
                    >
                      {ALL_ROLES.map((r) => (
                        <option
                          key={r}
                          value={r}
                          disabled={!assignable.includes(r) && r !== p.role}
                        >
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <p className="mt-2 text-xs text-muted">
                  {p.is_congregation
                    ? "Words given to everyone are tagged to this row. It has no role, never signs in, and cannot be removed — but you can rename it."
                    : isSelf
                      ? "You cannot change your own role — ask another editor."
                      : lockedForAdmin
                        ? `Only an editor can change an existing ${p.role} account.`
                        : null}
                </p>

                <div className="mt-3 flex gap-2">
                  <button
                    type="submit"
                    disabled={lockedForAdmin}
                    className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-stone-50 disabled:opacity-40"
                  >
                    Save
                  </button>
                  {!isSelf && !lockedForAdmin && !p.is_congregation ? (
                    <button
                      type="submit"
                      formAction={removePerson}
                      className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 transition hover:bg-red-50"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </form>
            );
          })}
        </div>
      </section>

      {removed.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Removed ({removed.length})</h2>
            <p className="mt-1 text-sm text-muted">
              They cannot sign in. Their rows are kept so every word they
              received or gave keeps its name, and their profile page still
              works. Restoring one brings the same row back, so a returning
              member never ends up with a duplicate.
            </p>
          </div>

          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
            {removed.map((p) => {
              const lockedForAdmin =
                viewer.role === "admin" && p.role !== "member";

              return (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm"
                >
                  <Link
                    href={`/profile/${p.id}`}
                    className="font-medium hover:underline"
                  >
                    {p.name}
                  </Link>
                  <span className="text-muted">{p.email}</span>
                  <span className="rounded bg-stone-100 px-2 py-0.5 text-xs text-muted">
                    {ROLE_LABELS[p.role]} · removed {formatWhen(p.removed_at)}
                  </span>

                  {lockedForAdmin ? (
                    <span className="ml-auto text-xs text-muted">
                      Only an editor can restore an {p.role} account.
                    </span>
                  ) : (
                    <form action={restorePerson} className="ml-auto">
                      <input type="hidden" name="person_id" value={p.id} />
                      <button
                        type="submit"
                        className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-stone-50"
                      >
                        Restore
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
