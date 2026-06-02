/**
 * Centralized event name constants — mirrors src-tauri/src/events.rs.
 * All Tauri event listeners must import from here; never use raw strings.
 *
 * Audit: `grep "listen(DataEvents\|listen(SyncEvents" src/` to find all subscribers.
 */

export const DataEvents = {
  RESOURCE_CHANGED: "data:resource-changed",
  FOLDER_CHANGED: "data:folder-changed",
  TAG_CHANGED: "data:tag-changed",
  ANNOTATION_CHANGED: "data:annotation-changed",
  QUESTION_CHANGED: "data:question-changed",
  QUESTION_LINK_CHANGED: "data:question-link-changed",
  QUESTION_NOTE_CHANGED: "data:question-note-changed",
  SYNC_COMPLETED: "data:sync-completed",
  CONFIG_CHANGED: "data:config-changed",
} as const;

export const SyncEvents = {
  STARTED: "sync-started",
  FAILED: "sync-failed",
  PROGRESS: "sync-progress",
} as const;

// ── Payload types ──

export interface ResourceChangedPayload {
  action: "created" | "updated" | "deleted" | "moved";
  resource_id?: string;
  folder_id?: string;
}

export interface FolderChangedPayload {
  action: "created" | "updated" | "deleted" | "moved" | "reordered";
  folder_id?: string;
  parent_id?: string;
}

export interface TagChangedPayload {
  action: "created" | "updated" | "deleted";
  tag_id?: string;
  resource_id?: string;
}

export interface AnnotationChangedPayload {
  action: "created" | "updated" | "deleted";
  resource_id: string;
}

export interface QuestionChangedPayload {
  action: "created" | "updated" | "archived" | "unarchived" | "deleted";
  question_id?: string;
}

export interface QuestionLinkChangedPayload {
  action: "linked" | "unlinked" | "reason-updated";
  question_id: string;
  /** Absent when the event was emitted from a question-level cascade (e.g. delete_question). */
  target_type?: "resource" | "highlight" | "comment";
  target_id?: string;
}

export interface QuestionNoteChangedPayload {
  action: "created" | "updated" | "deleted";
  question_id: string;
  note_id?: string;
}

export interface ConfigChangedPayload {
  scope: "sync" | "encryption" | "lock_screen";
}

export interface SyncFailedPayload {
  message: string;
}

export interface SyncProgressPayload {
  phase: "uploading" | "downloading";
  current: number;
  total: number;
}
