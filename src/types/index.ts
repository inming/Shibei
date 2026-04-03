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
}
