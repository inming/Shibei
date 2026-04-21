#![deny(clippy::all)]

// Plain extern "C" implementations exposed to a hand-written C NAPI shim
// (see src/shim.c). napi-rs's auto-bindings do not work under HarmonyOS NEXT
// as of 2026-04; Phase 0 fallback is manual N-API wrapping.

use std::ffi::{CStr, CString, c_char};

/// Returns a pointer to a static NUL-terminated C string describing the
/// runtime. Pointer is valid for the lifetime of the library.
#[no_mangle]
pub extern "C" fn shibei_hello() -> *const c_char {
    static GREETING: &[u8] = b"hello from rust, os=ohos, arch=aarch64\0";
    GREETING.as_ptr() as *const c_char
}

#[no_mangle]
pub extern "C" fn shibei_add(a: i32, b: i32) -> i32 {
    a + b
}

/// S3 smoke test: PUT a small payload then GET it back.
/// All parameters are NUL-terminated UTF-8 C strings.
/// Returns a heap-allocated NUL-terminated JSON result string (leaked — this
/// is verification code with no deallocation path needed).
#[no_mangle]
pub extern "C" fn shibei_s3_smoke_test(
    endpoint: *const c_char,
    region: *const c_char,
    bucket: *const c_char,
    access_key: *const c_char,
    secret_key: *const c_char,
) -> *const c_char {
    let result = smoke_test_impl(endpoint, region, bucket, access_key, secret_key);
    let cstr = CString::new(result)
        .unwrap_or_else(|_| CString::new("result-serialization-failed").unwrap());
    cstr.into_raw()
}

fn smoke_test_impl(
    endpoint: *const c_char,
    region: *const c_char,
    bucket: *const c_char,
    access_key: *const c_char,
    secret_key: *const c_char,
) -> String {
    fn read(ptr: *const c_char) -> Result<String, String> {
        if ptr.is_null() {
            return Err("null pointer".into());
        }
        unsafe { CStr::from_ptr(ptr) }
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| e.to_string())
    }

    let cfg = (|| -> Result<(String, String, String, String, String), String> {
        Ok((
            read(endpoint)?,
            read(region)?,
            read(bucket)?,
            read(access_key)?,
            read(secret_key)?,
        ))
    })();
    let (ep, reg, bkt, ak, sk) = match cfg {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"bad_args: {e}"}}"#),
    };

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => return format!(r#"{{"ok":false,"error":"rt_build: {e}"}}"#),
    };

    rt.block_on(async move {
        use s3::creds::Credentials;
        use s3::{Bucket, Region};

        let creds = match Credentials::new(Some(&ak), Some(&sk), None, None, None) {
            Ok(c) => c,
            Err(e) => return format!(r#"{{"ok":false,"error":"creds: {e}"}}"#),
        };
        let region = Region::Custom {
            region: reg.clone(),
            endpoint: ep.clone(),
        };
        let bkt_box = match Bucket::new(&bkt, region, creds) {
            Ok(b) => b,
            Err(e) => return format!(r#"{{"ok":false,"error":"bucket_new: {e}"}}"#),
        };
        let bucket_obj = *bkt_box.with_path_style();

        // Use SystemTime for a unique key (no chrono dep)
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let key = format!("shibei-phase0/smoke-{ts_ms}.txt");
        let payload = format!("hello shibei phase 0 at t={ts_ms}").into_bytes();

        let put = match bucket_obj.put_object(&key, &payload).await {
            Ok(r) => r,
            Err(e) => return format!(r#"{{"ok":false,"stage":"put","error":"{e}"}}"#),
        };
        let get = match bucket_obj.get_object(&key).await {
            Ok(r) => r,
            Err(e) => return format!(
                r#"{{"ok":false,"stage":"get","error":"{e}","put_status":{}}}"#,
                put.status_code()
            ),
        };
        let body = get.bytes();
        let roundtrip_ok = body.as_ref() == payload.as_slice();
        let preview = String::from_utf8_lossy(&body[..body.len().min(80)]);
        format!(
            r#"{{"ok":true,"put_status":{},"get_status":{},"bytes":{},"roundtrip_ok":{},"preview":{:?},"key":{:?}}}"#,
            put.status_code(),
            get.status_code(),
            body.len(),
            roundtrip_ok,
            preview,
            key
        )
    })
}
