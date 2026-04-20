// HarmonyOS NAPI module registration shim.
//
// napi-rs emits `napi_register_module_v1(env, exports) -> exports` following
// the Node.js convention. HarmonyOS's NAPI runtime instead expects a module
// descriptor registered via `napi_module_register` from a library constructor.
//
// This file provides the constructor + descriptor; `nm_register_func` points
// directly at napi-rs's generated entry, so all `#[napi]` exports become
// properties on the module's exports object at load time.
//
// The module name must be the .so filename minus `lib` prefix and `.so`
// suffix — i.e. libshibei_core.so -> "shibei_core" — to match how ArkTS
// resolves the import specifier.

#include <stddef.h>

typedef void* napi_env;
typedef void* napi_value;

typedef struct napi_module {
    int nm_version;
    unsigned int nm_flags;
    const char* nm_filename;
    napi_value (*nm_register_func)(napi_env env, napi_value exports);
    const char* nm_modname;
    void* nm_priv;
    void* reserved[4];
} napi_module;

extern void napi_module_register(napi_module* mod);
extern napi_value napi_register_module_v1(napi_env env, napi_value exports);

static napi_module shibei_module = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = NULL,
    .nm_register_func = napi_register_module_v1,
    .nm_modname = "shibei_core",
    .nm_priv = NULL,
    .reserved = {NULL, NULL, NULL, NULL},
};

// Non-static so build.rs can reference it via `-Wl,-u,register_shibei_core`,
// which forces the linker to pull this object out of the static archive
// (otherwise the whole file would be garbage-collected since nothing in
// Rust code references it directly).
__attribute__((used, constructor))
void register_shibei_core(void) {
    napi_module_register(&shibei_module);
}
