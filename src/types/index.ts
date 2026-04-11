/** Special folder ID representing "all resources across all folders". */
export const ALL_RESOURCES_ID = "__all__";

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

export interface TextPosition {
  start: number;
  end: number;
}

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface Anchor {
  text_position: TextPosition;
  text_quote: TextQuote;
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
