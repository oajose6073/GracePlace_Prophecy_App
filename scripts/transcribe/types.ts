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
  /** Guest words are Phase 3; these are skipped with a warning. */
  guest?: boolean;
  /** Marks the end of the last word. Carries no recipient. */
  end?: boolean;
  /** Free-text note for the reviewer. Not published. */
  note?: string;
};

/** A marker after validation, with names resolved to person ids. */
export type ResolvedMarker = {
  index: number;
  startSec: number;
  /** Undefined for the final clip, which runs to the end of the recording. */
  endSec?: number;
  recipientId: string | null;
  recipientName: string | null;
  giverId: string | null;
  giverName: string | null;
  addendum: boolean;
  note?: string;
};

export type PersonRow = {
  id: string;
  name: string;
  name_spellings: string[];
  removed_at: string | null;
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
};

export type RunSummary = {
  meetingDate: string;
  dryRun: boolean;
  wordsCreated: number;
  addendaAttached: number;
  guestsSkipped: number;
  clips: number;
  minutesTranscribed: number;
  estimatedCostUsd: number;
  outputDir: string;
};
