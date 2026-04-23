# Phase 5.1 — HarmonyOS 移动端 i18n + 深色主题打通 Implementation Plan

> **For agentic workers:** 按 task 顺序逐个 commit；每 task 一次提交，message 用 `feat(harmony):` / `refactor(harmony):` / `fix(harmony):`。

**Goal:** 把鸿蒙端 ~250 处硬编码中文与 ~60 处 hex 颜色全部抽到资源体系，建立 zh/en 双语 + light/dark 双主题基础设施，达到 AGC 提交前的可演示水准。

**Background:** 走查报告（2026-04-23）发现：
- i18n 完全缺失 —— 无 `zh_CN/` `en_US/` 资源限定目录、无 `t()` 服务，[pages/Settings.ets](shibei-harmony/entry/src/main/ets/pages/Settings.ets)（66 行 CJK） / [pages/Onboard.ets](shibei-harmony/entry/src/main/ets/pages/Onboard.ets)（59 行）/ [pages/Reader.ets](shibei-harmony/entry/src/main/ets/pages/Reader.ets)（20 行）等全部硬编码
- 主题只到 `appCtx.setColorMode()` 切系统 chrome —— [app/ThemeManager.ets:5-8](shibei-harmony/entry/src/main/ets/app/ThemeManager.ets#L5-L8) 自己注释承认 page UI 是 hex 硬编码；无 `resources/dark/element/color.json`；Reader.ets 未设 `darkMode(WebDarkMode.Auto)`；pdf-shell `style.css` 全 light 写死

**Architecture:**

- **i18n** 用鸿蒙原生 `resourceManager.getStringSync(resource, ...args)` —— 不引第三方库（i18next 在 ArkTS 用不上，且系统 API 已经支持 `%s` `%d` 占位符 + 资源限定目录自动切语言）
- **资源限定目录**：`resources/base/`（默认 / fallback）+ `resources/zh_CN/element/string.json` + `resources/en_US/element/string.json` + `resources/dark/element/color.json`，鸿蒙系统按设备语言/主题自动选
- **i18n 包装**：新建 [services/I18n.ets](shibei-harmony/entry/src/main/ets/services/I18n.ets) 提供 `t(key: Resource, ...args): string` 单一入口，所有调用走 `$r('app.string.xxx')` 引资源（编译期检查 + 类型安全）
- **色板包装**：所有页面用 `$r('app.color.xxx')`（不直接写 hex），dark qualifier 自动 override
- **WebView 黑暗模式**：Reader.ets 加 `.darkMode(WebDarkMode.Auto)` + `.forceDarkAccess(false)`（让网页自己处理而不是反色）；pdf-shell `style.css` 加 `@media (prefers-color-scheme: dark)` 块；annotator-mobile.js / pdf-annotator-mobile.js 高亮色保持桌面同色（标注数据跨端共享，不做 dark 反转）
- **桌面对齐**：i18n key 命名沿用桌面 11 namespace 习惯（前缀 `common_` / `sync_` / `lock_` / `reader_` / `annotation_` / `settings_` / `search_` / `data_` / `encryption_` / `ai_` / `sidebar_`）—— 鸿蒙 string.json 是平铺 key 不能嵌套，用 `_` 分割模拟 namespace；占位符语法用鸿蒙原生 `%s` `%d` `%1$s`，文档里标注每个 key 的 placeholder 顺序

**Tech Stack:** ArkTS（`@kit.LocalizationKit` 的 `resourceManager` + `i18n` API）+ ArkUI（`$r('app.string.xxx')` / `$r('app.color.xxx')`）+ 真机验证（Mate X5，hdc shell 切语言/主题）。

**Out of scope:**
- WebView 内 annotator-mobile.js / pdf-annotator-mobile.js 的字符串国际化（当前只有英文 console.warn，无用户可见 UI 文案）
- 字号/字体/行距偏好（已在 spec §十一未决项 v2+）
- 高亮色板 dark 反转（数据跨端，保持桌面同色）

---

## 约束索引

- 每 task 独立 commit，跨文件改动 ≤ 6 个文件（可分批）
- `string.json` 每次新增 zh + en 两份必须同步（PR diff 必须 1:1）
- `color.json` 每次新增 base + dark 两份必须同步
- 不允许 `String + ' ' + variable` 拼接 —— 一律走 `t()` + 占位符
- 不允许保留任何 hex 颜色文字面量（除高亮色板 `HL_COLORS`，这是数据不是样式）
- 真机验证命令：`ssh inming@192.168.64.1 "hdc shell aa start ..."`、`hdc shell setprop persist.sys.locale en-US`（切语言后需 `aa force-stop` 重启 app）
- ArkTS UI 文本默认走 `Text($r('app.string.key'))` —— 但在 `ifElse` 拼接 / 模板字符串内必须改用 `Text(this.i18n.t($r('app.string.key'), arg))`

---

## File Structure

### 新建

```
shibei-harmony/entry/src/main/
  ets/services/
    I18n.ets                          ← t(resource, ...args) + locale 检测 + 单例

  resources/zh_CN/element/
    string.json                       ← 所有中文 UI 文案（key 沿桌面 namespace）
  resources/en_US/element/
    string.json                       ← 英文翻译（1:1 镜像 zh_CN）
  resources/dark/element/
    color.json                        ← 深色主题色 token override
```

### 扩展

```
shibei-harmony/entry/src/main/
  resources/base/element/
    string.json                       ← 仅保留 entry_label / app_name / 权限说明（fallback）
    color.json                        ← 扩展为完整色板 token（~30 个，对齐桌面 variables.css）

  ets/pages/
    Settings.ets                      ← 替换 66 行 CJK + 9 处 hex
    Onboard.ets                       ← 替换 59 行 CJK + 26 处 hex
    Reader.ets                        ← 替换 20 行 CJK + 8 处 hex（HL_COLORS 保留） + 加 darkMode
    LockScreen.ets                    ← 替换 19 行 CJK + 3 处 hex
    Search.ets                        ← 替换 13 行 CJK
    Library.ets                       ← 替换 4 行 CJK + 3 处 hex
  ets/components/
    AnnotationPanel.ets               ← 15 行 CJK + 4 处 hex
    FolderDrawer.ets                  ← 8 行 CJK
    ResourceList.ets                  ← 3 行 CJK + 4 处 hex
    ResourceItem.ets                  ← 1 行 CJK
  ets/services/
    HuksService.ets                   ← 1 行 CJK（auth title 文案）

  resources/rawfile/pdf-shell/
    shell.html                        ← "加载中…" → 走 URL 参数注入翻译
    style.css                         ← 加 @media (prefers-color-scheme: dark) 块
    main.js                           ← 解析 URL 参数 ?lang=xx 设置 status 文案
```

---

## Task 0: 桌面 key 清单提取（准备工作）

**Goal:** 把鸿蒙 11 个 .ets 文件里所有用户可见中文逐条提取，对齐桌面 namespace 命名，产出 zh/en 草稿表（CSV 或 markdown table），后续每个 task 对照填充。**这是「思考成本」最高的一步，做完后续任务就是机械替换。**

**Files:**
- Create: `docs/superpowers/plans/2026-04-23-harmony-i18n-keys.md`（草稿表，task 完成后保留作翻译档案）

- [ ] **Step 1: 列所有硬编码字符串**

  ```bash
  for f in shibei-harmony/entry/src/main/ets/pages/*.ets \
           shibei-harmony/entry/src/main/ets/components/*.ets \
           shibei-harmony/entry/src/main/ets/services/HuksService.ets; do
    echo "=== $f ==="
    grep -nE "['\"][^'\"]*[一-鿿][^'\"]*['\"]" "$f"
  done > /tmp/harmony-cjk.txt
  ```

- [ ] **Step 2: 按文件归类成 key 表**

  格式（markdown table）：

  | namespace | key | zh | en | placeholders | 出处 |
  |---|---|---|---|---|---|
  | settings | settings_pin_must_be_4_digits | PIN 必须是 4 位数字 | PIN must be 4 digits | — | Settings.ets:66 |
  | settings | settings_sync_complete | 同步完成 ↑%1$d ↓%2$d | Sync complete ↑%1$d ↓%2$d | uploaded, downloaded | Settings.ets:190 |
  | onboard | onboard_decrypt_success | 解密成功，%1$d 项配置已自动填入 | Decrypted, %1$d fields auto-filled | count | Onboard.ets:xxx |

- [ ] **Step 3: 校对**
  - 桌面已存在的相同语义 key 必须复用同一 zh 文案（保持术语一致：「资料」「文件夹」「标注」「同步」「锁屏」「PIN」）
  - 占位符顺序统一用 `%1$s` `%2$d` 样式（鸿蒙 `getStringSync` 支持）
  - 估算总量 200~250 个 key

**Commit:** `docs(harmony): extract i18n key checklist for Phase 5.1`

---

## Task 1: i18n 基础设施 + 资源限定目录

**Goal:** 建 `services/I18n.ets` 单例 + zh_CN/en_US/base 三套 `string.json` 骨架（先放 5 个 `common_*` key 跑通），ArkTS 调用 `I18n.t($r('app.string.common_save'))` 拿翻译。**真机切语言能看到中英切换才算通过。**

**Files:**
- Create: `shibei-harmony/entry/src/main/ets/services/I18n.ets`
- Create: `shibei-harmony/entry/src/main/resources/zh_CN/element/string.json`
- Create: `shibei-harmony/entry/src/main/resources/en_US/element/string.json`
- Modify: `shibei-harmony/entry/src/main/resources/base/element/string.json`（fallback 与 zh_CN 内容相同）

- [ ] **Step 1: 写 I18n.ets**

  ```typescript
  // shibei-harmony/entry/src/main/ets/services/I18n.ets
  import { common } from '@kit.AbilityKit';
  import { hilog } from '@kit.PerformanceAnalysisKit';

  export class I18n {
    private static _ctx: common.UIAbilityContext | null = null;

    static init(ctx: common.UIAbilityContext): void {
      I18n._ctx = ctx;
    }

    /** Sync lookup by Resource ($r('app.string.key')) with optional placeholders. */
    static t(res: Resource, ...args: (string | number)[]): string {
      if (!I18n._ctx) {
        hilog.warn(0x0000, 'shibei', 'I18n.t called before init');
        return '';
      }
      try {
        return I18n._ctx.resourceManager.getStringSync(res, ...args);
      } catch (err) {
        hilog.warn(0x0000, 'shibei', 'I18n.t failed: %{public}s', (err as Error).message);
        return '';
      }
    }
  }
  ```

- [ ] **Step 2: EntryAbility.onCreate 初始化**

  在 `EntryAbility.ets` `onCreate` 末尾加：

  ```typescript
  import { I18n } from '../services/I18n';
  // ...
  I18n.init(this.context);
  ```

- [ ] **Step 3: 写三份 string.json 骨架**

  `resources/zh_CN/element/string.json`:
  ```json
  {
    "string": [
      { "name": "common_save", "value": "保存" },
      { "name": "common_cancel", "value": "取消" },
      { "name": "common_confirm", "value": "确认" },
      { "name": "common_delete", "value": "删除" },
      { "name": "common_loading", "value": "加载中…" }
    ]
  }
  ```

  `resources/en_US/element/string.json`:
  ```json
  {
    "string": [
      { "name": "common_save", "value": "Save" },
      { "name": "common_cancel", "value": "Cancel" },
      { "name": "common_confirm", "value": "Confirm" },
      { "name": "common_delete", "value": "Delete" },
      { "name": "common_loading", "value": "Loading…" }
    ]
  }
  ```

  `resources/base/element/string.json`（保留 entry_label / 权限说明 + 镜像 zh_CN 5 个 key 作 fallback）

- [ ] **Step 4: 在 Library.ets 跑一个 smoke 测试**

  挑 1 处中文（比如某个 toast）改成 `I18n.t($r('app.string.common_loading'))`，编译通过即可。

- [ ] **Step 5: 真机验证**

  ```bash
  ssh inming@192.168.64.1 "hdc shell setprop persist.sys.locale en-US && hdc shell aa force-stop com.shibei.app && hdc shell aa start -a EntryAbility -b com.shibei.app"
  ```
  打开 Library 页，看那处 toast 是否英文；切回 `zh-CN` 看中文。

**Commit:** `feat(harmony): i18n service + zh_CN/en_US resource scaffold`

---

## Task 2: 主题色板基础设施 + dark qualifier

**Goal:** 把 `resources/base/element/color.json` 扩成完整色板（~30 token，对齐桌面 [src/styles/variables.css](src/styles/variables.css)），新建 `resources/dark/element/color.json` 同名 override。挑 Library.ets 头栏 1-2 处 hex 替换成 `$r('app.color.xxx')` 跑通切换。

**Files:**
- Modify: `shibei-harmony/entry/src/main/resources/base/element/color.json`
- Create: `shibei-harmony/entry/src/main/resources/dark/element/color.json`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Library.ets`（smoke 1-2 处）

- [ ] **Step 1: 看桌面 variables.css 抄 token 名**

  ```bash
  cat src/styles/variables.css | head -80
  ```

  抽出常用 token，命名约定：
  - `bg_primary` / `bg_secondary` / `bg_elevated`
  - `text_primary` / `text_secondary` / `text_tertiary` / `text_disabled`
  - `border_default` / `border_strong`
  - `accent_primary`（蓝 `#2b7de9`）/ `accent_danger`（红 `#d33`）
  - `surface_hover` / `surface_pressed`
  - `shadow_default`（半透明 `#40000000`）

- [ ] **Step 2: base/element/color.json**

  ```json
  {
    "color": [
      { "name": "start_window_background", "value": "#FFFFFF" },
      { "name": "bg_primary", "value": "#FFFFFF" },
      { "name": "bg_secondary", "value": "#F5F5F5" },
      { "name": "bg_elevated", "value": "#FFFFFF" },
      { "name": "text_primary", "value": "#222222" },
      { "name": "text_secondary", "value": "#666666" },
      { "name": "text_tertiary", "value": "#888888" },
      { "name": "text_disabled", "value": "#BBBBBB" },
      { "name": "border_default", "value": "#EEEEEE" },
      { "name": "border_strong", "value": "#DDDDDD" },
      { "name": "accent_primary", "value": "#2B7DE9" },
      { "name": "accent_danger", "value": "#D33333" },
      { "name": "surface_hover", "value": "#F0F0F0" },
      { "name": "shadow_default", "value": "#40000000" }
    ]
  }
  ```

- [ ] **Step 3: dark/element/color.json**（同名 key，深色取值）

  ```json
  {
    "color": [
      { "name": "start_window_background", "value": "#1A1A1A" },
      { "name": "bg_primary", "value": "#1A1A1A" },
      { "name": "bg_secondary", "value": "#0F0F0F" },
      { "name": "bg_elevated", "value": "#262626" },
      { "name": "text_primary", "value": "#E8E8E8" },
      { "name": "text_secondary", "value": "#A0A0A0" },
      { "name": "text_tertiary", "value": "#777777" },
      { "name": "text_disabled", "value": "#555555" },
      { "name": "border_default", "value": "#333333" },
      { "name": "border_strong", "value": "#444444" },
      { "name": "accent_primary", "value": "#5B9DF9" },
      { "name": "accent_danger", "value": "#E55757" },
      { "name": "surface_hover", "value": "#2A2A2A" },
      { "name": "shadow_default", "value": "#80000000" }
    ]
  }
  ```

- [ ] **Step 4: Library.ets smoke**

  挑头栏标题 / 背景 1-2 处 hex 改成 `.fontColor($r('app.color.text_primary'))` `.backgroundColor($r('app.color.bg_primary'))`。

- [ ] **Step 5: 真机验证**

  Settings → 主题切到 dark（或 hdc 改 `setprop persist.sys.dark_mode 1`），看 Library 头栏色对调。

**Commit:** `feat(harmony): color token system + dark qualifier`

---

## Task 3: Settings.ets 全量替换（66 CJK + 9 hex，最大头）

**Goal:** Settings.ets 替换全部硬编码字符串 + hex 颜色，按 Task 0 表里的 `settings_*` key 落表。

**Files:**
- Modify: `shibei-harmony/entry/src/main/resources/zh_CN/element/string.json`（追加 `settings_*` 所有 key）
- Modify: `shibei-harmony/entry/src/main/resources/en_US/element/string.json`（同步追加）
- Modify: `shibei-harmony/entry/src/main/resources/base/element/string.json`（同步追加）
- Modify: `shibei-harmony/entry/src/main/ets/pages/Settings.ets`

- [ ] **Step 1: 把 Task 0 表里 `settings_*` 行全部填进 zh/en/base string.json**

- [ ] **Step 2: Settings.ets 逐处替换**

  - `Text('启用生物识别?')` → `Text(I18n.t($r('app.string.settings_bio_enroll_title')))`
  - 带占位的 `'同步完成 ↑${u} ↓${d}'` → `I18n.t($r('app.string.settings_sync_complete'), u, d)`
  - 颜色 `.fontColor('#666')` → `.fontColor($r('app.color.text_secondary'))`

- [ ] **Step 3: 真机验证**

  Settings 页中英切换 + light/dark 切换全跑一遍，截图对比。

**Commit:** `refactor(harmony): i18n + theme tokens for Settings page`

---

## Task 4: Onboard.ets 全量替换（59 CJK + 26 hex，第二大头）

**Files:**
- Modify: `resources/zh_CN/element/string.json`（追加 `onboard_*`）
- Modify: `resources/en_US/element/string.json`
- Modify: `resources/base/element/string.json`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Onboard.ets`

- [ ] **Step 1: 落 `onboard_*` key**
- [ ] **Step 2: Onboard.ets 逐处替换**（5 步引导文案 + 错误反馈 + 按钮 label + 26 处 hex）
- [ ] **Step 3: 真机验证 5 步引导（中英 + 双主题）**

**Commit:** `refactor(harmony): i18n + theme tokens for Onboard page`

---

## Task 5: Reader.ets + AnnotationPanel.ets 替换（含 darkMode）

**Goal:** Reader.ets / AnnotationPanel.ets 文案 + 颜色替换；同时给 Reader 的 `Web` 组件加 `.darkMode(WebDarkMode.Auto)`，让 HTML 快照内嵌的 annotator-mobile.js 跟随系统主题。**注意 HL_COLORS 不动**（标注数据跨端共享，桌面也是这 4 色）。

**Files:**
- Modify: `resources/{zh_CN,en_US,base}/element/string.json`（追加 `reader_*` `annotation_*`）
- Modify: `shibei-harmony/entry/src/main/ets/pages/Reader.ets`
- Modify: `shibei-harmony/entry/src/main/ets/components/AnnotationPanel.ets`

- [ ] **Step 1: 落 `reader_*` `annotation_*` key**
- [ ] **Step 2: Reader.ets 替换 20 行 CJK + 8 hex（除 HL_COLORS）**
- [ ] **Step 3: Reader.ets `Web` 组件加 `.darkMode(WebDarkMode.Auto).forceDarkAccess(false)`**
  - `Auto` 让 ArkWeb 跟随系统主题
  - `forceDarkAccess(false)` 不让 Chromium 强制反色（避免破坏快照原貌；用户想要可读性主动开 invert filter，对齐桌面）
- [ ] **Step 4: AnnotationPanel.ets 替换 15 行 CJK + 4 hex**
- [ ] **Step 5: 真机验证打开 1 个 HTML + 1 个 PDF，中英 + 双主题切换**

**Commit:** `refactor(harmony): i18n + theme tokens for Reader + AnnotationPanel`

---

## Task 6: LockScreen.ets + Search.ets + Library.ets 替换

**Files:**
- Modify: `resources/{zh_CN,en_US,base}/element/string.json`（追加 `lock_*` `search_*` `sidebar_*`）
- Modify: `shibei-harmony/entry/src/main/ets/pages/LockScreen.ets`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Search.ets`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Library.ets`

- [ ] **Step 1: 落 key**
- [ ] **Step 2: LockScreen.ets 替换 19 CJK + 3 hex**
- [ ] **Step 3: Search.ets 替换 13 CJK**（无 hex）
- [ ] **Step 4: Library.ets 完成剩余 CJK + hex（Task 2 smoke 之外的）**
- [ ] **Step 5: 真机验证锁屏流程 + 搜索页 + Library 切换**

**Commit:** `refactor(harmony): i18n + theme tokens for LockScreen/Search/Library`

---

## Task 7: 剩余 components + HuksService 文案

**Files:**
- Modify: `resources/{zh_CN,en_US,base}/element/string.json`
- Modify: `shibei-harmony/entry/src/main/ets/components/FolderDrawer.ets`
- Modify: `shibei-harmony/entry/src/main/ets/components/ResourceList.ets`
- Modify: `shibei-harmony/entry/src/main/ets/components/ResourceItem.ets`
- Modify: `shibei-harmony/entry/src/main/ets/services/HuksService.ets`（生物识别 prompt title）

- [ ] **Step 1: 落最后一批 key**
- [ ] **Step 2: 替换 4 个文件**
- [ ] **Step 3: 真机验证 FolderDrawer 抽屉 + 资料列表 + 生物识别 prompt 文案**

**Commit:** `refactor(harmony): i18n + theme tokens for remaining components`

---

## Task 8: pdf-shell WebView 深色 + 文案国际化

**Goal:** PDF shell 是独立 HTML，不走 ArkUI 资源系统，但能通过：①URL 参数注入翻译字符串；②CSS `@media (prefers-color-scheme: dark)` 跟随系统主题。

**Files:**
- Modify: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/shell.html`
- Modify: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/style.css`
- Modify: `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/main.js`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Reader.ets`（构造 PDF URL 时拼 `?lang=zh|en` + `&loadingText=...`）

- [ ] **Step 1: shell.html 把 "加载中…" 改成空 `<div id="status"></div>`**

- [ ] **Step 2: main.js 解析 URL 参数注入文案**

  ```javascript
  const params = new URLSearchParams(location.search);
  const loadingText = params.get('loadingText') || 'Loading…';
  document.getElementById('status').textContent = loadingText;
  ```

- [ ] **Step 3: Reader.ets 构造 PDF Web src 时拼参数**

  ```typescript
  const lang = I18n.currentLocale(); // 'zh' | 'en'
  const loadingText = I18n.t($r('app.string.common_loading'));
  const src = `pdf-shell/shell.html?id=${id}&zoom=${z}&lang=${lang}&loadingText=${encodeURIComponent(loadingText)}`;
  ```

- [ ] **Step 4: style.css 加 dark 块**

  ```css
  @media (prefers-color-scheme: dark) {
    body { background: #0f0f0f; color: #e8e8e8; }
    .page { background: #2a2a2a; box-shadow: 0 1px 4px rgba(0,0,0,0.6); }
    #status { color: #a0a0a0; }
  }
  ```
  ⚠️ PDF canvas 渲染本身不变（PDF 内容白底就是白底，对齐 Acrobat / 桌面），只动 chrome（背景 / status / 阴影）

- [ ] **Step 5: I18n.ets 加 `currentLocale()` 辅助方法**

  ```typescript
  import { i18n } from '@kit.LocalizationKit';
  static currentLocale(): string {
    return i18n.System.getSystemLanguage().startsWith('zh') ? 'zh' : 'en';
  }
  ```

- [ ] **Step 6: 真机验证打开 PDF，中英切换 + dark 切换看背景 + status 文案**

**Commit:** `feat(harmony): pdf-shell dark mode + i18n via URL params`

---

## Task 9: 回归扫描 + AGC 截图

**Goal:** 确认所有硬编码已清零，跑一遍完整流程截图存档。

- [ ] **Step 1: 自动扫描**

  ```bash
  # 应该都返回空（HL_COLORS 数组例外）
  grep -rn "[一-鿿]" shibei-harmony/entry/src/main/ets/ \
      --include="*.ets" \
      --exclude-dir=build \
      | grep -v "//\|/\*"

  grep -rnE "['\"]#[0-9a-fA-F]{3,8}['\"]" shibei-harmony/entry/src/main/ets/ \
      --include="*.ets" \
      --exclude-dir=build \
      | grep -v "HL_COLORS"
  ```

  剩余必须 case-by-case justify（注释里写 `// SAFE: …`）。

- [ ] **Step 2: 真机回归矩阵**

  | 流程 | zh + light | zh + dark | en + light | en + dark |
  |---|---|---|---|---|
  | Onboard 5 步 | ✓ | ✓ | ✓ | ✓ |
  | Library 折叠 / 展开 | ✓ | ✓ | ✓ | ✓ |
  | Reader（HTML） + 标注 | ✓ | ✓ | ✓ | ✓ |
  | Reader（PDF） + 标注 + 缩放 | ✓ | ✓ | ✓ | ✓ |
  | Search | ✓ | ✓ | ✓ | ✓ |
  | LockScreen + 生物识别 | ✓ | ✓ | ✓ | ✓ |
  | Settings 各 section | ✓ | ✓ | ✓ | ✓ |

- [ ] **Step 3: 4 套截图存到 `docs/superpowers/reports/2026-04-23-harmony-i18n-theme-screenshots/`**

- [ ] **Step 4: 更新 CLAUDE.md**

  在 "鸿蒙" 相关 bullet 加一条 i18n + theme 的约束（约 100 字），提示后续新加 UI 文案 / 颜色必须走资源系统。

**Commit:** `chore(harmony): i18n + theme regression sweep + CLAUDE.md update`

---

## 风险与回退

| 风险 | 概率 | 对策 |
|---|---|---|
| `getStringSync` 在某些 build 偶发返回空 | 低 | I18n.t 已 try/catch + 返空字符串 + hilog |
| 切语言后 ArkUI 不刷新 | 中 | `aa force-stop` 重启 app；用户切换语言本身就是系统级操作 |
| 桌面色板 token 名不全 | 低 | Task 2 抄 variables.css 时缺啥补啥，dark override 同步加 |
| Reader `darkMode(Auto)` 让某些快照变形 | 中 | `forceDarkAccess(false)` 已挡住 Chromium 强制反色；保留 invert filter 作用户主动选项 |
| pdf-shell URL 参数 `loadingText` 包含 `&` 导致 URL 解析错 | 低 | `encodeURIComponent` 已处理 |
| AGC 审核要求 `string.json` 必须有 `en_US`（不仅 zh_CN） | 已对齐 | Task 1 起就建双语骨架 |

---

## 完成标准

- 所有 9 个 task 全部 commit
- `grep "[一-鿿]"` 在 `shibei-harmony/entry/src/main/ets/` 下扫描结果为空（除注释）
- `grep "['\"]#[0-9a-fA-F]"` 同上结果为空（除 `HL_COLORS`）
- 真机回归矩阵 4 套全部通过
- CLAUDE.md 已更新

---

## 时间估算

| Task | 预估 |
|---|---|
| 0  Key 清单提取 | 2 h（费心） |
| 1  i18n 基础设施 | 1 h |
| 2  色板基础设施 | 1.5 h |
| 3  Settings | 2 h |
| 4  Onboard | 2 h |
| 5  Reader + AnnotationPanel | 1.5 h |
| 6  LockScreen + Search + Library | 1.5 h |
| 7  剩余 components | 1 h |
| 8  pdf-shell | 1 h |
| 9  回归 + 截图 + CLAUDE.md | 2 h |
| **合计** | **15.5 h** |

---

**文档结束。** 下一步：执行 Task 0（key 清单提取），完成后逐 task 推进。
