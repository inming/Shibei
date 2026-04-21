/// Centralized event name constants for Tauri emit.
/// Frontend mirrors these in `src/lib/events.ts`.
///
/// Audit: `grep "emit_event\|DATA_" src-tauri/src/` to find all emit sites.
// Domain data events
pub const DATA_RESOURCE_CHANGED: &str = "data:resource-changed";
pub const DATA_FOLDER_CHANGED: &str = "data:folder-changed";
pub const DATA_TAG_CHANGED: &str = "data:tag-changed";
pub const DATA_ANNOTATION_CHANGED: &str = "data:annotation-changed";
pub const DATA_SYNC_COMPLETED: &str = "data:sync-completed";
pub const DATA_CONFIG_CHANGED: &str = "data:config-changed";

// Sync status events (UI-only, not data events)
pub const SYNC_STARTED: &str = "sync-started";
pub const SYNC_FAILED: &str = "sync-failed";
pub const SYNC_PROGRESS: &str = "sync-progress";
