# 鸿蒙移动端 Reader 抽屉 — 摘要与元数据

- 日期：2026-04-24
- 范围：`shibei-harmony/entry/src/main/ets/pages/Reader.ets` + `AnnotationPanel.ets`
- 状态：设计中，待 review

## 一、动机

当前移动端 Reader 右侧/overlay 抽屉（`AnnotationPanel`）只展示标注（高亮 + 笔记），缺少资料摘要和元数据。桌面端 `AnnotationPanel` 在 scroll area 顶部有 `SummarySection`（description 或 auto-extract plain_text）和 `ResourceMeta`（标题/URL/日期/标签）。

移动端标题已在 TopBar 中显示，其余信息（摘要、URL、日期、标签）应补入抽屉，让用户在查看标注时有上下文。

## 二、布局

抽屉 scroll area 内从上到下：

```
┌─ 抽屉 ───────────────────────────────────┐
│  [标注 (3)]          ← 现有 header（不变）│
├──────────────────────────────────────────┤
│  ┌─ scroll ───────────────────────────┐  │
│  │                                     │  │
│  │  ── 摘要 ───────────────────        │  │  ← 新增 SummarySection
│  │  文本内容（max 3行截断）            │  │
│  │                                     │  │
│  │  🌐 url  📅 date  ●●● tags   ← 新增 MetaRow
│  │                                     │  │
│  │  ── 标注 (N) ───────────────        │  │  ← 现有（不变）
│  │  高亮卡片 ...                       │  │
│  │                                     │  │
│  │  ── 笔记 (M) ───────────────        │  │  ← 现有（不变）
│  │  笔记卡片 ...                       │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  [+ 笔记]                    ← 现有 footer│
└───────────────────────────────────────────┘
```

摘要和元数据在 scroll area 最顶部、标注列表之前。当 description 和 plain_text 都为空时，整块（摘要 + 元数据行）不渲染。

## 三、SummarySection

### 内容来源（优先级）

1. `resource.description`（用户手动编辑，桌面端 `ResourceEditDialog` 写入）— 直接展示
2. `getResourceSummary(resourceId)` — 自动提取正文前 200 字（NAPI → Rust `resources::get_plain_text`）
3. 两者都空 → **不渲染 SummarySection**

### 表现

- `<Text>` 组件，`maxLines(3)` + `textOverflow.ellipsis`
- 点击可展开 / 用独立 sheet 查看完整文本
- 标签："摘要"（新增 i18n key `annotation_summary`）

### 数据加载

- `resource.description` 随 `@Prop resource: Resource | null` 传入，同步可用
- `getResourceSummary()` 在抽屉首次打开 / resource 切换时异步调用，result 存 `@State summaryText: string`
- 若 description 已非空，跳过 `getResourceSummary()` 调用（与桌面逻辑一致）

## 四、MetaRow（元数据行）

摘要下方以小型信息行展示：

| 字段 | 来源 | 表现 |
|------|------|------|
| URL | `resource.url` | 域名+路径截断，单行 `textOverflow.ellipsis`。单击复制到剪贴板或系统浏览器打开 |
| 日期 | `resource.captured_at` 或 `resource.created_at` | `YYYY-MM-DD` 格式 |
| 标签 | `cmd.getTagsForResource(id)` | 色点 inline（max 4 个），超出省略；色点直径 10vp |

整行 12sp 灰色字体 (`text_secondary`)，与 SummarySection 间用 `border-bottom` 细线分隔。

## 五、数据流

```
Reader.aboutToAppear()
  ├── shibei.getResource(id) → @State resource: Resource | null
  └── AnnotationsService.load(id) → @State bundle: AnnotationsBundle

Reader → AnnotationPanel
  @Prop resource                                  ← 新增 prop
  @Prop bundle                                    ← 已有 prop
  @Prop focusedHighlightId                        ← 已有 prop

AnnotationPanel 内部
  ┌── SummarySection({ resource, summaryText })   ← 新增子组件
  ├── MetaRow({ resource, tags })                 ← 新增子组件
  ├── highlight list                              ← 已有
  └── note list                                   ← 已有
```

### Reactivity

- `data:resource-changed` 事件 → Reader 重新 `getResource(id)`，更新 `@State resource` → `@Prop` 自动传导到 AnnotationPanel，触发 SummarySection 重渲染
- 标签通过 `getTagsForResource` 在一次读取中获取；若后续标签变更，通过 `data:tag-changed` + `data:resource-changed` 联动刷新

## 六、不改的部分

- Header 动态切换逻辑（标注 (N) ↔ 笔记 (M)）不变
- Footer "+ 笔记" 按钮不变
- 高亮卡片渲染、交互（长按菜单、改色、评论、点击跳转）不变
- 笔记卡片渲染、编辑、删除不变
- 抽屉打开/关闭动画（`animateTo` 260ms）不变
- 侧滑手势不变

## 七、文件变更清单

| 文件 | 变更 |
|------|------|
| `AnnotationPanel.ets` | 新增 `@Prop resource: Resource | null`；新增 SummarySection + MetaRow 子组件；新增 `@State summaryText` + `@State tags`；`aboutToAppear` 中加载 summary + tags；监听 resource 变更 |
| `Reader.ets` | 传递 `resource` prop 给 `AnnotationPanel`；加载 tags 传入 |
| `resources/base/element/string.json` | 新增 `annotation_summary` key |
| `resources/zh_CN/element/string.json` | 同上 |
| `resources/en_US/element/string.json` | 同上 |

## 八、不做的

- 不提供移动端 description 编辑能力（MVP 只读；编辑在桌面端完成，通过同步到达移动端）
- 不在抽屉内重复显示标题（已在 TopBar）
- 标签不可点击交互（移动端 MVP 无标签管理 UI）
- 不引入 sticky header 或 IntersectionObserver（保持现有简单 header 切换）

## 九、Spec 自检

- [x] 无 TBD / TODO
- [x] 布局、数据流、reactive 路径无矛盾
- [x] 范围限于移动端 AnnotationPanel，不触碰桌面端
- [x] 所有新增文案有对应 i18n key
