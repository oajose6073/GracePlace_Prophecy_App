# GracePlace — Prophecy Capture App

Prophetic words given in church meetings, tagged to the member who received
them and published to a church-wide feed once a pastor approves them.

This repository implements two phases from [SPEC.md](SPEC.md):

- **Phase 2 — App core.** The Supabase schema and row-level security,
  invite-only sign-in, the feed, member profiles, the review queue and the
  members list.
- **Phase 1 — Transcribe and split.** A local script that cuts a meeting
  recording into one clip per word, transcribes each with the member names as
  keyword hints, and publishes them as pending words. See §6. Written in
  TypeScript rather than the Python the spec suggests, so it shares the
  existing `lib/` types and Supabase client.

Not built yet: the live operator console and the guest email flow (Phase 3),
and moving the worker to Lambda (Phase 4). The `guest_word` table exists so
the schema is complete, but nothing writes to it.

---

## 1. What you need

- Node.js 20 or newer (built against 24)
- A Supabase project
- The Supabase CLI, if you want to push the migration from the terminal

---

## 2. Environment

`.env.local` already holds the keys. The full set:

```ini
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable key>
SUPABASE_SECRET_KEY=<secret key — server only>
SUPABASE_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json

# Needed only by the transcribe script (§6)
OPENAI_API_KEY=<openai key — server only>

# Optional, only for local testing with the seeded accounts
ENABLE_DEV_LOGIN=true
```

`SUPABASE_SECRET_KEY` is read only by `lib/supabase/admin.ts` and the scripts
in `scripts/`. Those files start with `import "server-only"`, so the build
fails if a client component ever imports them, and the variable has no
`NEXT_PUBLIC_` prefix, so it is never inlined into the browser bundle.
`OPENAI_API_KEY` is read only by `scripts/transcribe/` and never by the app.

---

## 3. Apply the database migration

There are two migrations, applied in filename order:

1. [`20261004000100_phase2_core.sql`](supabase/migrations/20261004000100_phase2_core.sql)
   — the five tables, the enums, every `GRANT` to `authenticated`, the RLS
   policies, the invite-only auth trigger, the role-assignment guard, and the
   private `word-audio` bucket with its storage policies.
2. [`20261004000200_service_role_grants.sql`](supabase/migrations/20261004000200_service_role_grants.sql)
   — privileges for `service_role`, which the scripts in `scripts/` run as.
   With auto-expose off it gets nothing by default, and `BYPASSRLS` skips row
   policies but *not* the `GRANT` check, so the seed fails with "permission
   denied for table person" without this. It also sets `ALTER DEFAULT
   PRIVILEGES` so tables added later are covered automatically.

3. [`20261004000300_soft_removal.sql`](supabase/migrations/20261004000300_soft_removal.sql)
   — `person.removed_at`, and the foreign-key changes that stop anything
   deleting a word implicitly. See §8.1.

4. [`20261004000400_pending_visibility.sql`](supabase/migrations/20261004000400_pending_visibility.sql)
   — keeps pending words out of the feed, profiles and the audio bucket. See
   §8.2.

5. [`20261004000500_audio_mime_types.sql`](supabase/migrations/20261004000500_audio_mime_types.sql)
   — the `word-audio` bucket's accepted formats and its 100 MB limit.

6. [`20261004000600_approval_requires_transcripts.sql`](supabase/migrations/20261004000600_approval_requires_transcripts.sql)
   — a word cannot be approved while any segment is missing its transcript.

7. [`20261004000700_word_source.sql`](supabase/migrations/20261004000700_word_source.sql)
   — `word.source`, so the transcribe script can tell its own pending words
   apart from hand-made ones. See §6.

None of them grants anything to `anon`; the second adds a default-privileges
rule that keeps future tables that way too.

**Either** paste it into the Supabase dashboard SQL editor and run it,

**or** push it with the CLI:

```bash
npx supabase login
npx supabase link --project-ref qiwztvumbmrecjlbhrvn
npm run db:push
```

> I have not executed this SQL against your project — I do not have your
> database password or a CLI session, and Docker Desktop was not running, so I
> could not apply it to a local stack either. It builds and the structure
> checks out, but the first run is yours. If anything fails, send me the error.

---

## 4. Supabase dashboard settings

Three things have to be set in the dashboard, because they are project
configuration rather than SQL:

1. **Authentication → Providers → Google.** Enable it and paste in the Google
   OAuth client ID and secret. In the Google Cloud console, the authorised
   redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`.
2. **Authentication → URL Configuration.** Set Site URL to
   `http://localhost:3000` for local work, and add
   `http://localhost:3000/auth/callback` to the redirect allow-list. Add the
   Vercel URL later alongside it.
3. **Authentication → Providers → Email.** Leave the email provider on; it is
   what sends the one-time link. You can turn off "Confirm email" — the link
   *is* the confirmation.

You do **not** need to find a public-sign-up toggle. Invite-only is enforced in
the database: `on_auth_user_created` refuses to create any auth user whose
email is not already on the `person` list, matched case-insensitively. Someone
who tries anyway lands on `/not-invited`, which explains it in plain words
rather than showing an auth error.

---

## 5. Run it

```bash
npm install
npm run seed      # fake members + 3 sample words; prints test passwords once
npm run dev
```

Open <http://localhost:3000>.

The seed prints a block like this, **once**. The passwords are generated fresh
each run and are not written to the repo or to any file — copy them before
you clear the terminal.

```
====================================================================
TEST PASSWORDS — shown once, not saved anywhere. Copy them now.
Usable only with NODE_ENV=development and ENABLE_DEV_LOGIN=true.
====================================================================
  editor  editor@example.com          k3Jv8qZ...
  admin   admin@example.com           pQ2mXr7...
  member  member@example.com          9bNt4Ls...
====================================================================
```

To use them, put `ENABLE_DEV_LOGIN=true` in `.env.local` and restart `npm run
dev`. A dashed "Dev sign-in" box appears under the normal sign-in buttons.

That box is gated on `NODE_ENV === "development" && ENABLE_DEV_LOGIN === "true"`,
evaluated on the server. In a production build the form is never rendered and
`/auth/dev-login` answers 404 — I checked the built output and neither the
markup nor the route's behaviour survives `next build`.

To remove everything the seed created:

```bash
npm run seed:clean
```

That deletes every `@example.com` auth user, their `person` rows, the words
they gave or received, those words' audio objects, and any meeting left empty.
It matches on `@example.com` only, so real members are never touched.

---

## 6. Transcribing a meeting (Phase 1)

The script takes a local recording plus a markers file, cuts one clip per
marker, transcribes each clip, and publishes the results as pending words for
the review queue.

**The full recording is never uploaded.** Only the cut clips reach storage,
and `uploadClip` refuses any path outside the run's own clips folder rather
than trusting the caller.

```bash
# see what it would do, and read the transcripts, without touching anything
npm run transcribe:dry -- --markers recordings/2026-05-08.markers.json

# for real: creates the meeting, the words and the segments, uploads the clips
npm run transcribe -- --markers recordings/2026-05-08.markers.json
```

Recordings live in `recordings/` and output in `transcribe-output/`. Both are
gitignored.

### The markers file

Copy [`scripts/transcribe/example.markers.json`](scripts/transcribe/example.markers.json),
which documents every field inline. The shape:

```json
{
  "meeting": { "date": "2026-05-08", "format": "hybrid" },
  "recording": "recordings/2026-05-08-meeting.m4a",
  "markers": [
    { "at": "00:01:12", "recipient": "Ruth", "giver": "Pastor Grace" },
    { "at": "00:07:45", "recipient": "Eshter", "giver": "Pastor Sam" },
    { "at": "00:11:02", "recipient": "Ruth", "addendum": true },
    { "at": "00:14:20", "guest": true },
    { "at": "00:17:05", "recipient": null },
    { "at": "00:19:40", "end": true }
  ]
}
```

- `at` accepts `"HH:MM:SS.mmm"`, `"MM:SS"` or a plain number of seconds, and
  must be strictly increasing.
- A clip runs from one marker to the next, whatever kind the next one is — a
  guest or `end` marker still acts as a boundary. The last marker runs to the
  end of the recording unless an `end` marker closes it.
- Names match against `person.name` **and** `name_spellings`,
  case-insensitively, which is what makes `"Eshter"` resolve to Esther Nwosu.
- `"recipient": null` is deliberate: it publishes as "to be confirmed". A name
  that matches *nobody* is an error listing every unmatched name, plus the
  current member list — except under `--dry-run`, where it is only a warning.
- A name that matches two people is always an error; fix the spellings on the
  Members page.
- `"addendum": true` adds a further segment to that recipient's earlier word in
  the same file, instead of creating a second word.
- `"guest": true` is skipped with a warning. Guests are Phase 3.

### Clips and transcription

Clips are cut with the `ffmpeg-static` binary — no system ffmpeg needed — to
mono AAC at 64 kbps in an `.m4a`, which is the spec's cost basis of about
0.5 MB a minute and is on the bucket's MIME allow-list.

Transcription uses **`gpt-transcribe`**, OpenAI's recommended transcription
model, and passes every member name and spelling variant in its **`keywords`**
parameter — a list of literal terms to bias towards. That is the right home
for names; `prompt` is for unstructured context. Clips over 25 MB are rejected
before the call, because the endpoint will not take them.

### Re-running a meeting

A second run against a meeting that already has pending words refuses, so
nothing is silently duplicated. `--replace-pending` rebuilds the pending set:

1. It prints every pending word it would delete and asks for `y/N`.
2. `word.source` records whether the script or a person created each word, and
   comparing `updated_at` with `created_at` on the word and its segments says
   whether it was edited in review. If any pending word was **added by hand or
   edited**, it refuses outright and names them — `--force` is needed as well
   to discard that work.
3. **Reviewed words are never selected**, so they cannot be caught up in it.

```bash
npm run transcribe -- --markers <file> --replace-pending
npm run transcribe -- --markers <file> --replace-pending --force   # also discards hand edits
```

### The local copy

`results.json` holds the **full text of every transcript**, so a stale output
folder is a plain-text copy of people's prophetic words on a laptop. Every
real run ends with a reminder that it exists.

```bash
npm run transcribe:clean                      # deletes output folders over 30 days old
npm run transcribe:clean -- --days 7 --dry-run
```

---

## 7. Testing each role

The seed creates two editors, two pastors (admins) and three members. Sign in
as each — different browsers or private windows are easiest, since sessions
are cookie-based.

### Member — `member@example.com`

| Try this | Expected |
| --- | --- |
| Open the feed | Two approved words, newest meeting first. Audio plays. |
| Search a name, set a date range | Filters the feed. |
| Open "My words" | Just Ruth's word; the "oldest first" toggle reverses it. |
| Look at the nav | No "Review queue", no "Members". |
| Visit `/review` directly | Redirected to the feed with "That page is for editors and pastors only." |
| Count the words | **2**, not 3 — the pending one is invisible. That is RLS, not the UI. |
| Fetch the pending clip's signed URL by path | Refused — the storage policy checks the word is approved. |

To prove the last point is enforced in the database, open the browser console
while signed in as the member and query it directly:

```js
const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
// paste your NEXT_PUBLIC_ values
const sb = createClient(URL, ANON_KEY);
await sb.auth.signInWithPassword({ email: "member@example.com", password: "…" });
await sb.from("word").select("id,status");          // only status: "reviewed"
await sb.from("word").insert({ meeting_id: "…" });  // refused by RLS
await sb.from("word").delete().eq("id", "…");       // deletes nothing
```

### Admin / pastor — `admin@example.com`

| Try this | Expected |
| --- | --- |
| Open the review queue | The third word is there, marked Pending. |
| Open the feed as the admin | **2** words, same as a member. Pending words only ever appear in the review queue. |
| Add a meeting | Appears in the meeting dropdown. |
| Add a word with an audio file | Uploads to the private bucket, lands in the queue. |
| Approve a word with no recipient | Refused: "Assign a recipient before approving". |
| Approve a word with an empty transcript | Approve is disabled, with "To approve, fill in the transcript — and Save changes." The empty box is highlighted. |
| Blank a published word's transcript and save | Refused by the database: unapprove it first. |
| Assign a recipient, fill the transcript, then approve | Moves to the feed and to that member's profile. |
| Edit a transcript, drag a start time back | Saved. |
| Look for a Delete button | There isn't one — "Deleting is an editor-only action." |
| Open Members, add someone | Works. The role dropdown offers **Member only**. |
| Remove a member who has words | They move to "Removed". Their words stay in the feed, still showing their name. |
| Re-add that same email | You get "Restore their existing row?" rather than a duplicate-key failure. |
| Try to remove yourself | Refused by the database, not just the hidden button. |
| Try to edit an editor's or another admin's row | Fields are disabled; "Only an editor can change an existing editor account." |
| Try to change your own role | The dropdown is disabled. |

The last three are enforced by the `person_role_guard` trigger, not just by
the disabled inputs. To confirm, run this in the Supabase SQL editor as the
admin's JWT, or call the REST API with the admin's token — the update is
rejected with "Admins may only add people as members."

### Editor — `editor@example.com`

| Try this | Expected |
| --- | --- |
| Everything an admin can do | Works. |
| Delete a word | Works; the audio object goes with it. |
| Members page role dropdown | Offers Member, Admin and Editor. |
| Promote a member to admin | Works. |
| Restore a removed editor or admin | Works — an admin gets "Only an editor can restore an editor account." |
| Remove the only remaining editor | Refused: "That is the last remaining editor. Appoint another editor first." |
| Delete a meeting that still has words | Refused by the foreign key. Delete the words first, explicitly. |
| Change your own role | Dropdown disabled, and the trigger refuses it even via the API. |

### Not invited

Sign in with a Google account or email address that is not on the member list.
You land on `/not-invited`: *"You're not on the member list — ask a pastor to
add you."* No account is created. Add that email on the Members page, sign in
again, and it works.

---

## 8. How the permissions map to the spec

The Roles and permissions table in [SPEC.md](SPEC.md) is the source of truth.
One thing worth flagging, because your build request phrased it differently:
you wrote "admins insert/update, only editors delete", but the spec's table
also gives **Editors** "Edit, review and approve transcripts" and "Run the
operator console". I followed the table — editors are a superset of admins:

| | Editor | Admin | Member |
| --- | --- | --- | --- |
| Select words, segments, meetings | all | all | approved only |
| Insert / update words, segments, meetings | yes | yes | no |
| Delete words, segments, meetings, audio | **yes** | no | no |
| Manage the member list | yes | yes | no |
| Assign admin / editor roles | yes | no | no |
| Read `guest_word` | yes | yes | **no** |

### 8.1 Removing a member never removes a word

A word is only ever deleted by an editor's explicit delete on that word.
Nothing else deletes one as a side effect. Three things enforce that:

- **Removal is soft.** "Remove" sets `person.removed_at`; the row stays. Every
  word they received *or gave* keeps its attribution, their name still reads
  correctly on feed cards, and their profile page still works. What they lose
  is access: `app.member_role()` returns null for a removed person, which
  closes every RLS policy at once — storage included, so a stale session in
  their browser cannot even mint a signed audio URL.
- **Restore brings back the same row**, so a returning member never ends up
  with a duplicate. Re-adding a removed address on the Members page offers
  restore instead of failing on the unique index.
- **`word.meeting_id` is `ON DELETE RESTRICT`.** It used to be `CASCADE`, which
  meant an editor deleting a meeting silently deleted every word in it,
  approved ones included. `recipient_id` and `giver_id` are `RESTRICT` too, so
  even a direct API call cannot hard-delete a person out from under a word.
  Someone invited by mistake, with no words, can still just be deleted.
  `segment` → `word` stays `CASCADE` on purpose: a segment is part of a word.

### 8.2 Pending words

A word reaches members only after an admin approves it, and that holds in
three places: the `word` row, its `segment` rows, and its audio object. A
member cannot select a pending word, cannot read its transcript, and cannot
mint a signed URL for its clip.

Editors and admins *can* select pending words — they have to, to review them —
so the app has to be deliberate about where they are shown. `fetchWords()`
defaults to `status: "reviewed"` and the review queue is the only caller that
asks for anything else. The feed and profile pages pass `"reviewed"`
explicitly, so a pastor browsing the feed sees exactly what the congregation
sees.

Two further judgement calls, both following the table rather than the summary
line:

- **Managing the member list** is editor *and* admin, so both can remove and
  restore — subject to the existing rule that an admin cannot touch a row that
  is already an editor or admin. You asked for restore "for editors"; I read
  that as naming the screen rather than a new permission tier, since removal
  is already open to both. Say the word if you want restore locked to editors.
- **Members cannot see `guest_word` at all.** The spec says nothing about
  guests is kept and guests never get accounts, so exposing guest emails to
  the congregation would be wrong.

Two guards I added that you did not ask for, because soft removal made them
reachable: you cannot remove yourself, and you cannot remove the last
remaining editor (that would leave nobody able to delete a word or grant the
editor role). Both raise from the database, not just the UI.

---

## 9. How the pieces fit

```
app/
  login/              Google button, email one-time link, dev-only password form
  not-invited/        Friendly rejection page for anyone not on the list
  auth/callback/      Lands both Google and the email link; routes rejects to /not-invited
  auth/dev-login/     404 unless NODE_ENV=development and ENABLE_DEV_LOGIN=true
  (app)/feed/         All approved words, search by name and date
  (app)/profile/[id]/ One member's words, newest or oldest first
  (app)/review/       Upload audio, add a word, fix names, edit transcripts, approve
  (app)/members/      Invite, set roles, name spellings
lib/
  supabase/server.ts  Session-scoped client — used for almost everything, so RLS applies
  supabase/client.ts  Browser client, publishable key only
  supabase/admin.ts   Service role; server-only; used in exactly two places
  audio.ts            Signed URLs, 1 hour, minted with the member's own session
  words.ts            The one joined query the feed and profiles share
scripts/
  seed.ts             Fake members, a meeting, 3 sample words, random passwords
  clean.ts            Undoes all of the above
supabase/migrations/  The schema, grants, RLS, triggers and bucket
```

Two details that matter if you change things:

- **Signed URLs are minted with the member's session, not the secret key**
  (`lib/audio.ts`). That means the storage policies in the migration are what
  decide who gets a playable link. If you switch to the admin client there,
  you silently lose that check.
- **The accepted audio formats are written down twice on purpose.**
  [`lib/audio-formats.ts`](lib/audio-formats.ts) and the bucket's
  `allowed_mime_types` must stay in step: the bucket enforces the rule, the
  shared constant drives the file picker and the error messages. `video/mp4`
  is on the list because WhatsApp voice notes are audio in an MP4 container.
  Non-standard spellings a browser might report (`audio/mp3`, `audio/m4a`)
  are normalised client-side rather than widened in the bucket, so each
  format has exactly one name there.
- **Approval rules live in three places on purpose.** `word_approval_guard`
  is the real gate; `approveWord` repeats the check so the reviewer gets a
  sentence instead of a Postgres error; the review page repeats it again to
  disable the button and say what is missing. If you add a condition, add it
  to all three — the trigger is the one that must not be skipped.
- **Audio uploads go straight from the browser to Supabase Storage**
  (`add-word-form.tsx`), not through a server action. A 45-minute recording
  would blow past the server action body limit, and the storage insert policy
  still restricts it to editors and admins.

---

## 10. Known gaps

- `guest_word` has no UI and nothing purges rows past `expires_at`. Phase 3.
- The feed fetches up to 500 words and sorts them in the app, because the sort
  key lives on the joined `meeting` row. Fine at roughly 500 words a year;
  revisit with a view or a denormalised date column if the archive grows.
- A word's audio is one pre-cut clip per word, uploaded by hand. Cutting a
  full meeting recording at marker timestamps is the Phase 1 worker's job.
- No tests. The role rules are the part most worth covering first.
