fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.ends_with("-ohos") {
        let ndk = std::env::var("OHOS_NDK_HOME")
            .expect("OHOS_NDK_HOME must point to the HarmonyOS NDK root");
        let sysroot_include = format!("{ndk}/sysroot/usr/include");

        cc::Build::new()
            .file("src/shim.c")
            .include(&sysroot_include)
            .compile("shibei_shim");

        // Pull the shim's constructor in despite LTO / dead-code elimination
        // (nothing in Rust references it).
        println!("cargo:rustc-link-arg=-Wl,-u,register_shibei_core");

        // Link against HarmonyOS's NAPI runtime for napi_* symbols.
        println!("cargo:rustc-link-lib=ace_napi.z");
    }
}
