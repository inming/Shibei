# 拾贝移动端 MVP — 鸿蒙优先（HarmonyOS NEXT）设计文档

- 日期：2026-04-20（Phase 0 验证后修订）
- 范围：HarmonyOS NEXT（Mate X5 折叠屏优先）
- 状态：Phase 0–5.1 核心链路已合入并完成真机验收；2026-04-24 已补齐会话持久化 / Deep Link / 同步刷新收尾项
- 验证报告：`docs/superpowers/reports/2026-04-20-harmony-phase0-verification-report.md`
- Phase 1 计划：`docs/superpowers/plans/2026-04-21-phase1-pairing-qr.md`

## Phase 0 修订摘要（2026-04-20）

基于真机验证（Mate X5 / HarmonyOS 6.1.0）发现，对本 spec 做以下修订：

1. **§4.4 折叠状态**：Mate X5 **会**发 `HALF_FOLDED`（原假设错），最小 delta 86ms；debounce 降到 100ms 或改"状态静默 N ms 后才应用"
2. **§5.1 / §7.1 file://**：el2 sandbox `file://` 直接可用，无需 in-app HTTP server fallback（按原设计推进）
3. **§5.7 PDF 管线**：ArkWeb 拒绝 ES module 跨文件 import + `window.fetch`，pdfjs 必须走 4 重 workaround（legacy build / IIFE bundle 双 classic script / 桥传 PDF 字节 / polyfill Uint8Array.toHex）——已固化到 commit 历史和报告
4. **§6.1 / §6.2 Biometric**：Mate X5 对 `ATL3 + [FACE, FINGERPRINT]` 返回 401，生产实现必须做运行时能力探测（默认 ATL2 + FINGERPRINT，回退密码）
5. **§10.2 后台同步**：短任务在后台可续行 30s+ 无 expire，"只前台同步"可放宽——短同步完结允许走 `requestSuspendDelay`

### NAPI 路线锁定

**napi-rs 2.x 在 HarmonyOS NEXT 不可用**（`napi_register_module_v1` 执行但 exports 回 undefined）。Phase 0 采用 fallback：**手写 C NAPI shim + 纯 `extern "C"` Rust 函数**。Plan 3 需准备 codegen 工具自动生成 shim，避免 40+ 命令手写。

## 一、背景与目标

### 1.1 背景

拾贝桌面端（Tauri + React + SQLite + S3 同步 + E2EE）已完成到 v2.4。移动端是用户既定方向。本文档确立移动端 MVP 的技术路线、范围与接口契约。

### 1.2 目标平台选择

**HarmonyOS NEXT 优先，iOS / Android 排到 v2 之后。**

理由：

1. 用户主力设备 Huawei Mate X5，日常消费场景高度依赖折叠屏交互，这是唯一能亲身打磨的平台
2. HarmonyOS NEXT（2024 年后的纯血鸿蒙）不再兼容 Android APK，跨平台 fork 方案均有滞后——要做到"与原生一样好"必须正面攻克 ArkUI
3. 架构上保留跨平台复用的通道（Rust 核心 + WebView 阅读器），iOS/Android 时外壳重写但成本可控

### 1.3 MVP 核心用例

**读 + 标注**（从 Q1 方案 B 落定）：
- 浏览资料库、打开快照/PDF
- 查看桌面已有高亮/评论
- 触屏划词新建高亮（4 色）
- 新建/编辑/删除评论（Markdown 存储，移动端编辑无预览）
- 搜索（元数据全量 + 已缓存快照正文）
- S3 双向同步

**明确不做**（Q10 定）：

- 分享菜单保存网页（属于"采集版"，独立项目）
- MCP / AI 配置页
- 本地备份 / 开机自启 / 超级终端
- 拖拽移动、批量操作、文件夹 CRUD、标签管理 UI
- 折叠屏外屏独立交互（Mate X5 外屏按普通折叠态处理）

---

## 二、技术栈与架构

### 2.1 分层复用

```
┌─────────────────────────────────────────────────────────┐
│  ArkUI 原生外壳（ArkTS）                                │
│  FolderDrawer / ResourceList / SearchView /             │
│  SettingsView / AnnotationSheet / FoldObserver          │
│  Navigation 组件（mode Auto） + 折叠响应式布局           │
│                                                         │
│     ↓ @ohos.napi（同步 / DB / 加密调用）                │
│     ↓                                                   │
│  ┌────────────────────────────────────────────────┐    │
│  │ Rust 核心库（libshibei_core.so, ohos-abi）     │    │
│  │ 直接复用桌面 src-tauri/src/                    │    │
│  │ ─ db/（rusqlite bundled）                      │    │
│  │ ─ sync/（HLC + sync_log + S3 + E2EE）          │    │
│  │ ─ storage/（快照文件管理）                     │    │
│  │ ─ search/（FTS5 trigram）                      │    │
│  │ 新增：napi 桥层（src-harmony-napi/）           │    │
│  └────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─ ArkWeb（@ohos.web.webview）────────────────────┐    │
│  │  React 阅读器（复用 src/components/Reader*）   │    │
│  │  annotator.js（选词锚点/高亮渲染）             │    │
│  │  pdfjs-dist（PDF 渲染）                        │    │
│  │  MarkdownContent（评论渲染）                   │    │
│  │  通信：ArkWeb JS 桥 ↔ ArkTS 外壳               │    │
│  └────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 2.2 代码复用率（估算）

| 层 | 新写 | 复用桌面 |
|---|---|---|
| 外壳（ArkTS/ArkUI） | 100% | 0% |
| NAPI 桥 | 100% | 0% |
| Rust 核心 | ~5%（cfg 开关 + ohos-abi target 配置） | ~95% |
| 阅读器（WebView 内） | ~15%（触屏手势适配） | ~85% |

### 2.3 技术选型

| 层 | 选型 | 备注 |
|---|---|---|
| UI | ArkTS + ArkUI | API ≥ 12 |
| WebView | `@ohos.web.webview`（ArkWeb） | Chromium 内核 |
| 数据库 | Rust rusqlite (bundled) | 编到 .so，通过 NAPI 访问 |
| 凭据存储 | `@ohos.security.huks` | S3 配置 + biometric wrapper |
| 偏好存储 | `@ohos.data.preferences` | UI 状态、session state |
| 生物认证 | `@ohos.userIAM.userAuth` | 指纹 / 人脸 |
| 扫码 | `@kit.ScanKit` | 首次配对 |
| 网络 | Rust `rust-s3` + `tokio` | NAPI 层起 runtime |
| 折叠检测 | `@ohos.display` | foldStatusChange |
| Deep Link | `@ohos.app.ability.Want` + UriScheme | `shibei://...` |

### 2.4 代码仓位置（保持同仓）

```
shibei-harmony/          # 鸿蒙应用项目
  entry/
    src/main/
      ets/
        pages/           # 页面
        components/      # 复用 UI 组件
        services/        # 业务服务（sync / auth / napi 封装）
        i18n/            # ArkUI i18n 资源
      resources/
        rawfile/
          pdf-shell/     # PDF WebView 静态资源
      module.json5
    libs/                # 原生库产物 (.so)
  AppScope/              # 应用级配置
src-harmony-napi/        # NAPI 桥 crate（独立）
  Cargo.toml
  src/lib.rs
src-tauri/               # 桌面端不变；NAPI crate 作为 path dep
```

Rust 核心代码**物理保留在 `src-tauri/`**，NAPI crate 以 path dependency 引用相关模块并包装 `#[napi]` 装饰。桌面迭代不被鸿蒙拖慢，鸿蒙只消费稳定的内部 API。

---

## 三、数据流与同步

### 3.1 NAPI API 契约

ArkTS 侧类型声明（NAPI 构建时自动生成 `.d.ts`）：

```typescript
interface ShibeiCore {
  // --- 初始化 ---
  init(dataDir: string): Promise<void>;
  setS3Config(cfg: S3Config): Promise<void>;
  setE2EEPassword(pwd: string): Promise<void>;
  lockVault(): void;
  isUnlocked(): boolean;

  // --- 浏览 ---
  listFolders(): Promise<Folder[]>;
  listResources(folderId: string, tagIds?: string[], sort?: Sort): Promise<Resource[]>;
  searchResources(query: string, tagIds?: string[]): Promise<SearchResult[]>;
  getResource(id: string): Promise<Resource | null>;
  getResourceSummary(id: string, maxChars?: number): Promise<string>;
  listTags(): Promise<Tag[]>;

  // --- 标注 ---
  listHighlights(resourceId: string): Promise<Highlight[]>;
  listComments(resourceId: string): Promise<Comment[]>;
  createHighlight(input: HighlightInput): Promise<Highlight>;
  updateHighlight(id: string, patch: HighlightPatch): Promise<Highlight>;
  deleteHighlight(id: string): Promise<void>;
  createComment(input: CommentInput): Promise<Comment>;
  updateComment(id: string, patch: CommentPatch): Promise<Comment>;
  deleteComment(id: string): Promise<void>;

  // --- 快照文件（移动端独有） ---
  hasSnapshotCached(resourceId: string): Promise<boolean>;
  downloadSnapshot(resourceId: string): Promise<string>;
  extractPlainText(resourceId: string): Promise<void>;
  evictSnapshotLRU(targetBytes: number): Promise<void>;

  // --- 同步 ---
  syncMetadata(): Promise<SyncReport>;
  getSyncStatus(): Promise<SyncStatus>;

  // --- 事件 ---
  on(event: DomainEvent, cb: (payload: unknown) => void): Subscription;
}
```

**裁剪的桌面 command**（鸿蒙不暴露）：文件夹 / 资料 / 标签 CRUD、备份导出、AI 工具配置、自启相关。

### 3.2 三条主要数据流

**① 元数据同步（冷启动 + 下拉刷新）**

```
打开 app
  → ArkTS SyncService.syncIfNeeded()
  → NAPI shibei.syncMetadata()
  → Rust sync::run(ctx) — 复用桌面 SyncEngine
  → 上传本地 sync_log → 拉远端 JSONL → apply
  → 不下载任何 snapshot.html/pdf
  → Rust emit 领域事件 → NAPI 转发 ArkTS EventBus
  → Page/Component 自动刷新
```

**② 打开资料（冷 → 热）**

```
点资料
  → ArkTS pushPage(Reader, id)
  → Reader.onInit: shibei.hasSnapshotCached(id)
     ├─ true  → 直接加载本地 file:// 进 ArkWeb
     └─ false → 显示下载骨架
                → shibei.downloadSnapshot(id)
                → shibei.extractPlainText(id)（异步）
                → 加载 file:// 进 ArkWeb
  → ArkWeb loadUrl 完成后注入 annotator.js 启动参数
```

**③ 创建高亮（阅读器内）**

```
长按选词 → 系统手柄 → selectionchange
  → annotator.js (WebView 内)
  → window.shibeiHost.onSelectionChange(payload)
  → ArkTS Reader 计算浮动工具条位置并渲染
  → 用户点颜色圆点 → shibei.createHighlight(input)
  → Rust 写 DB + sync_log + emit data:annotation-changed
  → NAPI 回传 Highlight → ArkTS 通过 runJavaScript 告知 WebView 渲染
  → AnnotationSheet（若打开）通过 EventBus 自动刷新
```

### 3.3 事件系统跨 NAPI

桌面 Tauri events 在鸿蒙上转译：

- Rust `emit(event, payload)` → 内部 mpsc channel
- NAPI 封装注册 `ThreadsafeFunction` → 推送到 ArkTS 回调
- ArkTS 端 `EventBus` 对订阅者分发
- 保持桌面 6 个领域事件命名一致：`data:resource-changed` / `data:folder-changed` / `data:tag-changed` / `data:annotation-changed` / `data:sync-completed` / `data:config-changed` + `sync-started` / `sync-failed`

### 3.4 架构原则

- **NAPI 接口资源导向**，不是命令导向；移动端 UI 状态机直接绑数据
- **NAPI 层保持薄**：不缓存、不做业务逻辑，纯转发
- **ArkTS 服务层做轻量协调**：EventBus、生物解锁、UI 级 debouncer

---

## 四、页面路由与折叠响应式

### 4.1 页面清单

| 页面 | 折叠态 | 展开态 | 备注 |
|---|---|---|---|
| OnboardPage | 全屏 | 全屏 | 首次引导（5 步） |
| LockPage | 全屏 | 全屏 | 生物或密码解锁 |
| LibraryPage | 单栏列表 | 双栏 split | 主页面 |
| ReaderPage | push 全屏 | 嵌入 Library 右栏 | 同一组件 |
| SearchPage | push 全屏 | overlay | 独立路由 |
| SettingsPage | push 全屏 | push 全屏 | 两态都全屏 |
| FolderDrawer | 左侧 overlay 抽屉 | 左侧 overlay 抽屉 | 两态统一 |
| AnnotationSheet | 底部半屏 sheet | 右侧半宽 sheet | 两态表现不同 |

### 4.2 Navigation 结构

```typescript
@Entry @Component
struct App {
  @StorageProp('foldStatus') foldStatus: FoldStatus = FoldStatus.FOLDED;

  @Builder
  PageMap(name: string) {
    if (name === 'Onboard')   OnboardPage()
    if (name === 'Lock')      LockPage()
    if (name === 'Library')   LibraryPage({ foldStatus: this.foldStatus })
    if (name === 'Reader')    ReaderPage()
    if (name === 'Search')    SearchPage()
    if (name === 'Settings')  SettingsPage()
  }

  build() {
    Navigation(this.pathStack)
      .mode(NavigationMode.Auto)    // 折叠=Stack，展开=Split
      .navBarWidth('40%')
      .navBarWidthRange([280, 400])
      .hideNavBar(isFullscreenPage(this.currentPage))
  }
}
```

**分栏行为**：

- 折叠态 → Reader / Search：`pathStack.pushPath`
- 展开态 → Reader：不 push，LibraryPage 右栏切换目标；靠 `Navigation.mode(Auto)` 天然行为
- Settings：两态都 push（`hideNavBar(true)`）
- Onboard / Lock：两态都全屏

### 4.3 LibraryPage 内部结构

```typescript
@Component
struct LibraryPage {
  @Prop foldStatus: FoldStatus;
  @State selectedResourceId: string | null = null;
  @State drawerOpen: boolean = false;

  build() {
    SideBarContainer(SideBarContainerType.Overlay) {
      FolderDrawer({ onSelect: ... })

      if (this.foldStatus === FoldStatus.FOLDED) {
        ResourceList({
          onResourceTap: (id) => this.pathStack.pushPath({ name: 'Reader', param: id })
        })
      } else {
        ResourceList({
          onResourceTap: (id) => { this.selectedResourceId = id }
        })
        // 右栏由 Navigation 的 NavDestination 渲染 Reader
      }
    }
    .showSideBar(this.drawerOpen)
    .controlButton({ showButton: false })
  }
}
```

### 4.4 折叠状态转换

```typescript
// entry/src/main/ets/app/FoldObserver.ets
export class FoldObserver {
  static instance = new FoldObserver();

  start(): void {
    display.on('foldStatusChange', (status: display.FoldStatus) => {
      const normalized = this.normalize(status);
      AppStorage.setOrCreate('foldStatus', normalized);
    });
  }

  private normalize(s: display.FoldStatus): FoldStatus {
    // Mate X5: HALF_FOLDED 罕见，按 EXPANDED 处理
    return s === display.FoldStatus.FOLD_STATUS_FOLDED
      ? FoldStatus.FOLDED
      : FoldStatus.EXPANDED;
  }
}
```

**保底逻辑**：

- 折叠 → 展开：若栈里有 Reader，展开态 LibraryPage 看到 `selectedResourceId` 已设，自动渲染右栏；路由栈中多余的 Reader 页保留不 pop
- 展开 → 折叠：`selectedResourceId` 有值则 push 一个 Reader 页
- 状态转换 debounce 250ms，只应用最终态（避免动画中多次触发）

### 4.5 Top Bar

```
折叠态                     展开态
┌─────────────────────┐    ┌──────────────────┬──────────────────┐
│ ☰  收件箱  🔍  ⚙  │    │ ☰ 收件箱  🔍  ⚙│ ← 标题  🌓 ✏N ⋯│
└─────────────────────┘    └──────────────────┴──────────────────┘
```

展开态右栏顶栏：← 在折叠态返回（展开态隐藏）、标题省略、🌓 切主题反转（仅 HTML）、✏N 打开 AnnotationSheet、⋯ 二级菜单。

### 4.6 展开态分栏宽度

| 项 | 宽度 | 最小 | 持久化 |
|---|---|---|---|
| 左栏 ResourceList | 拖拽 | 280vp | `preferences: library-left-width` |
| Handle | 4vp | — | — |
| 右栏 Reader | flex:1 | 400vp | — |
| 标注抽屉（打开时） | 覆盖右栏 | 240vp | `annotation-drawer-width` |

---

## 五、阅读器 WebView 与标注

### 5.1 WebView 容器

```typescript
@Component
struct ReaderView {
  controller: webview.WebviewController = new webview.WebviewController();
  @Link resourceId: string;
  @State localPath: string = '';
  @State ready: boolean = false;
  @State selection: SelectionInfo | null = null;

  aboutToAppear() {
    this.resolveLocalPath(this.resourceId);
    this.registerBridge();
  }

  build() {
    Stack() {
      if (this.localPath) {
        Web({ src: this.localPath, controller: this.controller })
          .javaScriptAccess(true)
          .fileAccess(true)
          .domStorageAccess(true)
          .mediaPlayGestureAccess(false)
          .darkMode(WebDarkMode.Auto)
          .onPageEnd(() => this.injectBootstrap())
      }
      if (!this.ready) LoadingSkeleton()
      if (this.selection) {
        SelectionToolbar({
          selection: this.selection,
          onHighlight: (color) => this.createHighlight(color),
          onComment:   ()      => this.openCommentSheet()
        })
        .position({ x: this.toolbarX, y: this.toolbarY })
      }
    }
  }
}
```

### 5.2 JS 桥：双向

**WebView → ArkTS**（`registerJavaScriptProxy`，方法白名单）：

```typescript
this.controller.registerJavaScriptProxy({
  object: {
    onSelectionChange: (payload: string) => { /* 选区 */ },
    onHighlightTap:    (hlId: string)    => { /* 点已有高亮 */ },
    onScroll:          (payload: string) => { /* 滚动 */ },
    onAnnotatorReady:  ()                => { this.ready = true; }
  },
  name: 'shibeiHost',
  methodList: ['onSelectionChange', 'onHighlightTap', 'onScroll', 'onAnnotatorReady']
});
```

annotator.js 内：

```typescript
const host = (window as any).shibeiHost;
document.addEventListener('selectionchange', debounce(() => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    host.onSelectionChange(JSON.stringify({
      text: sel.toString(),
      rect: sel.getRangeAt(0).getBoundingClientRect(),
      anchor: computeAnchor(sel)
    }));
  }
}, 250));
```

**ArkTS → WebView**（`runJavaScript`）：

```typescript
controller.runJavaScript(`window.__shibeiRenderHighlights(${JSON.stringify(list)})`);
controller.runJavaScript(`window.__shibeiScrollTo('${hlId}')`);
controller.runJavaScript(`window.__shibeiSetInvertTheme(${on})`);
```

annotator.js 暴露（前缀 `__shibei`）：`__shibeiRenderHighlights(list)` / `__shibeiScrollTo(hlId)` / `__shibeiSetInvertTheme(on)` / `__shibeiGetPlainText()`。

### 5.3 浮动工具条：ArkUI 原生层

**不在 WebView 内画**，原因：

- WebView 内 HTML 工具条会被页面 CSS 干扰，也无法越过 WebView 边界
- ArkUI 原生 Stack 绝对定位像素精准，不受主题影响
- 颜色圆点点击直接 NAPI 调 Rust 创建高亮，少一次 JS 桥

边界避让算法复用桌面 `useFlipPosition` 的思路：向上溢出翻到选区下方；左右 clamp 到屏幕内（4vp 边距）。

### 5.4 颜色与工具条

- **4 色**（黄/绿/蓝/粉），与桌面一致
- 工具条：`[● ● ● ●   💬评论   ⋯]`
- 1 tap 建高亮是最短路径；"⋯" 展开复制、改色、删除

### 5.5 已有高亮交互

- 单击：mini popup `[💬编辑评论] [🎨改色] [🗑删除]`
- 没评论时气泡直接展开评论编辑器（减一跳）

### 5.6 评论编辑器

- 半屏底部 sheet（折叠态）/ 右侧抽屉（展开态）
- **纯 textarea，不提供 Markdown 预览切换**（移动端精简；在 AnnotationSheet / PreviewPanel 里看渲染结果）
- 保存后即时反馈，渲染依然用 `MarkdownContent`（移植到 ArkWeb 内）

### 5.7 PDF 分支

```
ReaderView
  ├─ resource.type === 'html' → 加载 snapshot.html (file://)
  │                              注入 annotator.js
  └─ resource.type === 'pdf'  → 加载 pdf-shell.html (rawfile://)
                                桥传 PDF 文件路径 → PDF.js 加载
                                PDF 高亮仍走 page+charIndex anchor
```

**pdf-shell.html**：`src/harmony-pdf-shell/` 入口，Vite `build:harmony-pdf` 产出单 HTML（pdfjs-dist worker 拆为 file:// 相对引用），放到 `entry/src/main/resources/rawfile/pdf-shell/`。

### 5.8 会话持久化

已实现为 `entry/src/main/ets/app/SessionState.ets`，存储介质为 `@ohos.data.preferences` 的 `shibei_prefs` store，单 key `shibei-session-state`。移动端没有桌面 TabBar，因此 schema 采用移动端简化形态：`version` / `inReader` / `readerResourceId` / `library(selectedFolderId, selectedTagIds, selectedResourceId, listScrollTop?)`。

Reader 滚动位置和 PDF 缩放不复制进 `SessionState.ets`：HTML/PDF scroll 继续由 `ReaderScrollState.ets` 按 resource_id 持久化，PDF zoom 继续由 `ReaderZoomState.ets` 的 `reader:zoomMap` 持久化。打开 Reader 前必须 `await SessionState.save({ inReader: true, readerResourceId })` 再 `router.pushUrl`，避免用户快速杀进程时尚未落盘。**不得在 `Reader.aboutToDisappear()` 清 `inReader`**，因为任务管理器杀 app 也会触发该生命周期；只在显式返回（系统 back / 顶部 `←`）时通过 `leaveReader()` 清除。

### 5.9 PDF 缩放与手势

- PDF 双指缩放手势 → 映射到桌面相同的 `zoomFactor` prop（0.5–4.0，step 0.05）
- 每份 PDF 独立持久化到 `sessionState.ReaderTab.pdfZoom`
- HTML 快照不支持缩放（和桌面一致）

---

## 六、首次配置与解锁

### 6.1 OnboardPage 五步

```
Step 1: 欢迎 → [开始配置]

Step 2: 扫码
  桌面：Settings → 同步 → [添加移动设备] → Modal（QR + 6 位 PIN + 30s 倒计时）
  手机：[📷 打开扫码] → ScanKit → 扫到 QR → 解 payload
  QR payload: { version: 1, nonce: base64(16B), ciphertext: base64(...) }

Step 3: 输 PIN
  PIN → HKDF → 32B AES-GCM 密钥 → 解密 ciphertext → S3Config
  解密失败限 3 次

Step 4: E2EE 密码
  shibei.setE2EEPassword(pwd) 内部自动：
    1. 拉 S3 keyring.json（不写入本地 sync_log）
    2. Argon2id 派生 → 尝试解 keyring → MK 缓存
    3. 失败抛错（密码错 / 网络错分别返回不同 error kind）
  UI 对密码错误不限次；对网络错误可重试

Step 5: 生物解锁（可跳过）
  1. 随机生成 wrapper_key (32B)
  2. userIAM.userAuth 认证成功 → HUKS 存 wrapper_key (SECURE_SIGN_WITH_BIOMETRIC)
  3. wrapper_key 包裹 MK → 存 pref: mk_biometric_wrapped

✓ 进入 LibraryPage，后台执行首次元数据全量同步
```

### 6.2 LockPage

触发条件（任一）：

- 冷启动（app 从未运行过或 MK 已清）
- 应用切到后台超过 `autoLockMinutes`（默认 **10 分钟**，可调 1/5/10/30/永不）
- 用户手动点"锁定"
- 收到 deep link 时 MK 未缓存

UI：

```
┌─────────────────────────┐
│     🔒 拾贝             │
│  [👆 指纹/人脸]          │  ← 仅启用生物时显示
│  ─── 或使用密码 ───     │
│  E2EE 密码:             │
│  ●●●●●●●             │
│  [解锁]                 │
└─────────────────────────┘
```

锁屏时 deep link 通过 `AppStorage` 的 `KEY_PENDING_DEEP_LINK` 暂存，解锁后进入 `Library.aboutToAppear()` 消费。`module.json5` 已注册 `shibei://open/resource/{id}?highlight={hlId}` scheme；`EntryAbility.onCreate/onNewWant` 负责暂存 `Want.uri`，`Library` 消费后 push `pages/Reader`，`Reader` 接收 `highlightId` route param 并在 ready 后 flash 对应标注。

### 6.3 Auto-lock 时序

```typescript
// EntryAbility
onForeground() {
  const now = Date.now();
  const suspendedAt = preferences.getSync('suspendedAt', 0);
  const autoLockMs = preferences.getSync('autoLockMinutes', 10) * 60_000;
  if (suspendedAt && now - suspendedAt > autoLockMs) {
    shibei.lockVault();
    navigateToLockPage();
  }
  preferences.delete('suspendedAt');
}

onBackground() {
  preferences.putSync('suspendedAt', Date.now());
}
```

### 6.4 HUKS 密钥管理

| Alias | 用途 | 访问策略 |
|---|---|---|
| `shibei_s3_aead` | S3 config 对称加密 | 启动时解，session 内使用 |
| `shibei_mk_wrapper` | biometric 解锁 MK 的包裹 key | `BIOMETRIC_REQUIRED`（每次生物认证） |
| `shibei_device_salt` | 设备随机 salt | 启动读一次，常驻内存 |

**关键决策**：MK 不直接进 HUKS，只驻内存（`Zeroizing<[u8;32]>`）。

原因：

- HUKS `BIOMETRIC_REQUIRED` 每次取都要生物 prompt，高频操作无法接受
- 生物解锁语义是"一次生物换一个 session 的 MK 缓存"，不是"每次用 MK 都认证"
- 与桌面 session 级内存缓存语义一致

### 6.5 密码 / 设备重置

- **不做云端重置**（和桌面一致不可恢复）
- Settings → 安全 → "重置本机"：清 HUKS + preferences + 本地 DB + 快照，等同卸载重装
- 不提供"忘记密码"入口；E2EE 密码即 Master Password

### 6.6 桌面端前置改动

**✅ 已完成（2026-04-21，Phase 1）**。合入记录：

```
/Cargo.toml                      # 新增顶层 workspace
crates/shibei-pairing/           # 独立密码学 crate（HKDF-SHA256 + XChaCha20-Poly1305）
crates/shibei-pair-decrypt/      # 开发者 CLI（round-trip 验证 + 鸿蒙 NAPI 参考实现）
scripts/test-pairing-roundtrip.sh

src-tauri/src/sync/pairing.rs    # 组装 S3 配置 → shibei-pairing::encrypt_payload
src-tauri/src/commands/mod.rs    # 新增 cmd_generate_pairing_payload

src/components/Settings/PairingDialog.{tsx,module.css,test.tsx}
src/components/Settings/SyncPage.tsx    # 新增"添加移动设备"入口
src/lib/commands.ts              # generatePairingPayload wrapper
src/locales/{zh,en}/sync.json    # addMobileDevice + pairing.* 11 keys
src/locales/{zh,en}/common.json  # error.pairing* 5 keys

npm: + qrcode + @types/qrcode
```

实施细节：
- KDF 是 **HKDF-SHA256**（不是原本写的 AES-GCM），6 位 PIN 的 20 bits 熵挡不住任何 KDF，防御来自一次性使用 + 30s 时效 + PIN 不落到 QR
- Cipher 用 **XChaCha20-Poly1305**，和桌面 E2EE 栈一致
- Payload 原始二进制上限 512 字节，超限返回 `error.pairingPayloadTooLarge`
- 过期策略前端静默：30s 到 UI 切「已过期」，envelope 无 `exp` 字段
- 密码学实现细节见 `crates/shibei-pairing/src/lib.rs` 文件头注释

详细计划：`docs/superpowers/plans/2026-04-21-phase1-pairing-qr.md`。

**不改**：同步协议、数据库 schema、加密机制。

---

## 七、本地存储与离线缓存

### 7.1 sandbox 路径

```
/data/storage/el2/base/haps/entry/
  ├─ databases/
  │   └─ shibei.db                # 与桌面同 schema
  ├─ files/
  │   ├─ storage/resources/{id}/
  │   │   ├─ snapshot.html|.pdf
  │   │   └─ meta.json
  │   └─ cache-index.json         # LRU 索引
  └─ preferences/
      └─ shibei_settings.xml
```

**el2** 加密级别（DeviceUnlock 类）叠加 E2EE，系统级 + 应用级双层保护。

### 7.2 LRU 缓存

```rust
// src-tauri/src/storage/cache.rs（新增，feature mobile-cache）
pub struct CacheIndex {
    entries: BTreeMap<String, CacheEntry>,  // resource_id -> entry
    total_bytes: u64,
}

pub struct CacheEntry {
    resource_id: String,
    bytes: u64,
    last_access: i64,      // epoch ms
    pinned: bool,          // 标记常驻
}
```

**操作**：

- **下载**：`cache.put(id, bytes)` → 若超限触发 `evict`
- **打开**：`cache.touch(id)` 更新 `last_access`
- **淘汰**：`last_access` 升序遍历，跳过 `pinned`，直到降到 `target_bytes`
- **持久化**：变更后异步 flush `cache-index.json`（debounce 500ms）

feature 隔离：

```toml
[features]
mobile-cache = []  # src-harmony-napi 打开
```

桌面不启用（桌面快照无上限驻磁盘）。

### 7.3 Settings → 数据（UI 规划）

```
┌─ 缓存管理 ─────────────────────────┐
│ 已缓存：234 MB / 1000 MB           │
│ ▓▓▓▓░░░░░░░░░░░░░░░░ 23%          │
│                                    │
│ 缓存上限        [1000 MB ▼]        │ 200 / 500 / 1000 / 2000 MB
│ WiFi 自动预下载 [ 关 ]             │ 关（默认）/ 最近 30 天 / 最近 90 天
│                                    │
│ [清空快照缓存]                     │
└────────────────────────────────────┘

┌─ 同步 ─────────────────────────────┐
│ 上次同步：14:23                    │
│ [立即同步]                         │
│ 自动同步  [ 打开时 ▼]              │ 打开时（默认）/ 手动
└────────────────────────────────────┘
```

**默认缓存上限 1000 MB**。

### 7.4 首次 / 增量同步

**首次**（Onboard 后立即）：

- 拉 S3 `/shibei/log/*.jsonl` 全量
- apply 所有 entries 到本地 DB（仅元数据）
- 重建 FTS 索引（此时无 `plain_text`，只有 title/url/desc/标注/评论）
- `SyncState.last_log_seq` 写入
- 进度提示："同步中 1234/2500"

**增量**（打开 app 或手动）：

- 只拉 `seq > last_log_seq` 的 JSONL
- apply → 影响 resource 对应 FTS 索引增量重建
- 本地已缓存的快照按 mtime 对比决定是否需要下载更新
- **不自动重下快照**（要求用户再次打开）

### 7.5 移动端 FTS 本地派生

**`plain_text` 不跨端同步**（桌面既有约定）。移动端做法：

- 首次下载快照后，异步 `extract_plain_text(id)`：HTML 走 `scraper`，PDF 走 `pdf-extract`（桌面同路径）
- `rebuild_search_index(resource_id)` 写入 body_text 到本地 FTS
- **缓存淘汰时同步清 body_text，保留元数据索引**
- 搜索结果 `match_fields` 字段如实反映（"body" 命中仅限已缓存）

### 7.6 同步冲突与 HLC

完全复用桌面三层 LWW + 拓扑排序 apply + JSONL 断档回退快照导入。

HLC 节点 ID 用鸿蒙设备生成的 UUID（首启写 preferences，之后固定）。节点 ID 仅参与 HLC 逻辑，不参与同步协议。

### 7.7 错误与恢复

| 失败场景 | 兜底 |
|---|---|
| 网络中断（同步中） | 已 apply 保留；`last_log_seq` 仅全部成功后更新；重跑不重复 apply |
| JSONL 断档 | 触发 `snapshot_import` 兜底（桌面既有逻辑） |
| 快照下载失败 | 提示"网络错误"；不入缓存不记 LRU |
| DB 损坏 | Settings → 安全 → 重置本机 |
| HUKS key 消失（用户清数据） | 回退"输 E2EE 密码" |
| S3 凭据失效 | 同步失败；引导重走 Onboard |

---

## 八、构建、测试、发布

### 8.1 三条构建 pipeline

**① 鸿蒙 ArkUI 构建（DevEco Studio）**

- `entry/` → `.hap` / `.app`
- 依赖：DevEco Studio + HarmonyOS SDK (API 12+) + Huawei Developer 账号
- 用户操作：Build / Run on device

**② Rust 核心 → ohos-abi**

- `src-harmony-napi/` → `libshibei_core.so`（arm64-v8a 为主）
- 工具：rustup ohos target + `napi-rs`（鸿蒙 fork / 备选手写 N-API） + HarmonyOS NDK
- 产物：`entry/libs/arm64-v8a/libshibei_core.so`
- 一键：`cargo build --target aarch64-unknown-linux-ohos --release --features mobile-cache`

**③ PDF shell HTML 打包（桌面 Vite）**

- `src/harmony-pdf-shell/` → `dist-harmony/pdf-shell.html`
- npm script：`npm run build:harmony-pdf`
- 产物：`entry/src/main/resources/rawfile/pdf-shell/`

**CI/CD**：MVP 不做自动化，手工触发三条 pipeline。

### 8.2 测试策略

| 层 | 覆盖 | 工具 | 执行方 |
|---|---|---|---|
| Rust 单测 | db / sync / crypto / LRU / plain_text 提取 | `cargo test --features mobile-cache` | AI |
| NAPI 集成测 | napi 桥参数 / 错误映射 / 事件转发 | Node.js harness（napi-rs） | AI |
| ArkTS 单测 | 服务层 / EventBus / 状态机 | `@ohos/hypium` | AI 写，用户跑 |
| UI e2e | 折叠切换 / Onboard / 选词 / 标注 / 同步 | `@ohos/hvigor` + 真机 | 手动 |

**Phase 0 真机验证清单**（必过才能进 Phase 2）：

1. `display.on('foldStatusChange')` 在 Mate X5 的触发时机与去抖需求
2. ArkWeb `selectionchange` 手柄拖动节流
3. PDF.js `streamTextContent()` 在 ArkWeb 运行正常
4. `file://` URL 在 el2 路径下 WebView 访问权限
5. HUKS 生物认证超时（默认 60s）
6. `BackgroundTaskManager` 短任务同步中断恢复
7. S3 上传/下载网络切换（WiFi ↔ 蜂窝）

每点做一个 ≤ 200 行的 minimal verification demo，通过后集成。

### 8.3 发布（华为 AGC）

- 实名开发者认证
- 应用图标、截图、隐私协议（E2EE 必须说明）
- 审核 1-3 天；相机权限需说明理由（扫 QR 配对）
- sandbox 内存储不需额外申请
- 不做灰度；未来可用 AGC "封闭测试" 招小批用户

### 8.4 桌面端并行改动

见 §6.6，先于鸿蒙 Phase 2 合入。

---

## 九、里程碑

```
Phase 0  工具链与技术验证        1~2 周
Phase 1  桌面端配对 QR           ~3 天
Phase 2  骨架 + 核心能力         4~5 周
         ─ 脚手架 + NAPI 粘合
         ─ Onboard + Lock + 生物 + HUKS
         ─ 首次 / 增量元数据同步
         ─ Library 折叠 / 展开响应式骨架
         ─ FolderDrawer + ResourceList（仅展示）
Phase 3  阅读与标注              3~4 周
         ─ ReaderView + ArkWeb + JS 桥
         ─ HTML 快照 + annotator.js 集成
         ─ 浮动工具条（ArkUI 层）
         ─ AnnotationSheet
         ─ 快照下载 + LRU 缓存
         ─ 本地 plain_text + 本地 FTS
         ─ 搜索页
Phase 4  PDF 支持                2 周
         ─ pdf-shell.html 打包
         ─ PDFReader 移植
         ─ 双指缩放 → zoomFactor
         ─ PDF 标注
Phase 5  打磨与内测              2 周
         ─ 主题 / i18n 全路径
         ─ Auto-lock / Deep Link
         ─ 失败路径 UI
         ─ 性能 profile
         ─ AGC 打包 + 隐私协议 + 首版提交

合计 12~15 周（独立开发）
```

截至 2026-04-24，Phase 0–5.1 的核心功能已合入；会话持久化、Deep Link、同步刷新收尾项已通过真机验收。剩余发布工作集中在 AGC 材料、隐私协议、截图与更大样本的内测性能观察。

---

## 十、风险矩阵

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| Rust → ohos-abi 工具链跑不通 | 中 | 致命 | Phase 0 最先验证；失败则 NAPI 桥改 C++ 再 bindgen |
| `napi-rs` 鸿蒙 fork 不稳 | 中 | 高 | 备选：手写 N-API (`ohos-node-api` 裸接口) |
| ArkWeb `selectionchange` 不可用 | 低 | 中 | 降级自绘选区（参考桌面 region-selector） |
| 大 PDF (>50MB) pdfjs 卡顿 | 中 | 中 | 降级：PDF 只渲染不标注 / Rust 侧 `pdfium` 分页位图 |
| 首次同步 apply 上万 entry 卡主线程 | 中 | 中 | tokio runtime + 进度条 + 1000 entries 一批 yield |
| HUKS 生物认证跨系统版本差异 | 低 | 中 | 抽象 `BiometricService` 接口，实测版本分支 |
| `foldStatusChange` 事件时序不稳 | 中 | 低 | 250ms debounce + 只应用最终态 |
| 桌面 E2EE 加新字段，鸿蒙 Rust 落后 | 低 | 高 | NAPI crate 与桌面共享 workspace，同步升级 |
| 应用市场审核要求变化 | 低 | 高 | 不可控；退路华为侧加壳 APK（HarmonyOS 4.x 兼容场景） |

---

## 十一、未决项（挂起到 v2+）

1. 超级终端 / 分布式接力（手机↔桌面阅读接力）
2. 从系统分享菜单保存网页（采集版，独立项目）
3. iOS 端（RN 或 SwiftUI 另定）
4. Android 端（NDK 路线成熟，不急）
5. 卡片 / Widget（鸿蒙 Form Ability）
6. 后台周期同步（`BackgroundTaskManager`）
7. 标签管理 UI / 文件夹 CRUD
8. 字号 / 行距 / 字体偏好

---

## 十二、v1 不破坏未来的原则

- NAPI 接口命名对齐桌面 command，移植 iOS/Android 不重设计
- ArkTS 组件按功能分层，view-model 层未来可复用到 SwiftUI / Compose
- session state 语义与桌面对齐（恢复当前阅读上下文与资料库选择），但移动端 schema 允许按 Navigation 架构简化；跨端接力未来以显式迁移层转换，不要求 v1 完全同形
- 不写"仅鸿蒙"魔法字符串到 Rust 核心；所有 cfg 差异通过 `#[cfg(feature = "...")]` 明确分支
- 鸿蒙端不修改同步协议、数据库 schema、加密算法；出现冲突时以桌面为准

---

## 附录 A — 术语表

| 术语 | 含义 |
|---|---|
| MK | Master Key，E2EE 的根密钥 |
| HUKS | HarmonyOS Universal Keystore Service |
| ArkWeb | HarmonyOS 内置 WebView（Chromium 内核） |
| NAPI | Node API，HarmonyOS ets ↔ native 的 FFI 机制 |
| Ark | ArkTS / ArkUI / ArkCompiler 统称 |
| Mate X5 | Huawei 横折大折叠手机，拾贝移动端主验机型 |
| 外屏 / 内屏 | 折叠 / 展开态对应的屏幕 |

## 附录 B — 关键代码位置索引（计划中）

- Rust NAPI 入口：`src-harmony-napi/src/lib.rs`
- ArkTS 服务层：`entry/src/main/ets/services/`
- 折叠观察：`entry/src/main/ets/app/FoldObserver.ets`
- 桥协议（annotator → host）：`entry/src/main/ets/services/WebViewBridge.ets` + `src-tauri/src/annotator.ts`（WebView 端复用）
- PDF shell：`src/harmony-pdf-shell/`
- 桌面配对：`src-tauri/src/commands/cmd_generate_pairing_qr.rs` + `src/components/Settings/PairingDialog.tsx`

---

**文档结束。实施计划见独立文件 `docs/superpowers/plans/2026-04-20-harmony-mobile-mvp-plan.md`（计划阶段产出）。**
