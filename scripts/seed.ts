/**
 * Seeds fake members and three sample words so every role can be tested.
 *
 * Person rows are created first, because the invite-only trigger refuses to
 * create an auth user whose email is not already on the member list - the
 * same path a real invitation takes.
 *
 * Passwords are generated fresh on every run and printed once. They are not
 * stored anywhere in the repo. Sign in with them only in development, with
 * ENABLE_DEV_LOGIN=true set.
 */
import { randomBytes } from "node:crypto";

import { admin, AUDIO_BUCKET, SEED_DOMAIN } from "./lib";
import type { PersonRole } from "../lib/types";

type SeedPerson = {
  name: string;
  email: string;
  role: PersonRole;
  name_spellings: string[];
};

const PEOPLE: SeedPerson[] = [
  { name: "Ada Okonkwo", email: `editor@${SEED_DOMAIN}`, role: "editor", name_spellings: ["Ada", "Adaeze"] },
  { name: "Tunde Bakare", email: `editor2@${SEED_DOMAIN}`, role: "editor", name_spellings: ["Tunde"] },
  { name: "Pastor Grace Mensah", email: `admin@${SEED_DOMAIN}`, role: "admin", name_spellings: ["Grace", "Pastor Grace"] },
  { name: "Pastor Samuel Idowu", email: `admin2@${SEED_DOMAIN}`, role: "admin", name_spellings: ["Sam", "Samuel"] },
  { name: "Ruth Adeyemi", email: `member@${SEED_DOMAIN}`, role: "member", name_spellings: ["Ruth"] },
  { name: "Daniel Osei", email: `member2@${SEED_DOMAIN}`, role: "member", name_spellings: ["Dan", "Danny"] },
  { name: "Esther Nwosu", email: `member3@${SEED_DOMAIN}`, role: "member", name_spellings: ["Esther", "Eshter"] },
];

const SAMPLE_WORDS = [
  {
    recipient: `member@${SEED_DOMAIN}`,
    giver: `admin@${SEED_DOMAIN}`,
    status: "reviewed" as const,
    segments: [
      {
        start_sec: 12.5,
        end_sec: 74.2,
        transcript:
          "I see a season of steady ground under your feet. The decisions you have been turning over for months will settle, and you will know them by their quietness rather than by their noise. Keep doing the small faithful things.",
      },
      {
        start_sec: 302.0,
        end_sec: 331.4,
        transcript:
          "An addendum given later in the same meeting: the door you thought had closed in the spring is not closed. Ask again.",
      },
    ],
  },
  {
    recipient: `member2@${SEED_DOMAIN}`,
    giver: `admin2@${SEED_DOMAIN}`,
    status: "reviewed" as const,
    segments: [
      {
        start_sec: 95.0,
        end_sec: 168.8,
        transcript:
          "There is a work of patience being done in you. You have been asking for the next thing, and the answer is that the next thing is already in your hands, half finished. Finish it.",
      },
    ],
  },
  {
    // Left pending on purpose, so the review queue has something in it and a
    // member signing in cannot see it.
    recipient: `member3@${SEED_DOMAIN}`,
    giver: `admin@${SEED_DOMAIN}`,
    status: "pending" as const,
    segments: [
      {
        start_sec: 210.0,
        end_sec: 265.5,
        transcript:
          "Draft transcript, not yet reviewed. I hear encouragement over your household this year, particularly over the youngest. [name unclear - check recording at 4:10]",
      },
    ],
  },
];

function password(): string {
  return randomBytes(12).toString("base64url");
}

/** A short quiet tone, so the players on the feed actually have something to play. */
function toneWav(seconds = 5, hz = 320, sampleRate = 22050): Buffer {
  const samples = seconds * sampleRate;
  const data = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i += 1) {
    // Fade in and out so it is not unpleasant to click play on.
    const envelope = Math.min(1, i / (sampleRate * 0.4), (samples - i) / (sampleRate * 0.4));
    const value = Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.18 * envelope;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

async function main() {
  const db = admin();

  console.log("Seeding GracePlace…\n");

  // 1. Member list first — this is the invitation.
  const credentials: { email: string; role: PersonRole; password: string }[] = [];

  for (const p of PEOPLE) {
    const { data: existing } = await db
      .from("person")
      .select("id")
      .ilike("email", p.email)
      .maybeSingle();

    if (!existing) {
      const { error } = await db.from("person").insert(p);
      if (error) throw new Error(`person ${p.email}: ${error.message}`);
    } else {
      const { error } = await db
        .from("person")
        .update({ name: p.name, role: p.role, name_spellings: p.name_spellings })
        .eq("id", existing.id);
      if (error) throw new Error(`person ${p.email}: ${error.message}`);
    }
  }
  console.log(`  ${PEOPLE.length} people on the member list`);

  // 2. Auth users. The on_auth_user_created trigger links each one to its
  //    person row and would reject any email not added above.
  for (const p of PEOPLE) {
    const pass = password();
    const { error } = await db.auth.admin.createUser({
      email: p.email,
      password: pass,
      email_confirm: true,
      user_metadata: { full_name: p.name },
    });

    if (error) {
      if (/already/i.test(error.message)) {
        console.log(`  auth user ${p.email} already exists — leaving its password alone`);
        continue;
      }
      throw new Error(`auth ${p.email}: ${error.message}`);
    }

    credentials.push({ email: p.email, role: p.role, password: pass });
  }

  const byEmail = new Map<string, string>();
  const { data: allPeople } = await db.from("person").select("id, email");
  for (const p of allPeople ?? []) byEmail.set(p.email.toLowerCase(), p.id);

  // 3. A meeting to hang the words off.
  const meetingDate = "2026-09-27";
  let meetingId: string;

  const { data: existingMeeting } = await db
    .from("meeting")
    .select("id")
    .eq("date", meetingDate)
    .maybeSingle();

  if (existingMeeting) {
    meetingId = existingMeeting.id;
  } else {
    const { data, error } = await db
      .from("meeting")
      .insert({ date: meetingDate, format: "hybrid", status: "complete" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`meeting: ${error?.message}`);
    meetingId = data.id;
  }
  console.log(`  meeting ${meetingDate}`);

  // 4. Three sample words, with a playable clip each.
  const clip = toneWav();
  const approver = byEmail.get(`admin@${SEED_DOMAIN}`) ?? null;

  const { data: alreadySeeded } = await db
    .from("word")
    .select("id")
    .eq("meeting_id", meetingId);

  if ((alreadySeeded ?? []).length > 0) {
    console.log(
      `  ${alreadySeeded!.length} word(s) already on that meeting — skipping sample words`,
    );
  } else {
    for (const [index, sample] of SAMPLE_WORDS.entries()) {
      const path = `${meetingId}/sample-${index + 1}.wav`;

      const { error: uploadError } = await db.storage
        .from(AUDIO_BUCKET)
        .upload(path, clip, { contentType: "audio/wav", upsert: true });
      if (uploadError) throw new Error(`upload ${path}: ${uploadError.message}`);

      // Always created pending, then approved separately, because
      // word_approval_guard requires the segments to exist and carry text
      // before a word may become 'reviewed'. The seed goes through the same
      // gate a reviewer does rather than around it.
      const { data: word, error } = await db
        .from("word")
        .insert({
          meeting_id: meetingId,
          recipient_id: byEmail.get(sample.recipient) ?? null,
          giver_id: byEmail.get(sample.giver) ?? null,
          status: "pending",
          audio_clip_path: path,
        })
        .select("id")
        .single();

      if (error || !word) throw new Error(`word ${index + 1}: ${error?.message}`);

      const segments = sample.segments.map((s, position) => ({
        word_id: word.id,
        position,
        ...s,
      }));

      const { error: segmentError } = await db.from("segment").insert(segments);
      if (segmentError) throw new Error(`segments ${index + 1}: ${segmentError.message}`);

      if (sample.status === "reviewed") {
        const { error: approveError } = await db
          .from("word")
          .update({
            status: "reviewed",
            approved_at: new Date().toISOString(),
            approved_by: approver,
          })
          .eq("id", word.id);

        if (approveError) {
          throw new Error(`approve ${index + 1}: ${approveError.message}`);
        }
      }
    }
    console.log(`  ${SAMPLE_WORDS.length} sample words (2 approved, 1 pending)`);
  }

  // 5. Credentials, printed once.
  if (credentials.length > 0) {
    console.log("\n" + "=".repeat(68));
    console.log("TEST PASSWORDS — shown once, not saved anywhere. Copy them now.");
    console.log("Usable only with NODE_ENV=development and ENABLE_DEV_LOGIN=true.");
    console.log("=".repeat(68));
    for (const c of credentials) {
      console.log(`  ${c.role.padEnd(6)}  ${c.email.padEnd(26)}  ${c.password}`);
    }
    console.log("=".repeat(68));
  } else {
    console.log(
      "\nNo new auth users were created, so no passwords to print.\n" +
        "Run `npm run seed:clean` first if you want a fresh set.",
    );
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nSeed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
