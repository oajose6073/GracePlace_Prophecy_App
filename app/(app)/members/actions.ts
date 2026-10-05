"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireWriter } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { PersonRole } from "@/lib/types";
import { zeroRowReason } from "@/lib/write-guards";

/**
 * The role rules live in the database (person_role_guard in the migration):
 * admins may only create or set 'member', only editors touch the admin and
 * editor roles, and nobody changes their own. These actions pass the attempt
 * through and translate whatever Postgres says back into a sentence.
 */

function back(message: string, kind: "ok" | "error" = "ok"): never {
  redirect(`/members?${kind === "ok" ? "ok" : "error"}=${encodeURIComponent(message)}`);
}

function parseSpellings(raw: FormDataEntryValue | null): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function addPerson(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "member") as PersonRole;

  if (!name) back("Enter the person's name.", "error");
  if (!email.includes("@")) back("Enter a valid email address.", "error");

  // A returning member should get their row back, not a second one. The
  // unique index on lower(email) would reject the insert anyway; catching it
  // here turns a dead end into an offer to restore.
  const { data: existing } = await supabase
    .from("person")
    .select("id, name, removed_at")
    .ilike("email", email)
    .maybeSingle();

  if (existing?.removed_at) {
    redirect(
      `/members?restore=${existing.id}&name=${encodeURIComponent(existing.name)}`,
    );
  }

  if (existing) {
    back(`${existing.name} is already on the member list.`, "error");
  }

  const { error } = await supabase.from("person").insert({
    name,
    email,
    role,
    name_spellings: parseSpellings(formData.get("name_spellings")),
  });

  if (error) {
    if (error.code === "23505") {
      back("That email is already on the member list.", "error");
    }
    back(error.message, "error");
  }

  revalidatePath("/members");
  back(`${name} added. They can sign in with ${email}.`);
}

export async function updatePerson(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const id = String(formData.get("person_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "") as PersonRole;

  if (!id) back("Missing person.", "error");
  if (!name) back("A name is required.", "error");

  const { data, error } = await supabase
    .from("person")
    .update({
      name,
      role,
      name_spellings: parseSpellings(formData.get("name_spellings")),
    })
    .eq("id", id)
    .select("id");

  if (error) back(error.message, "error");

  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "person", id);
    back(
      reason === "forbidden"
        ? "You do not have permission to change that person. Only an editor can edit an existing editor or admin account."
        : "That person is no longer on the member list. Reload the page.",
      "error",
    );
  }

  revalidatePath("/members");
  revalidatePath("/feed");
  back("Member updated.");
}

/**
 * Removal is soft: the person row is kept, so every word they received or
 * gave keeps its attribution and their profile page still works. What it
 * takes away is access - app.member_role() returns null for a removed person,
 * which closes every RLS policy at once, storage included.
 *
 * A word is only ever deleted by an editor's explicit delete on that word.
 */
export async function removePerson(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const id = String(formData.get("person_id") ?? "");
  if (!id) back("Missing person.", "error");

  const { data, error } = await supabase
    .from("person")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", id)
    .is("removed_at", null)
    .select("id, name");

  // The database raises for self-removal and for the last remaining editor;
  // those arrive here as a readable sentence already.
  if (error) back(error.message, "error");

  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "person", id);
    if (reason === "missing") {
      back("That person is no longer on the member list. Reload the page.", "error");
    }

    // The row is there, so either it is already removed (the `removed_at is
    // null` filter matched nothing) or the policy refused the update.
    const { data: existing } = await supabase
      .from("person")
      .select("removed_at")
      .eq("id", id)
      .maybeSingle();

    back(
      existing?.removed_at
        ? "They have already been removed from the member list."
        : "You do not have permission to remove that person. Only an editor can remove an editor or admin.",
      "error",
    );
  }

  revalidatePath("/members");
  revalidatePath("/feed");
  back(
    `${data[0].name} can no longer sign in. Their words stay in the feed and on their profile — only an editor deleting a word removes one.`,
  );
}

/** Puts a removed member back, rather than creating a duplicate row. */
export async function restorePerson(formData: FormData) {
  await requireWriter();
  const supabase = await createClient();

  const id = String(formData.get("person_id") ?? "");
  if (!id) back("Missing person.", "error");

  const { data, error } = await supabase
    .from("person")
    .update({ removed_at: null })
    .eq("id", id)
    .select("id, name, email");

  if (error) back(error.message, "error");

  if (!data || data.length === 0) {
    const reason = await zeroRowReason(supabase, "person", id);
    back(
      reason === "forbidden"
        ? "You do not have permission to restore that person. Only an editor can restore an editor or admin."
        : "That person is no longer on the member list, so there is nothing to restore.",
      "error",
    );
  }

  revalidatePath("/members");
  revalidatePath("/feed");
  back(
    `${data[0].name} is back on the member list and can sign in again with ${data[0].email}.`,
  );
}
