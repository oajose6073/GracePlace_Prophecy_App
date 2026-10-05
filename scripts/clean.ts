/**
 * Removes everything the seed created: every @example.com auth user, their
 * person rows, and the words (with audio) attached to them.
 *
 * Only touches @example.com. Real members and their words are never matched.
 */
import { wordAudioObjects } from "../lib/word-audio";
import { admin, AUDIO_BUCKET, isSeedEmail, listAllAuthUsers, SEED_DOMAIN } from "./lib";

async function main() {
  const db = admin();

  console.log(`Removing seeded @${SEED_DOMAIN} data…\n`);

  // 1. Person rows for the seeded addresses.
  const { data: people, error: peopleError } = await db
    .from("person")
    .select("id, email, name")
    .ilike("email", `%@${SEED_DOMAIN}`);

  if (peopleError) throw new Error(peopleError.message);
  const personIds = (people ?? []).map((p) => p.id);

  // 2. Their words — as recipient or as giver — plus the audio objects.
  if (personIds.length > 0) {
    const idList = personIds.join(",");
    const { data: words, error: wordError } = await db
      .from("word")
      .select("id, audio_clip_path, segment ( audio_clip_path )")
      .or(`recipient_id.in.(${idList}),giver_id.in.(${idList})`);

    if (wordError) throw new Error(wordError.message);

    type WordRow = {
      id: string;
      audio_clip_path: string | null;
      segment: { audio_clip_path: string | null }[];
    };

    // A multi-segment word owns a joined clip plus one per segment.
    const paths = [
      ...new Set(
        ((words ?? []) as unknown as WordRow[]).flatMap((w) =>
          wordAudioObjects(w.audio_clip_path, w.segment ?? []),
        ),
      ),
    ];

    if (paths.length > 0) {
      const { error } = await db.storage.from(AUDIO_BUCKET).remove(paths);
      if (error) console.warn(`  audio: ${error.message}`);
      else console.log(`  ${paths.length} audio object(s) deleted`);
    }

    if ((words ?? []).length > 0) {
      // Segments go with the word through the cascade.
      const { error } = await db
        .from("word")
        .delete()
        .in("id", words!.map((w) => w.id));
      if (error) throw new Error(error.message);
      console.log(`  ${words!.length} word(s) deleted`);
    }
  }

  // 3. Auth users. Deleting these first would leave the person rows unlinked,
  //    so they go before the person rows but after the words that point at them.
  const authUsers = await listAllAuthUsers(db);
  const seeded = authUsers.filter((u) => isSeedEmail(u.email));

  for (const user of seeded) {
    const { error } = await db.auth.admin.deleteUser(user.id);
    if (error) console.warn(`  auth ${user.email}: ${error.message}`);
  }
  console.log(`  ${seeded.length} auth user(s) deleted`);

  // 4. Person rows.
  if (personIds.length > 0) {
    const { error } = await db.from("person").delete().in("id", personIds);
    if (error) throw new Error(error.message);
    console.log(`  ${personIds.length} person row(s) deleted`);
  }

  // 5. Any meeting left with no words at all.
  const { data: meetings } = await db.from("meeting").select("id, date");
  let emptied = 0;
  for (const m of meetings ?? []) {
    const { count } = await db
      .from("word")
      .select("id", { count: "exact", head: true })
      .eq("meeting_id", m.id);
    const { count: guestCount } = await db
      .from("guest_word")
      .select("id", { count: "exact", head: true })
      .eq("meeting_id", m.id);

    if ((count ?? 0) === 0 && (guestCount ?? 0) === 0) {
      await db.from("meeting").delete().eq("id", m.id);
      emptied += 1;
    }
  }
  if (emptied > 0) console.log(`  ${emptied} empty meeting(s) deleted`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nCleanup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
