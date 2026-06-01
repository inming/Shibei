/** Special folder ID representing "all resources across all folders". */
export const ALL_RESOURCES_ID = "__all__";

/** System-preset inbox folder that receives newly-clipped resources. Not editable/deletable. */
export const INBOX_FOLDER_ID = "__inbox__";

export interface Folder {
  id: string;
  name: string;
  parent_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Resource {
  id: string;
  title: string;
  url: string;
  domain: string | null;
  author: string | null;
  description: string | null;
  folder_id: string;
  resource_type: string;
  file_path: string;
  created_at: string;
  captured_at: string;
  selection_meta: string | null;
  /** Timeliness of the content itself (e.g. publication date), as YYYY-MM-DD.
   *  Null until backfilled via the edit dialog. Distinct from created_at. */
  content_time: string | null;
}

export interface SearchResult extends Resource {
  matchedBody: boolean;
  matchFields: string[];
  snippet: string | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface TagWithCount {
  id: string;
  name: string;
  color: string;
  count: number;
}

export interface TextPosition {
  start: number;
  end: number;
}

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface HtmlAnchor {
  text_position: TextPosition;
  text_quote: TextQuote;
}

export interface PdfAnchor {
  type: "pdf";
  page: number;
  charIndex: number;
  length: number;
  textQuote: TextQuote;
}

// Audio highlight: a time range [start, end] in seconds (start == end for a
// point marker). When created from a transcript (Phase B) the optional
// charIndex/length/textQuote fields locate the selection in the transcript
// plain_text for re-anchoring; pure timeline markers omit them.
export interface AudioAnchor {
  type: "audio";
  start: number;
  end: number;
  charIndex?: number;
  length?: number;
  textQuote?: TextQuote;
}

// Anchor is opaque JSON — backend stores without interpreting.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Anchor = HtmlAnchor | PdfAnchor | AudioAnchor | Record<string, any>;

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

// Audio transcript (transcript.json), written by an external agent via the MCP
// set_transcript tool. Drives the reader's transcript view and full-text search.
export interface Transcript {
  version: number;
  language?: string | null;
  segments: TranscriptSegment[];
}

export interface Highlight {
  id: string;
  resource_id: string;
  text_content: string;
  anchor: Anchor;
  color: string;
  created_at: string;
}

export interface Comment {
  id: string;
  highlight_id: string | null;
  resource_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface SyncConfig {
  endpoint: string;
  region: string;
  bucket: string;
  has_credentials: boolean;
  last_sync_at: string;
  sync_interval: number; // minutes, 0 = disabled
}

export interface EncryptionStatus {
  enabled: boolean;
  unlocked: boolean;
  remember_key: boolean;
}

export type AutoUnlockResult =
  | "unlocked"
  | "unlocked_unverified"
  | "no_stored_key"
  | "keychain_error"
  | "key_mismatch";

export interface AnnotationCounts {
  highlights: number;
}

export interface DeletedResource {
  id: string;
  title: string;
  url: string;
  domain: string | null;
  folder_id: string;
  deleted_at: string;
}

export interface DeletedFolder {
  id: string;
  name: string;
  parent_id: string;
  deleted_at: string;
}

// ── Questions (research focus areas with polymorphic links) ──

export type QuestionStatus = "active" | "archived";

export type QuestionTargetType = "resource" | "highlight" | "comment";

export interface Question {
  id: string;
  title: string;
  description: string | null;
  status: QuestionStatus;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuestionLink {
  id: string;
  question_id: string;
  target_type: QuestionTargetType;
  target_id: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}
