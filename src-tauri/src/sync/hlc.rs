use std::fmt;
use std::str::FromStr;
use std::sync::Mutex;

use chrono::Utc;

/// Hybrid Logical Clock timestamp.
///
/// Serialized as `"{wall_time_ms:013}-{counter:04}-{device_id}"` so that
/// lexicographic string comparison equals chronological order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hlc {
    pub wall_time_ms: i64,
    pub counter: u32,
    pub device_id: String,
}

impl Hlc {
    pub fn new(wall_time_ms: i64, counter: u32, device_id: impl Into<String>) -> Self {
        Self {
            wall_time_ms,
            counter,
            device_id: device_id.into(),
        }
    }
}

impl fmt::Display for Hlc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:013}-{:04}-{}",
            self.wall_time_ms, self.counter, self.device_id
        )
    }
}

/// Error returned when parsing an HLC string fails.
#[derive(Debug)]
pub struct ParseHlcError(String);

impl fmt::Display for ParseHlcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid HLC string: {}", self.0)
    }
}

impl std::error::Error for ParseHlcError {}

impl FromStr for Hlc {
    type Err = ParseHlcError;

    /// Parse a string of the form `"{wall_ms:013}-{counter:04}-{device_id}"`.
    ///
    /// The device_id may itself contain `-` characters (e.g. UUID v4), so we
    /// split on the first two `-`-separated numeric fields only.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        // Split into at most 3 parts: wall_ms, counter, rest-as-device_id
        let mut parts = s.splitn(3, '-');
        let wall_str = parts
            .next()
            .ok_or_else(|| ParseHlcError(s.to_string()))?;
        let counter_str = parts
            .next()
            .ok_or_else(|| ParseHlcError(s.to_string()))?;
        let device_id = parts
            .next()
            .ok_or_else(|| ParseHlcError(s.to_string()))?;

        let wall_time_ms = wall_str
            .parse::<i64>()
            .map_err(|_| ParseHlcError(s.to_string()))?;
        let counter = counter_str
            .parse::<u32>()
            .map_err(|_| ParseHlcError(s.to_string()))?;

        Ok(Hlc {
            wall_time_ms,
            counter,
            device_id: device_id.to_string(),
        })
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Thread-safe Hybrid Logical Clock.
pub struct HlcClock {
    last: Mutex<Hlc>,
    device_id: String,
}

impl HlcClock {
    pub fn new(device_id: String) -> Self {
        Self {
            last: Mutex::new(Hlc::new(0, 0, device_id.clone())),
            device_id,
        }
    }

    /// Generate a new HLC timestamp for a local event.
    pub fn tick(&self) -> Hlc {
        let mut last = self.last.lock().expect("HlcClock mutex poisoned");
        let wall = now_ms().max(last.wall_time_ms);
        let counter = if wall == last.wall_time_ms {
            last.counter + 1
        } else {
            0
        };
        let hlc = Hlc::new(wall, counter, self.device_id.clone());
        *last = hlc.clone();
        hlc
    }

    /// Merge with a remote HLC (receive event).
    pub fn receive(&self, remote: &Hlc) -> Hlc {
        let mut last = self.last.lock().expect("HlcClock mutex poisoned");
        let wall = now_ms().max(last.wall_time_ms).max(remote.wall_time_ms);
        let counter = if wall == last.wall_time_ms && wall == remote.wall_time_ms {
            last.counter.max(remote.counter) + 1
        } else if wall == last.wall_time_ms {
            last.counter + 1
        } else if wall == remote.wall_time_ms {
            remote.counter + 1
        } else {
            0
        };
        let hlc = Hlc::new(wall, counter, self.device_id.clone());
        *last = hlc.clone();
        hlc
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hlc_serialize_format() {
        let hlc = Hlc::new(1_711_987_200_000, 3, "abc-123");
        assert_eq!(hlc.to_string(), "1711987200000-0003-abc-123");
    }

    #[test]
    fn test_hlc_parse_roundtrip() {
        let original = Hlc::new(1_711_987_200_000, 3, "abc-123");
        let serialized = original.to_string();
        let parsed: Hlc = serialized.parse().expect("parse should succeed");
        assert_eq!(parsed.wall_time_ms, original.wall_time_ms);
        assert_eq!(parsed.counter, original.counter);
        assert_eq!(parsed.device_id, original.device_id);
    }

    #[test]
    fn test_hlc_lexicographic_order() {
        // Earlier wall_time should sort before later wall_time
        let earlier = Hlc::new(1_000_000_000_000, 0, "dev-1");
        let later = Hlc::new(1_000_000_000_001, 0, "dev-1");
        assert!(earlier.to_string() < later.to_string());

        // Same wall_time: lower counter sorts first
        let low_counter = Hlc::new(1_000_000_000_000, 1, "dev-1");
        let high_counter = Hlc::new(1_000_000_000_000, 2, "dev-1");
        assert!(low_counter.to_string() < high_counter.to_string());
    }

    #[test]
    fn test_hlc_clock_tick_advances() {
        let clock = HlcClock::new("test-device".to_string());
        let t1 = clock.tick();
        let t2 = clock.tick();
        // t2 must be strictly after t1 in lexicographic order
        assert!(t2.to_string() > t1.to_string());
        // wall times should be >= t1 wall time
        assert!(t2.wall_time_ms >= t1.wall_time_ms);
    }

    #[test]
    fn test_hlc_clock_receive_remote() {
        let clock = HlcClock::new("local-device".to_string());
        // A remote timestamp far in the future
        let remote = Hlc::new(9_999_999_999_999, 0, "remote-device");
        let result = clock.receive(&remote);
        // The resulting wall_time must advance to (at least) the remote wall_time
        assert!(result.wall_time_ms >= remote.wall_time_ms);
        assert_eq!(result.device_id, "local-device");
        // Counter should be remote.counter + 1 when wall == remote.wall_time_ms
        assert!(result.counter > remote.counter);
    }
}
