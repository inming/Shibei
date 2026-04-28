# 鸿蒙移动端网页抓取设计（v1）

- 日期：2026-04-28
- 状态：Design
- 范围：鸿蒙端从无采集能力 → 具备 HTML 整页 + PDF 抓取
- 依赖：现有 [crates/shibei-db](../../../crates/shibei-db/) / [crates/shibei-storage](../../../crates/shibei-storage/) / [crates/shibei-sync](../../../crates/shibei-sync/) / 桌面 axum handler

---

## 1. 背景与目标

### 当前 gap
- 桌面端通过 Chrome 插件 (SingleFile) 采集网页 + 本地 PDF 导入。
- 鸿蒙端**完全无采集入口**，所有内容必须先在桌面入库再同步过来。
- 移动场景下用户经常需要"看到一篇文章想存"，目前要切到桌面才能完成，体验断裂。

### 目标
- v1 让鸿蒙端独立完成"抓 + 存 + 阅读 + 标注"完整闭环（不依赖桌面）。
- 解决两个移动场景特有的痛点：**懒加载图片** 和 **登录墙**。
- 提供两条入口：**系统分享接收** + **库内手动粘贴 URL**。

### 非目标
- ❌ 选区抓取（小屏 DOM 选区交互差，桌面也是高级用法）。
- ❌ 自动登录态嗅探 / 凭据迁移。
- ❌ 无头后台抓取（v1 全部走可视化，由用户掌控页面状态）。
- ❌ 抓取队列 / 离线重试。

---

## 2. 核心设计：可视化抓取

抓取页 = **真实可交互的 WebView**，不是隐藏后台抓取。用户在自己手里把页面"准备好"再点保存——懒加载、登录、SPA 导航全交给用户处理，**所见即所得**。

### 2.1 流程

```
分享 URL / 粘贴 URL
  ↓
CapturePage（全屏 Web 组件）
  ┌──────────────────────────────────────┐
  │ ←  example.com         ↻             │ top bar：取消 / host / 刷新
  ├──────────────────────────────────────┤
  │                                      │
  │       真实加载的网页                 │ 用户可滚、可点、可登录
  │                                      │
  │                                      │
  ├──────────────────────────────────────┤
  │ 📁 收件箱 ▾    [⤓ 滑到底]  [保存] │ 底部工具栏
  └──────────────────────────────────────┘
  ↓ 点保存
顶部 overlay「正在打包页面...」
  ↓ runJavaScript SingleFile
ArkTS 收到 HTML → NAPI 写库 → Toast「已保存」→ router.back()
```

### 2.2 三大移动场景的处理

#### A. 懒加载图片
- 用户**自己滚到底**触发 lazy load——能直观看到哪些图加载完了。
- 提供 **「⤓ 滑到底」** 一键助手：注入 step-scroll 脚本（每 300ms 滚一屏，到底为止）：
  ```js
  (function autoScroll() {
    const step = window.innerHeight * 0.8;
    let lastY = -1;
    const tick = setInterval(() => {
      if (window.scrollY === lastY) { clearInterval(tick); return; }
      lastY = window.scrollY;
      window.scrollBy(0, step);
    }, 300);
  })();
  ```
- 保存的是 **当前 DOM 状态**，所见即所得。

#### B. 登录墙
- 用户在 WebView 里看到登录页 → **直接登录** → 页面跳转到正文 → 点保存。
- ArkWeb 的 cookie store 默认按 app 维度持久化，**第二次抓同一域名时已登录**，等同于浏览器登录态保留。
- 不需要任何"嗅探登录态"的代码——用户自己看得见。
- 文档说明：「需要登录的页面请先登录再保存」。

#### C. SPA / 动态内容
- 用户在 WebView 里点几下进到正文页（比如 Twitter 长推文展开） → 保存当前 DOM。
- 桌面插件靠用户在 Chrome 里浏览到位才点击保存，移动端照搬。

---

## 3. 入口

### 3.1 系统分享（被动接收）

[`entry/src/main/module.json5`](../../../shibei-harmony/entry/src/main/module.json5) 在 `EntryAbility.skills` 中追加：

```json5
{
  "actions": ["ohos.want.action.share"],
  "uris": [
    { "scheme": "https" },
    { "scheme": "http" }
  ]
}
```

[`EntryAbility.onNewWant`](../../../shibei-harmony/entry/src/main/ets/entryability/EntryAbility.ets) 处理逻辑：

```typescript
if (want.action === 'ohos.want.action.share') {
  const url = extractUrl(want);  // Want.uri 优先，回落 parameters['ability.params.stream']
  if (url && LockService.instance.state === 'Unlocked') {
    router.pushUrl({ url: 'pages/CapturePage', params: { url } });
  } else if (url) {
    // 锁屏态：暂存，解锁后由 Library 消费
    AppStorage.setOrCreate(KEY_PENDING_SHARE_URL, url);
  }
}
```

`KEY_PENDING_SHARE_URL` 加入 [`AppStorageKeys.ets`](../../../shibei-harmony/entry/src/main/ets/app/AppStorageKeys.ets)。Library `aboutToAppear` 检查并消费（与 Deep Link 行为一致）。

### 3.2 库内手动粘贴（主动添加）

[`Library.ets`](../../../shibei-harmony/entry/src/main/ets/pages/Library.ets) 在 ResourceList 右下角放 **FAB「+」** 按钮（折叠侧栏时也常驻），点击弹 `AddByUrlDialog`。

```
┌────────────────────────────┐
│  添加网页                   │
│                            │
│  [______________________]  │ ← URL 输入框，autofocus
│  例如 https://example.com  │
│                            │
│  📋 从剪贴板粘贴            │ ← 仅当剪贴板是 URL 时显示
│                            │
│      [取消]    [打开]       │
└────────────────────────────┘
```

#### 关键交互
- **剪贴板嗅探**：dialog 打开时调 `pasteboard.getSystemPasteboard().getData()`，正则判 URL（`^https?://[^\s]+$`），是就显示一行「📋 从剪贴板粘贴：{url 截断 40 字符}」一键填入。鸿蒙 NEXT 系统会有"应用已读取剪贴板"顶部提示条，属系统行为告知用户。
- **URL 校验**：本地正则即可，不发请求嗅探。无效 → 输入框红边 + 文案。
- **Schema 容错**：用户没写 `https://` 时自动补 `https://`（与桌面浏览器一致）。
- **Enter 提交**：软键盘"完成"键触发"打开"。
- **打开后**：`router.pushUrl({ url: 'pages/CapturePage', params: { url } })`，与分享入口完全合流。

### 3.3 不做
- ❌ Android 风格的"系统浏览器长按链接选自定义 App"——鸿蒙暂不支持。
- ❌ 浏览器主页快捷方式直跳。

---

## 4. CapturePage 详细设计

### 4.1 文件
- 新文件：`entry/src/main/ets/pages/CapturePage.ets`
- 新文件：`entry/src/main/ets/pages/AddByUrlDialog.ets`
- 修改：[`Library.ets`](../../../shibei-harmony/entry/src/main/ets/pages/Library.ets) (加 FAB)
- 修改：[`EntryAbility.ets`](../../../shibei-harmony/entry/src/main/ets/entryability/EntryAbility.ets) (加 share skill 分支)
- 修改：[`module.json5`](../../../shibei-harmony/entry/src/main/module.json5) (加 share skill)
- 修改：[`AppStorageKeys.ets`](../../../shibei-harmony/entry/src/main/ets/app/AppStorageKeys.ets) (加 PENDING_SHARE_URL key)

### 4.2 路由参数

```typescript
interface CaptureParams {
  url: string;        // 要抓取的 URL
  folderId?: string;  // 可选预设目标 folder（默认收件箱）
}
```

### 4.3 状态机

```
loading        网页加载中（onPageBegin → onPageEnd）
ready          可保存
scrolling      自动滚动中（disable 保存按钮）
saving         SingleFile 打包 + 写库
saved          toast + back（短暂 200ms 让用户看到反馈）
error_load     页面加载失败
error_save     SingleFile 失败 / NAPI 写失败
```

### 4.4 UI 结构

```typescript
@Entry
@Component
struct CapturePage {
  @State url: string = '';
  @State title: string = '';
  @State host: string = '';
  @State progress: number = 0;
  @State state: CaptureState = 'loading';
  @State isPdf: boolean = false;          // 检测到 Content-Type: application/pdf
  @State pdfBytes?: Uint8Array;           // PDF 模式下缓存
  @State targetFolder: Folder = INBOX;
  @State error: string = '';
  private webController: webview.WebviewController = new webview.WebviewController();

  build() {
    Column() {
      this.TopBar();
      Stack() {
        Web({ src: this.url, controller: this.webController })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .databaseAccess(true)
          .geolocationAccess(false)
          .onPageBegin(() => { this.state = 'loading'; })
          .onPageEnd(() => { this.state = 'ready'; this.injectSingleFile(); })
          .onTitleReceive((e) => { this.title = e.title; })
          .onProgressChange((e) => { this.progress = e.newProgress; })
          .onResourceLoad((e) => { this.detectPdf(e); })
          .onErrorReceive((e) => { this.state = 'error_load'; this.error = e.error.getErrorInfo(); });

        if (this.state === 'saving') this.SavingOverlay();
        if (this.state === 'error_save') this.ErrorOverlay();
      }
      .layoutWeight(1);

      this.BottomBar();
    }
  }

  // ... TopBar / BottomBar / FolderPicker / SavingOverlay 等 @Builder
}
```

### 4.5 SingleFile 注入

#### Bundle 位置
将 [`extension/lib/single-file-bundle.js`](../../../extension/lib/single-file-bundle.js) 拷到 `entry/src/main/resources/rawfile/single-file-bundle.js`（~700KB）。

#### 注入时机
`onPageEnd` 触发时**预注入**（不等用户点保存），避免保存时再注入造成几秒延迟：

```typescript
private async injectSingleFile() {
  const code = await loadRawfile('single-file-bundle.js');
  await this.webController.runJavaScriptExt(code);  // 用 Ext 版传大字符串
  // 同时挂一个 sentinel，让保存逻辑可以确认 SingleFile 就绪
  await this.webController.runJavaScript(`window.__shibeiSFReady = true;`);
}
```

#### 保存时调用
```typescript
private async saveHtmlSnapshot() {
  this.state = 'saving';
  const js = `
    (async () => {
      if (!window.__shibeiSFReady) {
        window.shibeiBridge.emit('snapshot-error', 'singlefile_not_ready');
        return;
      }
      try {
        const d = await SingleFile.getPageData({
          removeScripts: true,
          compressHTML: true,
          removeHiddenElements: false,
        });
        window.shibeiBridge.emit('snapshot', JSON.stringify({
          html: d.content,
          title: d.title || document.title,
          url: location.href,
        }));
      } catch (err) {
        window.shibeiBridge.emit('snapshot-error', String(err && err.message || err));
      }
    })();
  `;
  await this.webController.runJavaScript(js);
  // ArkTS 端订阅 shibeiBridge 'snapshot' 事件，收到后调 NAPI
}
```

#### 桥接事件
扩展 [`AnnotationBridge.ets`](../../../shibei-harmony/entry/src/main/ets/components/AnnotationBridge.ets) （或新建 `CaptureBridge.ets`）：

```typescript
interface SnapshotPayload {
  html: string;     // SingleFile 输出的 inlined HTML
  title: string;
  url: string;
}
```

收到后 ArkTS 调 NAPI：
```typescript
const resourceId = ShibeiService.instance.saveHtmlSnapshot(
  payload.url, payload.title, payload.html, this.targetFolder.id
);
```

### 4.6 自动滚助手

底部「⤓ 滑到底」按钮 → state → `'scrolling'`，禁用「保存」按钮 → 注入 step-scroll 脚本：

```typescript
private async scrollToBottom() {
  this.state = 'scrolling';
  const js = `
    (function () {
      const step = Math.floor(window.innerHeight * 0.8);
      let lastY = -1, stable = 0;
      const tick = setInterval(() => {
        if (window.scrollY === lastY) {
          stable++;
          if (stable >= 3) {
            clearInterval(tick);
            window.shibeiBridge.emit('autoscroll-done', '');
          }
        } else {
          stable = 0;
          lastY = window.scrollY;
        }
        window.scrollBy(0, step);
      }, 300);
    })();
  `;
  await this.webController.runJavaScript(js);
  // 监听 'autoscroll-done' 事件，恢复 'ready' state
}
```

`stable >= 3` 阈值是为了等懒加载脚本反应过来——单帧 scrollY 不动可能只是请求中。

### 4.7 PDF 分支

- `onResourceLoad` 监 mainFrame 响应：URL 与 `this.url` 匹配且响应头 `Content-Type` 为 `application/pdf` 时 → `this.isPdf = true`。
- 顶部进度条变绿勾，底部按钮文案换成「保存 PDF」。
- 不跑 SingleFile，ArkTS 直接走 `@kit.NetworkKit` 的 `http.request(url, { extraData: { 'cookie': cookieFromWeb } })` 拿 bytes。
  - **关键**：要带上 WebView 当前 cookie（同样为了过登录墙）。`webview.WebCookieManager.getCookie(url)` 取出 cookie 字符串塞到请求头。
- 拿到 bytes → base64 → NAPI `save_pdf_snapshot`。

---

## 5. NAPI 接口

新增两条命令（[`src-harmony-napi/src/commands.rs`](../../../src-harmony-napi/src/commands.rs)）：

```rust
#[shibei_napi]
pub fn save_html_snapshot(
    url: String,
    title: String,
    html: String,
    folder_id: String,
) -> String {
    // 返回 JSON: { resource_id: string } 或 { error: i18n_key }
    // 实现要点：
    // 1. 复用 src-tauri/src/server/ 的 save_html handler 核心逻辑
    // 2. 写文件 storage/{resource_id}/snapshot.html
    // 3. INSERT resources + 写 sync_log（透 SyncContext）
    // 4. 提取 plain_text（shibei-storage::plain_text）
    // 5. rebuild_search_index
    // 6. 标记 snapshot_present = 1，触发 onDataChanged
}

#[shibei_napi]
pub fn save_pdf_snapshot(
    url: String,
    title: String,
    pdf_b64: String,
    folder_id: String,
) -> String {
    // 同上，存 storage/{resource_id}/snapshot.pdf
    // plain_text 用 shibei-storage::pdf_text
}
```

**复用而非重写**：把 [src-tauri/src/server/](../../../src-tauri/src/server/) 现在的 axum handler 内核抽到 `crates/shibei-storage` 的新模块 `ingest.rs`（双端共用），axum 和 NAPI 都做薄包装。本设计不要求一定先抽，但实现时建议同步抽出避免代码漂移。

---

## 6. 错误处理 / 边界

| 情况 | 处理 |
|---|---|
| URL 加载失败（DNS / 超时 / 4xx 5xx） | `state = 'error_load'`，显示 onErrorReceive 信息 + 「重试」按钮 |
| SingleFile 注入失败（页面 CSP 极严，禁 inline script） | 降级：`document.documentElement.outerHTML` 兜底（无 inline 资源），toast 提醒「该页面只能保存简化版本」 |
| HTML > 80MB | NAPI 返 `error.pageTooLarge`，提示用户「页面过大，建议保存 PDF」 |
| PDF 下载失败 | 显示错误，「重试」 |
| 用户中途按 ← 取消 | 直接 `router.back()`，不写库 |
| 保存中按 ← | 拦截：「保存进行中，确认放弃？」 |
| 锁屏 + 分享进入 | 暂存到 AppStorage，解锁后 Library 消费并 push CapturePage |
| 同 URL 重复抓取 | 不去重，每次都新建 resource（与桌面行为一致，由用户决定是否删除旧的） |

---

## 7. i18n keys

[`resources/{zh_CN,en_US,base}/element/string.json`](../../../shibei-harmony/entry/src/main/resources/) 各加：

```
capture_add_by_url        添加网页 / Add web page
capture_url_placeholder   https://...
capture_url_paste         从剪贴板粘贴：%1$s
capture_url_invalid       请输入有效的 URL
capture_open              打开
capture_cancel            取消
capture_back              返回
capture_refresh           刷新
capture_save              保存
capture_save_pdf          保存 PDF
capture_scroll_to_bottom  滑到底
capture_scrolling         滚动中…
capture_saving            正在保存…
capture_saved             已保存到 %1$s
capture_view              查看
capture_login_required    需要登录的页面请先登录再保存
capture_load_failed       页面加载失败
capture_save_failed       保存失败：%1$s
capture_too_large         页面过大，建议改为保存 PDF
capture_retry             重试
capture_target_folder     保存到
capture_abandon_confirm   保存进行中，确认放弃？
```

底部 Toast「已保存」附「查看」按钮 → 直接 `router.replaceUrl('pages/Reader', { resourceId })`。

---

## 8. 安全 / 隐私

- **JS 注入**：CapturePage 的 `Web` 组件 `javaScriptAccess(true)`，因为 SingleFile 必须跑 JS。同 Reader 行为一致。
- **Cookie 隔离**：CapturePage 的 cookie 与 Reader 的 cookie 共享同一 ArkWeb cookieStore（app 范围内共用）。这意味着用户登录态在所有内嵌 WebView 间共享 —— 是 feature 不是 bug。
- **不上传**：所有抓取数据都在本地，sync_log 走 S3 时已经是用户配置的 E2EE 路径。
- **Geo / Camera 权限**：Web 组件关闭 `geolocationAccess` / `cameraAccess`，避免被抓取页面骚扰。
- **隐私 URL**：用户输入或分享的 URL 写到 sync_log 与 hilog 时**不脱敏**（用户已知情）。但 `debug.log` 不写 URL（避免协作时贴日志泄露）。

---

## 9. 工作量拆解

| 任务 | 估时 |
|---|---|
| `module.json5` share skill + EntryAbility 分支 + 锁屏暂存 | 0.5d |
| `AddByUrlDialog` + Library FAB + 剪贴板嗅探 | 0.5d |
| `CapturePage` UI（top/bottom bar + Web + folder picker + overlay） | 1d |
| SingleFile 注入 + bridge + 自动滚助手 | 0.5d |
| PDF 分支（cookie 注入 + http 下载 + base64） | 0.5d |
| `save_html_snapshot` / `save_pdf_snapshot` NAPI + 抽 ingest 模块 | 1d |
| 端到端联调 + 边界 case + i18n | 0.5d |
| **总计** | **~4.5d** |

---

## 10. 验收 checklist

- [ ] 浏览器分享 URL 到拾贝 → 进入 CapturePage → 点保存 → Library 列表立即出现新资料
- [ ] Library FAB「+」→ 粘贴 URL 也能进 CapturePage
- [ ] 剪贴板含 URL 时 dialog 显示一键粘贴
- [ ] 微信公众号文章登录后能正确抓取（cookie 持久化）
- [ ] 知乎专栏长文 + 图，「滑到底」后图片完整保存
- [ ] PDF URL（如 arxiv）分享进入后保存为 pdf 类型，Reader 能用 PDF shell 打开
- [ ] 锁屏中分享 → 解锁后自动跳到 CapturePage
- [ ] CapturePage 期间按 ← 不写库
- [ ] 80MB+ 页面提示用户改保存 PDF
- [ ] 保存的快照在桌面同步后可正常打开标注

---

## 11. v2 后续（不在本设计范围）

- 抓取队列：批量分享多个 URL 时排队
- 离线缓存：弱网环境下先存 URL，恢复后异步抓取
- 选区抓取：长按 WebView 内容触发选区面板
- 抓取后自动建议标签
- 与桌面共享 cookie（HUKS 加密 cookie 包跨端同步）—— 隐私敏感，需独立设计
