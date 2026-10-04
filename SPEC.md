# Prophecy Capture App — Spec & Workflow

Oct 1, 2026 · @Olamilekan

## Overview

The app records prophetic words given in church meetings, tags each word to its recipient as it is spoken, and publishes the reviewed audio and transcript to a church-wide feed and to each member's profile. It replaces the current manual process of transcribing in Otter.ai and copying into a Google Doc.

Decisions agreed with leadership:

- Words given in meetings are public within the church: every member can read every member's word.
- Each word appears in two places: a general feed and the recipient's profile, with both audio and transcript.
- Pastors (admins) can create, edit and approve; members can only read; only editors can delete.
- Guest words are emailed to the guest, then deleted. Nothing about guests is kept.
- Sign-in is single sign-on (Google), invite-only, with no public sign-up.

Meetings are hybrid: some people join on Zoom, others are in the room.

## Roles and permissions

Three signed-in roles, plus guests who never get an account.

| Action | Editor | Admin (pastors) | Member | Guest |
| --- | --- | --- | --- | --- |
| Read all member words (feed and profiles) | Yes | Yes | Yes | No |
| Play audio and read transcripts | Yes | Yes | Yes | Own word, by email only |
| Run the operator console | Yes | Yes | No | No |
| Edit, review and approve transcripts | Yes | Yes | No | No |
| Manage the member list | Yes | Yes | No | No |
| Delete words and audio | Yes | No | No | No |

Appoint at least two editors, so a removal request never waits on one person.

## End-to-end workflow

A word is tagged live, transcribed automatically, and reaches members only after an admin approves it. Guest words are emailed once and then deleted.

&#91;embedded content: workflow · meeting to published word\]

Before each meeting, the member list must be current, so the operator's name buttons and the transcription name hints are right. After a word is published, an editor is the only person who can remove it.

## Pages and screens

Five screens cover the whole app.

| Screen | Who uses it | What it does |
| --- | --- | --- |
| Feed | Everyone signed in | All approved words, newest meeting first. Each card: recipient, giver, date, audio player, transcript. Search by name and date. |
| Member profile | Everyone signed in | The same cards filtered to one person, oldest to newest option for revisiting past words. |
| Operator console | Editor, admin | Used live in the meeting. Big name buttons, a Guest button, "next recipient", "add to previous word", "to be confirmed". Each tap drops a timestamp marker. |
| Review queue | Editor, admin | Each word's transcript next to its audio. Adjust start and end, fix names, assign unconfirmed recipients, add guest emails, approve. |
| Members | Editor, admin | Invite members, set roles, add spelling variants of names to help transcription. |

The operator console must work on a phone or tablet, because the operator may be in the room rather than at a desk.

## Data model

Five tables. A word is made of one or more segments, so an addendum given later in the meeting attaches to the same word.

| Table | Key fields | Notes |
| --- | --- | --- |
| `person` | id, name, email, role (editor, admin, member), name\_spellings | Members only. Guests are never stored here. |
| `meeting` | id, date, format (zoom, in-person, hybrid), status | The full meeting recording is deleted once all clips are cut and approved. |
| `word` | id, meeting\_id, recipient\_id, giver\_id, status (pending, reviewed), audio\_clip\_path | recipient\_id is empty while "to be confirmed". |
| `segment` | id, word\_id, start\_sec, end\_sec, transcript | One per marker. Addenda add a segment to an existing word. |
| `guest_word` | id, meeting\_id, guest\_email, audio\_clip\_path, transcript, send\_status, expires\_at | Temporary. Deleted on successful send, or 7 days after creation regardless. |

Permissions are enforced in the database (row-level security), not just hidden in the interface: members can only select, admins can insert and update, and only editors can delete.

## Tech stack and tools

Next.js on Vercel for the app, Supabase for database, sign-in and audio storage, a small Python worker for cutting and transcribing, and Resend for guest emails.

| Layer | Tool | Why this one |
| --- | --- | --- |
| Front end | Next.js (React) + Tailwind, hosted on Vercel | One codebase for feed, profiles, console and review. Deploys from GitHub. |
| Database | Supabase Postgres with row-level security | Roles enforced in the database, so a bug in the interface can't expose delete. |
| Sign-in | Supabase Auth: Google sign-in + email one-time link | Single sign-on as agreed, with a fallback for members without Google accounts. |
| Audio storage | Supabase Storage, private bucket, signed URLs | Only signed-in members can play clips. Links expire, so shared links stop working. |
| Audio capture | Zoom recording on the in-room laptop + USB conference mic | One audio source for both online and in-person speakers. |
| Processing worker | Python + `ffmpeg`, on AWS Lambda (container image); run locally during the pilot | Cuts clips at markers and calls transcription. Lambda only runs when a meeting is uploaded. |
| Transcription | OpenAI `gpt-transcribe` API, with member names passed as keyword hints | Cheap, accurate, accepts name hints. Fallback: self-hosted `faster-whisper` (free, slower, audio stays local). |
| Guest email | Resend (Amazon SES as an alternative) | Simple API, free tier far above guest volume. |
| Google Doc export (optional) | Google Docs API | Only if leadership still wants a Doc; regenerate it from the app, never edit it by hand. |

How the recording reaches the app: after the meeting, an admin uploads the Zoom audio file in the review queue. The console records the moment the operator taps "Recording started", so marker times line up with the file. Automatic pickup from Zoom cloud recordings can come later.

## Costs

Running costs are about US$1/month during the pilot and about US$26/month in production, almost all of it the Supabase Pro plan. One-time costs are mainly a conference mic. Prices are in US dollars unless marked CAD.

Assumed volume: 4 meetings a month, about 45 minutes of spoken words each (180 minutes a month), around 5 guest emails a month. The May 8 meeting had 10 words in 30 minutes.

**One-time**

| Item | Cost | Notes |
| --- | --- | --- |
| USB conference mic or speakerphone | \~CA$100–250 (approximate) | The single biggest factor in transcription quality. |
| Domain name | \~CA$15–25 per year (approximate) | Optional. Needed for a church-branded address and for sending email from the church's domain. |
| Build time | Your time | No software licences to buy. |

**Monthly running**

| Item | Pilot | Production | Basis |
| --- | --- | --- | --- |
| Supabase | $0 (Free) | $25 (Pro) | Free: 1 GB storage, pauses after 1 week idle. Pro: 100 GB storage, no pause. [source](https://livemy.app/blog/supabase-pricing) |
| Transcription (`gpt-transcribe`) | \~$0.81 | \~$0.81 | 180 min × $0.0045/min. [source](https://costgoat.com/pricing/openai-transcription) |
| Guest email (Resend) | $0 | $0 | Free tier covers 3,000 emails/month. [source](https://www.buildmvpfast.com/api-costs/email) |
| Vercel hosting | $0 | $0 | Hobby tier is enough at this traffic (approximate, not checked). |
| AWS Lambda worker | $0 | \~$0 | A few minutes of compute a month falls within the free allowance (approximate, not checked). |
| Zoom | $0 extra | $0 extra | Assumes the church's existing Zoom account. |
| **Total** | **\~$1** | **\~$26 (\~CA$35)** |  |

Why Pro in production: clips at 64 kbps mono are about 0.5 MB per minute, so 180 minutes a month adds about 1 GB a year. That fills the Free plan's 1 GB within a year. The 1-week pause also means a member opening the app after a quiet stretch could hit an error.

Cheapest alternative: self-hosted `faster-whisper` instead of the OpenAI API saves the \~$0.81/month but needs a machine to run it on. Not worth it at this volume unless keeping audio off third-party servers matters to leadership.

## Build plan

Four phases, each usable on its own, so leadership sees results after phase 1 instead of waiting for the whole app.

1. **Phase 1 — Transcribe and split (local script).** Python script: takes a recording plus a list of markers, cuts clips with `ffmpeg`, transcribes with name hints, outputs one entry per word. Test on the May 8 recording.
   - Done when: the 10 May 8 words come out correctly split, with names right after review.
2. **Phase 2 — App core.** Supabase project, tables and row-level security, Google sign-in, feed and profile pages, review queue with manual upload.
   - Done when: two pastors and a few members sign in, an admin approves a word, members can play it but not edit it.
3. **Phase 3 — Operator console and guests.** Live console with markers, "next recipient", "add to previous", "to be confirmed". Guest flow with Resend and auto-deletion.
   - Done when: a real meeting runs end to end, including one guest email that deletes itself after sending.
4. **Phase 4 — Polish.** Move the worker to Lambda, optional Google Doc export, search, automatic pickup of Zoom cloud recordings, upgrade Supabase to Pro.
   - Done when: nobody has to touch a script after a meeting.

## Open questions and risks

- [ ] Recording consent: will meetings open with a short announcement that they are recorded and transcribed?
- [ ] Who are the editors? At least two people, named before launch.
- [ ] Is the Google Doc still wanted, or is the app the only place to read words?
- [ ] Does the church's Zoom plan allow recording on the in-room laptop, and does it run past 40 minutes?
- [ ] Is reviewing every meeting realistic for the pastors, or should a dedicated reviewer role exist?

Risks:

- **Audio quality.** A poor room mic will make every later step harder. Test the mic on one real meeting before building phase 2.
- **Late taps.** The operator will sometimes tap a name late. The review screen must let the reviewer drag a clip's start time back.
- **Permanence.** A searchable archive lasts longer than a word spoken in a room. Members may re-read words years later, which is the point, but leadership should know deletion is the only undo.
- **Single developer.** If you're the only person who understands the system, document the setup so someone else can keep it running.
