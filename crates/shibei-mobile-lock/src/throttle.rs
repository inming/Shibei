//! Failed-attempt counter + lockout_until, persisted as JSON.
//!
//! Thresholds (spec §6 failure matrix):
//!   1-4 failures  → no lockout
//!   5, 6…         → 30 seconds
//!   10, 11…       → 5 minutes
//!   15 or more    → 30 minutes
//!
//! The counter is cumulative — stays incremented across app kills via
//! `preferences/security.json` persistence (spec §3.1). A successful unlock
//! resets it to zero.

use serde::{Deserialize, Serialize};

const TIER_1_FAILS: u32 = 5;
const TIER_2_FAILS: u32 = 10;
const TIER_3_FAILS: u32 = 15;
const TIER_1_SECS: i64 = 30;
const TIER_2_SECS: i64 = 5 * 60;
const TIER_3_SECS: i64 = 30 * 60;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ThrottleState {
    pub failed_attempts: u32,
    /// Unix epoch ms when the current lockout ends. 0 = not locked out.
    pub lockout_until_ms: i64,
}

impl ThrottleState {
    /// Seconds remaining in the current lockout. `<=0` means unlocked.
    pub fn remaining_secs(&self, now_ms: i64) -> i64 {
        if self.lockout_until_ms <= now_ms {
            0
        } else {
            (self.lockout_until_ms - now_ms + 999) / 1000
        }
    }

    /// Record a failed attempt. Bumps failed_attempts; if the new count is
    /// on a tier boundary, sets lockout_until to now + tier duration.
    pub fn on_failure(&mut self, now_ms: i64) {
        self.failed_attempts = self.failed_attempts.saturating_add(1);
        let dur_secs = match self.failed_attempts {
            n if n >= TIER_3_FAILS && n % TIER_1_FAILS == 0 => Some(TIER_3_SECS),
            n if n >= TIER_2_FAILS && n % TIER_1_FAILS == 0 => Some(TIER_2_SECS),
            n if n >= TIER_1_FAILS && n % TIER_1_FAILS == 0 => Some(TIER_1_SECS),
            _ => None,
        };
        if let Some(secs) = dur_secs {
            self.lockout_until_ms = now_ms + secs * 1000;
        }
    }

    /// Record a success: clear both counters.
    pub fn on_success(&mut self) {
        self.failed_attempts = 0;
        self.lockout_until_ms = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_state_not_locked() {
        let s = ThrottleState::default();
        assert_eq!(s.remaining_secs(1_000), 0);
    }

    #[test]
    fn fifth_failure_triggers_30s() {
        let mut s = ThrottleState::default();
        for _ in 0..4 {
            s.on_failure(1_000);
            assert_eq!(s.lockout_until_ms, 0);
        }
        s.on_failure(1_000);
        assert_eq!(s.failed_attempts, 5);
        assert_eq!(s.lockout_until_ms, 1_000 + 30 * 1000);
        assert_eq!(s.remaining_secs(1_000), 30);
    }

    #[test]
    fn tenth_failure_triggers_5min() {
        let mut s = ThrottleState::default();
        for _ in 0..10 {
            s.on_failure(1_000);
        }
        assert_eq!(s.failed_attempts, 10);
        assert_eq!(s.lockout_until_ms, 1_000 + 5 * 60 * 1000);
    }

    #[test]
    fn fifteenth_failure_triggers_30min() {
        let mut s = ThrottleState::default();
        for _ in 0..15 {
            s.on_failure(1_000);
        }
        assert_eq!(s.lockout_until_ms, 1_000 + 30 * 60 * 1000);
    }

    #[test]
    fn twentieth_failure_stays_at_30min() {
        let mut s = ThrottleState::default();
        for _ in 0..20 {
            s.on_failure(1_000);
        }
        // 20 % 5 == 0 and >= 15, so tier 3
        assert_eq!(s.lockout_until_ms, 1_000 + 30 * 60 * 1000);
    }

    #[test]
    fn success_resets_counters() {
        let mut s = ThrottleState::default();
        for _ in 0..6 {
            s.on_failure(1_000);
        }
        s.on_success();
        assert_eq!(s.failed_attempts, 0);
        assert_eq!(s.lockout_until_ms, 0);
    }

    #[test]
    fn remaining_secs_rounds_up() {
        let s = ThrottleState { failed_attempts: 5, lockout_until_ms: 2_001 };
        // now=1000, remaining = 1001ms → ceil to 2s
        assert_eq!(s.remaining_secs(1_000), 2);
    }

    #[test]
    fn serde_round_trip() {
        let s = ThrottleState { failed_attempts: 7, lockout_until_ms: 1_234_567_890 };
        let json = serde_json::to_string(&s).unwrap();
        let back: ThrottleState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.failed_attempts, 7);
        assert_eq!(back.lockout_until_ms, 1_234_567_890);
    }
}
