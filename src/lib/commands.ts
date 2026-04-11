import { invoke } from "@tauri-apps/api/core";
import type { Folder, Resource, Tag, Highlight, Comment, Anchor, SyncConfig, EncryptionStatus, AutoUnlockResult, DeletedResource, DeletedFolder, SearchResult, AnnotationCounts } from "@/types";

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

export function getFolder(id: string): Promise<Folder> {
  return invoke("cmd_get_folder", { id });
}

export function getFolderPath(folderId: string): Promise<Folder[]> {
  return invoke("cmd_get_folder_path", { folderId });
}

// ── Resources ──

export function listResources(
  folderId: string,
  sortBy?: "created_at" | "annotated_at",
  sortOrder?: "asc" | "desc",
  tagIds?: string[],
): Promise<Resource[]> {
  return invoke("cmd_list_resources", {
    folderId,
    sortBy: sortBy ?? "created_at",
    sortOrder: sortOrder ?? "desc",
    tagIds: tagIds ?? [],
  });
}

export function listAllResources(
  sortBy?: "created_at" | "annotated_at",
  sortOrder?: "asc" | "desc",
  tagIds?: string[],
): Promise<Resource[]> {
  return invoke("cmd_list_all_resources", {
    sortBy: sortBy ?? "created_at",
    sortOrder: sortOrder ?? "desc",
    tagIds: tagIds ?? [],
  });
}

export function searchResources(
  query: string,
  folderId: string | null,
  tagIds: string[],
  sortBy?: "created_at" | "annotated_at",
  sortOrder?: "asc" | "desc",
): Promise<SearchResult[]> {
  return invoke("cmd_search_resources", {
    query,
    folderId,
    tagIds,
    sortBy: sortBy ?? "created_at",
    sortOrder: sortOrder ?? "desc",
  });
}

export interface IndexStats {
  total: number;
  indexed: number;
  pending: number;
  ftsInitialized: boolean;
}

export function getIndexStats(): Promise<IndexStats> {
  return invoke("cmd_get_index_stats");
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

// ── Annotation Counts ──

export function getAnnotationCounts(resourceIds: string[]): Promise<Record<string, AnnotationCounts>> {
  return invoke("cmd_get_annotation_counts", { resourceIds });
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

export function updateHighlightColor(id: string, resourceId: string, color: string): Promise<Highlight> {
  return invoke("cmd_update_highlight_color", { id, resourceId, color });
}

export function deleteHighlight(id: string, resourceId: string): Promise<void> {
  return invoke("cmd_delete_highlight", { id, resourceId });
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

export function updateComment(id: string, content: string, resourceId: string): Promise<void> {
  return invoke("cmd_update_comment", { id, content, resourceId });
}

export function deleteComment(id: string, resourceId: string): Promise<void> {
  return invoke("cmd_delete_comment", { id, resourceId });
}

// ── Sync ──

export function syncNow(): Promise<string> {
  return invoke("cmd_sync_now");
}

export function forceCompact(): Promise<string> {
  return invoke("cmd_force_compact");
}

export interface OrphanItem {
  resource_id: string;
  size: number;
}

export interface OrphanScanResult {
  count: number;
  total_size: number;
  items: OrphanItem[];
}

export interface PurgeResult {
  deleted: number;
  freed_bytes: number;
}

export function listOrphanSnapshots(): Promise<OrphanScanResult> {
  return invoke("cmd_list_orphan_snapshots");
}

export function purgeOrphanSnapshots(): Promise<PurgeResult> {
  return invoke("cmd_purge_orphan_snapshots");
}

export function saveSyncConfig(
  endpoint: string, region: string, bucket: string,
  accessKey: string, secretKey: string,
): Promise<void> {
  return invoke("cmd_save_sync_config", { endpoint, region, bucket, accessKey, secretKey });
}

export function getSyncConfig(): Promise<SyncConfig> {
  return invoke("cmd_get_sync_config");
}

export function testS3Connection(
  endpoint: string, region: string, bucket: string,
  accessKey: string, secretKey: string,
): Promise<boolean> {
  return invoke("cmd_test_s3_connection", { endpoint, region, bucket, accessKey, secretKey });
}

export function downloadSnapshot(resourceId: string): Promise<boolean> {
  return invoke("cmd_download_snapshot", { resourceId });
}

export function getSnapshotStatus(resourceId: string): Promise<string> {
  return invoke("cmd_get_snapshot_status", { resourceId });
}

export function setSyncInterval(minutes: number): Promise<void> {
  return invoke("cmd_set_sync_interval", { minutes });
}

// ── Encryption ──

export function setupEncryption(password: string): Promise<void> {
  return invoke("cmd_setup_encryption", { password });
}

export function unlockEncryption(password: string): Promise<void> {
  return invoke("cmd_unlock_encryption", { password });
}

export function changeEncryptionPassword(oldPassword: string, newPassword: string): Promise<void> {
  return invoke("cmd_change_encryption_password", { oldPassword, newPassword });
}

export function getEncryptionStatus(): Promise<EncryptionStatus> {
  return invoke("cmd_get_encryption_status");
}

export function autoUnlockEncryption(): Promise<AutoUnlockResult> {
  return invoke("cmd_auto_unlock");
}

export function setRememberKey(remember: boolean): Promise<void> {
  return invoke("cmd_set_remember_key", { remember });
}

export function getRememberKey(): Promise<boolean> {
  return invoke("cmd_get_remember_key");
}

// ── Recycle Bin ──

export function listDeletedResources(): Promise<DeletedResource[]> {
  return invoke("cmd_list_deleted_resources");
}

export function listDeletedFolders(): Promise<DeletedFolder[]> {
  return invoke("cmd_list_deleted_folders");
}

export function restoreResource(id: string): Promise<Resource> {
  return invoke("cmd_restore_resource", { id });
}

export function restoreFolder(id: string): Promise<Folder> {
  return invoke("cmd_restore_folder", { id });
}

export function purgeResource(id: string): Promise<void> {
  return invoke("cmd_purge_resource", { id });
}

export function purgeFolder(id: string): Promise<void> {
  return invoke("cmd_purge_folder", { id });
}

export function purgeAllDeleted(): Promise<void> {
  return invoke("cmd_purge_all_deleted");
}

// ── Lock Screen ──

export function setupLockPin(pin: string): Promise<void> {
  return invoke("cmd_setup_lock_pin", { pin });
}

export function verifyLockPin(pin: string): Promise<boolean> {
  return invoke("cmd_verify_lock_pin", { pin });
}

export function getLockStatus(): Promise<{ enabled: boolean; timeout_minutes: number }> {
  return invoke("cmd_get_lock_status");
}

export function setLockTimeout(minutes: number): Promise<void> {
  return invoke("cmd_set_lock_timeout", { minutes });
}

export function disableLockPin(pin: string): Promise<void> {
  return invoke("cmd_disable_lock_pin", { pin });
}

// ── Debug ──

const DEBUG_ENABLED = import.meta.env.VITE_DEBUG === "1";

export async function debugLog(label: string, data?: unknown): Promise<void> {
  if (!DEBUG_ENABLED) return;
  const msg = data !== undefined ? `[${label}] ${JSON.stringify(data)}` : `[${label}]`;
  return invoke("cmd_debug_log", { msg });
}

// ── i18n Error Translation ──

import i18n from "@/i18n";

/**
 * Translate a backend error message. If the message is an i18n key (e.g. "error.wrongPassword"),
 * returns the translated string. If the key contains ": " (e.g. "error.keyGenFailed: details"),
 * translates the key part and appends the detail. Otherwise returns the message as-is.
 */
export function translateError(message: string): string {
  // Handle "key: detail" format from backend format!() calls
  const colonIdx = message.indexOf(": ");
  if (colonIdx > 0) {
    const key = message.substring(0, colonIdx);
    const detail = message.substring(colonIdx + 2);
    if (i18n.exists(key)) {
      return `${String(i18n.t(key as never))}: ${detail}`;
    }
  }
  if (i18n.exists(message)) {
    return String(i18n.t(message as never));
  }
  return message;
}
