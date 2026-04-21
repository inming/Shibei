# ~~技术债：鸿蒙端 CA bundle 打进 .so~~（2026-04-21,已解决）

> **已解决 (M4 收尾)**：采用方案 A,cacert.pem 迁到 `shibei-harmony/entry/src/main/resources/rawfile/ca-bundle.pem`,ArkTS 侧 `app/CaBundle.ets` 在 `ShibeiService.init(ctx)` 里拷到沙盒,把路径传给 Rust `initApp(dataDir, caBundlePath)`。`.so` 从 8.19 MB 回落到 7.96 MB。以下内容保留作为当时的决策记录。

## 现状

`src-harmony-napi/ca-bundle.pem`（226 KB，Mozilla 根证书，来源 <https://curl.se/ca/cacert.pem>）通过 `include_bytes!` 嵌入 `libshibei_core.so`；`state::init` 把它写到 `$data_dir/ca-bundle.pem` 并设 `SSL_CERT_FILE` 环境变量，让 `rustls-native-certs` 找到。

**.so 体积**：7.5 MB → 7.8 MB。

## 问题

1. **证书过期风险**：Mozilla 定期吊销/新增 CA。这套 bundle 冻结在编译时，等 rebuild 才刷新。桌面端不存在这问题（`rustls-native-certs` 用系统信任库，OS 更新跟进）。
2. **升级摩擦**：每次发版都得手动重下 cacert.pem + commit + rebuild。容易忘。
3. **包体积**：几百 KB 打在二进制里，对越来越大的 `.so`（现在已 7.8 MB）不友好。用户 OTA 更新多下这部分。
4. **环境变量污染**：`std::env::set_var` 改进程级 env，对未来 tokio 多线程 + 同 process 里的其他库行为有潜在影响（rust 1.74 后 `set_var` 甚至被标为 `unsafe`）。

## 更优解（按推荐度排）

### 方案 A：ArkTS 把 bundle 路径/句柄传给 Rust（最推荐）

把 `cacert.pem` 放 `shibei-harmony/entry/src/main/resources/rawfile/ca-bundle.pem`（HAP 资源，不在 .so 内）。
- ArkTS 启动时通过 `resourceManager.getRawFd('ca-bundle.pem')` 拿到 FD 或把资源拷到 `$data_dir`
- `initApp(dataDir, caBundlePath)` 多一个参数，Rust 侧读该路径设 `SSL_CERT_FILE`
- 优势：bundle 作为资源文件管理，独立刷新；.so 体积回到 7.5 MB；HAP 的资源系统原生支持多语言/版本

### 方案 B：直接注入 rustls `ClientConfig`，绕开 `SSL_CERT_FILE`

用 `webpki-roots` crate（纯 trust anchors，静态编译，~40 KB 压缩后），在 Rust 启动时构造一个 `rustls::ClientConfig` 注入 hyper-rustls。但 rust-s3 0.35 不暴露 TLS 配置口。需要：
- 升级到 rust-s3 0.37+（有 `Bucket::with_http_client` 之类 API）
- 或 fork/PR rust-s3 添加 hook

### 方案 C：HarmonyOS 官方 cert API（如果有）

探索 `@kit.NetworkKit` 或 `@kit.NetworkSecurity` 有没有暴露系统 CA 或让 app 接入系统 TLS 栈。如果有，rust-s3 外层用 ArkTS `http` 客户端拿 keyring 字节，HTTPS 在 ArkTS 层解；Rust 只收明文字节（但这又绕一圈）。

## 建议路径

**先 A 再 B**：A 简单，量小，HAP 资源机制本来就处理多文件更新；B 涉及 rust-s3 版本升级，引发连锁依赖变动，放 Phase 2 末期统一升。

## 留痕

- 初始修复提交：`5a39da2 fix(harmony-napi): ship Mozilla CA bundle for TLS`
- 迁移到 HAP rawfile 的提交：见 M4 commit
- 当前刷新步骤:`curl -sSL -o shibei-harmony/entry/src/main/resources/rawfile/ca-bundle.pem https://curl.se/ca/cacert.pem`(只需要重打 HAP,不需要 Rust rebuild)
