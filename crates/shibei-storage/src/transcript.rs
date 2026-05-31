//! Audio transcript persistence: `storage/{id}/transcript.json`.
//!
//! Transcripts are produced by an external AI agent through the MCP
//! `set_transcript` tool (Shibei does no speech-to-text itself). The
//! concatenated segment text feeds `plain_text` / FTS so audio becomes
//! searchable, and the per-segment timestamps drive the reader's transcript
//! view (click-to-seek, karaoke follow) and transcript-anchored highlights.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{resource_dir, StorageError};

pub const TRANSCRIPT_VERSION: u32 = 1;

/// A contiguous span of transcribed speech with start/end offsets in seconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A full transcript for one audio resource.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transcript {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub segments: Vec<Segment>,
}

impl Transcript {
    pub fn new(language: Option<String>, segments: Vec<Segment>) -> Self {
        Self {
            version: TRANSCRIPT_VERSION,
            language,
            segments,
        }
    }

    /// Concatenate non-empty segment texts into a single plain-text body for
    /// full-text search.
    pub fn to_plain_text(&self) -> String {
        self.segments
            .iter()
            .map(|s| s.text.trim())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn transcript_path(base: &Path, resource_id: &str) -> PathBuf {
    resource_dir(base, resource_id).join("transcript.json")
}

/// Write `transcript.json` for a resource, creating its storage dir if needed.
pub fn save_transcript(
    base: &Path,
    resource_id: &str,
    transcript: &Transcript,
) -> Result<(), StorageError> {
    std::fs::create_dir_all(resource_dir(base, resource_id))?;
    let json = serde_json::to_vec_pretty(transcript)
        .map_err(|e| StorageError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
    std::fs::write(transcript_path(base, resource_id), json)?;
    Ok(())
}

/// Read `transcript.json` for a resource, or None if absent/unparseable.
pub fn load_transcript(base: &Path, resource_id: &str) -> Option<Transcript> {
    let data = std::fs::read(transcript_path(base, resource_id)).ok()?;
    serde_json::from_slice(&data).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_plain_text() {
        let dir = tempfile::tempdir().unwrap();
        let t = Transcript::new(
            Some("en".to_string()),
            vec![
                Segment { start: 0.0, end: 1.5, text: "  Hello  ".to_string() },
                Segment { start: 1.5, end: 3.0, text: "world".to_string() },
                Segment { start: 3.0, end: 3.1, text: "   ".to_string() },
            ],
        );
        assert_eq!(t.to_plain_text(), "Hello\nworld");

        save_transcript(dir.path(), "r1", &t).unwrap();
        let loaded = load_transcript(dir.path(), "r1").unwrap();
        assert_eq!(loaded.version, TRANSCRIPT_VERSION);
        assert_eq!(loaded.language.as_deref(), Some("en"));
        assert_eq!(loaded.segments.len(), 3);
        assert_eq!(loaded.segments[1].text, "world");
    }

    #[test]
    fn load_missing_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_transcript(dir.path(), "nope").is_none());
    }
}
