# 拾贝 (Shibei) — 代码审查修复设计

## 背景

v1.1/v1.1.1 完成后，对全量代码进行了一次 review，发现约 35 个问题，覆盖安全、健壮性、性能和用户体验四个维度。本文档描述修复方案，按问题域分为 4 个提交。

## 原则

- 局部修改，不做架构重构
- 每个提交可独立编译运行
- 不引入新的架构模式，沿用现有约定

---

## 提交 1：fix: security hardening

### 1.1 annotator postMessage 源标记

**问题**：annotator.js 的 message handler（L447）不校验消息来源，任意页面可伪造高亮指令。发送端用 `"*"` 作为 targetOrigin。

**方案**：采用消息签名而非 origin 校验。原因：annotator 运行在 `shibei://` 自定义协议 iframe 中，parent 是 Tauri WebView（`tauri://localhost` 或 `http://tauri.localhost`），跨自定义协议的 origin 行为在不同平台/引擎间不一致，无法可靠比对。

- 所有 shibei 消息新增 `source: "shibei"` 字段
- annotator.js message handler 开头检查 `if (msg.source !== "shibei") return`
- React 端（ReaderView.tsx）发送消息时加 `source: "shibei"`，接收消息时同样检查
- 安全边界：annotator 仅在 `shibei://` 或 `http://shibei.localhost` 协议下激活（已有的 L4-5 检查），外部页面无法加载该脚本

**改动文件**：
- `src-tauri/src/annotator.js`（或 annotator.ts → 编译产物）：message handler + 所有 postMessage 调用
- `src/components/ReaderView.tsx`：message handler + 所有 postMessage 调用

### 1.2 extension sender 校验

**问题**：background.js `onMessage` listener（L22）不验证 sender，任意 content script 可触发保存。

**方案**：在 handler 开头检查 `sender.id === chrome.runtime.id`，拒绝来自其他扩展的消息。

**改动文件**：`extension/src/background/background.js`

### 1.3 CORS 限制

**问题**：server CORS 配置允许 `Any` origin（L72），配合 `/token` 端点可被外部页面利用。

**方案**：改为 predicate 模式，仅允许：
- `chrome-extension://` 开头（浏览器扩展）
- `tauri://localhost` 和 `http://tauri.localhost`（Tauri WebView）
- `http://127.0.0.1` 和 `http://localhost`（本地开发）

使用 `tower_http::cors::AllowOrigin::predicate(|origin, _| { ... })` 实现。

**改动文件**：`src-tauri/src/server/mod.rs`

### 1.4 clipHtml 危险属性过滤

**问题**：region-selector.js 的 `clipHtml` 函数（L277-297）复制 DOM 元素属性时不过滤事件处理器，存储的 HTML 可能含 XSS 向量。

**方案**：新增 `isSafeAttr(name)` 函数，过滤规则：
- 拒绝所有 `on*` 开头的属性（onclick, onload, onerror 等）
- 拒绝 `href`/`src`/`action` 值以 `javascript:` 开头的情况
- 在复制 body attributes 和 ancestor attributes 时都应用过滤

**改动文件**：`extension/src/content/region-selector.js`

### 1.5 token 缓存并发控制

**问题**：background.js 和 popup.js 的 `getToken()` 无并发控制，多请求并发时重复 fetch。

**方案**：用 promise 缓存模式，两个文件统一改法：
```javascript
let cachedToken = null;
let tokenPromise = null;

async function getToken() {
  if (cachedToken) return cachedToken;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/token`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      cachedToken = data.token;
      return cachedToken;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}
```

**改动文件**：
- `extension/src/background/background.js`
- `extension/src/popup/popup.js`

---

## 提交 2：fix: robustness improvements

### 2.1 server 启动错误处理

**问题**：`start_server` 中 `bind().await.unwrap()` 和 `serve().await.unwrap()`（L89-90），端口被占用时 panic 崩溃整个应用。

**方案**：
- `start_server` 签名改为 `pub async fn start_server(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error>>`
- bind 和 serve 用 `?` 传播错误
- 调用方（lib.rs 中 `tauri::async_runtime::spawn`）捕获错误后 `eprintln!` 记录

**改动文件**：
- `src-tauri/src/server/mod.rs`
- `src-tauri/src/lib.rs`

### 2.2 handle_save 事务化 + 标签错误上报

**问题**：handle_save 的文件写入 → DB 插入 → 标签关联三步无事务保护（L256-328），标签关联错误被 `let _ =` 静默吞掉（L317）。

**方案**：
- 获取 conn 后 `conn.execute_batch("BEGIN")`
- 全部成功后 `conn.execute_batch("COMMIT")`
- 任何一步失败：`conn.execute_batch("ROLLBACK")` + 清理已写入的文件（`fs::remove_dir_all`）
- 标签关联的 `let _ =` 改为 `.map_err(...)` 向上传播

同时修复标签查询 N+1：循环前一次性 `let all_tags = tags::list_tags(&conn)?`，循环内从 `all_tags` 中 find。

**改动文件**：`src-tauri/src/server/mod.rs`

### 2.3 folder tree 递归深度限制

**问题**：`build_folder_tree`（L143-158）递归无深度限制，深层嵌套可导致栈溢出。

**方案**：增加 `depth` 参数，调用入口传 0，每层递归 +1，超过 20 层返回空 children。

```rust
fn build_folder_tree(conn: &Connection, parent_id: &str, depth: u32) -> Result<Vec<FolderNode>, DbError> {
    if depth > 20 {
        return Ok(Vec::new());
    }
    // ... 现有逻辑，递归时传 depth + 1
}
```

**改动文件**：`src-tauri/src/server/mod.rs`

### 2.4 前端事件监听器泄漏修复

**问题 A — 拖拽监听器**：Layout.tsx（L39-40）和 ReaderView.tsx（L196-197）在 mousedown 回调里直接往 document 挂 mousemove/mouseup，组件卸载时如果正在拖拽则泄漏。

**方案**：将 mousemove/mouseup 注册移到 `useEffect` 中，通过 `dragging` ref 控制是否生效：

```tsx
useEffect(() => {
  function onMouseMove(e: MouseEvent) {
    if (!dragging.current) return;
    // ... 计算逻辑
  }
  function onMouseUp() {
    if (!dragging.current) return;
    dragging.current = false;
    // ... 清理逻辑
  }
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  return () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };
}, []);
```

mousedown handler 只负责设 `dragging.current = true`。

**问题 B — Tauri 事件监听器**：useResources.ts（L32-37）`listen()` 返回 Promise，cleanup 时如果 promise 未 resolve 则 unlisten 永远不执行。

**方案**：用 cancelled 标记：

```tsx
useEffect(() => {
  let isCancelled = false;
  const unlisten = listen("resource-saved", () => {
    refresh();
  });
  return () => {
    isCancelled = true;
    unlisten.then((fn) => fn());
  };
}, [refresh]);
```

注意：`unlisten.then(fn => fn())` 在 promise resolve 后仍会执行（即使组件已卸载），这实际上是安全的——unlisten 是幂等操作。真正的问题是 refresh 可能在卸载后被调用。加 `isCancelled` 检查：

```tsx
const unlisten = listen("resource-saved", () => {
  if (!isCancelled) refresh();
});
```

**改动文件**：
- `src/components/Layout.tsx`
- `src/components/ReaderView.tsx`
- `src/hooks/useResources.ts`

### 2.5 资源删除文件清理日志

**问题**：`cmd_delete_resource`（commands/mod.rs L123）文件删除失败被 `let _ =` 静默忽略。

**方案**：改为 `if let Err(e) = ... { eprintln!(...) }`，不阻断操作但留下可追踪日志。

**改动文件**：`src-tauri/src/commands/mod.rs`

---

## 提交 3：perf: query and rendering optimization

### 3.1 find_by_url SQL 预过滤

**问题**：`find_by_url`（resources.rs L191-220）加载全表到内存再逐条 normalize 比对。

**方案**：不加新列（避免 migration），改为 SQL LIKE 预过滤 + Rust 精确匹配：

1. 从 normalized URL 中提取 host+path 部分作为搜索关键词
2. SQL 改为 `WHERE url LIKE ?1`（模糊匹配 host+path）
3. Rust 侧对结果集再做 `normalize_url` 精确比对

大部分场景从全表扫描变为几条记录的精确比对。

**改动文件**：`src-tauri/src/db/resources.rs`

### 3.2 annotator 文本节点缓存

**问题**：每次 `resolveAnchor` 都调用 `getTextNodes()` 全量遍历 DOM，批量渲染时 O(n*m)。

**方案**：
- `shibei:render-highlights` 批量渲染时：调用一次 `getTextNodes()` 缓存到局部变量，传入各次 resolve 函数复用
- `shibei:add-highlight` 单次渲染时：仍实时遍历（DOM 可能因新高亮元素变化）
- 需修改 `resolveByPosition` 和 `resolveByQuote` 接受可选的 `textNodes` 参数

**改动文件**：`src-tauri/src/annotator.js`（或 annotator.ts 源码）

---

## 提交 4：feat: error feedback with toast

### 4.1 引入 react-hot-toast

- `npm install react-hot-toast`
- App.tsx 根组件加 `<Toaster position="bottom-right" />`
- 位置选 bottom-right，不干扰主阅读区域

### 4.2 错误提示替换

所有 `console.error` 处增加 `toast.error(message)`，保留原有 console.error 供调试。

| 文件 | 位置 | toast 消息 |
|------|------|-----------|
| useAnnotations.ts L19 | 加载标注失败 | "加载标注失败" |
| useAnnotations.ts L59 | 删除高亮失败 | "删除高亮失败" |
| useAnnotations.ts L74 | 创建评论失败 | "创建评论失败" |
| useAnnotations.ts L88 | 删除评论失败 | "删除评论失败" |
| useAnnotations.ts L104 | 编辑评论失败 | "编辑评论失败" |
| useResources.ts L19 | 加载资料失败 | "加载资料列表失败" |
| ReaderView.tsx L159 | 创建高亮失败 | "创建高亮失败" |

### 4.3 不做的事

- 成功操作不弹 toast（UI 状态变化即反馈）
- 不做全局错误边界（超出本次范围）
- toast 消息用中文简短描述，不暴露技术细节

**改动文件**：
- `package.json`（新依赖）
- `src/App.tsx`（Toaster 组件）
- `src/hooks/useAnnotations.ts`
- `src/hooks/useResources.ts`
- `src/components/ReaderView.tsx`

---

## 改动范围汇总

| 提交 | 文件数 | 预估行数 |
|------|--------|---------|
| security hardening | 6 | ~80 |
| robustness | 6 | ~120 |
| perf optimization | 2 | ~40 |
| toast feedback | 5 | ~30 |
| **合计** | **~15** | **~270** |

## 不在本次范围

- AnnotationPanel prop drilling 优化（体验改进，不影响功能，留给 v1.2 和标签系统一起重构）
- Loading 状态统一（同上）
- aria-label 补全（v1.2 视觉打磨中处理）
- Tauri command 名称类型化（低优先级，不影响运行时安全）
- annotator 事件监听器清理（高亮元素移除时不清理 click handler）——影响有限，annotator 随页面卸载整体释放，非长驻进程
