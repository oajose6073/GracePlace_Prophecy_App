export type PersonRole = "editor" | "admin" | "member";
export type MeetingFormat = "zoom" | "in-person" | "hybrid";
export type MeetingStatus = "scheduled" | "recorded" | "processing" | "complete";
export type WordStatus = "pending" | "reviewed";
/** Which path created a word. Used by the transcribe script's --replace-pending. */
export type WordSource = "script" | "manual" | "seed";
export type GuestSendStatus = "pending" | "sent" | "failed";

export type Person = {
  id: string;
  auth_user_id: string | null;
  name: string;
  email: string;
  role: PersonRole;
  name_spellings: string[];
  /** Set when an editor removes them. The row is kept so their words keep
      their recipient and giver; access is revoked in the database. */
  removed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Meeting = {
  id: string;
  date: string;
  format: MeetingFormat;
  status: MeetingStatus;
  recording_path: string | null;
  created_at: string;
  updated_at: string;
};

export type Word = {
  id: string;
  meeting_id: string;
  recipient_id: string | null;
  giver_id: string | null;
  status: WordStatus;
  source: WordSource;
  audio_clip_path: string | null;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Segment = {
  id: string;
  word_id: string;
  start_sec: number;
  end_sec: number | null;
  transcript: string;
  /** This segment's own clip. null for a segment typed in by a reviewer. */
  audio_clip_path: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export type GuestWord = {
  id: string;
  meeting_id: string;
  guest_email: string;
  audio_clip_path: string | null;
  transcript: string;
  send_status: GuestSendStatus;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

/** A word with everything a feed card needs, as returned by the joined select. */
export type WordWithRelations = Word & {
  meeting: Pick<Meeting, "id" | "date" | "format"> | null;
  recipient: Pick<Person, "id" | "name"> | null;
  giver: Pick<Person, "id" | "name"> | null;
  segment: Segment[];
};

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      person: Table<Person>;
      meeting: Table<Meeting>;
      word: Table<Word>;
      segment: Table<Segment>;
      guest_word: Table<GuestWord>;
    };
    Views: Record<string, never>;
    Functions: {
      claim_membership: {
        Args: Record<string, never>;
        Returns: boolean;
      };
    };
    Enums: {
      person_role: PersonRole;
      meeting_format: MeetingFormat;
      meeting_status: MeetingStatus;
      word_status: WordStatus;
      word_source: WordSource;
      guest_send_status: GuestSendStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};

export const ROLE_LABELS: Record<PersonRole, string> = {
  editor: "Editor",
  admin: "Admin (pastor)",
  member: "Member",
};

/** Editors and admins edit, review and approve (Roles and permissions table). */
export function canWrite(role: PersonRole | null | undefined): boolean {
  return role === "editor" || role === "admin";
}

/** Only editors delete words and audio. */
export function canDelete(role: PersonRole | null | undefined): boolean {
  return role === "editor";
}

/** Only editors assign or change the admin and editor roles. */
export function canAssignPrivilegedRoles(
  role: PersonRole | null | undefined,
): boolean {
  return role === "editor";
}
