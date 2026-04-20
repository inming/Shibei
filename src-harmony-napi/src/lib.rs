#![deny(clippy::all)]

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    format!("hello from rust, os={}, arch={}", std::env::consts::OS, std::env::consts::ARCH)
}

#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
