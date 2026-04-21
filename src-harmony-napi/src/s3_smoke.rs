//! Phase 0 Demo 7 S3 PUT+GET smoke test. Kept as a command for regression
//! checking; will be replaced by the real sync engine in later Phase 2 tracks.

pub fn run(
    endpoint: &str,
    region: &str,
    bucket: &str,
    access_key: &str,
    secret_key: &str,
) -> String {
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => return format!(r#"{{"ok":false,"error":"rt_build: {e}"}}"#),
    };

    rt.block_on(async move {
        use s3::creds::Credentials;
        use s3::{Bucket, Region};

        let creds = match Credentials::new(Some(access_key), Some(secret_key), None, None, None) {
            Ok(c) => c,
            Err(e) => return format!(r#"{{"ok":false,"error":"creds: {e}"}}"#),
        };
        let region = Region::Custom {
            region: region.to_string(),
            endpoint: endpoint.to_string(),
        };
        let bkt_box = match Bucket::new(bucket, region, creds) {
            Ok(b) => b,
            Err(e) => return format!(r#"{{"ok":false,"error":"bucket_new: {e}"}}"#),
        };
        let bucket_obj = *bkt_box.with_path_style();

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
