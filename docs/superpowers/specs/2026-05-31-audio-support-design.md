# 音频资料支持设计文档

> 状态：Phase A + B + C 全部实现。桌面（A/B）在 `main`；鸿蒙（Phase C：播放 + 转写视图 + 标注 + 多选）在分支 `feat/harmony-audio`，Mate X5 真机已验证。
> 日期：2026-05-31
> 模板参考：`docs/superpowers/specs/2026-04-15-v2.3-pdf-support-design.md`（PDF 接入模式）

## 目标

让拾贝支持**音频资料**（会议/讲座/播客/语音备忘等录音）的导入、播放与标注，并能被全文搜索。与现有 HTML/PDF 体验对齐。

## 核心决策（已确认）

1. **范围**：只**导入已有音频文件**。不做应用内录音，不做浏览器插件抓取。
2. **转写**：拾贝**自身不做语音转写**。它只存音频；转写交给**外部 AI agent 经 MCP 完成**——agent 拿到音频本地路径，用自带的 ASR 手段转写，再经 MCP 写回拾贝。
   - 理由：保持拾贝「只读资料库 + AI 工具的数据后端」定位；不在拾贝里引入转写 provider / API key / 文件大小上限 / 后台任务；用户可自由选择任意转写方式（最大灵活）。
   - 代价：转写从「导入即自动」变为**用户/agent 主动触发**；且 agent 必须自带 ASR 手段（Claude 本身不直接「听」音频）。
3. **平台**：先桌面。鸿蒙移动端音频留后续，本轮不做（数据模型对齐，移动端可独立排期）。
4. **播放**：经 `shibei://resource/{id}` 自定义协议返回原始字节 + **支持 Range（HTTP 206）**，让 `<audio>` 原生流式 seek。
5. **转写粒度**：**段级时间戳** `[{start, end, text}]`，解锁转写视图、点句跳播、选转写文本建高亮。

## 架构方案

**最小侵入，复刻 PDF 模式**：音频作为新的 `resource_type = "audio"` 平行于 webpage/pdf，复用现有存储/同步/搜索/标注/问题/备份管道，只在内容渲染层（`AudioReader`）与转写写回（MCP `set_transcript`）分叉。

- ReaderView 按 `resource_type` 条件渲染 — HTML 走 iframe，PDF 走 `PDFReader`，音频走 `AudioReader`
- 外围 UI（meta 栏、AnnotationPanel、面板折叠、问题 chip、预览面板、Deep Link）全部复用
- DB schema 零 migration；highlights/comments 表、同步协议、备份恢复零改动

---

## 1. 存储与数据模型

### 文件存储

```
storage/{resource_id}/snapshot.{原扩展名}    # 音频原文件，不转码（如 snapshot.m4a）
storage/{resource_id}/transcript.json        # 转写产物（新增），仅转写后存在
```

`storage::save_snapshot_ext()` 已支持任意扩展名，导入时按原始扩展名落盘。**不引入 ffmpeg / 不转码**。

### transcript.json 格式

```json
{
  "version": 1,
  "language": "zh",
  "segments": [
    { "start": 0.0,  "end": 4.2,  "text": "第一段话。" },
    { "start": 4.2,  "end": 9.8,  "text": "第二段话。" }
  ]
}
```

- `start`/`end`：秒（浮点）
- `plain_text` 列 = `segments[].text` 顺序拼接（用于 FTS）

### DB 变更

无 migration。`resource_type` 字段已存在（migration 001，默认 `'webpage'`），新增值 `"audio"`。`file_path` 存相对路径，音频为 `storage/{id}/snapshot.{ext}`。

**是否已转写**由 `transcript.json` 是否存在 / `plain_text` 是否非空**派生**，**不新增状态列**——转写是 agent 外部触发，拾贝无需任务队列/状态机。

---

## 2. 同步

### 音频文件（snapshot.{ext}）

复用现有 S3 快照管道（按需下载：元数据先同步，打开时才下载音频）。需改动：

- `snapshot_s3_key()` / `snapshot_filename()`（`crates/shibei-sync/src/engine.rs:87,93`）当前按 `== "pdf"` 硬编码扩展名。改为**从 resources 行的 `file_path` 派生扩展名**（resources 行作为元数据先同步，下载时可读到 `file_path`），不再硬编码 per-type。
- 音频已压缩，gzip 收益甚微：可对 audio **跳过 gzip**（直接上传/下载原字节），减少 CPU。S3 key 相应去掉 `.gz`（或保留统一 `.gz` 但内部 store 模式——实现时定，倾向跳过 gzip）。

### transcript.json（新增同步产物）

**关键设计点**：音频的 `plain_text` **不能**沿用现有「各设备从快照本地重提」规则——HTML/PDF 本地重提是免费的，但音频重提 = 重新转写 = 重新花钱/算力。因此：

- `transcript.json` 作为**独立同步产物**上传/下载（很小，KB 级）。
- transcript.json **随元数据提前下载**（不等音频文件按需下载），使**搜索在不下载大音频的前提下也能命中转写正文**。
- 下载 transcript.json 后，从 `segments` 派生 `plain_text` → `set_plain_text()`（顺带重建 FTS）。
- `download_snapshot()`（`engine.rs:2011`）当前的 `if pdf / else html` 转写提取分支，对 audio 改为：不从音频字节提取，而是确保 transcript.json 已下载并据此填 `plain_text`。

> 实现选项：transcript.json 可走与快照并列的第二条同步路径，或在元数据同步阶段批量拉取。实现时细化，原则是「小、早、随元数据」。

---

## 3. 内容获取与播放

### shibei:// 协议返回音频 + Range

协议处理器在 `src-tauri/src/lib.rs:402`（同步 `register_uri_scheme_protocol("shibei", ...)`），当前只 `load_resource_html` + 注入 annotator。新增音频分支：

1. 路由 `/resource/{id}` 命中后，判定资源类型：
   - 当前闭包只捕获 `base_dir`（无 DB 句柄）。**推荐做法**：扫 `storage/{id}/` 探测 snapshot 文件——有 `snapshot.html` 走 HTML 旧路径；否则按已知音频扩展名（mp3/m4a/wav/...）识别为音频。（备选：给闭包加 `SharedPool` 句柄查 `resource_type`/`file_path`，更精确但耦合更重。）
2. 音频分支：读 `Range` 请求头 → 只读对应字节区间 → 返回 **206 Partial Content**，带 `Content-Type`（按扩展名映射 MIME）、`Accept-Ranges: bytes`、`Content-Range`、`Content-Length`。无 Range 头则返回 200 全文 + `Accept-Ranges: bytes`。
3. 不注入 annotator.js（音频标注走 React 组件 props，不走 iframe postMessage）。

> 注：同步协议可只读请求的字节区间（避免整文件进内存）。若实现遇到大文件阻塞，再评估迁移到 `register_asynchronous_uri_scheme_protocol`。

### 前端

`<audio src="shibei://resource/{id}">`，浏览器原生发 Range 请求实现 seek。无需 blob URL、无需整文件进内存。

---

## 4. 前端渲染（AudioReader）

### ReaderView 条件分支

`ReaderView.tsx` 现有 `resource_type === "pdf" ? <PDFReader> : <iframe>`，扩展为三分支，新增 `"audio" → <AudioReader>`。外围 UI 复用。

### AudioReader 组件（`src/components/AudioReader.tsx`，新增）

- **播放器**：`<audio>` + 自定义控件 — 播放/暂停、进度条、当前/总时长、倍速（0.5–2x）、±15s 跳转。时长由 `<audio>` 的 `loadedmetadata` 事件给出（无需后端）。
- **时间轴标注 marker**：highlights 以 marker 叠加在进度条上（按 `anchor.start` 定位）；点 marker → seek 到该时间。
- **转写视图**（transcript.json 存在时）：
  - 段落列表，可滚动；
  - **卡拉OK 跟随**：随播放位置高亮当前 segment（`currentTime` 落在 `[start,end)`）；
  - **点句跳播**：点 segment → `audio.currentTime = segment.start`；
  - **选转写文本建高亮**：原生 Selection → 映射到字符偏移与时间段 → 创建 highlight。
- 无转写时：仅播放器 + 时间轴 marker 标注。
- **meta 栏 auto-hide**：HTML/PDF 靠滚动方向触发；音频无内容滚动（或仅转写滚动）。简单起见，音频模式 meta 栏常显或随转写滚动隐藏（实现时定，倾向常显）。
- 与 AnnotationPanel：作为 React 子组件，经 props/callbacks 通信（同 PDFReader 模式，不走 postMessage）。

---

## 5. 音频标注系统

### Anchor 格式（统一 audio 类型）

```json
{
  "type": "audio",
  "start": 752.3,
  "end": 768.9,
  "charIndex": 1840,
  "length": 56,
  "textQuote": { "exact": "...", "prefix": "...", "suffix": "..." }
}
```

- **纯时间段高亮**（直接在进度条/时间轴标）：只有 `start`/`end`；`charIndex`/`length`/`textQuote` 缺省。`text_content` 存用户输入的笔记或格式化时间标签。
- **转写文本高亮**（选转写文本）：`start`/`end` 由所选 segment 时间戳推出；`charIndex`/`length` 为转写 `plain_text` 中的偏移，`textQuote` 为模糊回退（转写重生成后重新对齐）。`text_content` = 选中的转写文本。

### 后端零改动

`anchor` 在 DB 中是 TEXT（不透明 JSON），highlights/comments 的 CRUD、同步、FTS、级联软删全部透传。`crates/shibei-db/src/highlights.rs` 的 `Anchor = serde_json::Value` 注释补充 audio 形态说明即可。

### 复用

- highlights 上的 `text_content` 进 FTS `highlights_text`（已有）。
- AnnotationPanel 高亮列表、评论、点击跳转全部复用；点击高亮 → AudioReader seek 到 `anchor.start`（替代 HTML 的滚动跳转）。
- **问题系统**：音频 resource、音频 highlight、音频 note 均可关联问题（免费继承，多态 link 已支持 resource/highlight/comment）。

---

## 6. 本地文件导入

### Tauri command

新增 `cmd_import_audio(file_path: String, folder_id: String) -> Resource`，照搬 `cmd_import_pdf`（`src-tauri/src/commands/mod.rs`）：

1. 读文件 → 生成 resource_id → `save_snapshot_ext(base_dir, id, content, ext)`（ext 取原扩展名）
2. 标题取文件名（去扩展名）
3. `create_resource()` 写 DB，`resource_type = "audio"`，`file_path = storage/{id}/snapshot.{ext}`
4. emit `data:resource-changed`

**导入时不做任何文本提取**（转写是外部的，PDF 那个后台 `extract_plain_text` 分支音频不走）。

> 可选：用 `cmd_import_pdf`/`cmd_import_audio` 共用一个按扩展名分派的内部函数，减少重复。

### 前端入口

复用现有两处右键「导入文件」菜单（Sidebar 文件夹行 / ResourceList 空白处）。把 `src/lib/importPdf.ts` 泛化为 `importFile.ts`：

- 文件对话框 filter 扩展为 `pdf` + 常见音频（`mp3, m4a, aac, wav, ...`）；
- 按选中文件扩展名分派 `cmd.importPdf` / `cmd.importAudio`；
- `reader.importFile`（「导入文件」）这个 i18n key 当初即为「未来扩展格式」预留，正好启用。

---

## 7. MCP（转写委托面 — 本方案的核心新增）

agent 经 MCP 完成「读音频 → 自带 ASR 转写 → 写回拾贝」。涉及工具：

### 读取（让 agent 拿到音频）

- `get_resource`（`mcp/src/tools/resource.ts`）：对 audio 资源**额外返回音频文件的绝对路径**，agent 直接读本地文件转写。（拾贝是本地桌面应用，MCP server 与 agent 同机，故返回本地路径而非 base64/二进制最干净。）
- `list_resources` / `search_resources`：支持过滤 `resource_type=audio` 且 `transcribed=false`，让 agent **批量**转未转写音频。

### 写回（agent 写转写结果）

新增 `set_transcript(resource_id, text, segments)`：

```
set_transcript(
  resource_id: string,
  text: string,                                  // 全文（也可由 segments 拼）
  segments: { start: number, end: number, text: string }[]
)
```

- 写 `transcript.json` + `plain_text` + 重建 FTS + emit `data:resource-changed`（PreviewPanel/搜索自动刷新）。
- 幂等覆盖（重转写直接替换）。
- 经 axum HTTP 端点（新增 `POST /api/resources/{id}/transcript`），与现有 MCP→HTTP→DB 模式一致。

### get_resource_content

audio 返回 `plain_text`（= 转写），已泛型，无需改。

### 典型 agent 流程

```
list_resources(type=audio, transcribed=false)
  → 对每个：get_resource 拿路径 → (agent 自带 ASR 转写) → set_transcript(id, text, segments)
```

---

## 8. 搜索

- transcript → `plain_text` → FTS5 自动索引（`set_plain_text` 已重建 `body_text`）。命中显示转写正文 snippet，`match_fields` 含 `body`。
- transcript.json 提前下载 + plain_text 派生 → **不下载大音频也能搜中转写正文**。
- 搜索模块零改动。

---

## 9. 边界情况与限制

- **未转写音频**：可正常播放 + 时间段标注 + 资料级笔记，但不进正文搜索（同「扫描版 PDF」地位）。
- **WebView 编解码**：macOS WKWebView 原生支持 mp3/m4a/wav 稳；opus/ogg/flac 不保证。MVP 先保证前三类，其余给提示或仍允许导入（能存能转写，只是可能不能在内置播放器放）。
- **大文件**：导入路径无 80MB 限制（本地文件直读）。转写文件大小限制**已 moot**——转写在 agent 侧，拾贝不调 API。
- **同步带宽**：音频文件大，沿用按需下载；transcript.json 小、提前下载。

### 不在本轮范围

- 应用内录音
- 浏览器插件音频抓取
- 内置自动转写（数据模型已中立，将来可加而不返工）
- 波形图可视化（用进度条 + 时间轴 marker 替代）
- 音频转码 / 切块

---

## 10. 新增依赖

- **Rust**：无（播放靠 WebView 原生；转写不在拾贝侧；MIME 映射用静态表/标准库）。
- **npm**：无（`<audio>` 原生）。

> 这是本方案相对内置云转写的最大优势：**零新增重依赖**。

---

## 11. 改动范围概览

| 模块 | 改动 |
|------|------|
| `crates/shibei-sync/src/engine.rs` | `snapshot_s3_key`/`snapshot_filename` 扩展名从 `file_path` 派生；audio 跳过 gzip；transcript.json 同步 + 提前下载；`download_snapshot` audio 分支从 transcript.json 派生 plain_text |
| `src-tauri/src/lib.rs`（协议处理器） | `shibei://resource/{id}` 新增 audio 分支：返回原始字节 + Range（206） |
| `src-tauri/src/commands/` | 新增 `cmd_import_audio`（照搬 `cmd_import_pdf`） |
| `src-tauri/src/server/` | 新增 `POST /api/resources/{id}/transcript`（写 transcript.json + plain_text + FTS） |
| `src/components/ReaderView.tsx` | 增加 `"audio" → <AudioReader>` 分支 |
| `src/components/AudioReader.tsx` | 新增：播放器 + 转写视图 + 时间轴标注层 |
| `src/lib/importPdf.ts → importFile.ts` | 泛化为 pdf + audio，按扩展名分派 |
| `src/lib/commands.ts` | 新增 `importAudio` invoke 封装 |
| `mcp/src/tools/resource.ts` | `get_resource` 返音频路径；新增 `set_transcript`；list/search 支持 transcribed 过滤 |
| `src/types/index.ts` | 新增 `AudioAnchor` 类型 |
| `crates/shibei-db/src/highlights.rs` | `Anchor` 注释补 audio 形态 |
| i18n（zh/en） | 音频/转写相关文案 |

**不改动**：DB migration、highlights/comments 表、AnnotationPanel 核心、问题系统、备份恢复、搜索模块、Chrome 插件。

---

## 12. 实现阶段建议

1. **Phase A — 音频核心**：导入 + 存储/同步（扩展名派生）+ 协议 Range 播放 + AudioReader 播放器 + 时间段标注。可独立交付（无转写也可用）。
2. **Phase B — 转写联动**：MCP `set_transcript` + 路径返回 + transcript.json 同步 + AudioReader 转写视图 + 转写文本高亮 + FTS。
3. **Phase C — 鸿蒙移动端音频（已实现）**：NAPI `ensure_audio_downloaded`（返路径，AVPlayer `fdSrc` 直读）+ `get_transcript`（返 transcript.json 字符串）；`Reader.ets` `AudioContent` 分支 = AVPlayer 播放 + 转写视图（点句跳播 / 跟随 / seek 滚动）+ 高亮原生着色 + 长按建标注（单句 / 多选区间）。**关键坑**：音频无 Web，`webController.runJavaScript` 必须对 audio guard（否则同步抛异常闪退）。详见 CLAUDE.md「鸿蒙音频（Phase C）」。

> 工程顺序：A 是基础，B 在其上叠加；两阶段可分别提交、各自可编译可运行。
