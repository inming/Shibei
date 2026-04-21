// GENERATED — do not edit by hand.
// Run `cargo run -p shibei-napi-codegen` after editing commands.rs.

#include "napi/native_api.h"
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Rust-owned heap string; pair every returning pointer with a free.
extern void shibei_ffi_free_cstring(char* p);

// ── Rust FFI entry points (see generated/bindings.rs) ─────────────
extern char* shibei_ffi_init_app(const char* data_dir);
extern bool shibei_ffi_is_initialized(void);
extern bool shibei_ffi_has_saved_config(void);
extern bool shibei_ffi_is_unlocked(void);
extern void shibei_ffi_lock_vault(void);
extern char* shibei_ffi_decrypt_pairing_payload(const char* pin, const char* envelope_json);
extern char* shibei_ffi_set_s3_config(const char* config_json);
extern void shibei_ffi_set_e2ee_password(const char* password, void* ctx);
extern void shibei_ffi_sync_metadata(void* ctx);
extern void* shibei_ffi_subscribe_sync_progress(void* ctx);
extern void shibei_ffi_subscribe_sync_progress_unsubscribe(void* token);
extern char* shibei_ffi_list_folders(void);
extern char* shibei_ffi_list_resources(const char* folder_id, const char* tag_ids_json, const char* sort_json);
extern char* shibei_ffi_search_resources(const char* query, const char* tag_ids_json);
extern char* shibei_ffi_list_tags(void);
extern char* shibei_ffi_get_resource(const char* id);
extern char* shibei_ffi_get_resource_summary(const char* id, int32_t max_chars);
extern char* shibei_ffi_hello(void);
extern int32_t shibei_ffi_add(int32_t a, int32_t b);
extern char* shibei_ffi_s3_smoke_test(const char* endpoint, const char* region, const char* bucket, const char* access_key, const char* secret_key);
extern void shibei_ffi_echo_async(const char* text, void* ctx);
extern void* shibei_ffi_on_tick(int64_t interval_ms, void* ctx);
extern void shibei_ffi_on_tick_unsubscribe(void* token);

// C callbacks invoked from Rust worker threads.
void shibei_async_resolve(void* ctx, int ok, const char* payload);
void shibei_event_emit_i64(void* ctx, int64_t payload);
void shibei_event_emit_string(void* ctx, const char* payload);

// ── Shared async plumbing ─────────────────────────────────────────
typedef struct {
    napi_threadsafe_function tsfn;
    napi_deferred deferred;
    char* payload;   // strdup'd by shibei_async_resolve, freed by completion cb
    int ok;
} AsyncCtx;

// Called by Rust from a tokio worker thread.
void shibei_async_resolve(void* ctx_ptr, int ok, const char* payload) {
    AsyncCtx* ctx = (AsyncCtx*)ctx_ptr;
    ctx->ok = ok;
    ctx->payload = payload ? strdup(payload) : NULL;
    napi_call_threadsafe_function(ctx->tsfn, ctx, napi_tsfn_nonblocking);
}

static void async_complete_cb(napi_env env, napi_value js_cb, void* ctx_ptr, void* data) {
    (void)js_cb; (void)ctx_ptr;
    AsyncCtx* ctx = (AsyncCtx*)data;
    napi_value value = NULL;
    napi_create_string_utf8(env, ctx->payload ? ctx->payload : "", NAPI_AUTO_LENGTH, &value);
    if (ctx->ok) napi_resolve_deferred(env, ctx->deferred, value);
    else         napi_reject_deferred(env, ctx->deferred, value);
    if (ctx->payload) free(ctx->payload);
    napi_release_threadsafe_function(ctx->tsfn, napi_tsfn_release);
    free(ctx);
}

// ── Shared event plumbing (i64 + string payloads) ────────────────
typedef struct {
    napi_threadsafe_function tsfn;
    void* token;  // opaque Rust subscription handle
} EventCtx;

typedef struct { int64_t value; } I64Payload;

// Called by Rust worker thread to fire a single i64 event.
void shibei_event_emit_i64(void* ctx_ptr, int64_t payload) {
    EventCtx* ctx = (EventCtx*)ctx_ptr;
    I64Payload* p = (I64Payload*)malloc(sizeof(I64Payload));
    p->value = payload;
    napi_call_threadsafe_function(ctx->tsfn, p, napi_tsfn_nonblocking);
}

static void event_i64_cb(napi_env env, napi_value js_cb, void* ctx_ptr, void* data) {
    (void)ctx_ptr;
    I64Payload* p = (I64Payload*)data;
    napi_value v = NULL;
    napi_create_int64(env, p->value, &v);
    napi_value undef = NULL; napi_get_undefined(env, &undef);
    napi_value ret = NULL;
    napi_call_function(env, undef, js_cb, 1, &v, &ret);
    free(p);
}

// Called by Rust worker thread to fire a single string event. `payload` is
// Rust-owned for the duration of this call; we strdup before returning so the
// Rust side can free its CString immediately.
void shibei_event_emit_string(void* ctx_ptr, const char* payload) {
    EventCtx* ctx = (EventCtx*)ctx_ptr;
    char* copy = payload ? strdup(payload) : NULL;
    napi_call_threadsafe_function(ctx->tsfn, copy, napi_tsfn_nonblocking);
}

static void event_string_cb(napi_env env, napi_value js_cb, void* ctx_ptr, void* data) {
    (void)ctx_ptr;
    char* s = (char*)data;
    napi_value v = NULL;
    napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &v);
    napi_value undef = NULL; napi_get_undefined(env, &undef);
    napi_value ret = NULL;
    napi_call_function(env, undef, js_cb, 1, &v, &ret);
    if (s) free(s);
}

// ── Per-command NAPI wrappers ─────────────────────────────────────
static napi_value subscribe_sync_progress_unsubscribe_wrap(napi_env env, napi_callback_info info);
static napi_value on_tick_unsubscribe_wrap(napi_env env, napi_callback_info info);

static napi_value init_app_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_data_dir[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_data_dir, sizeof(buf_data_dir), &len); }
    napi_value result = NULL;
    char* ret = shibei_ffi_init_app(buf_data_dir);
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value is_initialized_wrap(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;
    bool ret = shibei_ffi_is_initialized();
    napi_get_boolean(env, ret, &result);
    return result;
}

static napi_value has_saved_config_wrap(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;
    bool ret = shibei_ffi_has_saved_config();
    napi_get_boolean(env, ret, &result);
    return result;
}

static napi_value is_unlocked_wrap(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;
    bool ret = shibei_ffi_is_unlocked();
    napi_get_boolean(env, ret, &result);
    return result;
}

static napi_value lock_vault_wrap(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;
    shibei_ffi_lock_vault();
    napi_get_undefined(env, &result);
    return result;
}

static napi_value decrypt_pairing_payload_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_pin[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_pin, sizeof(buf_pin), &len); }
    char buf_envelope_json[4096] = {0};
    if (1 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[1], buf_envelope_json, sizeof(buf_envelope_json), &len); }
    napi_value result = NULL;
    char* ret = shibei_ffi_decrypt_pairing_payload(buf_pin, buf_envelope_json);
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value set_s3_config_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_config_json[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_config_json, sizeof(buf_config_json), &len); }
    napi_value result = NULL;
    char* ret = shibei_ffi_set_s3_config(buf_config_json);
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value set_e2ee_password_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_password[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_password, sizeof(buf_password), &len); }
    AsyncCtx* ctx = (AsyncCtx*)calloc(1, sizeof(AsyncCtx));
    napi_value promise = NULL;
    napi_create_promise(env, &ctx->deferred, &promise);
    napi_value res_name = NULL;
    napi_create_string_utf8(env, "setE2eePassword_tsfn", NAPI_AUTO_LENGTH, &res_name);
    napi_create_threadsafe_function(env, NULL, NULL, res_name, 0, 1, NULL, NULL, NULL, async_complete_cb, &ctx->tsfn);
    shibei_ffi_set_e2ee_password(buf_password, ctx);
    return promise;
}

static napi_value sync_metadata_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value* args = NULL;
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    AsyncCtx* ctx = (AsyncCtx*)calloc(1, sizeof(AsyncCtx));
    napi_value promise = NULL;
    napi_create_promise(env, &ctx->deferred, &promise);
    napi_value res_name = NULL;
    napi_create_string_utf8(env, "syncMetadata_tsfn", NAPI_AUTO_LENGTH, &res_name);
    napi_create_threadsafe_function(env, NULL, NULL, res_name, 0, 1, NULL, NULL, NULL, async_complete_cb, &ctx->tsfn);
    shibei_ffi_sync_metadata(ctx);
    return promise;
}

static napi_value subscribe_sync_progress_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    EventCtx* ctx = (EventCtx*)calloc(1, sizeof(EventCtx));
    napi_value res_name = NULL;
    napi_create_string_utf8(env, "subscribeSyncProgress_tsfn", NAPI_AUTO_LENGTH, &res_name);
    napi_create_threadsafe_function(env, args[0], NULL, res_name, 0, 1, NULL, NULL, NULL, event_string_cb, &ctx->tsfn);
    ctx->token = shibei_ffi_subscribe_sync_progress(ctx);
    // Return a JS fn that unsubscribes when invoked.
    napi_value unsubscribe = NULL;
    napi_create_function(env, "unsubscribe", NAPI_AUTO_LENGTH, subscribe_sync_progress_unsubscribe_wrap, ctx, &unsubscribe);
    return unsubscribe;
}

static napi_value subscribe_sync_progress_unsubscribe_wrap(napi_env env, napi_callback_info info) {
    void* data = NULL;
    napi_get_cb_info(env, info, NULL, NULL, NULL, &data);
    EventCtx* ctx = (EventCtx*)data;
    if (ctx && ctx->token) {
        shibei_ffi_subscribe_sync_progress_unsubscribe(ctx->token);
        ctx->token = NULL;
        napi_release_threadsafe_function(ctx->tsfn, napi_tsfn_release);
    }
    napi_value undef = NULL; napi_get_undefined(env, &undef); return undef;
}

static napi_value list_folders_wrap(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;
    char* ret = shibei_ffi_list_folders();
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value list_resources_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_folder_id[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_folder_id, sizeof(buf_folder_id), &len); }
    char buf_tag_ids_json[4096] = {0};
    if (1 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[1], buf_tag_ids_json, sizeof(buf_tag_ids_json), &len); }
    char buf_sort_json[4096] = {0};
    if (2 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[2], buf_sort_json, sizeof(buf_sort_json), &len); }
    napi_value result = NULL;
    char* ret = shibei_ffi_list_resources(buf_folder_id, buf_tag_ids_json, buf_sort_json);
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value search_resources_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_query[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_query, sizeof(buf_query), &len); }
    char buf_tag_ids_json[4096] = {0};
    if (1 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[1], buf_tag_ids_json, sizeof(buf_tag_ids_json), &len); }
    napi_value result = NULL;
    char* ret = shibei_ffi_search_resources(buf_query, buf_tag_ids_json);
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value list_tags_wrap(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;
    char* ret = shibei_ffi_list_tags();
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value get_resource_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_id[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_id, sizeof(buf_id), &len); }
    napi_value result = NULL;
    char* ret = shibei_ffi_get_resource(buf_id);
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value get_resource_summary_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_id[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_id, sizeof(buf_id), &len); }
    int32_t v_max_chars = 0; if (1 < argc) napi_get_value_int32(env, args[1], &v_max_chars);
    napi_value result = NULL;
    char* ret = shibei_ffi_get_resource_summary(buf_id, v_max_chars);
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value hello_wrap(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = NULL;
    char* ret = shibei_ffi_hello();
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value add_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    int32_t v_a = 0; if (0 < argc) napi_get_value_int32(env, args[0], &v_a);
    int32_t v_b = 0; if (1 < argc) napi_get_value_int32(env, args[1], &v_b);
    napi_value result = NULL;
    int32_t ret = shibei_ffi_add(v_a, v_b);
    napi_create_int32(env, ret, &result);
    return result;
}

static napi_value s3_smoke_test_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value args[5] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_endpoint[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_endpoint, sizeof(buf_endpoint), &len); }
    char buf_region[4096] = {0};
    if (1 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[1], buf_region, sizeof(buf_region), &len); }
    char buf_bucket[4096] = {0};
    if (2 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[2], buf_bucket, sizeof(buf_bucket), &len); }
    char buf_access_key[4096] = {0};
    if (3 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[3], buf_access_key, sizeof(buf_access_key), &len); }
    char buf_secret_key[4096] = {0};
    if (4 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[4], buf_secret_key, sizeof(buf_secret_key), &len); }
    napi_value result = NULL;
    char* ret = shibei_ffi_s3_smoke_test(buf_endpoint, buf_region, buf_bucket, buf_access_key, buf_secret_key);
    napi_create_string_utf8(env, ret ? ret : "", NAPI_AUTO_LENGTH, &result);
    if (ret) shibei_ffi_free_cstring(ret);
    return result;
}

static napi_value echo_async_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char buf_text[4096] = {0};
    if (0 < argc) { size_t len = 0; napi_get_value_string_utf8(env, args[0], buf_text, sizeof(buf_text), &len); }
    AsyncCtx* ctx = (AsyncCtx*)calloc(1, sizeof(AsyncCtx));
    napi_value promise = NULL;
    napi_create_promise(env, &ctx->deferred, &promise);
    napi_value res_name = NULL;
    napi_create_string_utf8(env, "echoAsync_tsfn", NAPI_AUTO_LENGTH, &res_name);
    napi_create_threadsafe_function(env, NULL, NULL, res_name, 0, 1, NULL, NULL, NULL, async_complete_cb, &ctx->tsfn);
    shibei_ffi_echo_async(buf_text, ctx);
    return promise;
}

static napi_value on_tick_wrap(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2] = {0};
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    int64_t v_interval_ms = 0; if (0 < argc) napi_get_value_int64(env, args[0], &v_interval_ms);
    EventCtx* ctx = (EventCtx*)calloc(1, sizeof(EventCtx));
    napi_value res_name = NULL;
    napi_create_string_utf8(env, "onTick_tsfn", NAPI_AUTO_LENGTH, &res_name);
    napi_create_threadsafe_function(env, args[1], NULL, res_name, 0, 1, NULL, NULL, NULL, event_i64_cb, &ctx->tsfn);
    ctx->token = shibei_ffi_on_tick(v_interval_ms, ctx);
    // Return a JS fn that unsubscribes when invoked.
    napi_value unsubscribe = NULL;
    napi_create_function(env, "unsubscribe", NAPI_AUTO_LENGTH, on_tick_unsubscribe_wrap, ctx, &unsubscribe);
    return unsubscribe;
}

static napi_value on_tick_unsubscribe_wrap(napi_env env, napi_callback_info info) {
    void* data = NULL;
    napi_get_cb_info(env, info, NULL, NULL, NULL, &data);
    EventCtx* ctx = (EventCtx*)data;
    if (ctx && ctx->token) {
        shibei_ffi_on_tick_unsubscribe(ctx->token);
        ctx->token = NULL;
        napi_release_threadsafe_function(ctx->tsfn, napi_tsfn_release);
    }
    napi_value undef = NULL; napi_get_undefined(env, &undef); return undef;
}

// ── Module registration ───────────────────────────────────────────
static napi_value shibei_register_exports(napi_env env, napi_value exports) {
    napi_property_descriptor props[] = {
        {"initApp", NULL, init_app_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"isInitialized", NULL, is_initialized_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"hasSavedConfig", NULL, has_saved_config_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"isUnlocked", NULL, is_unlocked_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"lockVault", NULL, lock_vault_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"decryptPairingPayload", NULL, decrypt_pairing_payload_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"setS3Config", NULL, set_s3_config_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"setE2eePassword", NULL, set_e2ee_password_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"syncMetadata", NULL, sync_metadata_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"subscribeSyncProgress", NULL, subscribe_sync_progress_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"listFolders", NULL, list_folders_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"listResources", NULL, list_resources_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"searchResources", NULL, search_resources_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"listTags", NULL, list_tags_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"getResource", NULL, get_resource_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"getResourceSummary", NULL, get_resource_summary_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"hello", NULL, hello_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"add", NULL, add_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"s3SmokeTest", NULL, s3_smoke_test_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"echoAsync", NULL, echo_async_wrap, NULL, NULL, NULL, napi_default, NULL},
        {"onTick", NULL, on_tick_wrap, NULL, NULL, NULL, napi_default, NULL},
    };
    napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
    return exports;
}

static napi_module shibei_module = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = NULL,
    .nm_register_func = shibei_register_exports,
    .nm_modname = "shibei_core",
    .nm_priv = NULL,
    .reserved = {NULL, NULL, NULL, NULL},
};

__attribute__((used, constructor))
void register_shibei_core(void) {
    napi_module_register(&shibei_module);
}
