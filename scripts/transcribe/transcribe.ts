import { createReadStream } from "node:fs";

import OpenAI from "openai";

/**
 * `gpt-transcribe` is OpenAI's recommended transcription model, and the only
 * one that supports `keywords` — a list of literal terms to bias towards,
 * which is exactly what the spec means by "member names passed as keyword
 * hints". `prompt` is for unstructured context, so names go in `keywords`.
 *
 * https://developers.openai.com/api/docs/guides/speech-to-text
 */
export const TRANSCRIPTION_MODEL = "gpt-transcribe";

/**
 * $0.0045 per minute of audio, per OpenAI's pricing page. Used only for the
 * estimate printed in the run summary.
 *
 * https://developers.openai.com/api/docs/pricing
 */
export const COST_PER_MINUTE_USD = 0.0045;

export function estimateCostUsd(totalSeconds: number): number {
  return (totalSeconds / 60) * COST_PER_MINUTE_USD;
}

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (client) return client;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. It belongs in .env.local and is only ever read by these scripts.",
    );
  }

  client = new OpenAI({ apiKey });
  return client;
}

export async function transcribeClip(options: {
  file: string;
  keywords: string[];
  /** Spoken language, to stop a short clip being mistaken for another one. */
  language?: string;
}): Promise<string> {
  const { file, keywords, language = "en" } = options;

  const response = await openai().audio.transcriptions.create({
    file: createReadStream(file),
    model: TRANSCRIPTION_MODEL,
    keywords,
    language,
    response_format: "json",
  });

  return (response.text ?? "").trim();
}
