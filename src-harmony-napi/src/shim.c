// Hand-rolled HarmonyOS NAPI module shim.
//
// Phase 0 verified that napi-rs 2.x does not function under HarmonyOS NEXT:
// napi_register_module_v1 runs but ArkTS sees "export objects of native so
// is undefined". As a fallback we wrap each exported Rust function by hand
// using the standard HarmonyOS N-API entry points.
//
// At .so load time, __attribute__((constructor)) runs register_shibei_core,
// which hands a napi_module struct (with nm_modname = "shibei_core") to
// napi_module_register. When ArkTS imports 'libshibei_core.so', HarmonyOS
// resolves the module by name and calls init(env, exports), which populates
// `exports` with `hello` and `add` properties bound to the wrap functions
// below. Each wrap function marshals arguments to/from the Rust symbols
// exported by src/lib.rs.

#include "napi/native_api.h"
#include <stddef.h>
#include <string.h>

// Rust-side extern "C" functions (src/lib.rs)
extern const char* shibei_hello(void);
extern int shibei_add(int a, int b);

static napi_value hello_wrap(napi_env env, napi_callback_info info) {
    (void)info;
    const char* msg = shibei_hello();
    napi_value result = NULL;
    napi_create_string_utf8(env, msg, strlen(msg), &result);
    return result;
}

static napi_value add_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2] = {NULL, NULL};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int a = 0, b = 0;
    if (argc >= 2) {
        napi_get_value_int32(env, args[0], &a);
        napi_get_value_int32(env, args[1], &b);
    }

    int sum = shibei_add(a, b);
    napi_value result = NULL;
    napi_create_int32(env, sum, &result);
    return result;
}

static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor props[] = {
        {"hello", NULL, hello_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"add",   NULL, add_wrap,   NULL, NULL, NULL, napi_default, NULL},
    };
    napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
    return exports;
}

static napi_module shibei_module = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = NULL,
    .nm_register_func = init,
    .nm_modname = "shibei_core",
    .nm_priv = NULL,
    .reserved = {NULL, NULL, NULL, NULL},
};

// Non-static + (used, constructor) so `-Wl,-u,register_shibei_core` in
// build.rs keeps the whole object at link time.
__attribute__((used, constructor))
void register_shibei_core(void) {
    napi_module_register(&shibei_module);
}
