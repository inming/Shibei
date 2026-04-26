# 移动端配置回传桌面（Mobile → Desktop Config Transfer）

**Status**: design (2026-04-26)

**Goal**: 让已完成装机配置（S3 同步）的鸿蒙移动端，能将其 S3 凭据快速回传给桌面端，实现双向配置传递。

**Outcome**: 用户无需在桌面端手工填写 S3 配置；手机生成加密 envelope + PIN，用户自行把 envelope URL 传到桌面，Deep Link 或手动粘贴触发桌面端解密导入。

---

## 1. 背景

### 1.1 现状

Phase 1（`2026-04-21-phase1-pairing-qr.md`）实现了桌面→手机的配对传输：

- 桌面端 `SyncPage` → 点击「添加移动设备」→ `PairingDialog` 生成 6 位 PIN + QR（内容为加密 envelope）
- 手机 `Onboard.ets` Step 1 → 扫 QR 获取 envelope → 输入 PIN → 解密得到 S3 配置
- 密码学依托 `crates/shibei-pairing/`：HKDF-SHA256 + XChaCha20-Poly1305，零改动

**缺失方向**：只有桌面→手机，没有手机→桌面。如果用户先在手机上完成装机（手动输入 S3 配置），想将配置回传到桌面端，目前没有优雅路径。

### 1.2 可行性与复用

`shibei-pairing` crate 的 `encrypt_payload` / `decrypt_payload` 是**完全对称**的——加密和解密不绑定角色。桌面端已编译了 encrypt 路径（`build_pairing_envelope`），移动端已编译了 decrypt 路径（`decrypt_pairing_payload` NAPI）。反向传输只需：

- 移动端新增 encrypt NAPI 调用（已有 crate 支持）
- 桌面端新增 decrypt Tauri command（已有 crate 支持）

---

## 2. 设计

### 2.1 整体架构

```
┌── 移动端 Settings → 同步 ────────────┐         ┌── 桌面端 ────────────────────────┐
│                                     │         │                                  │
│  [传输配置到桌面]                     │         │                                  │
│       ↓                             │         │                                  │
│  生成 6 位 PIN + encrypt S3 配置      │         │                                  │
│  shibei_pairing::encrypt_payload()   │         │                                  │
│                                     │         │                                  │
│  PIN: "384 712"                      │         │                                  │
│  URL: shibei://pair?v=1&salt=...&   │         │                                  │
│       nonce=...&ct=...              │         │                                  │
│       60s 倒计时                      │         │                                  │
│                                     │         │                                  │
│  用户自行把 URL 传到桌面              │         │                                  │
│  (粘贴 / IM / 邮件 / AirDrop / ...) ─┼────────→│ 入口 A: Deep Link                        │
│                                     │         │   shibei://pair?... 被系统拦截       │
│                                     │         │                                    │
│                                     │         │ 入口 B: SyncPage「导入配置」按钮       │
│                                     │         │   粘贴 envelope URL                │
│                                     │         │         ↓                          │
│                                     │         │   PairingImportDialog               │
│                                     │         │   ├─ PIN 输入（6 digits）           │
│                                     │         │   ├─ envelope 解析                  │
│                                     │         │   └─ cmd_import_pairing_config      │
│                                     │         │       ↓                            │
│                                     │         │   shibei_pairing::decrypt_payload() │
│                                     │         │       ↓                            │
│                                     │         │   store_credentials (OS Keychain)   │
│                                     │         │   sync_state 写入 endpoint/region/  │
│                                     │         │     bucket                         │
└─────────────────────────────────────┘         └────────────────────────────────────┘
```

### 2.2 传输内容

仅 S3 配置，不含 E2EE 密码。与现有桌面→手机传输内容**完全对称**。

Plain payload JSON（加密前）：

```json
{
  "version": 1,
  "endpoint": "https://s3.example.com",
  "region": "us-east-1",
  "bucket": "my-bucket",
  "access_key": "AKIA...",
  "secret_key": "..."
}
```

最大 512 字节（`MAX_PAYLOAD_BYTES`）。

### 2.3 传输通道

用户自行解决 envelope URL 的传输（粘贴 / IM / 邮件 / AirDrop / Handoff / 手动输入 / ...）。应用不提供自动化通道。

理由：鸿蒙↔macOS 之间无 AirDrop、无 Universal Clipboard；iOS 尚无 Shibei 版本。任何自动化方案（mDNS、蓝牙）工程量大且不可靠。等 iOS 版落地或鸿蒙生态成熟后再考虑自动通道。

### 2.4 过期时间

60 秒。从 PIN 显示开始倒计时。相比桌面→手机配对的 30s 延长一倍，因为多了一步"跨设备传 URL"的操作。

---

## 3. Deep Link

### 3.1 URL 格式

```
shibei://pair?v=1&salt=<base64url>&nonce=<base64url>&ct=<base64url>
```

- `v`: envelope version（当前为 1）
- `salt`: 16B random，Base64URL no-padding
- `nonce`: 24B random，Base64URL no-padding
- `ct`: XChaCha20-Poly1305 ciphertext || tag，Base64URL no-padding

URL 不含 PIN。PIN 只看移动端屏幕手工输入。

总长度约 400–750 字符（取决于 AK/SK 长度），远小于各平台 Deep Link 限制。

### 3.2 桌面端接收

已有 Deep Link 基础设施（`src-tauri/src/lib.rs` + `src/App.tsx`）通过三种入口处理 `shibei://` URL：

1. Cold start: `tauri-plugin-deep-link` → `getDeepLinkCurrent()`
2. Warm start: `onOpenUrl` callback
3. Second instance: `deep-link-received` event

新增 `shibei://pair?` 分支：从 URL query 中提取 `salt`/`nonce`/`ct`/`v`，重组为 envelope JSON，emit `shibei:pair-received` 事件或直接打开 `PairingImportDialog`。

### 3.3 兼容性

不影响现有 `shibei://open/resource/{id}?highlight={hlId}` Deep Link。两个路由按 URL path 前缀分支：
- `shibei://open/*` → 现有逻辑（打开资料）
- `shibei://pair?*` → 导入配置

---

## 4. 密码学

### 4.1 零改动

`crates/shibei-pairing/` 不做任何修改。该 crate 提供的是对称加密能力，角色对调只需调用方各自用对应的 encrypt/decrypt 函数：

```
移动端（新增）:
  plain S3 配置 → NAPI → shibei_pairing::encrypt_payload(pin, &plain) → envelope JSON

桌面端（新增）:
  envelope JSON → cmd_import_pairing_config → shibei_pairing::decrypt_payload(pin, &envelope) → S3 配置
```

### 4.2 加密栈（与现有一致）

```
PIN (6-digit string) + random 16B salt
    → HKDF-SHA256(salt, info="shibei-pair-v1", L=32)
    → 32B key
    → XChaCha20-Poly1305.seal(plain, aad="shibei-pair-v1")
    → nonce(24B) + ct → Envelope { v:1, salt, nonce, ct }
```

### 4.3 安全分析

| 风险 | 结论 |
|------|------|
| URL 经 IM/邮件/剪贴板传播 | envelope 不含 PIN，无法解密 |
| PIN 在 URL 中？ | **绝不。** PIN 只显示在手机屏幕，桌面端用户目视输入 |
| 60s 过期 | 计时器到期后 PIN + envelope 失效 |
| 重复使用 | PIN 一次性使用，6 位熵 ~20 bits，真防御来自一次性 + 短时效 |
| 日志泄露 | `debug_log` 只写 `pair_payload_generated len=N`，不写 PIN/envelope |

---

## 5. 移动端（shibei-harmony）

### 5.1 入口

`Settings.ets` 同步分区 → 新增按钮「传输配置到桌面」→ `router.pushUrl('pages/PairingOut')`。

### 5.2 PairingOutPage.ets

新页面，职责：生成 PIN → 加密配置 → 显示 PIN 和 URL → 60s 倒计时。

```
PairingOutPage:
  @State pin: string = ''
  @State envelopeUrl: string = ''
  @State secondsLeft: number = 0
  @State expired: boolean = false

  aboutToAppear():
    1. pin = generatePin()   // crypto.getRandomValues → 6-digit
    2. plain = buildS3ConfigPlain()  // 读 AppState / sync_state
    3. envelopeJson = napiEncryptPairingPayload(pin, plain)
    4. envelopeUrl = "shibei://pair?v=1&salt={s}&nonce={n}&ct={c}"
    5. secondsLeft = 60 → setInterval 倒计时

  60s 到期: expired = true → 显示"已过期" + [重新生成] 按钮

  UI:
    - 标题: "传输配置到桌面"
    - PIN 大字号: "384 712"  (XXX XXX 分组)
    - URL 文本: 单行截断 + [复制] 按钮 (systemPasteboard.setData)
    - 60s 倒计时
```

**重新生成**：`regenerate()` 重置所有状态，重新生成 PIN + envelope。

**按钮禁用条件**：
- `!s3_creds || !bucket` → 按钮 disabled + tooltip "请先配置同步"

### 5.3 NAPI: `encrypt_pairing_payload`

```rust
// src-harmony-napi/src/commands.rs
#[shibei_napi]
pub fn encrypt_pairing_payload(pin: String, plain_json: String) -> String
```

逻辑：
1. 验证 PIN 为 6 位数字
2. `serde_json::from_str::<serde_json::Value>(&plain_json)` → 验证为合法 JSON
3. `shibei_pairing::encrypt_payload(&pin, plain_json.as_bytes())` → envelope JSON
4. 成功返回 envelope 字符串
5. 失败返回 `{"error":"error.pairingXXX"}`

**为什么接受 plain_json 参数而非内部读配置？** NAPI 不做 I/O 是设计原则：plain 由 ArkTS 层组装（从 `ShibeiService` 读 `AppState.s3_creds` + `sync_state`），传给 NAPI 只做纯加密。这样 NAPI 保持零依赖、零 I/O。

### 5.4 ShibeiService 适配

```typescript
async transferConfigToDesktop(): Promise<{ pin: string; envelopeUrl: string }> {
  const plain = {
    version: 1,
    endpoint: await this.getSyncState('config:s3_endpoint') || '',
    region: (await this.getSyncState('config:s3_region')) || '',
    bucket: (await this.getSyncState('config:s3_bucket')) || '',
    access_key: this.s3_creds?.access_key ?? '',
    secret_key: this.s3_creds?.secret_key ?? '',
  };
  const pin = generatePin();
  const envelope = napiEncryptPairingPayload(pin, JSON.stringify(plain));
  const params = JSON.parse(envelope); // { v, salt, nonce, ct }
  const url = `shibei://pair?v=${params.v}&salt=${params.salt}&nonce=${params.nonce}&ct=${params.ct}`;
  return { pin, envelopeUrl: url };
}
```

### 5.5 i18n

三份 `string.json` 新增：

| Key | zh_CN | en_US |
|-----|-------|-------|
| `settings_transferToDesktop` | 传输配置到桌面 | Transfer Config to Desktop |
| `pairing_out_title` | 传输配置到桌面 | Transfer Config to Desktop |
| `pairing_out_pin_label` | 配对码 | Pairing Code |
| `pairing_out_link_label` | 配置链接 | Config Link |
| `pairing_out_copy_link` | 复制链接 | Copy Link |
| `pairing_out_copied` | 已复制 | Copied |
| `pairing_out_expired` | 已过期，请重新生成 | Expired. Please regenerate |
| `pairing_out_regenerate` | 重新生成 | Regenerate |

---

## 6. 桌面端（src-tauri + src）

### 6.1 Deep Link 解析

**File:** `src/App.tsx`

在现有 `handleDeepLinkUrl` 中新增 `shibei://pair?` 分支：

```typescript
const handleDeepLinkUrl = useCallback(async (url: string) => {
  // 现有: shibei://open/resource/{id}
  const openMatch = url.match(/shibei:\/\/open\/resource\/([^?]+)(?:\?highlight=(.+))?/);
  if (openMatch) { /* 现有逻辑 */ return; }

  // 新增: shibei://pair?v=1&salt=...&nonce=...&ct=...
  const pairMatch = url.match(/shibei:\/\/pair\?v=(\d+)&salt=([^&]+)&nonce=([^&]+)&ct=([^&]+)/);
  if (pairMatch) {
    const [, v, salt, nonce, ct] = pairMatch;
    const envelope = JSON.stringify({ v: parseInt(v), salt, nonce, ct });
    setPendingPairEnvelope(envelope);  // 触发 PairingImportDialog
    return;
  }
}, [openResource]);
```

### 6.2 cmd_import_pairing_config

**File:** `src-tauri/src/commands/mod.rs`

```rust
#[tauri::command]
pub async fn cmd_import_pairing_config(
    state: tauri::State<'_, Arc<AppState>>,
    envelope: String,
    pin: String,
) -> Result<(), CommandError>
```

逻辑：
1. 获取 DB 连接
2. 调用 `shibei_pairing::decrypt_payload(&pin, &envelope)` → 得到 `Vec<u8>`
3. 解析为 `PlainPayload { version, endpoint, region, bucket, access_key, secret_key }`
4. 校验字段完整（`access_key` / `secret_key` / `bucket` 非空）
5. 写入 `storage::state`（endpoint / region / bucket to `sync_state`）
6. 调用 `credentials::store_credentials(conn, &access_key, &secret_key)` → OS Keychain
7. 失败返回 `CommandError` 带 i18n key

### 6.3 PairingImportDialog.tsx

新组件，两个入口：

**入口 A — Deep Link 自动打开**：当 `pendingPairEnvelope` 被设置，渲染 `<PairingImportDialog envelope={envelope} onClose={...} />`。

**入口 B — 手动打开**：`SyncPage.tsx` 新增「导入配置」按钮：

```tsx
<button className={styles.secondary} onClick={() => setImportOpen(true)}>
  {t('importFromMobile')}
</button>
```

**对话框内容**：

```
┌────────────────────────────────────┐
│  导入移动端配置                       │
│                                    │
│  配置链接                            │
│  ┌──────────────────────────────┐  │
│  │ shibei://pair?v=1&salt=...   │  │
│  └──────────────────────────────┘  │
│                                    │
│  配对码         [384] [712]         │
│               ↑ 6 位数字输入框       │
│                                    │
│  [取消]          [确认导入]          │
└────────────────────────────────────┘
```

- envelope 文本框：Deep Link 入口时预填充；手动入口时为空，用户粘贴
- PIN 输入：6 位数字，分组显示
- 确认 → `cmd_import_pairing_config(envelope, pin)`
- 成功 → toast "配置已导入" → 关闭对话框 → SyncPage 刷新（`data:config-changed` 事件）
- 失败 → toast 翻译错误信息

### 6.4 i18n

桌面端新增（命名空间 `sync` + `common`）：

| Key | zh | en |
|-----|-----|-----|
| `sync.importFromMobile` | 导入配置 | Import Config |
| `sync.importDialogTitle` | 导入移动端配置 | Import Mobile Config |
| `sync.pasteEnvelopeUrl` | 粘贴配置链接 | Paste Config Link |
| `sync.enterPin` | 输入 6 位配对码 | Enter 6-digit pairing code |
| `sync.importSuccess` | 配置已导入 | Config imported |
| `common.error.pairingConfigAlreadyExists` | 配置已存在，请先清除现有配置 | Config already exists. Clear existing config first |

---

## 7. 改动清单

### 7.1 零改动

| 模块 | 原因 |
|------|------|
| `crates/shibei-pairing/` | `encrypt_payload` / `decrypt_payload` 已完备 |
| `crates/shibei-sync/src/pairing.rs` | 仅 desktop→mobile 的 encrypt 路径，不需要改 |
| `src-tauri/src/sync/pairing.rs` | 同上 |
| `cmd_generate_pairing_payload` | 同上 |
| `PairingDialog.tsx` | 桌面→手机流程独立 |

### 7.2 移动端

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `shibei-harmony/.../services/ShibeiService.ets` | Modify | 新增 `transferConfigToDesktop()` 方法 |
| `shibei-harmony/.../pages/PairingOutPage.ets` | Create | 新页面：PIN + envelope URL 显示 + 60s 倒计时 |
| `src-harmony-napi/src/commands.rs` | Modify | 新增 `encrypt_pairing_payload` NAPI 命令 |
| `shibei-harmony/.../pages/Settings.ets` | Modify | 同步分区新增按钮 |
| `resources/{zh_CN,en_US,base}/element/string.json` | Modify | 新增 8 条 i18n key |

### 7.3 桌面端

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/App.tsx` | Modify | `handleDeepLinkUrl` 新增 `shibei://pair?` 分支 |
| `src-tauri/src/commands/mod.rs` | Modify | 新增 `cmd_import_pairing_config` Tauri command |
| `src/components/Settings/PairingImportDialog.tsx` | Create | 新组件：PIN 输入 + envelope 粘贴 + 解密导入 |
| `src/components/Settings/PairingImportDialog.module.css` | Create | 样式 |
| `src/components/Settings/PairingImportDialog.test.tsx` | Create | 测试 |
| `src/components/Settings/SyncPage.tsx` | Modify | 新增「导入配置」按钮 |
| `src/locales/zh/sync.json` | Modify | 新增 5 条 i18n key |
| `src/locales/en/sync.json` | Modify | 同上 |
| `src/locales/zh/common.json` | Modify | 新增 1 条 error key |
| `src/locales/en/common.json` | Modify | 同上 |

---

## 8. 测试

### 8.1 `shibei-pairing` round-trip（已有）

```bash
cargo test -p shibei-pairing
```

13 个测试覆盖 encrypt→decrypt round-trip、错误 PIN、篡改等。

### 8.2 移动端 NAPI 单测

- Rust: `src-harmony-napi/src/commands.rs` 中 `encrypt_pairing_payload` 的 Rust 层单元测试（encrypt→decrypt round-trip）
- 端到端验证：`scripts/test-pairing-roundtrip.sh` 已有 desktop→CLI 路径；可扩展覆盖 NAPI→CLI 路径

### 8.3 桌面端 Tauri command 单测

`cmd_import_pairing_config` 测试：
1. 成功导入 → S3 配置写入
2. 错误 PIN → 返回 `error.pairingBadPin`
3. 无效 envelope → 返回 `error.pairingBadEnvelope`
4. 配置已存在 → 返回 `error.pairingConfigAlreadyExists`

### 8.4 前端组件测试

- `PairingImportDialog.test.tsx`：渲染测试、PIN 输入、envelope 粘贴、成功/失败 toast、Deep Link 预填充、手动入口为空
- `SyncPage.test.tsx`：确认「导入配置」按钮存在且可点击

### 8.5 端到端

```bash
# 1. 桌面端生成配置（验证现有流程）
cargo run -p shibei-pair-decrypt -- --pin 123456 ...
# 2. 上述流程在 NAPI 中 encrypt → 桌面 cmd 中 decrypt
# 3. 真机: 手机生成 → 桌面 open "shibei://pair?..."  → 验证 Deep Link
```

---

## 9. 约束与风险

| 约束 | 影响 |
|------|------|
| 用户需自行跨设备传 URL | 体验不如 QR 扫描自然，但零工程依赖 |
| `cmd_import_pairing_config` 检查配置已存在时拒绝覆盖 | 用户需手动在 Settings → 同步 清除旧配置后才可导入新配置 |
| 不含 E2EE 密码传输 | 桌面端导入后需另外设置加密（如已有加密数据则需输入密码） |
| 鸿蒙/macOS 无自动剪贴板同步 | 比 iOS/macOS 生态体验差，等 iOS 版 Shibei 落地后改善 |

---

## 10. 后续增强（V2，非本期）

- 手机桌面同在一个 WiFi 下时，mDNS 自动发现 + 直连传输
- 二维码 + WebCam 扫 QR（桌面端用 jsQR 实时解码）
- S3 短码中转：手机上传 envelope → 返回短码 → 桌面输入短码拉取
- iOS 版本落地后：Universal Clipboard / Handoff 一键传输
