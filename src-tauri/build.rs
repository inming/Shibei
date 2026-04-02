use std::path::Path;
use std::process::Command;

fn main() {
    let annotator_js = Path::new("src/annotator.js");
    let annotator_ts = Path::new("../src/annotator/annotator.ts");

    // Rebuild annotator.js from TypeScript if missing or outdated
    let needs_build = if annotator_js.exists() {
        // Rebuild if TS source is newer than compiled JS
        let js_modified = annotator_js.metadata().and_then(|m| m.modified()).ok();
        let ts_modified = annotator_ts.metadata().and_then(|m| m.modified()).ok();
        match (js_modified, ts_modified) {
            (Some(js_t), Some(ts_t)) => ts_t > js_t,
            _ => true,
        }
    } else {
        true
    };

    if needs_build {
        let status = Command::new("npm")
            .args(["run", "build:annotator"])
            .current_dir("..")
            .status()
            .expect("failed to run npm run build:annotator");
        assert!(status.success(), "npm run build:annotator failed");
    }

    // Tell Cargo to rerun if TS source changes
    println!("cargo:rerun-if-changed=../src/annotator/annotator.ts");

    tauri_build::build()
}
