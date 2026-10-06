/** The markers file an operator hands to the script. */
export type MarkersFile = {
  meeting: {
    /** YYYY-MM-DD. */
    date: string;
    format: "zoom" | "in-person" | "hybrid";
  };
  /**
   * Path to the local recording. Resolved against the working directory
   * first, then against the markers file's own folder.
   */
  recording: string;
  markers: RawMarker[];
};

export type RawMarker = {
  /** The console marker this came from, when the source is the database. */
  clientId?: string | null;
  /** "HH:MM:SS(.mmm)", "MM:SS", or a plain number of seconds. */
  at: string | number;
  /**
   * Who received the word. An explicit null means "to be confirmed" and is
   * published with no recipient; a name that matches nobody is an error.
   */
  recipient?: string | null;
  giver?: string | null;
  /** Attaches a further segment to this recipient's earlier word. */
  addendum?: boolean;
  /** Guest words become guest_word rows, emailed once and then deleted. */
  guest?: boolean;
  /** Only on a guest marker. Blank is fine - it is added in review. */
  guestEmail?: string | null;
  /** Only on a guest marker. How the operator remembered who it was. */
  guestLabel?: string | null;
  /** Set once that guest word was emailed, discarded or expired. */
  guestSentAt?: string | null;
  /** Marks the end of the last word. Carries no recipient. */
  end?: boolean;
  /** Free-text note for the reviewer. Not published. */
  note?: string;
};

/** A marker after validation, with names resolved to person ids. */
export type ResolvedMarker = {
  index: number;
  clientId: string | null;
  startSec: number;
  /** Undefined for the final clip, which runs to the end of the recording. */
  endSec?: number;
  recipientId: string | null;
  recipientName: string | null;
  giverId: string | null;
  giverName: string | null;
  addendum: boolean;
  /** A guest word: emailed to the guest, never published to members. */
  isGuest: boolean;
  guestEmail: string | null;
  guestLabel: string | null;
  guestSentAt: string | null;
  note?: string;
};

export type PersonRow = {
  id: string;
  name: string;
  name_spellings: string[];
  removed_at: string | null;
  is_congregation: boolean;
};

export type ClipResult = {
  marker: ResolvedMarker;
  clipPath: string;
  durationSec: number;
  transcript: string;
  /** Only set on a real run. */
  wordId?: string;
  storagePath?: string;
  attachedToWordId?: string;
  guestWordId?: string;
};

export type RunSummary = {
  meetingDate: string;
  dryRun: boolean;
  wordsCreated: number;
  addendaAttached: number;
  guestWordsCreated: number;
  clips: number;
  minutesTranscribed: number;
  estimatedCostUsd: number;
  outputDir: string;
};
