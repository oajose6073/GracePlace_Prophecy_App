import "server-only";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { canWrite, type Person } from "@/lib/types";

/**
 * The signed-in member, or null.
 *
 * Returns null both for "not signed in" and for "signed in but not on the
 * member list" - the second should be impossible because of the invite-only
 * trigger, but the app never assumes the database is the only gate.
 */
export async function getCurrentPerson(): Promise<Person | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data } = await supabase
    .from("person")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  return data ?? null;
}

/** Guards every page behind the shell layout. */
export async function requirePerson(): Promise<Person> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: person } = await supabase
    .from("person")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  // Signed in, but not on the member list - never added, or removed since.
  // A removed member's session may still be valid in their browser, so this
  // is the app-side half of what app.member_role() enforces in the database.
  // It must not redirect to /login: the middleware would send a
  // session-holding user straight back here.
  if (!person || person.removed_at) redirect("/not-invited");

  return person;
}

/** Guards the review queue and the members page. */
export async function requireWriter(): Promise<Person> {
  const person = await requirePerson();
  if (!canWrite(person.role)) redirect("/feed?denied=1");
  return person;
}
