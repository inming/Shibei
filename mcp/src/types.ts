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
  matchedBody?: boolean;
}

export interface ResourceWithTags extends Resource {
  tags: Tag[];
  /** Absolute path to the snapshot file on disk (for audio: the file to transcribe). */
  abs_path?: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Highlight {
  id: string;
  resource_id: string;
  text_content: string;
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

export interface FolderNode {
  id: string;
  name: string;
  children: FolderNode[];
}

export interface AnnotationsResponse {
  highlights: Highlight[];
  comments: Comment[];
}

export interface ContentResponse {
  content: string;
  total_length: number;
  has_more: boolean;
}

export interface Question {
  id: string;
  title: string;
  description: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuestionLink {
  id: string;
  question_id: string;
  target_type: "resource" | "highlight" | "comment";
  target_id: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

/** A link with its target pre-resolved to the parent resource + a snippet, so
 *  the stage-summary gets everything in one round-trip. Matches the backend's
 *  `/api/questions/{id}/links/resolved`. */
export interface ResolvedQuestionLink {
  link: QuestionLink;
  resource: Resource | null;
  snippet: string | null;
  highlight_id: string | null;
  highlight_color: string | null;
  anchor: unknown | null;
}
