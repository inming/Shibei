// LRU cache index for mobile snapshot storage.
//
// Why: phone sandbox fills up after a few hundred PDFs. Desktop keeps every
// snapshot forever; mobile must cap + evict LRU. See §7.2 of the mobile MVP
// design doc.
//
// Scope: this module tracks byte accounting, access timestamps, and performs
// on-disk eviction of `storage/{id}/snapshot.*` files. It does NOT touch the
// SQLite metadata — resources + highlights + comments live on in the DB even
// after their snapshot is evicted, so the user still sees titles/urls/tags
// and can re-download on demand.
//
// Persistence: `{base}/cache-index.json` written atomically via tmp+rename
// on every mutation (put/touch/evict/clear/set_limit). Volume is small
// (~100 bytes per entry) so we don't debounce for MVP.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::resource_dir;

pub const DEFAULT_LIMIT_BYTES: u64 = 1024 * 1024 * 1024; // 1000 MB
const INDEX_FILENAME: &str = "cache-index.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CacheEntry {
    pub resource_id: String,
    pub bytes: u64,
    pub last_access_ms: i64,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CacheStats {
    pub total_bytes: u64,
    pub limit_bytes: u64,
    pub entry_count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedIndex {
    version: u32,
    limit_bytes: u64,
    entries: Vec<CacheEntry>,
}

#[derive(Debug)]
pub struct CacheIndex {
    entries: BTreeMap<String, CacheEntry>,
    total_bytes: u64,
    limit_bytes: u64,
}

impl Default for CacheIndex {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
            total_bytes: 0,
            limit_bytes: DEFAULT_LIMIT_BYTES,
        }
    }
}

impl CacheIndex {
    /// Load from `{base}/cache-index.json`. Missing file → empty index.
    /// Corrupt JSON → empty index (logged, not propagated — we'd rather lose
    /// LRU history than brick the app).
    pub fn load(base: &Path) -> Self {
        let path = base.join(INDEX_FILENAME);
        let raw = match fs::read(&path) {
            Ok(r) => r,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Self::default(),
            Err(e) => {
                eprintln!("[cache] read cache-index.json failed: {e} — starting empty");
                return Self::default();
            }
        };
        let parsed: PersistedIndex = match serde_json::from_slice(&raw) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[cache] parse cache-index.json failed: {e} — starting empty");
                return Self::default();
            }
        };
        if parsed.version != SCHEMA_VERSION {
            eprintln!(
                "[cache] cache-index.json version {} != expected {} — starting empty",
                parsed.version, SCHEMA_VERSION
            );
            return Self::default();
        }
        let mut entries: BTreeMap<String, CacheEntry> = BTreeMap::new();
        let mut total: u64 = 0;
        for e in parsed.entries {
            total = total.saturating_add(e.bytes);
            entries.insert(e.resource_id.clone(), e);
        }
        Self {
            entries,
            total_bytes: total,
            limit_bytes: parsed.limit_bytes.max(1),
        }
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            total_bytes: self.total_bytes,
            limit_bytes: self.limit_bytes,
            entry_count: self.entries.len() as u64,
        }
    }

    pub fn list(&self) -> Vec<CacheEntry> {
        let mut out: Vec<CacheEntry> = self.entries.values().cloned().collect();
        // Most-recently-accessed first → UI lists "just opened" at top.
        out.sort_by(|a, b| b.last_access_ms.cmp(&a.last_access_ms));
        out
    }

    pub fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    pub fn cached_ids<I: IntoIterator<Item = String>>(&self, ids: I) -> Vec<String> {
        ids.into_iter()
            .filter(|id| self.entries.contains_key(id))
            .collect()
    }

    /// Record that a snapshot of `bytes` bytes was written to disk for `id`.
    /// If the entry exists, replaces its byte count (covers re-download).
    pub fn put(&mut self, id: &str, bytes: u64) {
        let now = now_ms();
        if let Some(existing) = self.entries.get_mut(id) {
            self.total_bytes = self
                .total_bytes
                .saturating_sub(existing.bytes)
                .saturating_add(bytes);
            existing.bytes = bytes;
            existing.last_access_ms = now;
        } else {
            self.total_bytes = self.total_bytes.saturating_add(bytes);
            self.entries.insert(
                id.to_string(),
                CacheEntry {
                    resource_id: id.to_string(),
                    bytes,
                    last_access_ms: now,
                    pinned: false,
                },
            );
        }
    }

    /// Bump last_access_ms for `id` if it's tracked. No-op otherwise (the
    /// snapshot file may still be on disk from a previous install — LRU only
    /// governs entries we know about; eviction will catch orphans by cleaning
    /// the whole `storage/{id}` dir).
    pub fn touch(&mut self, id: &str) {
        if let Some(e) = self.entries.get_mut(id) {
            e.last_access_ms = now_ms();
        }
    }

    pub fn set_pinned(&mut self, id: &str, pinned: bool) {
        if let Some(e) = self.entries.get_mut(id) {
            e.pinned = pinned;
        }
    }

    pub fn set_limit(&mut self, bytes: u64) {
        self.limit_bytes = bytes.max(1);
    }

    pub fn limit_bytes(&self) -> u64 {
        self.limit_bytes
    }

    /// Evict least-recently-used entries until total_bytes ≤ target.
    /// Skips pinned. Deletes `storage/{id}/snapshot.*` from disk. Returns the
    /// list of evicted ids so callers can emit events / clear body_text later.
    pub fn evict_until(&mut self, target: u64, base: &Path) -> Vec<String> {
        if self.total_bytes <= target {
            return Vec::new();
        }
        let mut order: Vec<(String, i64, bool)> = self
            .entries
            .values()
            .map(|e| (e.resource_id.clone(), e.last_access_ms, e.pinned))
            .collect();
        order.sort_by(|a, b| a.1.cmp(&b.1));

        let mut evicted: Vec<String> = Vec::new();
        for (id, _, pinned) in order {
            if self.total_bytes <= target {
                break;
            }
            if pinned {
                continue;
            }
            if let Some(entry) = self.entries.remove(&id) {
                self.total_bytes = self.total_bytes.saturating_sub(entry.bytes);
                let dir = resource_dir(base, &id);
                if dir.exists() {
                    // Best-effort: log + continue. If we fail to unlink now,
                    // the storage-layer's next `save_snapshot` will overwrite
                    // and LRU accounting stays consistent.
                    if let Err(e) = fs::remove_dir_all(&dir) {
                        eprintln!("[cache] evict remove_dir_all {}: {e}", dir.display());
                    }
                }
                evicted.push(id);
            }
        }
        evicted
    }

    /// Evict until we fit under the current limit. Convenience wrapper.
    pub fn evict_if_over_limit(&mut self, base: &Path) -> Vec<String> {
        self.evict_until(self.limit_bytes, base)
    }

    /// Wipe every tracked entry + its on-disk files. Used by the Settings →
    /// 数据 → 清空缓存 button.
    pub fn clear_all(&mut self, base: &Path) -> Vec<String> {
        let ids: Vec<String> = self.entries.keys().cloned().collect();
        for id in &ids {
            let dir = resource_dir(base, id);
            if dir.exists() {
                if let Err(e) = fs::remove_dir_all(&dir) {
                    eprintln!("[cache] clear_all remove_dir_all {}: {e}", dir.display());
                }
            }
        }
        self.entries.clear();
        self.total_bytes = 0;
        ids
    }

    pub fn remove(&mut self, id: &str, base: &Path) -> bool {
        if let Some(entry) = self.entries.remove(id) {
            self.total_bytes = self.total_bytes.saturating_sub(entry.bytes);
            let dir = resource_dir(base, id);
            if dir.exists() {
                let _ = fs::remove_dir_all(&dir);
            }
            true
        } else {
            false
        }
    }

    /// Atomic write: tmp file in the same dir + rename. Caller decides when
    /// to flush (after put/touch/evict). Returns io::Result so callers can
    /// log on failure without poisoning in-memory state.
    pub fn flush(&self, base: &Path) -> io::Result<()> {
        let entries: Vec<CacheEntry> = self.entries.values().cloned().collect();
        let doc = PersistedIndex {
            version: SCHEMA_VERSION,
            limit_bytes: self.limit_bytes,
            entries,
        };
        let json = serde_json::to_vec_pretty(&doc)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        fs::create_dir_all(base)?;
        let final_path = base.join(INDEX_FILENAME);
        let tmp_path: PathBuf = base.join(format!("{INDEX_FILENAME}.tmp"));
        fs::write(&tmp_path, &json)?;
        fs::rename(&tmp_path, &final_path)?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_snapshot(base: &Path, id: &str, bytes: usize, ext: &str) {
        let dir = resource_dir(base, id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("snapshot.{ext}")), vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn put_accumulates_total_bytes() {
        let mut idx = CacheIndex::default();
        idx.put("a", 100);
        idx.put("b", 200);
        assert_eq!(idx.stats().total_bytes, 300);
        assert_eq!(idx.stats().entry_count, 2);
    }

    #[test]
    fn put_same_id_replaces_byte_count() {
        let mut idx = CacheIndex::default();
        idx.put("a", 100);
        idx.put("a", 250);
        assert_eq!(idx.stats().total_bytes, 250);
        assert_eq!(idx.stats().entry_count, 1);
    }

    #[test]
    fn touch_updates_last_access_without_double_counting() {
        let mut idx = CacheIndex::default();
        idx.put("a", 100);
        let before = idx.entries.get("a").unwrap().last_access_ms;
        std::thread::sleep(std::time::Duration::from_millis(2));
        idx.touch("a");
        let after = idx.entries.get("a").unwrap().last_access_ms;
        assert!(after >= before);
        assert_eq!(idx.stats().total_bytes, 100);
    }

    #[test]
    fn touch_unknown_id_is_noop() {
        let mut idx = CacheIndex::default();
        idx.touch("ghost");
        assert_eq!(idx.stats().entry_count, 0);
    }

    #[test]
    fn evict_removes_oldest_first_until_target() {
        let tmp = tempfile::tempdir().unwrap();
        make_snapshot(tmp.path(), "a", 100, "html");
        make_snapshot(tmp.path(), "b", 200, "html");
        make_snapshot(tmp.path(), "c", 400, "pdf");

        let mut idx = CacheIndex::default();
        idx.put("a", 100);
        std::thread::sleep(std::time::Duration::from_millis(2));
        idx.put("b", 200);
        std::thread::sleep(std::time::Duration::from_millis(2));
        idx.put("c", 400);

        let evicted = idx.evict_until(400, tmp.path());
        assert_eq!(evicted, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(idx.stats().total_bytes, 400);
        assert!(!resource_dir(tmp.path(), "a").exists());
        assert!(!resource_dir(tmp.path(), "b").exists());
        assert!(resource_dir(tmp.path(), "c").exists());
    }

    #[test]
    fn evict_respects_pinned() {
        let tmp = tempfile::tempdir().unwrap();
        make_snapshot(tmp.path(), "pin", 100, "html");
        make_snapshot(tmp.path(), "cold", 200, "html");

        let mut idx = CacheIndex::default();
        idx.put("pin", 100);
        idx.set_pinned("pin", true);
        std::thread::sleep(std::time::Duration::from_millis(2));
        idx.put("cold", 200);

        // Target 0 bytes — should still keep pinned entry.
        let evicted = idx.evict_until(0, tmp.path());
        assert_eq!(evicted, vec!["cold".to_string()]);
        assert!(idx.contains("pin"));
        assert!(resource_dir(tmp.path(), "pin").exists());
    }

    #[test]
    fn flush_and_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let mut idx = CacheIndex::default();
        idx.put("a", 100);
        idx.put("b", 200);
        idx.set_limit(5_000);
        idx.flush(tmp.path()).unwrap();

        let reloaded = CacheIndex::load(tmp.path());
        assert_eq!(reloaded.stats().total_bytes, 300);
        assert_eq!(reloaded.stats().entry_count, 2);
        assert_eq!(reloaded.stats().limit_bytes, 5_000);
        assert!(reloaded.contains("a"));
        assert!(reloaded.contains("b"));
    }

    #[test]
    fn load_missing_file_returns_default() {
        let tmp = tempfile::tempdir().unwrap();
        let idx = CacheIndex::load(tmp.path());
        assert_eq!(idx.stats().entry_count, 0);
        assert_eq!(idx.stats().limit_bytes, DEFAULT_LIMIT_BYTES);
    }

    #[test]
    fn load_corrupt_json_falls_back_to_default() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(INDEX_FILENAME), b"{not json").unwrap();
        let idx = CacheIndex::load(tmp.path());
        assert_eq!(idx.stats().entry_count, 0);
        assert_eq!(idx.stats().limit_bytes, DEFAULT_LIMIT_BYTES);
    }

    #[test]
    fn load_mismatched_version_falls_back_to_default() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join(INDEX_FILENAME),
            br#"{"version":999,"limit_bytes":1,"entries":[]}"#,
        )
        .unwrap();
        let idx = CacheIndex::load(tmp.path());
        assert_eq!(idx.stats().limit_bytes, DEFAULT_LIMIT_BYTES);
    }

    #[test]
    fn clear_all_wipes_entries_and_files() {
        let tmp = tempfile::tempdir().unwrap();
        make_snapshot(tmp.path(), "a", 100, "html");
        make_snapshot(tmp.path(), "b", 200, "pdf");
        let mut idx = CacheIndex::default();
        idx.put("a", 100);
        idx.put("b", 200);

        let removed = idx.clear_all(tmp.path());
        assert_eq!(removed.len(), 2);
        assert_eq!(idx.stats().total_bytes, 0);
        assert!(!resource_dir(tmp.path(), "a").exists());
        assert!(!resource_dir(tmp.path(), "b").exists());
    }

    #[test]
    fn cached_ids_filters_set() {
        let mut idx = CacheIndex::default();
        idx.put("a", 10);
        idx.put("c", 30);
        let got = idx.cached_ids(vec!["a".into(), "b".into(), "c".into(), "d".into()]);
        assert_eq!(got, vec!["a".to_string(), "c".to_string()]);
    }

    #[test]
    fn evict_noop_when_under_target() {
        let tmp = tempfile::tempdir().unwrap();
        make_snapshot(tmp.path(), "a", 100, "html");
        let mut idx = CacheIndex::default();
        idx.put("a", 100);
        let evicted = idx.evict_until(1000, tmp.path());
        assert!(evicted.is_empty());
        assert!(idx.contains("a"));
    }

    #[test]
    fn set_limit_minimum_is_one() {
        let mut idx = CacheIndex::default();
        idx.set_limit(0);
        assert_eq!(idx.stats().limit_bytes, 1);
    }
}
