#!/usr/bin/env bash
# Round-trip verification for the shibei-pairing envelope.
# Encrypts a fixed plaintext via the shibei-pairing crate (Rust helper),
# decrypts via the shibei-pair-decrypt CLI, and diffs the result.
#
# Run from the repo root: scripts/test-pairing-roundtrip.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."

cd "$REPO_ROOT"

PIN="246810"
PLAIN='{"version":1,"endpoint":"https://s3.example.com","region":"us-east-1","bucket":"my-bucket","access_key":"AKIAEXAMPLE","secret_key":"SecretExampleKey"}'

# Build both crates up front so timings below only measure the round-trip.
cargo build --quiet -p shibei-pairing -p shibei-pair-decrypt

# Encrypt: run a one-shot Rust program via `cargo run` on a tiny helper.
# We avoid adding a separate binary by using `cargo test -q` on a named
# function that prints the envelope to stdout. Simpler: inline `rustc`
# a throwaway source file that links against the built rlib.
#
# Practical approach here: use cargo's example target via an env-var-fed
# payload. But adding an example just for this adds noise, so instead we
# invoke a small inline crate via `cargo run --manifest-path` on a temp
# dir we create on the fly.

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/Cargo.toml" <<EOF
[package]
name = "pairing-encrypt-oneshot"
version = "0.0.0"
edition = "2021"

[dependencies]
shibei-pairing = { path = "$REPO_ROOT/crates/shibei-pairing" }

[[bin]]
name = "encrypt-oneshot"
path = "main.rs"

[workspace]
EOF

cat > "$TMPDIR/main.rs" <<'EOF'
use std::io::Read;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pin = &args[1];
    let mut plain = String::new();
    std::io::stdin().read_to_string(&mut plain).unwrap();
    let env = shibei_pairing::encrypt_payload(pin, plain.as_bytes()).unwrap();
    println!("{env}");
}
EOF

ENVELOPE="$(printf '%s' "$PLAIN" | cargo run --quiet --manifest-path "$TMPDIR/Cargo.toml" -- "$PIN")"

DECRYPTED="$(printf '%s' "$ENVELOPE" | cargo run --quiet -p shibei-pair-decrypt -- --pin "$PIN")"

# serde_json reorders keys alphabetically; compare the parsed values.
EXPECTED="$(printf '%s' "$PLAIN"     | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))')"
ACTUAL="$(printf '%s'   "$DECRYPTED" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "FAIL: round-trip mismatch"
  echo "expected: $EXPECTED"
  echo "actual:   $ACTUAL"
  exit 1
fi

echo "OK: round-trip verified (pin=$PIN, envelope ${#ENVELOPE} bytes)"
