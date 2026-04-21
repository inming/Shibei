//! Developer CLI for decrypting a Shibei pairing envelope.
//!
//! Mirrors what the HarmonyOS mobile client does after scanning the QR:
//! take (pin, envelope-json) → plain JSON payload.
//!
//! Not shipped to end users. Used for round-trip verification against the
//! desktop `cmd_generate_pairing_payload` command and as a reference
//! implementation for future mobile ports.

use std::io::{self, Read};
use std::process::ExitCode;

use clap::Parser;
use shibei_pairing::decrypt_payload;

#[derive(Parser, Debug)]
#[command(
    name = "shibei-pair-decrypt",
    about = "Decrypt a Shibei pairing envelope (dev tool)",
    long_about = None,
)]
struct Cli {
    /// 6-digit PIN displayed beside the QR code.
    #[arg(long)]
    pin: String,

    /// Envelope JSON string. If omitted, read from stdin.
    #[arg(long)]
    payload: Option<String>,

    /// Pretty-print the decrypted JSON.
    #[arg(long, default_value_t = false)]
    pretty: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let envelope = match cli.payload {
        Some(p) => p,
        None => {
            let mut buf = String::new();
            if let Err(e) = io::stdin().read_to_string(&mut buf) {
                eprintln!("read stdin: {e}");
                return ExitCode::FAILURE;
            }
            buf.trim().to_string()
        }
    };

    if envelope.is_empty() {
        eprintln!("empty envelope");
        return ExitCode::FAILURE;
    }

    let plain_bytes = match decrypt_payload(&cli.pin, &envelope) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("decrypt failed: {e}");
            return ExitCode::FAILURE;
        }
    };

    let value: serde_json::Value = match serde_json::from_slice(&plain_bytes) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("decrypted payload is not valid JSON: {e}");
            return ExitCode::FAILURE;
        }
    };

    let out = if cli.pretty {
        serde_json::to_string_pretty(&value)
    } else {
        serde_json::to_string(&value)
    };

    match out {
        Ok(s) => {
            println!("{s}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("serialize output: {e}");
            ExitCode::FAILURE
        }
    }
}
