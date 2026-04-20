fn main() {
    napi_build::setup();

    // HarmonyOS targets need a small C shim to register the module via
    // napi_module_register at .so load time (see src/shim.c for why).
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.ends_with("-ohos") {
        cc::Build::new().file("src/shim.c").compile("shibei_shim");
        // Force the linker to keep the shim's constructor — LTO + dead-code
        // elimination would otherwise drop the whole shim object because no
        // Rust code calls it explicitly.
        println!("cargo:rustc-link-arg=-Wl,-u,register_shibei_core");
    }
}
