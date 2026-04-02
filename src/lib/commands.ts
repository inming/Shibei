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

export function getFolderCounts(): Promise<Record<string, number>> {
  return invoke("cmd_get_folder_counts");
}

export function getNonLeafFolderIds(): Promise<string[]> {
  return invoke("cmd_get_non_leaf_folder_ids");
}

export function moveFolder(id: string, newParentId: string): Promise<void> {
  return invoke("cmd_move_folder", { id, newParentId });
}

export function reorderFolder(id: string, newSortOrder: number): Promise<void> {
  return invoke("cmd_reorder_folder", { id, newSortOrder });
}

// ── Resources ──

export function listResources(
  folderId: string,
  sortBy?: "created_at" | "annotated_at",
  sortOrder?: "asc" | "desc",
): Promise<Resource[]> {
  return invoke("cmd_list_resources", {
    folderId,
    sortBy: sortBy ?? "created_at",
    sortOrder: sortOrder ?? "desc",
  });
}

export function getResource(id: string): Promise<Resource> {
  return invoke("cmd_get_resource", { id });
}

export function deleteResource(id: string): Promise<void> {
  return invoke("cmd_delete_resource", { id });
}

export function moveResource(id: string, newFolderId: string): Promise<void> {
  return invoke("cmd_move_resource", { id, newFolderId });
}

export async function updateResource(id: string, title: string, description: string | null): Promise<void> {
  return invoke("cmd_update_resource", { id, title, description });
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

export function addTagToResource(resourceId: string, tagId: string): Promise<void> {
  return invoke("cmd_add_tag_to_resource", { resourceId, tagId });
}

export function removeTagFromResource(resourceId: string, tagId: string): Promise<void> {
  return invoke("cmd_remove_tag_from_resource", { resourceId, tagId });
}

export function updateTag(id: string, name: string, color: string): Promise<void> {
  return invoke("cmd_update_tag", { id, name, color });
}

export function getResourcesByTag(tagId: string): Promise<Resource[]> {
  return invoke("cmd_get_resources_by_tag", { tagId });
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
