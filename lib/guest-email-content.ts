/**
 * The words of the guest email, separate from the sending of it.
 *
 * No `import "server-only"` here, and nothing secret: this is pure string
 * building, so it can be previewed and tested from a plain script. The module
 * that actually talks to Resend — lib/guest-email.ts — carries the guard and
 * reads the API key.
 */
import { CHURCH_NAME, formatDateForPeople } from "./church";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type GuestEmailContent = {
  subject: string;
  text: string;
  html: string;
};

export function composeGuestEmail(options: {
  transcript: string;
  /** The meeting's YYYY-MM-DD, or null if it is somehow unknown. */
  meetingDate: string | null;
}): GuestEmailContent {
  const { transcript, meetingDate } = options;
  const when = formatDateForPeople(meetingDate);

  // The first line says who is writing and when, because a guest may have
  // visited once months ago and have no idea what this is.
  const intro = when
    ? `At ${CHURCH_NAME}'s meeting on ${when}, a word was given for you. The transcript is below and the recording is attached.`
    : `At a recent ${CHURCH_NAME} meeting, a word was given for you. The transcript is below and the recording is attached.`;

  const outro =
    "This is the only copy we send. We do not keep a record of it afterwards, so please save anything you would like to keep. If you would like to talk about it, just reply to this email.";

  const subject = when
    ? `A word for you from ${CHURCH_NAME}'s meeting on ${when}`
    : `A word for you from ${CHURCH_NAME}`;

  const paragraphs = transcript
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const text = [
    intro,
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    outro,
    "",
    "Blessings,",
    CHURCH_NAME,
  ].join("\n");

  const html = [
    '<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#1c1917;max-width:34em">',
    `<p style="margin:0 0 1.5em">${escapeHtml(intro)}</p>`,
    ...paragraphs.map(
      (p) => `<p style="margin:0 0 1em;white-space:pre-wrap">${escapeHtml(p)}</p>`,
    ),
    `<p style="margin:1.5em 0 0.5em;font-size:14px;color:#78716c">${escapeHtml(outro)}</p>`,
    `<p style="margin:0;font-size:14px;color:#78716c">Blessings,<br />${escapeHtml(CHURCH_NAME)}</p>`,
    "</div>",
  ].join("");

  return { subject, text, html };
}
