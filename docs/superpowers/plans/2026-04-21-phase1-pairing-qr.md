# Phase 1 — 桌面端配对 QR 实施计划

- 日期：2026-04-21
- 范围：桌面端 `src-tauri` + `src` + 新增 workspace / `crates/shibei-pair-decrypt`
- 前置依赖：无（Phase 0 已完成）
- 后置消费者：HarmonyOS Phase 2 Onboard Step 2/3
- 设计文档：`docs/superpowers/specs/2026-04-20-harmony-mobile-mvp-design.md` §6.1 / §6.6
- 预计工期：3 天
- **状态：✅ 已完成（2026-04-21）**，实际用时 1 天（加速自 Day 1 测试修复预见不到的顺利 + Day 2 流程没遇阻塞）

## 实施记录（按 commit）

| # | Commit | 说明 |
|---|---|---|
| 0 | `7d07b00` | `test(db): fix migration version assertion and isolate keychain tests` — 修主干预存 5→7 断言 + 加 `#[ignore]` |
| 1 | `89d9289` | `build: migrate to cargo workspace` — 新增 `/Cargo.toml`，lockfile 上升到根 |
| 2 | `a6fa983` | `feat(pairing): shibei-pairing crate with encrypt/decrypt` — 13 单测 |
| 3 | `54c91bd` | `feat(sync): generate pairing payload command for mobile onboard` — 4 集成测试 |
| 4 | `d52c91d` | `feat(tools): shibei-pair-decrypt CLI for round-trip verification` — + `scripts/test-pairing-roundtrip.sh` |
| 5 | `aaa131c` | `feat(settings): pairing dialog UI for mobile device onboard` — 6 前端测试 |
| 6 | 本次 | `docs(harmony): mark Phase 1 complete` — spec §6.6 勾选 + CLAUDE.md 同步 |

## 偏离 plan 的地方

- **多加一个 Commit 0**：主干 3 个 db::tests 预存断言版本不匹配 (`assert_eq!(version, 5)` 但 migrations 已到 7)，os_keystore 两个 test 接触真 OS keychain 在有数据的 dev 机上挂。独立前置 commit 修掉，保证 Commit 1 workspace 迁移是"零行为变化"的纯构建改动。
- **profile 处理方式调整**：原计划把 `src-harmony-napi/Cargo.toml` 的 `[profile.release]` 整块上升到 workspace root，实际发现会改桌面 `shibei` 的 release 行为。改用 `[profile.release.package.shibei-core]` per-package override；LTO 不支持 per-package 于是鸿蒙端暂时失去 LTO（交换：opt-level=s + strip + codegen-units=1 保留）。Phase 2 如果需要 LTO 再单独处理。
- **CLI round-trip 脚本**：原计划 `shibei-pair-decrypt` 走 `src-tauri` 的 path dep，实际为避免拉 tauri/axum/rusqlite 全栈进 CLI，把密码学抽成独立 `crates/shibei-pairing/`（plan §四已预告过这个决策，此处落地）。
- **qrcode mock**：vitest 下 `vi.mock("qrcode", factory)` 的 factory 不能引用 top-level 变量（hoisting），工厂函数内部定义 mock fn；`<img alt="">` ARIA role 不是 `img` 而是 `presentation`，测试用 `data-testid` 定位。

## 验收结果

- [x] `cargo test --workspace` — 184 passed（shibei 167 + shibei-pairing 13 + shibei pairing integration 4），3 ignored
- [x] `cargo clippy --workspace --all-targets` — 无新增警告（2 个预存警告与本次无关）
- [x] `tsc --noEmit` — 全绿
- [x] `vitest run` PairingDialog.test.tsx — 6/6 pass
- [x] `scripts/test-pairing-roundtrip.sh` — OK: round-trip verified (pin=246810, envelope 312 bytes)
- [x] `npm run tauri dev` 手动验收 10 条全通
- [x] debug.log 检查：仅 `pair_payload_generated len=N`，无 PIN / envelope 泄漏
- [x] spec §6.6 勾选
- [x] CLAUDE.md 更新

---

## 一、目标

桌面用户在 `Settings → 同步` 新增「添加移动设备」入口 → 弹 Modal 显示 QR + 6 位 PIN + 30s 倒计时 → 鸿蒙 app 扫码 + 输 PIN → 得到 S3 配置 → 完成 Onboard。

**边界**：
- 只传 S3 配置（endpoint/region/bucket/access_key/secret_key）。**不传** E2EE 密码、keyring、任何用户数据
- 不改：同步协议、DB schema、加密算法、sync_log
- 不做：设备管理、多设备可见性、撤销配对

## 二、锁定决策（对话确认）

| 决策点 | 选定 |
|---|---|
| PIN | 6 位数字，`^[0-9]{6}$`，前端 `crypto.getRandomValues` 生成 |
| KDF | HKDF-SHA256（salt 16B 随机，info `shibei-pair-v1`） |
| Cipher | XChaCha20-Poly1305（nonce 24B 随机），与 E2EE 栈一致 |
| AAD | ASCII bytes `shibei-pair-v1` |
| Envelope | JSON `{"v":1,"salt":...,"nonce":...,"ct":...}`，字段 Base64URL no-pad |
| Payload 大小上限 | **原始二进制 512 字节**（编码前），超限返回 `error.pairingPayloadTooLarge` |
| 过期策略 | 前端静默：30s 到切「已过期」UI；payload 不含 `exp` 字段 |
| CLI | `crates/shibei-pair-decrypt/`，顶层 Cargo workspace 一步到位 |
| SyncPage 按钮 | `disabled` + tooltip，前置条件（S3 已保存且有凭据）未满足时提示 |
| 警告文案 | Modal 内小字「请勿截图分享此二维码和 PIN」 |
| 新增 npm 包 | 仅 `qrcode`（~100KB，零运行时依赖） |
| 新增 Rust crate | 无（复用 `hkdf` / `chacha20poly1305` / `rand` / `base64` / `serde_json`） |

## 三、密码学设计

**Plain payload**（传输前明文，JSON UTF-8）：
```json
{
  "version": 1,
  "endpoint": "https://...",
  "region": "...",
  "bucket": "...",
  "access_key": "...",
  "secret_key": "..."
}
```

**Envelope**（加密后对外）：
```json
{
  "v": 1,
  "salt":  "<base64url 16B>",
  "nonce": "<base64url 24B>",
  "ct":    "<base64url ciphertext||tag>"
}
```

**派生与加密**：
```
key    = HKDF-SHA256(ikm = PIN_utf8, salt = salt, info = "shibei-pair-v1", L = 32)
ct||tag = XChaCha20Poly1305.seal(key, nonce, plain, aad = "shibei-pair-v1")
```

**为什么 KDF 用 HKDF 而不用 Argon2id**：6 位 PIN 熵 ~20 bits，任何 KDF 都挡不住离线爆破。真防御来自**一次性使用 + 30s 时效 + QR 不落盘（不含 PIN）**。HKDF 快、纯 Rust、鸿蒙侧好复刻。这一条在 `sync/pairing.rs` 文件头注释里写明，防止后续误判。

## 四、文件改动清单

### 前置：顶层 Cargo workspace 迁移

**新增** `/Cargo.toml`：
```toml
[workspace]
resolver = "2"
members = [
    "src-tauri",
    "src-harmony-napi",
    "crates/*",
]

[workspace.package]
edition = "2021"
authors = ["Ming Yin"]
license = "AGPL-3.0"
```

**`src-tauri/Cargo.toml`**：保持现状（package 成员），不改依赖版本。

**`src-harmony-napi/Cargo.toml`**：保持现状。

**`target/` 目录位置变化**：会从 `src-tauri/target/` 合并到仓库根 `target/`。需更新：
- `.gitignore`：确认根 `target/` 已忽略
- `src-tauri/tauri.conf.json`：`beforeBuildCommand` / `beforeDevCommand` 工作目录假设需验证（tauri 2.x 默认找 `src-tauri/Cargo.toml`，workspace 不影响）
- `npm run tauri dev / build`：手动跑一次验证（验收点）

**影响评估**：CI 无（仓库没 CI）；开发机首次 `cargo build` 会重编所有依赖（一次性代价）。

### Rust 后端

| 文件 | 操作 | 内容要点 |
|---|---|---|
| `src-tauri/src/sync/pairing.rs` | 新增 | `encrypt_payload(pin, plain) -> Result<String (json), PairingError>` + `decrypt_payload(pin, envelope_json) -> Result<Vec<u8>, PairingError>` + PIN 正则校验 + 512B 上限检查 |
| `src-tauri/src/sync/mod.rs` | 改 | 加 `pub mod pairing;` |
| `src-tauri/src/commands/mod.rs` | 改 | 新增 `cmd_generate_pairing_payload(state, pin) -> Result<String, CommandError>`；读 `sync_state` + `credentials` 组 plain → 调 `pairing::encrypt_payload` → 返回 envelope JSON 字符串 |
| `src-tauri/src/lib.rs` | 改 | `invoke_handler!` 注册 `cmd_generate_pairing_payload` |

**错误类型**：`PairingError` 独立 `thiserror` 枚举：
- `InvalidPin` → i18n `error.pairingInvalidPin`
- `SyncNotConfigured` → `error.pairingSyncNotConfigured`
- `CredentialsMissing` → `error.pairingCredentialsMissing`
- `PayloadTooLarge { size, limit }` → `error.pairingPayloadTooLarge`
- `Crypto(..)` / `Serde(..)` → `error.pairingInternal`

**日志纪律**：`cmd_generate_pairing_payload` 只打印 `"pair_payload_generated len={}"`，**绝不**打印 PIN 或 envelope 内容。

### 前端

| 文件 | 操作 | 内容要点 |
|---|---|---|
| `src/components/Settings/PairingDialog.tsx` | 新增 | 生成 PIN → 调 command → `qrcode` 渲染 → 30s 倒计时 → 过期 UI → 重新生成按钮 |
| `src/components/Settings/PairingDialog.module.css` | 新增 | Modal + QR + PIN 大字分组 + warning 小字 |
| `src/components/Settings/SyncPage.tsx` | 改 | 新增「添加移动设备」按钮；`disabled` 条件 `!has_credentials \|\| !bucket`；tooltip 文案 |
| `src/lib/commands.ts` | 改 | `generatePairingPayload(pin)` wrapper + `translateError` 已处理错误 key |
| `src/locales/zh/sync.json` | 改 | 新增 9 条 keys（见下） |
| `src/locales/en/sync.json` | 改 | 同上 |
| `src/locales/zh/common.json` | 改 | 新增 5 条 error keys |
| `src/locales/en/common.json` | 改 | 同上 |
| `package.json` | 改 | `dependencies` 加 `qrcode@^1.5.4`；`devDependencies` 加 `@types/qrcode` |

**新增 i18n keys**（最终）：

`sync.json`:
```json
"addMobileDevice": "添加移动设备",
"pairing": {
  "title": "配对移动设备",
  "instructions": "在手机拾贝中扫描二维码并输入下方 PIN 完成首次配对。",
  "pin": "PIN 码",
  "expiresIn": "{{seconds}} 秒后失效",
  "expired": "已过期",
  "regenerate": "重新生成",
  "noShareWarning": "请勿截图或分享此二维码和 PIN",
  "disabledTooltip": "请先在上方配置并测试 S3 连接"
}
```

`common.json → error.*`:
```json
"pairingInvalidPin": "PIN 必须为 6 位数字",
"pairingSyncNotConfigured": "请先配置 S3 同步",
"pairingCredentialsMissing": "S3 凭据缺失，请重新保存",
"pairingPayloadTooLarge": "配置过大，请缩短 endpoint 等字段",
"pairingInternal": "生成配对失败，请重试"
```

### CLI — `crates/shibei-pair-decrypt/`

| 文件 | 内容 |
|---|---|
| `Cargo.toml` | package + path dep 指向 `src-tauri`（只消费 `sync::pairing`） |
| `src/main.rs` | `clap` 解析 `--pin <6digit> [--payload <str>] [--pretty]`；无 `--payload` 时从 stdin 读；解密失败 `exit(1)` + stderr 写 `PairingError::to_string()` |

**问题**：`src-tauri` 是 `crate-type = ["staticlib", "cdylib", "rlib"]`，CLI 作为 path dep 引用 `rlib` 可行；但 `src-tauri` 拉进一堆 tauri 依赖（axum、tokio、rusqlite 等），CLI 编译会很慢。

**替代方案**：把 `sync/pairing.rs` 抽到独立 crate `crates/shibei-pairing/`，`src-tauri` 和 CLI 都依赖它。**这样更干净，也是这次一步到位的正事**。

**决定**：采用 `crates/shibei-pairing/` 独立 lib crate 方案：
- `crates/shibei-pairing/src/lib.rs` → 纯密码学 + 序列化（只依赖 `hkdf`, `chacha20poly1305`, `sha2`, `rand`, `base64`, `serde`, `serde_json`, `thiserror`）
- `src-tauri/Cargo.toml` 加 `shibei-pairing = { path = "../crates/shibei-pairing" }`
- `src-tauri/src/sync/pairing.rs` 仅做 `sync_state` / `credentials` 读取 + 调 `shibei_pairing::encrypt_payload`
- `crates/shibei-pair-decrypt/Cargo.toml` 加 `shibei-pairing = { path = "../shibei-pairing" }` + `clap`

CLI 依赖树将非常小（~10 个 crate），对拍速度快。

**CLI 接口**：
```
shibei-pair-decrypt --pin 123456 --payload <envelope-json>
echo '<envelope-json>' | shibei-pair-decrypt --pin 123456
# stdout: plain payload JSON (compact or --pretty)
# exit 1 + stderr on failure
```

## 五、测试计划

### `crates/shibei-pairing` 单测

覆盖：
1. `encrypt_payload(pin, plain) → decrypt_payload(pin, env) = plain` round-trip
2. 不同 PIN 解不开（AEAD 失败）
3. 篡改 `ct` / `nonce` / `salt` 任一字段 → 失败
4. AAD 不匹配 → 失败（通过临时 fork 验证不跨用）
5. PIN 格式非 6 位数字 → `InvalidPin`
6. 原始二进制 payload > 512B → `PayloadTooLarge`
7. envelope JSON 格式损坏 → `InvalidEnvelope`
8. version 字段 != 1 → `UnsupportedVersion`

### `src-tauri` 集成测

覆盖：
1. `cmd_generate_pairing_payload`：S3 配置齐全 + 凭据存在 → 返回 envelope JSON
2. S3 未配置 → `SyncNotConfigured`
3. 凭据缺失 → `CredentialsMissing`
4. 返回的 envelope 能被 `shibei_pairing::decrypt_payload` 正确还原

### 前端测试 `PairingDialog.test.tsx`（vitest + RTL）

覆盖：
1. Mount 时调 `generatePairingPayload`，`qrcode.toDataURL` 被调用一次
2. PIN 显示为 `XXX XXX` 格式
3. 假时间 30s 后 UI 切「已过期」状态，QR 打码
4. 点「重新生成」重新调 command + 计时重置
5. 关闭 Modal（unmount）清除 timer、state
6. Mock command 返回错误 → 显示 `translateError` 结果

### CLI round-trip 验证（手动 + 自动）

- `cargo run -p shibei-pair-decrypt -- --pin 123456 --payload "$(...)"` 还原 plain
- 加一个 shell 脚本 `scripts/test-pairing-roundtrip.sh`：调 Rust `encrypt` → pipe 给 CLI → diff 还原结果

### 手动验收清单

在 `npm run tauri dev` 下：
1. 未配置 S3 → 按钮 disabled + tooltip 可见
2. 配完 S3 + 凭据 → 按钮 enabled
3. 点击 → Modal 正常弹出，QR 在 < 200ms 渲染完成
4. PIN 清晰可读（分组显示）
5. 倒计时每秒 -1
6. 30s 到 → 「已过期」态，有「重新生成」按钮
7. 关闭 Modal 再开 → 新 PIN 和新 QR，不复用
8. QR 用手机拍下 → 用 `shibei-pair-decrypt` + 该 PIN 解出正确 S3 配置
9. `npm run tauri build` 能正常打包（workspace 迁移兼容）
10. `~/Library/Application Support/shibei/debug.log` 只有 `pair_payload_generated len=N`，无 PIN / envelope 泄漏

## 六、实施时序（3 天）

### Day 1 — Workspace 迁移 + `shibei-pairing` crate

**Commit 1**：`build: migrate to cargo workspace`
- 新增 `/Cargo.toml`
- 验证 `cargo check --workspace` pass
- 验证 `npm run tauri dev` 能启动（冷编译一次）
- 验证 `cargo test -p shibei` 现有测试全绿

**Commit 2**：`feat(pairing): shibei-pairing crate with encrypt/decrypt`
- `crates/shibei-pairing/` 含完整实现 + 单测（上述 8 条）
- `cargo test -p shibei-pairing` 全绿
- `cargo clippy -p shibei-pairing` 无警告

### Day 2 — 桌面后端 command + CLI + 前端骨架

**Commit 3**：`feat(sync): generate pairing payload command`
- `src-tauri/src/sync/pairing.rs` + `commands/mod.rs` + `lib.rs`
- `cargo test -p shibei` 含新集成测试
- `cargo clippy` 全绿

**Commit 4**：`feat(tools): shibei-pair-decrypt CLI for round-trip`
- `crates/shibei-pair-decrypt/` 完整
- `scripts/test-pairing-roundtrip.sh`
- 本地手动跑通 round-trip

**Commit 5**：`feat(settings): pairing dialog UI`
- `PairingDialog.tsx` + `.module.css`
- `SyncPage.tsx` 按钮入口
- `commands.ts` wrapper
- i18n zh/en
- `npm run test`（vitest）新测试全绿
- `tsc --noEmit` 全绿

### Day 3 — 联调 + 文档 + 收尾

**Commit 6**：`docs(harmony): Phase 1 done; update spec + CLAUDE.md`
- `docs/superpowers/specs/2026-04-20-harmony-mobile-mvp-design.md` §6.6 勾选「Phase 2 前必须合入」
- `CLAUDE.md` 更新：新模块 `crates/shibei-pairing`、新 command `cmd_generate_pairing_payload`、新 i18n keys
- plan 本文标注「已完成」+ 实际工时

手动验收 10 条逐条跑一遍，通过后合并主干。

## 七、风险与回滚

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| Workspace 迁移破坏 `tauri dev` 启动 | 低 | 高 | Commit 1 单独提交；失败即 revert Commit 1 单个 commit |
| `qrcode` npm 包 Node ESM/CJS 兼容问题 | 低 | 中 | 该包历史稳定；失败退回 `qrcode-generator` |
| `chacha20poly1305` crate 在 CLI 下体积超出预期 | 极低 | 低 | 已在 src-tauri 用，同版本共享 |
| 手机扫码成功率受 QR 容量影响 | 低 | 中 | 512B 限制已经保守；发现后调阈值即可 |
| `src-tauri/src/sync/pairing.rs` 与 `crates/shibei-pairing` 命名冲突 | 低 | 低 | 内层改名 `pairing_cmd.rs` 或合入 `commands/mod.rs` 直接调 crate |

**回滚策略**：每个 commit 独立可 revert。Commit 5 / 4 / 3 可单独 revert 回到「workspace 迁移 + 空 crate」稳定态。Commit 1+2 一起 revert 即回到 main 主干。

## 八、验收标准（Definition of Done）

- [ ] `cargo test --workspace` 全绿
- [ ] `cargo clippy --workspace --all-targets` 无警告
- [ ] `npm run test` 全绿
- [ ] `tsc --noEmit` 全绿
- [ ] `npm run tauri dev` 冷启动正常
- [ ] `npm run tauri build` 成功打包
- [ ] 手动验收 10 条全部通过
- [ ] CLI round-trip 脚本 `scripts/test-pairing-roundtrip.sh` 退出码 0
- [ ] debug.log 无 PIN / envelope 泄漏
- [ ] spec §6.6 勾选
- [ ] CLAUDE.md 同步更新

## 九、不做清单（划清边界）

- 不做设备列表管理（「我已配对几个设备」无 UI）
- 不做撤销配对（无需要——每次扫码都是一次性新 payload）
- 不写鸿蒙端代码（属于 Phase 2）
- 不改同步协议 / DB schema / E2EE 加密
- 不做 `--generate` 模式的 CLI（CLI 只解密）
- 不做 PIN 的用户自选输入（全随机，UX 简单）
- 不做 QR 体积预判 UI 提示（超限直接报错，用户改 endpoint 即可）
