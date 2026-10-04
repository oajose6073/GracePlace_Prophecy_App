/**
 * The one place the accepted audio formats are written down.
 *
 * This list must stay in step with `allowed_mime_types` on the `word-audio`
 * bucket — see supabase/migrations/20261004000500_audio_mime_types.sql. The
 * bucket is what actually enforces it; this is so the file picker offers the
 * right files and the reviewer gets a sentence instead of a storage error.
 *
 * No "server-only" guard here: the upload form is a client component.
 */
export const ALLOWED_AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  // An audio-only recording in an MP4 container. WhatsApp voice notes and
  // several phone recorders report this.
  "video/mp4",
] as const;

/** 100 MB, matching the bucket's file_size_limit. */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

/**
 * Extensions are listed alongside the MIME types because Windows and Android
 * often hand the picker a file with no usable type at all.
 */
export const AUDIO_ACCEPT_ATTRIBUTE = [
  ...ALLOWED_AUDIO_MIME_TYPES,
  ".mp3",
  ".m4a",
  ".wav",
  ".webm",
  ".ogg",
  ".mp4",
].join(",");

/** Fallback when the browser reports no type at all. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
};

/**
 * Non-standard spellings browsers still emit for formats already on the list.
 * Normalising here keeps the bucket's allow-list to one name per format.
 */
const ALIASES: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/m4a": "audio/mp4",
  "audio/x-mp4": "audio/mp4",
  "audio/vnd.wave": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-pn-wav": "audio/wav",
  "audio/vorbis": "audio/ogg",
  "application/ogg": "audio/ogg",
};

function isAllowed(type: string): boolean {
  return (ALLOWED_AUDIO_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * The content type to upload with, or null if the file is not an accepted
 * format. Resolution order: the browser's type, then a known alias for it,
 * then the file extension.
 */
export function resolveAudioType(file: File): string | null {
  const reported = file.type.toLowerCase().split(";")[0].trim();

  if (isAllowed(reported)) return reported;

  const alias = ALIASES[reported];
  if (alias && isAllowed(alias)) return alias;

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const byExtension = TYPE_BY_EXTENSION[ext];
  if (byExtension && isAllowed(byExtension)) return byExtension;

  return null;
}

export function describeAllowedFormats(): string {
  return "MP3, M4A, WAV, WebM, OGG or MP4";
}
