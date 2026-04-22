# Phase 4 — HarmonyOS 移动端 App 锁屏 + HUKS 安全存储 设计

**Status**: approved (2026-04-22)

**Goal**: 为鸿蒙移动端补齐桌面级的"丢机防护"能力，同时让冷启动不再每次都要输 E2EE 密码。

**Outcome**: 用户启用 App 锁后，日常解锁靠生物识别（瞬间）或 4 位 PIN，E2EE 密码只在首次配对 / 恢复 / 忘 PIN 时出现。S3 凭据 + MK 包装 blob 离开设备即废，抵御 `hdc file recv` 级别的静态数据泄露。

---

## 1. 威胁模型与范围

### 1.1 本次解决

| 威胁 | 今天 | 本次 |
|---|---|---|
| 捡到已解锁手机的旁观者翻 app | 无防护 | PIN/生物识别门闸 + 30s grace period 后台锁 |
| `hdc file recv` / `adb pull` 拖整个 data dir | S3 凭据 + keyring 裸奔 | HUKS device-bound key 加密 S3 凭据；MK 不持久化，只存 HUKS wrap blob |
| app 被 kill 后冷启动 | 每次要输 E2EE 密码 | HUKS bio/PIN 解 wrap，不再要 E2EE 密码 |
| 忘 PIN | N/A（今天没 PIN） | 回退输 E2EE 密码重建本地 HUKS 包 |

### 1.2 本次不解决

| 威胁 | 决定 |
|---|---|
| SQLite 本体内容（资料正文 / 标注文本）被 dump | 明文——桌面也明文，sqlcipher 维护成本太高，单独议题 |
| 云端 S3 数据 | N/A——已 E2EE（XChaCha20-Poly1305） |
| 暴力离线爆破 4 位 PIN | 4 位数字熵 ~13 bits，靠 Rust 侧节流（5 错 30s / 10 错 5min）+ HUKS device-bound 加密阻挡离线分析 |
| 根权限 / TEE 被攻破 | 超出应用层能力，依赖 HUKS + 鸿蒙系统自身 |

### 1.3 明确的非目标

- 不改桌面 PIN 位数（继续 4 位）或桌面 PIN 存储（继续 Argon2 hash 入 OS Keychain）。桌面/手机 PIN 对齐的工作留给 Phase 5+。
- 不引入 sqlcipher 或任何 SQLite 加密层。
- 不引入远程擦除 / 设备注销能力。
- 不动 keyring.json 格式（E2EE 子系统零改动）。
- pairing envelope 保持"内存一过，不落盘"现状。

---

## 2. 架构

### 2.1 三层密钥

```
┌─ E2EE 密码（用户记忆，Argon2id 派生） ────── root
│     只在「首次配对 / 忘 PIN 恢复 / 重置」出现
│     派生 & 解开 keyring.json → MK
│
├─ MK（32 字节） ──── 运行时只在内存，Zeroizing 保护
│
│     HUKS wrap 两份副本（同一 MK 明文）
│
├─ HUKS bio-gated key wraps MK   → 日常路径（指纹/面部 → HUKS unwrap）
├─ HUKS PIN-KEK wraps MK         → 兜底路径（4 位 PIN → Argon2 verify + HKDF 派生 KEK → 解 wrap）
│
└─ HUKS device-bound key ──────── 静态数据加密（S3 凭据 + 所有 secure/*.blob 外层包裹）
                                   启动即可解，不走 PIN/生物识别
```

**关键不变式**：
- MK 永远不落盘明文。
- E2EE 密码不存任何地方（甚至不在设备上散列）——只靠 keyring.json 验证。
- PIN 只做 Argon2id hash 入 `pin_hash.blob`，不参与 MK 加密的 KEK 派生密钥材料以外的用途。
- PIN-KEK 和 bio-KEK 是两把独立的 HUKS key，各自包一份 MK 副本（同一明文，不同密文）。

### 2.2 状态机

```
        NotConfigured                   用户从未启用 App 锁
             │
             │ Settings → 启用（输 E2EE 密码 → 设 PIN → 可选生物识别）
             ↓
          Unlocked  ←──────────┐        MK 在内存
             │                 │
    onBackground                │ PIN / 生物识别成功
             │                 │
             ↓                 │
         GracePeriod            │        MK 仍在内存，UI 被 LockScreen 覆盖
         (30s timer)           │        回前台 < 30s → 回到 Unlocked
             │                 │
             │ 30s 到 / app 被 kill / 用户点「立即锁定」
             ↓                 │
           Locked ──────────────┘        MK zeroize，S3 凭据内存副本清
             │
             │ 忘记 PIN
             ↓
      RecoverWithE2EE                    输 E2EE 密码 → 重建 HUKS 包 → Unlocked
                                         （旧 bio key 失效，需要重新启用生物识别）
```

### 2.3 新增 / 改造模块

| 位置 | 职责 |
|---|---|
| `src-harmony-napi/src/secure_store.rs` 新建 | `SecureStore` trait + HUKS 实现。封装 device-bound wrap/unwrap、PIN-KEK 派生、HUKS bio-key 生成 |
| `src-harmony-napi/src/lock.rs` 新建 | 锁屏命令实现：setup/unlock/disable/recover、节流计数器持久化 |
| `src-harmony-napi/src/commands.rs` 改造 | 暴露 8 个新 NAPI 命令；改造 `set_s3_config` / 新增 `load_s3_creds` 走 `SecureStore` |
| `shibei-harmony/.../services/HuksService.ets` 新建 | 封装 `@kit.UniversalKeystoreKit` 和 `@kit.UserAuthenticationKit`（ArkTS 层，负责生物识别 prompt） |
| `shibei-harmony/.../services/LockService.ets` 新建 | 锁屏状态机 + 30s grace timer + 生命周期 hooks；订阅者模式让 UI 响应状态变化 |
| `shibei-harmony/.../pages/LockScreen.ets` 改造 | 从「输 E2EE 密码」→「PIN/生物识别」，E2EE 密码降为「忘记 PIN」入口 |
| `shibei-harmony/.../pages/Settings.ets` 改造 | 「安全」分区增加"启用 App 锁"开关 + PIN 修改 + 生物识别开关 |
| `shibei-harmony/.../pages/Onboard.ets` 改造 | 配对完成后可选 Step 4：启用 App 锁 |
| `shibei-harmony/.../entryability/EntryAbility.ets` 改造 | `onWindowStageCreate` / `onBackground` / `onForeground` 钩 LockService |

---

## 3. 磁盘布局与密钥

### 3.1 存储布局

```
{data_dir}/
├── shibei.db                         ← 不动
├── storage/                          ← 不动
├── preferences/
│   └── security.json                 ← ArkTS 侧状态
│        {
│          "lockEnabled": true,
│          "bioEnabled": true,
│          "failedAttempts": 0,
│          "lockoutUntil": 0,         ← ms epoch；节流时非 0
│          "pinVersion": 1
│        }
└── secure/                           ← 新增，所有 blob 外层经 HUKS device-bound key 加密
    ├── mk_pin.blob                   ← PIN-KEK wrapped MK（XChaCha20-Poly1305 密文）
    ├── mk_bio.blob                   ← HUKS bio-gated key wrapped MK
    ├── pin_hash.blob                 ← Argon2id hash of PIN + salt
    └── s3_creds.blob                 ← JSON {access_key, secret_key}
```

**所有 blob 读写都经 `SecureStore::wrap/unwrap`**——ArkTS 只看到字节数组（经 base64 过 NAPI），看不到 HUKS 的 handle。

### 3.2 HUKS 密钥别名

| 别名 | 用途 | userAuth | 可导出 | 生命周期 |
|---|---|---|---|---|
| `shibei_device_bound_v1` | device-bound 主加密 | 否 | 否 | 首次启动生成，永不轮换 |
| `shibei_pin_kek_v1` | （保留，当前版本 KEK 在 Rust 侧派生，此 key 暂不实际使用；v2 升级为 HUKS USER_AUTH challenge 时启用） | 否 | 否 | — |
| `shibei_bio_kek_v1` | 生物识别 gated KEK | `authType: FINGERPRINT\|FACE`，`authAccessType: INVALID_NEW_BIO_ENROLL`，ATL2 | 否 | 启用生物识别时生成；指纹变更或停用时删 |

**版本后缀 `_v1`**：密钥规格如果改动（比如算法/长度/授权等级），别名升版，老别名解老数据做迁移后删。

### 3.3 PIN-KEK 派生

```
salt = random 16 bytes（存 pin_hash.blob 里）
kek  = HKDF-SHA256(
          ikm = Argon2id(pin, salt, memory=19MiB, iters=2, parallelism=1),
          salt = salt,
          info = b"shibei-mobile-lock-v1",
          length = 32,
       )
```

为什么 Argon2 + HKDF 而不是直接 Argon2 当 KEK：Argon2 的 output 可以直接用，但 HKDF 把"派生密钥"和"hash 验证"两条路径的派生函数分开（避免 KEK 和 hash 共用输出空间），也给 v2 切 HUKS USER_AUTH 时的迁移留口子。

**Argon2 参数**：memory=19 MiB, iters=2, parallelism=1——和桌面 `os_keystore` 对齐；移动端 Mate X5 实测 ~250ms，可接受。

### 3.4 wrap / unwrap 算法

- MK wrap: `XChaCha20-Poly1305(nonce 24B random, AAD = b"shibei-mk-v1", plaintext = MK)`——AAD 不掺设备 id，因为 blob 已经被 HUKS device-bound key 外层加密（换设备直接解不开最外层），不需要重复防 replay
- 外层 HUKS wrap：`HUKS_ALG_AES + KEY_PURPOSE_ENCRYPT|DECRYPT`（AES-256-GCM），HUKS 内部管 nonce

---

## 4. NAPI 命令

所有命令标量 ABI（string / bool / i32），错误返回 `String` 以 `"error."` 开头的 i18n key。

### 4.1 状态查询（sync）

```rust
#[shibei_napi] pub fn lock_is_configured() -> bool
  // 读 preferences/security.json 的 lockEnabled
#[shibei_napi] pub fn lock_is_bio_enabled() -> bool
  // 读 bioEnabled
#[shibei_napi] pub fn lock_is_mk_loaded() -> bool
  // 桥接到 EncryptionState：MK 在内存 = true
  // 注意：MK 在内存 ≠ UI 已解锁——Grace 态 MK 还在但 UI 锁。UI 状态由 ArkTS LockService 维护
#[shibei_napi] pub fn lock_lockout_remaining_secs() -> i32
  // 节流剩余秒数；<=0 表示未节流
```

### 4.2 启用 / 停用（async）

```rust
#[shibei_napi(async)] pub async fn lock_setup_pin(pin: String) -> Result<String, String>
  // 前提：MK 在内存（E2EE 已解锁）
  // 动作：
  //   1. 验 pin 合法（4 位数字）
  //   2. 生成 salt + Argon2 hash → secure/pin_hash.blob
  //   3. HKDF 派生 KEK → XChaCha20-Poly1305 包 MK → secure/mk_pin.blob
  //   4. 更新 preferences: lockEnabled=true, failedAttempts=0
  //   5. 返回 "ok"

#[shibei_napi(async)] pub async fn lock_enable_bio(auth_token: String) -> Result<String, String>
  // 前提：lockEnabled && MK 在内存
  // 入参：ArkTS 已做完 UserAuth.authV9，传回的 authToken（base64）
  // 动作：
  //   1. HUKS 生成 bio-gated key（authType=FINGERPRINT|FACE, ATL2, INVALID_NEW_BIO_ENROLL）
  //   2. 用该 key 包 MK → secure/mk_bio.blob
  //   3. bioEnabled=true

#[shibei_napi(async)] pub async fn lock_disable(pin: String) -> Result<String, String>
  // 验 PIN → 删 mk_pin.blob / mk_bio.blob / pin_hash.blob
  //         → 删 HUKS shibei_bio_kek_v1
  //         → lockEnabled=false, bioEnabled=false
```

### 4.3 解锁（async）

```rust
#[shibei_napi(async)] pub async fn lock_unlock_with_pin(pin: String) -> Result<String, String>
  // 节流检查：lockout_remaining_secs > 0 → "error.lockThrottled:<secs>"
  // Argon2 verify → 失败 → failedAttempts++；5/10/15… 次对应 30s/5min/30min 节流
  // 成功：派生 KEK → 解 mk_pin.blob → 推 MK 进 EncryptionState → failedAttempts=0

#[shibei_napi(async)] pub async fn lock_unlock_with_bio(auth_token: String) -> Result<String, String>
  // ArkTS 已做完 UserAuth.authV9，传回 token
  // HUKS init + update + finish 用 shibei_bio_kek_v1（HUKS 自己验 token）
  // 成功：解 mk_bio.blob → 推 MK
  // 失败（KEY_AUTH_VERIFY_FAILED = 指纹库变了）：清 mk_bio.blob + 删 HUKS key，返回 "error.bioRevoked"
```

### 4.4 恢复（async）

```rust
#[shibei_napi(async)] pub async fn lock_recover_with_e2ee(password: String, new_pin: String) -> Result<String, String>
  // 走 set_e2ee_password 内部逻辑：拉 keyring.json → Argon2id 派生 → 解 MK 入 EncryptionState
  // 若成功：
  //   → 清 mk_pin.blob / mk_bio.blob / pin_hash.blob
  //   → 删 shibei_bio_kek_v1
  //   → 调 setup_pin(new_pin)
  //   → bioEnabled=false（用户要在 Settings 重启用）
  //   → failedAttempts=0, lockoutUntil=0
```

### 4.5 S3 凭据改造（不是新命令，是改造现有）

```rust
// 改造现有 set_s3_config：
// 入参不变，但写入前序列化 {access_key, secret_key} 为 JSON
// → SecureStore::wrap_device_bound → secure/s3_creds.blob
// SQLite config 表只保留 bucket / endpoint / region（非敏感）

// 新增 load_s3_creds（启动时 Rust 内部调用，不走 NAPI）：
// 读 secure/s3_creds.blob → unwrap → JSON 反序列化 → 喂 SyncEngine
// 失败（blob 不存在或解密失败）：S3 未配置状态
```

---

## 5. ArkTS 层

### 5.1 LockService.ets

```typescript
export enum LockState { NotConfigured, Unlocked, GracePeriod, Locked }

export class LockService {
  private state: LockState
  private graceTimerId: number = -1
  private subscribers: ((s: LockState) => void)[] = []
  private readonly GRACE_MS = 30 * 1000

  async initialize(): Promise<void>                  // app 启动时根据 napi.lock_is_configured / is_unlocked 确定初始状态
  subscribe(cb: (s: LockState) => void): () => void  // 返回 unsubscribe 函数
  getState(): LockState

  async unlockWithPin(pin: string): Promise<void>    // 节流错误由调用方抛给 UI
  async unlockWithBio(): Promise<void>               // 内部先调 UserAuth.authV9 拿 token
  async lockNow(): Promise<void>                     // 立即锁 → napi.lockVault + state=Locked
  async setupPin(pin: string): Promise<void>
  async enableBio(): Promise<void>
  async disable(pin: string): Promise<void>

  onBackgrounded(): void                             // state=Unlocked → 启动 30s grace
  onForegrounded(): void                             // grace 未到 → 回 Unlocked；已到 → state=Locked
  onKilled(): void                                   // 理论上不会在进程 alive 时触发；Drop 自然 zeroize
}
```

### 5.2 EntryAbility.ets 生命周期

```typescript
onWindowStageCreate(stage) {
  // 已有：注册 scheme
  await LockService.instance.initialize()
  const initial = LockService.instance.getState()
  if (initial === LockState.Locked) {
    stage.loadContent('pages/LockScreen')
  } else if (hasSavedConfig()) {
    stage.loadContent('pages/Library')  // Unlocked / NotConfigured 都进 Library
  } else {
    stage.loadContent('pages/Onboard')
  }
}
onBackground() { LockService.instance.onBackgrounded() }
onForeground() { LockService.instance.onForegrounded() }
```

**路由切换**：LockService 订阅者在 `state → Locked` 时调 `router.replaceUrl('pages/LockScreen')`；`state → Unlocked` 时 `router.replaceUrl('pages/Library')`。用户在 Settings 点「立即锁定」也走这条路径。

### 5.3 LockScreen.ets 改造后

```
进入页面时：
  若 bioEnabled 且系统生物识别可用 → 立即调 UserAuth.authV9
    成功 → unlockWithBio → 跳回 Library
    失败/取消 → 留在 LockScreen 等 PIN

UI：
  [标题：已锁定]
  [PIN 输入：4 位圆点]  ← 填满自动提交
  [🔒 使用生物识别]     ← 若 bioEnabled
  [错误提示 / 节流倒计时]
  [忘记 PIN？]         ← 弱链接，点击展开 E2EE 密码输入
```

### 5.4 Settings.ets 改造后

```
【外观】 ... (不变)
【同步】 ... (不变)
【安全】
  [开关：启用 App 锁]          ← lockEnabled
    启用流程（开关 off→on）：
      1. 弹 PIN 设置对话框（4 位，两次确认）
      2. 询问「是否启用生物识别解锁？」→ 若选是 → 调 UserAuth + enableBio
      3. 成功 → 开关显示 on
    停用流程（on→off）：
      1. 弹 PIN 验证对话框
      2. 成功 → 调 lock_disable → 开关显示 off

  [仅当 lockEnabled]
  [修改 PIN]                  ← 弹「输当前 PIN → 输新 PIN → 确认新 PIN」
  [开关：生物识别解锁]          ← bioEnabled；需 lockEnabled
  [立即锁定]                  ← 已有，行为不变

【数据】 ... (不变)
```

### 5.5 Onboard.ets 改造后

```
Step 1-3：扫码 → 输 pairing PIN → 输 E2EE 密码（不变）
Step 4（新增，可跳过）：
  【启用 App 锁？】
  为这台设备设置 4 位 PIN，日常解锁可以用指纹或面部识别。
  [设置 PIN]  ← 主按钮，进 PIN 设置子流程
  [暂不启用]  ← 次按钮，直接进 Library
```

---

## 6. 失败处理矩阵

| 场景 | 行为 |
|---|---|
| HUKS 服务不可用（系统异常） | 启用时 toast `error.huksUnavailable` + 不写任何 blob；已启用时解锁失败 → 引导 recover |
| 生物识别不可用（用户没录） | 启用开关生物识别项置灰 + 文案「请先在系统设置中添加指纹/面部」 |
| 指纹库变更（`KEY_AUTH_VERIFY_FAILED`） | 清 `mk_bio.blob` + 删 `shibei_bio_kek_v1` + toast `error.bioRevoked` + 本次走 PIN；Settings 显示「生物识别已失效，点击重新启用」 |
| PIN 错 5 次 | 节流 30s；再 5 次 → 5min；再 5 次 → 30min。`lockoutUntil` 写 `preferences/security.json`，重启生效 |
| 节流期间 PIN 框 disabled + 显示倒计时 | 每秒刷新；到点自动恢复 |
| 忘 PIN | LockScreen 底部「忘记 PIN」→ 展开 E2EE 密码输入 + 新 PIN 输入 → `lock_recover_with_e2ee` |
| HUKS blob 存在但 unwrap 失败（极端：存储损坏） | 提示 `error.secureStoreCorrupted` → 引导「重置设备」清 secure/ + preferences + 回 Onboard |
| `load_s3_creds` 失败（blob 损坏） | 启动时 SyncEngine 视作未配置；Settings 同步分区提示「凭据不可用，请重新配对」 |
| cold start 时 preferences.json 被删但 secure/ 还在 | `lock_is_configured() = false` → 走 NotConfigured；secure/ 残留文件由 `SecureStore::init` 检测并清 |
| 用户在 Settings 停用锁屏 | 先验 PIN → 删所有 secure/ 里的 mk/pin blob + HUKS keys；**S3 凭据的 device-bound blob 保留**（停用锁屏 ≠ 退出 E2EE） |

---

## 7. 同步引擎对接

- **Unlocked / Grace**：sync 正常跑。MK 在 `EncryptionState`，S3 凭据已从 blob 解出。
- **Locked**：`SyncService::sync()` 返回 `error.vaultLocked` 立即失败，UI 降级提示「请先解锁」。
- **NotConfigured**：和今天行为完全一致——MK 运行时在内存，kill 之后重启要求 E2EE 密码（老路径）。

**S3 凭据的生命周期**：
- app 启动（任何状态）→ `load_s3_creds` 成功 → `SyncEngine::set_credentials`
- Lock → MK 清了，但 S3 凭据还在 SyncEngine（因为它和 PIN 闸门解耦）
- 用户注销设备 / 停用锁屏 → S3 凭据不受影响（独立生命周期）

---

## 8. 测试策略

### 8.1 Rust 单元测试（`src-harmony-napi` 内 `mod tests`）

- `SecureStore` trait 有一个 `InMemoryStore` 实现（HUKS 在 macOS 无法测，所以抽象）。所有 lock 逻辑 Rust 测试用 `InMemoryStore`。
- PIN hash 生成 / 验证 round-trip
- PIN-KEK 派生 + XChaCha20-Poly1305 wrap/unwrap round-trip（包括 AAD 篡改检测）
- 节流计数器：阶梯 5/10/15 → 30s/5min/30min；`lockoutUntil` 跨重启持久化
- 错误 PIN：`failedAttempts` 递增；正确 PIN：归零
- `lock_recover_with_e2ee`：旧 mk_bio.blob 被清除 + bioEnabled=false
- 边界：PIN 非 4 位数字 → `error.pinMustBe4Digits`

### 8.2 手机端手动验证（ssh + hdc 远程）

冒烟清单（每条都要过）：

1. 冷启动未配对 → Onboard
2. Onboard 跳过启用 App 锁 → 进 Library（老路径，lockEnabled=false）
3. Settings → 启用 App 锁 → 设 PIN → 启用生物识别 → kill app → 冷启动显示 LockScreen
4. 指纹解锁 → 秒进 Library
5. 切后台 20 秒回来 → 不需要重认证
6. 切后台 60 秒回来 → 要求重认证，MK 已 zeroize（可用 hilog 验证）
7. PIN 连错 5 次 → 节流 30s；kill + 重启 → 仍在节流（倒计时继续走）
8. 录入新指纹 → 启动 app → 生物识别失败 `error.bioRevoked` → PIN 路径可用 → Settings 重新启用生物识别
9. 忘 PIN → 输 E2EE 密码 + 新 PIN → 正常解锁；旧 bio 已失效，Settings 需重启用
10. `hdc file recv` 把 `data/` 拖到 Mac → 检查 `secure/*.blob` 都是密文；在 Mac 上用 pair-decrypt CLI（无 HUKS）无法解开
11. 手机 ↔ 桌面 annotation round-trip（确认 MK 经 HUKS 出入没丢数据）
12. Settings → 立即锁定 → LockScreen 出现；生物识别解回来 → MK 重新在内存 → sync 恢复

### 8.3 安全审计 checklist

- `Zeroizing<[u8; 32]>` 包裹所有 MK 明文中间变量
- PIN 输入框内存保留时间：`lock_unlock_with_pin` 返回后立即清 `pin: String`（ArkTS 和 Rust 两端）
- 没有任何 `hilog` / `println!` / `eprintln!` 打印 PIN / MK / KEK / auth_token
- 节流计数 `failedAttempts` 只递增，不因 app kill 重置
- HUKS key 生成时 `authAccessType: INVALID_NEW_BIO_ENROLL` 必须设置（指纹变更触发失效）
- `error.*` i18n key 覆盖所有失败分支，中英文 locale 都补

---

## 9. CLAUDE.md 更新

`## 架构约束` 段落末尾增补一条：

> **鸿蒙 App 锁屏（Phase 4）**：Settings → 安全 → 启用 App 锁 = 4 位 PIN + 可选生物识别。PIN Argon2id hash 存 `secure/pin_hash.blob`；MK 经 `XChaCha20-Poly1305` 包两份：PIN-KEK wrap 入 `secure/mk_pin.blob`，HUKS bio-gated key wrap 入 `secure/mk_bio.blob`。**所有 `secure/*.blob` 外层再经 HUKS device-bound key（`shibei_device_bound_v1`）加密**，离开设备立废。S3 凭据同样走 device-bound 包装（`secure/s3_creds.blob`），启动透明解密，**不走 PIN 闸门**（为了锁屏时后台同步能跑）。锁屏状态机：`NotConfigured / Unlocked / GracePeriod(30s) / Locked`；`onBackground` 起 30s grace timer，回前台 < 30s 直接 Unlocked，≥ 30s → MK `Zeroizing::zeroize` → 路由到 `pages/LockScreen`；进程被 kill 后冷启必锁。忘 PIN 回退 E2EE 密码 → `lock_recover_with_e2ee` 重建 HUKS 包（**旧 bio key 失效，需在 Settings 重启用**）。节流：错 5 次锁 30s，每累计 5 次错上一档（30s → 5min → 30min），`lockoutUntil` 写 `preferences/security.json` 跨重启生效。HUKS 密钥别名 `shibei_device_bound_v1` / `shibei_bio_kek_v1`（`_pin_kek_v1` 保留占位，v1 的 PIN-KEK 在 Rust 侧 HKDF-SHA256 派生而不走 HUKS USER_AUTH challenge）。指纹库变更（`KEY_AUTH_VERIFY_FAILED`）自动清 `mk_bio.blob`。

---

## 10. 开放问题（实施时确认，不阻塞设计）

- HUKS 在鸿蒙模拟器上是否可用——若只真机，测试矩阵里标注「需真机」
- `@kit.UserAuthenticationKit` 的 `authV9` 在 Mate X5 不同版本 ROM 的 API 行为一致性
- 30s grace timer 精度：鸿蒙 `setTimeout` 在 app 后台能否继续计时——若不行，用 `onForeground` 时刻 `Date.now() - lastBackgroundedAt` 自判断
- Argon2 参数在 Mate X5 实测耗时是否超过 500ms——超过就下调 memory

---

## 11. 范围与里程碑

**单一 phase**，目标是把整套 HUKS + PIN + 生物识别 + grace 锁屏 + S3 凭据加密一次落地。分 11–13 个 task 实施（具体见后续 plan 文档）：

1. `SecureStore` trait + `InMemoryStore` 测试桩
2. HUKS device-bound key 实现 + S3 凭据改造
3. PIN-KEK 派生 + wrap/unwrap + 单测
4. 锁屏 NAPI 命令（setup/unlock/disable/recover）+ 节流
5. HUKS bio-gated key 实现 + ArkTS UserAuth 集成
6. `LockService.ets` 状态机
7. `EntryAbility` 生命周期 hooks
8. `LockScreen.ets` UI 改造
9. `Settings.ets` 安全分区扩展
10. `Onboard.ets` 可选 Step 4
11. i18n（zh/en）
12. 手机端冒烟测试
13. CLAUDE.md 更新 + memory 追加

工时估算：**3–4 天**（不含真机调试的未知阻塞）。
