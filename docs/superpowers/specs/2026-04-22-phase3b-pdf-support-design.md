# Phase 3b — 鸿蒙移动端 PDF 支持设计文档

## 目标

让鸿蒙手机版拾贝支持 PDF 资料的阅读与标注，功能与桌面端对齐，并通过
现有同步管道跨端互通。本期只支持"同步下行"的 PDF（元数据 + 二进制均由
桌面端产出），手机端不提供本地导入入口。

## 前置

- Phase 3a 已交付：ArkWeb HTML 阅读器 + 完整标注链（高亮 / 评论 /
  LWW / 长按改色菜单）。本期只在此之上增加 PDF 分支。
- 桌面端 PDF 设计见 `2026-04-15-v2.3-pdf-support-design.md`，已在线运行；
  anchor 格式、sync 协议、plain_text 提取等后端基础设施可直接复用。

---

## 1. 架构总览

PDF 是在现有 `Reader.ets` 页面中的一个**条件分支**：外围 UI（Meta 栏、
AnnotationPanel、评论 bindSheet、滚动位置持久化、bridge API 契约、
AnnotationsService）全部共用；只有"内容渲染区"按 `resource_type`
派发到 `HtmlContent()` 或 `PdfContent()` 两个 @Builder。

```
                      Reader.ets (Entry)
                              │
          ┌── resource_type == 'pdf' ──┐
          │                             │
     HtmlContent()                 PdfContent()
     loadData(html)                Web(src=$rawfile('pdf-shell/shell.html?id=<id>'))
     annotator-mobile.js           pdf-annotator-mobile.js
                                   onInterceptRequest('shibei-pdf://')
                                        ↓
                                   NAPI get_pdf_bytes / ensure_pdf_downloaded
                                        ↓
                                   storage/{id}/snapshot.pdf

共享：AnnotationPanel, bindSheet(CommentSheet), ReaderScrollState,
      AnnotationsService, sessionState, window.__shibei.* bridge API
```

### 关键设计决定（已和用户对齐）

| # | 决定 |
|---|---|
| 1 | PDF 字节走 **ArkWeb `onInterceptRequest` + 自定义 scheme `shibei-pdf://`** |
| 2 | PDF Reader 在现有 `Reader.ets` 内**条件分支**，不新建 Entry 页 |
| 3 | pdfjs 静态资产（pdf.mjs, worker, cmaps, shell）打进 **HAP `rawfile/`** |
| 4 | **独立 `pdf-annotator-mobile.js`**，和 HTML annotator 不共享代码，只共享 `window.__shibei.*` API 名字 |
| 5 | **固定 fit-to-width**，MVP 不做任何缩放 |
| 6 | **标注完整三层**：PDF 高亮 + 资料级评论 + 高亮下评论，全部跨端同步 |
| 7 | 打开 PDF 时本地无文件 **自动后台下载**，转圈 → 渲染；失败态可重试 |

---

## 2. 数据流

### 2.1 打开 PDF 资料

```
Library.onOpenResource(id)
  → router.pushUrl('pages/Reader', { resourceId })

Reader.aboutToAppear()
  ├── resource = getResource(id)
  ├── if resource.resource_type == 'pdf':
  │     if !exists(storage/{id}/snapshot.pdf):
  │         pdfDownloading = true
  │         ensurePdfDownloaded(id) → pdfReady = true on success
  │                                 → pdfError on fail
  │     else pdfReady = true
  └── load annotations (复用 3a 的 AnnotationsService.load)

Reader.build() → PdfContent(resource) 分支
  Web({
    src: $rawfile('pdf-shell/shell.html?id=' + resource.id),
    controller: webController,
  })
  .onInterceptRequest(ev => handlePdfIntercept(ev))
  .onControllerAttached(() => registerJavaScriptProxy(bridge, 'shibeiBridge', ['emit']))
```

### 2.2 PDF 字节传输

shell.html 启动：
```js
const id = new URL(location.href).searchParams.get('id');
pdfjsLib.getDocument({
  url: `shibei-pdf://resource/${id}`,
  cMapUrl: './cmaps/',
  cMapPacked: true,
}).promise → 渲染管线
```

ArkWeb 发出该 URL 的网络请求 → `onInterceptRequest` 触发：

```ts
handlePdfIntercept(ev): WebResourceResponse | null {
  const url = ev.request.getRequestUrl();
  if (!url.startsWith('shibei-pdf://resource/')) return null;
  const id = url.slice('shibei-pdf://resource/'.length);
  const bytes = ShibeiService.instance.getPdfBytes(id);  // Uint8Array
  return new WebResourceResponse({
    responseMimeType: 'application/pdf',
    responseCode: 200,
    responseData: bytes,
  });
}
```

MVP 一次性返回全文件（Range 请求作为后续优化，见 §5）。

### 2.3 标注生命周期

```
(a) shell.html 第一页渲染完成 → pdf-annotator-mobile.js emit('ready')
    ArkTS 收到 → runJavaScript('window.__shibei.paintHighlights(<json>)')
    annotator 按 anchor.page 分组；当前已渲染的页上叠加 overlay

(b) 用户在文本层长按选中文字 → 浏览器原生 Selection
    annotator 捕捉 selectionchange 稳定态 → 计算 anchor：
        page        = 选区起点父 div 的 data-page-number
        charIndex   = 页文本流从头到选区起点的字符偏移
        length      = 选区长度
        textQuote   = { exact, prefix(10), suffix(10) }
    bridge.emit('selection', { textContent, anchor, rect })

    Reader 收到 → 弹色板 → 点色 → AnnotationsService.createHighlight(...)
    Service notify → paintHighlights 再跑一遍 → 新高亮出现

(c) 点已有高亮 → overlay click → bridge.emit('click', { highlightId })
    Reader 打开 AnnotationPanel（和 HTML 端行为一致）

(d) 改色 / 删除 / 长按菜单：复用 3a 的 Panel UI；annotator 暴露
    setHighlightColor / removeHighlight，ArkTS 侧 runJavaScript 驱动
```

### 2.4 虚拟滚动

shell 维护 pageContainers：每页一个空 div，占位用 CSS `aspect-ratio`。
`IntersectionObserver` 观察可视页 ±1 范围：

- 进入 → `page.render(canvas)` + `streamTextContent()` 渲染文本层 +
  本页高亮 overlay
- 离开 ±1 → 清 canvas 释放显存，文本层保留（体积小，避免重绘）

---

## 3. 模块清单与文件改动

### 3.1 Rust（NAPI）

| 文件 | 改动 |
|---|---|
| `src-harmony-napi/src/commands.rs` | 新增 `get_pdf_bytes(id) -> Vec<u8>`、`ensure_pdf_downloaded(id) -> String`（"ok" 或 "error.xxx"）。 |
| `src-harmony-napi/src/state.rs` | 无改动（`data_dir` + `db_pool` + `clock` 够用）。 |
| `shibei-sync` | 确认按需下载接口复用，Phase 3b spike 阶段验证；如有 gap 再补。 |

NAPI 返回 `Vec<u8>` → ArkTS 侧得到 `Uint8Array`。

### 3.2 HAP 静态资产

新增 `shibei-harmony/entry/src/main/resources/rawfile/pdf-shell/`：

| 文件 | 作用 |
|---|---|
| `shell.html` | ~30 行 HTML shell，`<script type="module" src="./main.mjs">` |
| `main.mjs` | pdfjs 启动 + 虚拟滚动骨架 + 加载 annotator |
| `pdf.mjs` | pdfjs-dist 预构建主库 |
| `pdf.worker.mjs` | pdfjs worker |
| `cmaps/` | CJK 字符映射数据（pdfjs 自带） |
| `pdf-annotator-mobile.js` | 独立标注脚本 |
| `style.css` | 页面容器 / 文本层 / 高亮 overlay 样式 |

新增 `scripts/copy-pdfjs-assets.sh`：执行 `npm install pdfjs-dist` 后，
把必要文件从 `node_modules/pdfjs-dist/build/` 与 `web/` 拷到 rawfile。
HAP 构建前跑一次（幂等）。

### 3.3 ArkTS

| 文件 | 改动 |
|---|---|
| `services/ShibeiService.ets` | 新增 `getPdfBytes(id): Uint8Array`、`ensurePdfDownloaded(id): Promise<void>` |
| `pages/Reader.ets` | 核心改动：拆 `HtmlContent()` / `PdfContent()` @Builder；`build()` 按 `resource_type` 派发；新增 `pdfReady/pdfDownloading/pdfError` 状态 + `handlePdfIntercept(ev)` |
| `components/AnnotationBridge.ets` | 无改动 |
| `components/AnnotationPanel.ets` | 无改动 |
| `services/AnnotationsService.ets` | 无改动 |

### 3.4 不改动的（列出来对照）

- DB schema / migrations
- 同步协议 / S3 key / LWW / sync_log
- `annotator-mobile.js`（HTML 用）
- `FolderDrawer.ets` / `ResourceList.ets` / `Library.ets`
- pairing / encryption / HUKS
- MCP / backup / search

### 3.5 新增依赖

- npm dev-only：`pdfjs-dist@^5.x`（只用于拷贝资产，不进运行时 JS bundle）
- Rust：无（sync 下载路径已存在）

---

## 4. 测试计划

### 4.1 Rust 单测

- `get_pdf_bytes`：文件存在 / 不存在 / resource_type 非 pdf 的错误路径
- `ensure_pdf_downloaded`：mock `SyncBackend`，覆盖已存在跳过 / 触发下载
  / 下载失败

`cargo test -p shibei-core` + `cargo clippy -- -D warnings` 均通过。

### 4.2 手动冒烟（SSH + hdc，参照 3a 已有套路）

| # | 场景 | 期望 |
|---|---|---|
| P1 | 桌面导入 A4 PDF，同步；手机拉元数据；点开 | 自动下载 → 首页 fit-to-width 渲染 |
| P2 | 翻滚到第 5 页 | 虚拟滚动按需渲染，无明显卡顿 |
| P3 | 文本长按 → 色板 → 黄色 | 显示 overlay，DB 写入，sync_log 有 INSERT |
| P4 | 手机同步 → 桌面同步 | 桌面 PDF Reader 能看到该黄色高亮（anchor 跨端兼容） |
| P5 | 桌面建蓝色高亮同步 → 手机拉 | 手机 PDF Reader 显示蓝色高亮 |
| P6 | 手机长按高亮卡片 → 改粉色 | 即时生效，UPDATE 入 sync_log |
| P7 | 高亮下 + 评论；资料级 + 笔记 | 两种评论都可创建；AnnotationPanel 复用正常 |
| P8 | 关闭 Reader 再打开 | 滚动位置恢复 |
| P9 | 扫描版 PDF（无文字层） | 能渲染图像；选不到文字；显示提示 |
| P10 | 下载失败（断网） | 错误态 + 重试按钮 |
| P11 | 损坏 PDF | 不崩溃，显示 parse error 态 |

工具：`scripts/smoke-sync-diff.sh` 按需扩展支持 `resource_type='pdf'`
过滤（最小改动，delta 输出里多一列即可）。

### 4.3 性能 spot-check（非硬指标）

- 10 MB / ~50 页 PDF 首次打开到首页可读：< 3s
- 翻页响应：滚动过程无持续卡顿
- Reader 常驻内存：< 200 MB

---

## 5. 风险 & Spike 验证

直接用 **一个端到端 spike** 同时验 5 个风险，不分项验证：

```
Task 0 spike 产物：
  1. rawfile/pdf-shell/ 放 shell.html + pdf.mjs + pdf.worker.mjs + 一个假 5 KB PDF
  2. ArkWeb Web 组件 src = $rawfile('pdf-shell/shell.html')
  3. onInterceptRequest 拦 shibei-pdf://test → 返回那 5 KB PDF 的字节
  4. shell.html 里 pdfjs.getDocument({url:'shibei-pdf://test'}) → render 到 canvas
```

第一页画出来（哪怕糊）= 5 个风险一次解：
- ✅ `onInterceptRequest` 能返回二进制
- ✅ pdfjs ES module 在 rawfile 下能解析相对路径 worker
- ✅ pdfjs worker 能在 ArkWeb 初始化
- ✅ Canvas 能在 ArkWeb 渲染
- ✅ 字节链路通

如果画不出来，按报错归因并回滚：
- intercept 返回二进制有问题 → 切 base64 via proxy
- worker 起不来 → 切 `useWorker: false`（单线程，慢但可用）
- canvas 不清晰 → 调 `devicePixelRatio`

### 已知限制（进 CLAUDE.md 记账）

- 无本地导入（手机端只能被动接收同步）
- 无缩放（fit-to-width 固定）
- 无搜索 / 目录 / 跳页
- 扫描 PDF 不支持文本高亮
- 加密 PDF 直接失败

---

## 6. 落地节奏

Phase 3a 的 task 拆分方式行之有效，沿用。预计 ~11 个 task，每个聚焦
一个变更，commit 直推 main。

| # | Task | 依赖 |
|---|---|---|
| 0 | **Spike**：假 PDF 经 intercept 渲染到 canvas | — |
| 1 | npm 装 pdfjs-dist + `scripts/copy-pdfjs-assets.sh` + rawfile 目录 | 0 |
| 2 | Rust NAPI：`get_pdf_bytes` + `ensure_pdf_downloaded` | 1 |
| 3 | ShibeiService facade + `Index.d.ts` 重建 + .so 重编 | 2 |
| 4 | shell.html + main.mjs：单页渲染 happy path | 1 |
| 5 | 虚拟滚动 + 多页 | 4 |
| 6 | `pdf-annotator-mobile.js`：选区 → anchor → 发桥 | 5 |
| 7 | annotator：paintHighlights / 点击 / 改色 | 6 |
| 8 | `Reader.ets` PdfContent 分支 + 下载态 UI + 错误态 | 3,7 |
| 9 | 长按菜单挂 + AnnotationPanel 共用（几乎零改动） | 8 |
| 10 | 跨端冒烟（P1–P11）+ smoke-sync-diff.sh 扩展 | 9 |
| 11 | CLAUDE.md 更新 + memory reference 更新 | 10 |

完成标志：P1–P11 全过；两端任意一条 PDF 高亮能双向同步并保持颜色一致。
