# 区域选择保存 — 设计文档

## 概述

为 Chrome 插件增加"选区保存"功能，让用户选择页面中的某个 DOM 元素区域进行保存，而非保存整个页面。解决"每次保存整页导致大量噪音"的核心痛点。

## 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 交互模式 | 先选后存 | 减少存储噪音，而非存完再裁 |
| 选区粒度 | DOM 元素级别 | 语义完整，样式继承好处理 |
| 层级微调 | 鼠标移动 + 滚轮/键盘辅助 | 鼠标移动覆盖 90% 场景，滚轮/键盘用于精确调整 |
| SingleFile 处理 | 整页抓取后裁剪 | SingleFile 完整页面路径经过充分测试，裁剪可控 |
| 元数据存储 | `selection_meta` 可空 JSON 字段 | 扩展性好，NULL 表示整页 |
| 文件夹/标签选择 | 先选参数再进入选区模式 | 流程清晰，不需要在两个 UI 间切换 |
| 选区确认 | 点击锁定 + 确认浮条 | 防止误触 |
| 抓取时机 | 选区确认后立即并行抓取 | 不浪费时间 |

## 用户流程

```
1. 打开插件 popup → 选文件夹、填标签 → 点击「选区保存」
2. Popup 关闭，参数暂存 chrome.storage.session，页面进入选区模式
3. 顶部出现提示条："选择要保存的区域（ESC 退出）"
4. 鼠标移动，自动高亮悬停的最内层 DOM 元素（蓝色半透明遮罩）
5. 滚轮上滚 / 键盘 ↑ → 切换到父元素；下滚 / 键盘 ↓ → 切换到子元素
6. 鼠标移动到新元素时，微调状态重置
7. 点击 → 元素被选中锁定，底部出现确认浮条：「✓ 确认保存」「✗ 重新选择」
8. 点击「重新选择」→ 回到步骤 4
9. 点击「确认保存」→ 同时：记录 CSS selector + 启动 SingleFile 整页抓取
10. 抓取完成 → 裁剪 HTML → POST 到本地 server → 显示成功 toast → 退出选区模式
```

## 技术设计

### 1. 插件 Popup 改动

**文件：** `extension/src/popup/popup.html` + `popup.js`

- 保存按钮区域从单按钮变为两个：「保存整页」（现有逻辑不变）和「选区保存」
- 「选区保存」点击时：
  1. 将当前选择的 folder_id、tags、页面信息存入 `chrome.storage.session`
  2. 注入 `region-selector.js` 到页面（MAIN world）
  3. 关闭 popup

### 2. 选区交互脚本（新增）

**文件：** `extension/src/content/region-selector.js`（MAIN world 注入）

#### 注入的 UI 元素

所有注入元素使用统一的 `data-shibei-selector` 属性标记，z-index 设为 `2147483647`（最高层级），使用 Shadow DOM 或内联样式避免被页面 CSS 影响。

- **顶部提示条**：固定定位，显示操作提示
- **高亮遮罩**：绝对定位的 div，覆盖在目标元素上方，蓝色半透明边框 + 背景，不修改原始 DOM 样式
- **确认浮条**：选中锁定后出现在选中元素下方，「✓ 确认保存」「✗ 重新选择」
- **状态 toast**：保存进度和结果提示

#### 事件处理

- `mousemove`：获取 `document.elementFromPoint()`，过滤非内容元素后更新高亮遮罩位置和大小
- `wheel`：`e.preventDefault()` 阻止滚动，上滚选父元素，下滚回到子元素
- `keydown(↑↓)`：同滚轮功能
- `click`：锁定当前元素，显示确认浮条
- `keydown(ESC)`：退出选区模式，清理所有注入元素和事件监听
- 所有事件在选区模式结束后统一移除

#### 过滤规则

- 忽略 `<html>`、`<body>`、`<head>`、`<script>`、`<style>`、`<link>`、`<meta>` 等非内容元素
- 忽略注入的选区 UI 元素自身（通过 `data-shibei-selector` 属性判断）
- 元素过小（宽或高 < 20px）时自动选择父元素

#### CSS Selector 生成

选中元素后生成唯一 CSS selector，优先级策略：
1. `#id`（如果元素有唯一 id）
2. 组合路径：从元素向上拼接 `tagName.className:nth-of-type(n)` 直到唯一

### 3. HTML 裁剪逻辑

在 `region-selector.js` 中完成，确认选区后执行：

#### 步骤

1. 确认选区的同时，调用 SingleFile `getPageData()` 整页抓取
2. 抓取完成后，用 `DOMParser` 解析返回的完整 HTML
3. 用 CSS selector 在解析后的 Document 中定位目标元素
4. 保留祖先链作为样式包裹：从选中元素向上遍历到 `<body>`，每一级祖先只保留标签名和属性（class、id、style），移除同级兄弟节点
5. 构造新 HTML：原始 `<head>`（完整保留）+ 裁剪后的 `<body>`
6. 序列化为字符串

#### 祖先链保留示例

```
原始结构：
body > div.wrapper > aside + main.content > nav + article.post > [选中的内容]

裁剪后：
<body>
  <div class="wrapper">
    <main class="content">
      <article class="post">
        [选中的内容]
      </article>
    </main>
  </div>
</body>
```

`aside`、`nav` 等兄弟节点被移除，但祖先容器保留以确保 CSS 选择器和继承样式正常生效。

### 4. 保存 Payload 变化

`POST /api/save` 的 payload 新增可选字段：

```json
{
  "title": "页面标题",
  "url": "https://example.com/article",
  "selection_meta": {
    "selector": "main.content > article.post",
    "tag_name": "article",
    "text_preview": "选中区域的前 50 个字符..."
  },
  ...其他现有字段不变
}
```

`selection_meta` 为 `null` 或不传时表示整页保存，与现有逻辑完全兼容。

### 5. Rust 后端改动

#### 数据库 Migration（002）

```sql
ALTER TABLE resources ADD COLUMN selection_meta TEXT;
```

#### 代码改动

- **`server/mod.rs`**：`SaveRequest` 新增 `selection_meta: Option<String>`，`handle_save()` 透传到数据库
- **`db/resources.rs`**：`Resource` 和 `CreateResourceInput` 新增 `selection_meta: Option<String>`，相关 INSERT/SELECT SQL 加上该字段
- **`commands/`**：`get_resource` 返回值自动包含 `selection_meta`

存储逻辑不变——裁剪后的 HTML 仍然存为 `snapshot.html`。

### 6. React 前端改动

改动极小：

- **`types/index.ts`**：`Resource` 接口新增 `selection_meta?: string | null`
- **资料列表组件**：`selection_meta` 非空时显示裁剪图标，区分选区资料和整页资料
- **阅读器 / 标注系统**：无改动（裁剪后的 HTML 是完整可渲染页面）

### 7. SingleFile Bundle 预注入优化

进入选区模式时即预注入 `single-file-bundle.js`（只注入不执行抓取），确认选区后调用 `getPageData()` 能更快启动。

## 改动范围总结

| 层 | 文件 | 改动类型 |
|----|------|---------|
| 插件 popup | `popup.html`, `popup.js` | 修改：新增选区保存按钮 |
| 插件选区脚本 | `content/region-selector.js` | **新增**：选区交互 + 裁剪 + 保存 |
| 插件 manifest | `manifest.json` | 修改：注册新脚本 |
| Rust migration | `migrations/002_add_selection_meta.sql` | **新增** |
| Rust server | `server/mod.rs` | 修改：SaveRequest 加字段 |
| Rust db | `db/resources.rs` | 修改：Resource 加字段 |
| Rust commands | `commands/` | 修改：透传字段 |
| 前端类型 | `types/index.ts` | 修改：Resource 加字段 |
| 前端资料列表 | 资料列表组件 | 修改：选区标记图标 |
| 前端阅读器 | — | **无改动** |
| 前端标注系统 | — | **无改动** |

## 不在本次范围

- 阅读器中选区聚焦/滚动（路线图中作为独立子项）
- URL 查重提示
- Token 鉴权
