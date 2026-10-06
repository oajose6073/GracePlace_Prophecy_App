import "server-only";

import { Resend } from "resend";

import { composeGuestEmail } from "./guest-email-content";

/**
 * Sending a guest their word.
 *
 * RESEND_API_KEY, RESEND_FROM and RESEND_REPLY_TO are read here and nowhere
 * else. None has a NEXT_PUBLIC_ prefix, and `import "server-only"` makes the
 * build fail if a client component ever reaches for this module. The wording
 * of the email lives in ./guest-email-content, which carries no guard so it
 * can be previewed from a script.
 *
 * RESEND_FROM is an env var on purpose: during the pilot it is Resend's test
 * sender, which only delivers to the account owner's own address. Pointing it
 * at an address on the church's domain later needs no code change.
 *
 * RESEND_REPLY_TO is the church's own mailbox. A guest who wants to reply
 * should reach a person, not a no-reply sender — so a missing value stops the
 * send rather than quietly posting a letter nobody can answer.
 */

/** Resend's documented ceiling is 40 MB per email, attachments included. */
const MAX_ATTACHMENT_BYTES = 38 * 1024 * 1024;

export type SendResult =
  | { ok: true; id: string | null }
  | { ok: false; error: string };

type Settings = { apiKey: string; from: string; replyTo: string };

function config(): Settings | { error: string } {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const replyTo = process.env.RESEND_REPLY_TO;

  if (!apiKey) {
    return { error: "RESEND_API_KEY is not set. Add it to .env.local (server-side only)." };
  }
  if (!from) {
    return {
      error:
        "RESEND_FROM is not set. Use Resend's test sender for now, or an address on the church's domain.",
    };
  }
  if (!replyTo) {
    return {
      error:
        "RESEND_REPLY_TO is not set. Add the church's Gmail address so a guest who replies reaches a person.",
    };
  }

  return { apiKey, from, replyTo };
}

export async function sendGuestWordEmail(options: {
  to: string;
  transcript: string;
  /** The meeting's YYYY-MM-DD, or null if it is somehow unknown. */
  meetingDate: string | null;
  clip: { filename: string; content: Buffer } | null;
}): Promise<SendResult> {
  const settings = config();
  if ("error" in settings) return { ok: false, error: settings.error };

  const { to, transcript, meetingDate, clip } = options;

  if (!to.includes("@")) {
    return { ok: false, error: "That guest has no valid email address yet." };
  }
  if (!transcript.trim()) {
    return { ok: false, error: "Add the transcript before sending." };
  }
  if (clip && clip.content.byteLength > MAX_ATTACHMENT_BYTES) {
    const mb = (clip.content.byteLength / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: `The clip is ${mb} MB, over Resend's 40 MB email limit. Trim it before sending.`,
    };
  }

  const { subject, text, html } = composeGuestEmail({ transcript, meetingDate });

  try {
    const resend = new Resend(settings.apiKey);
    const { data, error } = await resend.emails.send({
      from: settings.from,
      to,
      // Replies reach the church's mailbox, not the sending domain.
      replyTo: settings.replyTo,
      subject,
      // Both bodies: some mail clients, and some people, prefer plain text.
      text,
      html,
      attachments: clip
        ? [{ filename: clip.filename, content: clip.content }]
        : undefined,
    });

    if (error) {
      return { ok: false, error: `${error.name ?? "Resend"}: ${error.message}` };
    }
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Resend could not be reached.",
    };
  }
}
