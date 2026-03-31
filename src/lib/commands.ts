import { invoke } from "@tauri-apps/api/core";
import type { Folder, Resource, Tag, Highlight, Comment, Anchor } from "@/types";

// ── Folders ──

export function listFolders(parentId: string): Promise<Folder[]> {
  return invoke("cmd_list_folders", { parentId });
}

export function createFolder(name: string, parentId: string): Promise<Folder> {
  return invoke("cmd_create_folder", { name, parentId });
}

export function renameFolder(id: string, name: string): Promise<void> {
  return invoke("cmd_rename_folder", { id, name });
}

export function deleteFolder(id: string): Promise<string[]> {
  return invoke("cmd_delete_folder", { id });
}

export function moveFolder(id: string, newParentId: string): Promise<void> {
  return invoke("cmd_move_folder", { id, newParentId });
}

// ── Resources ──

export function listResources(folderId: string): Promise<Resource[]> {
  return invoke("cmd_list_resources", { folderId });
}

export function getResource(id: string): Promise<Resource> {
  return invoke("cmd_get_resource", { id });
}

export function deleteResource(id: string): Promise<void> {
  return invoke("cmd_delete_resource", { id });
}

// ── Tags ──

export function listTags(): Promise<Tag[]> {
  return invoke("cmd_list_tags");
}

export function createTag(name: string, color: string): Promise<Tag> {
  return invoke("cmd_create_tag", { name, color });
}

export function deleteTag(id: string): Promise<void> {
  return invoke("cmd_delete_tag", { id });
}

export function getTagsForResource(resourceId: string): Promise<Tag[]> {
  return invoke("cmd_get_tags_for_resource", { resourceId });
}

// ── Highlights ──

export function getHighlights(resourceId: string): Promise<Highlight[]> {
  return invoke("cmd_get_highlights", { resourceId });
}

export function createHighlight(
  resourceId: string,
  textContent: string,
  anchor: Anchor,
  color: string,
): Promise<Highlight> {
  return invoke("cmd_create_highlight", { resourceId, textContent, anchor, color });
}

export function deleteHighlight(id: string): Promise<void> {
  return invoke("cmd_delete_highlight", { id });
}

// ── Comments ──

export function getComments(resourceId: string): Promise<Comment[]> {
  return invoke("cmd_get_comments", { resourceId });
}

export function createComment(
  resourceId: string,
  highlightId: string | null,
  content: string,
): Promise<Comment> {
  return invoke("cmd_create_comment", { resourceId, highlightId, content });
}

export function updateComment(id: string, content: string): Promise<void> {
  return invoke("cmd_update_comment", { id, content });
}

export function deleteComment(id: string): Promise<void> {
  return invoke("cmd_delete_comment", { id });
}
