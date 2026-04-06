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

export interface ResourceWithTags extends Resource {
  tags: Tag[];
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
