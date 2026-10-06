import Link from "next/link";

import { CHURCH_NAME } from "@/lib/church";

export const metadata = {
  title: "Privacy — GracePlace",
  description: `How ${CHURCH_NAME} stores and protects prophetic words recorded in its meetings.`,
};

const LAST_UPDATED = "6 October 2026";

/**
 * The church's contact address, from RESEND_REPLY_TO — the same mailbox a
 * guest reaches by replying to their email, so the two cannot drift apart.
 *
 * Read on the server, so it needs no NEXT_PUBLIC_ copy. The value may be
 * written "Name <address>", in which case only the address is used.
 */
function contactEmail(): string | null {
  const raw = process.env.RESEND_REPLY_TO?.trim();
  if (!raw) return null;
  const bracketed = /<([^>]+)>/.exec(raw);
  const address = (bracketed ? bracketed[1] : raw).trim();
  return address.includes("@") ? address : null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-ink">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  const email = contactEmail();
  const contact = email ? (
    <a href={`mailto:${email}`} className="font-medium text-brand underline underline-offset-2">
      {email}
    </a>
  ) : (
    <>a pastor</>
  );

  return (
    <main className="mx-auto max-w-2xl px-5 py-12">
      <header className="mb-10 space-y-2">
        <p className="text-sm text-muted">{CHURCH_NAME}</p>
        <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>
        <p className="text-[15px] leading-relaxed text-muted">
          This app keeps a record of the prophetic words given in our meetings,
          so the people they were given to can hear them again. This page
          explains, in plain language, what it stores, who can see it, and how
          to have something removed.
        </p>
      </header>

      <div className="space-y-10">
        <Section title="What we store">
          <p>
            <strong>About members:</strong> your name, your email address, and
            any other spellings of your name we have added to help the
            transcription get it right. Your email is how you sign in.
          </p>
          <p>
            <strong>About each word:</strong> a short audio clip of the word
            being given, a written transcript of it, who it was for, who gave
            it, and the date of the meeting.
          </p>
          <p>
            <strong>The full meeting recording</strong> is kept only on the
            computer of the person who prepares the words, and is deleted once
            the words have been reviewed, at the latest within 30 days. It is
            never uploaded to this app.
          </p>
        </Section>

        <Section title="Who can see it">
          <p>
            Only members can see anything here. There is no public sign-up:
            someone has to be added to the member list by a pastor before they
            can sign in at all.
          </p>
          <p>
            Members see a word only after a pastor has reviewed and approved it.
            Words given in meetings are shared within the church, so every
            member can read and listen to every approved word, not just their
            own.
          </p>
          <p>
            The pastors and the small team who prepare the words also see them
            before they are approved, so they can check the transcript.
          </p>
          <p>
            The audio is stored privately. Each time you press play, the app
            creates a link that stops working after an hour, so a copied link
            cannot be passed around.
          </p>
        </Section>

        <Section title="How words are transcribed">
          <p>
            Each audio clip is sent to OpenAI&apos;s transcription service to be
            turned into text, along with the list of members&apos; names so it
            spells them correctly. The full meeting recording is never sent;
            only the clip for each word.
          </p>
          <p>
            Every transcript is then read and corrected by a person before
            anyone else sees it.
          </p>
        </Section>

        <Section title="Guests">
          <p>
            If you are visiting and a word is given for you, we do not add you
            to the member list and you never get an account.
          </p>
          <p>
            Your word is emailed to you once, with the transcript and the audio
            clip. As soon as it has been sent, the clip, the transcript and your
            email address are deleted. If it cannot be sent — for example, if we
            never get your email address — it is deleted automatically seven
            days after it was prepared.
          </p>
          <p>Guest words are never visible to members.</p>
        </Section>

        <Section title="Having a word removed">
          <p>
            If you would like a word removed — your own, or one given to you —
            please contact the church at {contact}. Once it is deleted, the
            audio and the transcript are gone from the app for everyone.
          </p>
          <p>
            Removing someone from the member list stops them signing in, but
            does not delete the words they gave or received. Those are removed
            only when someone asks.
          </p>
          <p>
            Deleted information can remain for a short time in the routine
            backups our database provider keeps, until those backups expire.
          </p>
        </Section>

        <Section title="Services we use">
          <p>
            The app is hosted by Vercel. Member details, words and audio clips
            are stored with Supabase. Guest emails are sent through Resend.
            Transcription is done by OpenAI, as described above.
          </p>
        </Section>

        <Section title="Questions">
          <p>
            Anything else about how your information is handled, please contact
            the church at {contact}.
          </p>
        </Section>
      </div>

      <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-sm text-muted">
        <span>Last updated {LAST_UPDATED}</span>
        <Link href="/login" className="text-brand underline underline-offset-2">
          Back to sign in
        </Link>
      </footer>
    </main>
  );
}
