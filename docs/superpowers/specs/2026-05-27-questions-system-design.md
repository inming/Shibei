# 问题（Questions）系统设计文档

**日期**：2026-05-27
**范围**：新增「问题」系统，维护关注的研究问题，并把资料 / 高亮 / 评论关联到问题上；为 AI 总结提供结构化上下文。
**当前阶段**：Phase 1（核心闭环：DB + 后端 + 最小 UI）
**关联文档**：
- 数据事件机制：`docs/superpowers/specs/2026-04-03-unified-data-events-design.md`
- 同步机制：`docs/superpowers/specs/2026-04-07-sync-mechanism-review.md`
- 会话持久化：`docs/superpowers/specs/2026-04-17-session-persistence-design.md`
- MCP Server：`docs/superpowers/specs/2026-04-06-v1.7-mcp-server-design.md`

## 背景与动机

现有 tag 系统是扁平 label，只能标"类别"。用户在长期收集资料时存在另一类需求：**追踪一组开放的"问题"**——例如「微服务的可观测性怎么落地」「估值方法在硬科技领域的适用性」——这些问题有生命周期（active / archived），有描述上下文，需要把多份资料、高亮、评论关联在一起，未来还要让 AI 基于这些关联做阶段性总结。

把这套需求塞进 tag 会污染 tag 的轻量心智模型（tag 要高频、零摩擦），所以独立建一个 **Question** 系统，但与 tag、folder 在 sidebar 同级并存：
- **Folder**：物理归档位置（一个资料只能在一个文件夹）
- **Tag**：分类标签（多对多，扁平）
- **Question**：研究焦点（多对多，跨实体，有生命周期，每条关联可附"为什么相关"）

## 目标与非目标

### Phase 1 目标

- DB：`questions` + `question_links` 两张表，对齐现有 sync_log / HLC / 软删除模式
- 后端 CRUD（`crates/shibei-db/src/questions.rs`）+ 单测覆盖
- Tauri commands + 领域事件 `data:question-changed` / `data:question-link-changed`
- 前端：Sidebar 新增「问题」分区（与文件夹并列）+ Question Detail Tab（与 ReaderTab 同级）
- 一个建立关联的入口（**ResourceList 右键 → "关联到问题…"**），打通端到端
- i18n：新增 `question` 命名空间，zh/en 同步

### Phase 1 非目标（推迟到后续阶段）

- AnnotationPanel 内为高亮/评论建立关联的入口 → Phase 2
- PreviewPanel 反查显示"被以下问题引用" → Phase 2
- MCP 工具 → Phase 2
- Deep link `shibei://open/question/{id}` → Phase 2
- FTS5 索引（question.title + description）→ Phase 3
- 同步联调（S3 上传/拉取/apply 走通）→ Phase 3
- 鸿蒙端 → Phase 3 之后
- AI 自动推荐关联（`suggest_question_links`）→ 永不（已确认 MVP 不做）
- Question 上贴 tag → 暂不做（等问题量级足够再加）
- Question 父子层级 → 永不

## 数据模型

### 新增 migration `008_questions.sql`

```sql
-- Questions: tracked research questions with lifecycle.
-- Soft-deleted via deleted_at; archived is a separate orthogonal state.
CREATE TABLE questions (
  id           TEXT PRIMARY KEY,           -- uuid v4
  title        TEXT NOT NULL,              -- 标题
  description  TEXT,                       -- Markdown，可空
  status       TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
  archived_at  TEXT,                       -- ISO8601；status='archived' 时必填
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  hlc          TEXT,                       -- sync LWW；本地 None，同步开启后填
  deleted_at   TEXT                        -- 软删除
);
CREATE INDEX idx_questions_status ON questions(status) WHERE deleted_at IS NULL;

-- Question links: polymorphic many-to-many with optional per-link reason.
-- target_type ∈ {'resource', 'highlight', 'comment'}.
-- Resource-level note is stored as resources.description, so it's covered by 'resource'.
CREATE TABLE question_links (
  id            TEXT PRIMARY KEY,          -- uuid v4
  question_id   TEXT NOT NULL,             -- 不加 FK（同步 apply 时父子可能乱序到达）
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  reason        TEXT,                      -- 可选，"为什么相关"，Markdown
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  hlc           TEXT,
  deleted_at    TEXT
);

-- 同一对 (question, target) 在 alive 状态下唯一；软删除后允许重新建
CREATE UNIQUE INDEX idx_qlinks_unique_alive
  ON question_links(question_id, target_type, target_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_qlinks_question ON question_links(question_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_qlinks_target   ON question_links(target_type, target_id) WHERE deleted_at IS NULL;
```

### 关键设计点

- **status vs deleted_at 正交**：archived 是用户级状态（"不关心了，但要保留历史"），deleted_at 是系统级回收。归档不动 `question_links`，删除才级联软删 link
- **archive 不级联 links**（用户明确要求）：归档 question 后，关联完整保留，只是默认列表查询过滤 archived；进入详情仍能看到全部历史关联
- **UNIQUE 约束**：同一 (question, target) 同时只能存在一条活跃 link；如果想"删了再加"——OK，旧的软删后能建新的（条件唯一索引允许）。reason 更新走 UPDATE 而非删建新
- **不加 FOREIGN KEY**：和现有同步表保持一致（`sync_log apply` 时父实体可能后到），靠应用层级联
- **`hlc` 可空**：本地未开同步时为 NULL（对齐现有 `tags.hlc` 模式），开同步后通过 `SyncContext` 写入

### 级联规则

| 触发事件 | 对 question_links 的处理 |
|---|---|
| `delete_question(id)`（软删） | 同 txn 软删所有 `question_id = id` 的 link |
| `archive_question(id)` | **不动 links** |
| `unarchive_question(id)` | **不动 links** |
| `resources::soft_delete(id)` | 同 txn 软删所有 `target_type='resource' AND target_id=id` 的 link |
| `highlights::soft_delete(id)` | 同上 |
| `comments::soft_delete(id)` | 同上 |
| compaction（90 天后物理清理） | 物理删 question_links 中 dangling link |

## 后端实现

### 新文件：`crates/shibei-db/src/questions.rs`

模式照搬 `tags.rs` + `folders.rs`（实参 + sync_log + HLC tick 都按既有套路）：

```rust
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use super::{now_iso8601, sync_log, DbError, SyncContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,                  // 'active' | 'archived'
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionLink {
    pub id: String,
    pub question_id: String,
    pub target_type: String,             // 'resource' | 'highlight' | 'comment'
    pub target_id: String,
    pub reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ── CRUD: questions ──
pub fn create_question(conn: &Connection, title: &str, description: Option<&str>,
                       sync_ctx: Option<&SyncContext>) -> Result<Question, DbError> { … }
pub fn update_question(conn: &Connection, id: &str, title: &str, description: Option<&str>,
                       sync_ctx: Option<&SyncContext>) -> Result<(), DbError> { … }
pub fn archive_question(conn: &Connection, id: &str,
                        sync_ctx: Option<&SyncContext>) -> Result<(), DbError> { … }
pub fn unarchive_question(conn: &Connection, id: &str,
                          sync_ctx: Option<&SyncContext>) -> Result<(), DbError> { … }
pub fn delete_question(conn: &Connection, id: &str,
                       sync_ctx: Option<&SyncContext>) -> Result<(), DbError> { … }
pub fn get_question(conn: &Connection, id: &str) -> Result<Question, DbError> { … }
pub fn list_questions(conn: &Connection, status: Option<&str>) -> Result<Vec<Question>, DbError> { … }

// ── CRUD: question_links ──
pub fn link(conn: &Connection, question_id: &str, target_type: &str, target_id: &str,
            reason: Option<&str>, sync_ctx: Option<&SyncContext>) -> Result<QuestionLink, DbError> { … }
pub fn update_link_reason(conn: &Connection, link_id: &str, reason: Option<&str>,
                          sync_ctx: Option<&SyncContext>) -> Result<(), DbError> { … }
pub fn unlink(conn: &Connection, link_id: &str,
              sync_ctx: Option<&SyncContext>) -> Result<(), DbError> { … }

// ── 查询 ──
/// 返回某 question 下所有 alive links（按 target_type 分组的入参更舒服）
pub fn list_links_for_question(conn: &Connection, question_id: &str)
    -> Result<Vec<QuestionLink>, DbError> { … }

/// 反查：某个 target 被哪些 alive question 引用
pub fn list_questions_for_target(conn: &Connection, target_type: &str, target_id: &str)
    -> Result<Vec<Question>, DbError> { … }

/// 批量反查（给 PreviewPanel / ResourceList 用）
pub fn list_questions_for_resources(conn: &Connection, resource_ids: &[String])
    -> Result<std::collections::HashMap<String, Vec<Question>>, DbError> { … }

// ── 级联（被 resources/highlights/comments 调用）──
pub(crate) fn cascade_soft_delete_for_target(
    conn: &Connection, target_type: &str, target_id: &str,
    sync_ctx: Option<&SyncContext>) -> Result<(), DbError> { … }
```

### sync_log entity types

| entity_type | 何时写入 |
|---|---|
| `question` | create / update / archive / unarchive / delete |
| `question_link` | link / update_link_reason / unlink |

> **同步对端兼容性**：旧版客户端拉到 unknown entity_type 的 sync_log 行时会忽略（参考 `sync/apply.rs` 现有处理）。无需新增对端版本协商。

### 现有模块的修改

| 文件 | 改动 |
|---|---|
| `crates/shibei-db/src/lib.rs` | `pub mod questions;` |
| `crates/shibei-db/src/resources.rs::soft_delete_*` | 调 `questions::cascade_soft_delete_for_target(conn, "resource", id, ctx)` |
| `crates/shibei-db/src/highlights.rs::soft_delete_*` | 同上，target_type="highlight" |
| `crates/shibei-db/src/comments.rs::soft_delete_*` | 同上，target_type="comment" |
| `crates/shibei-db/src/migration.rs` | 注册 `008_questions.sql`，version 7 → 8 |
| `crates/shibei-db/src/lib.rs::test_*` 中的 `assert_eq!(version, 7)` | 改为 8 |

### Tauri commands（`src-tauri/src/commands/questions.rs`，新文件）

```rust
#[tauri::command] pub async fn cmd_list_questions(state, status: Option<String>) -> Result<Vec<Question>, String>
#[tauri::command] pub async fn cmd_get_question(state, id: String) -> Result<Question, String>
#[tauri::command] pub async fn cmd_create_question(app, state, title: String, description: Option<String>) -> Result<Question, String>
#[tauri::command] pub async fn cmd_update_question(app, state, id: String, title: String, description: Option<String>) -> Result<(), String>
#[tauri::command] pub async fn cmd_archive_question(app, state, id: String) -> Result<(), String>
#[tauri::command] pub async fn cmd_unarchive_question(app, state, id: String) -> Result<(), String>
#[tauri::command] pub async fn cmd_delete_question(app, state, id: String) -> Result<(), String>

#[tauri::command] pub async fn cmd_list_question_links(state, question_id: String) -> Result<Vec<QuestionLink>, String>
#[tauri::command] pub async fn cmd_list_questions_for_target(state, target_type: String, target_id: String) -> Result<Vec<Question>, String>
#[tauri::command] pub async fn cmd_link_to_question(app, state, question_id: String, target_type: String, target_id: String, reason: Option<String>) -> Result<QuestionLink, String>
#[tauri::command] pub async fn cmd_update_link_reason(app, state, link_id: String, reason: Option<String>) -> Result<(), String>
#[tauri::command] pub async fn cmd_unlink(app, state, link_id: String) -> Result<(), String>
```

每个 mutation command 在 DB 写入成功后 emit 对应事件（见下）。

### 事件系统扩展

**`crates/shibei-events/src/lib.rs`** 新增：
```rust
pub const DATA_QUESTION_CHANGED: &str = "data:question-changed";
pub const DATA_QUESTION_LINK_CHANGED: &str = "data:question-link-changed";
```

**`src/lib/events.ts`** 同步新增：
```ts
export const DataEvents = {
  …existing,
  QUESTION_CHANGED: "data:question-changed",
  QUESTION_LINK_CHANGED: "data:question-link-changed",
} as const;

export interface QuestionChangedPayload {
  action: "created" | "updated" | "archived" | "unarchived" | "deleted";
  question_id?: string;
}

export interface QuestionLinkChangedPayload {
  action: "linked" | "unlinked" | "reason-updated";
  question_id: string;
  target_type: "resource" | "highlight" | "comment";
  target_id: string;
}
```

发射矩阵：

| Command | 事件 | action |
|---|---|---|
| create/update_question | QUESTION_CHANGED | created / updated |
| archive/unarchive_question | QUESTION_CHANGED | archived / unarchived |
| delete_question | QUESTION_CHANGED + QUESTION_LINK_CHANGED(×N) | deleted / unlinked |
| link_to_question | QUESTION_LINK_CHANGED | linked |
| unlink | QUESTION_LINK_CHANGED | unlinked |
| update_link_reason | QUESTION_LINK_CHANGED | reason-updated |
| resources/highlights/comments 软删触发级联 | QUESTION_LINK_CHANGED(×N) | unlinked |

> 级联事件批量发射时为每条 link 发一次：订阅方按 `target_type+target_id` 自行 dedupe，不在后端做合并（对齐现有事件设计）。

## 前端实现

### 新增文件清单

```
src/
  hooks/
    useQuestions.ts                 # 列表 + 订阅 QUESTION_CHANGED 自动 refresh
    useQuestionLinks.ts             # 某 question 的 links + 订阅 QUESTION_LINK_CHANGED
    useQuestionsForResource.ts      # 反查 hook（Phase 2 PreviewPanel 用，Phase 1 先建好）
  components/
    Sidebar/
      QuestionSection.tsx           # Sidebar 内新分区（折叠 + active/archived 子分组）
      QuestionItem.tsx              # 单项（标题 + 关联数徽章 + 状态色点）
      QuestionEditDialog.tsx        # 创建/编辑（title + description Markdown）
    QuestionDetail/
      QuestionDetailView.tsx        # Tab 内容主组件
      QuestionDetailHeader.tsx      # 标题 / 描述 / archive 按钮
      QuestionLinkList.tsx          # 按 target_type 分组的链接列表
      QuestionLinkItem.tsx          # 单条链接（来源标题 + snippet + reason 编辑）
    Resource/
      LinkToQuestionPopover.tsx     # 右键菜单选项打开的 popover（多选 + 新建）
  lib/
    questions.ts                    # cmd.* 封装（list/get/create/update/archive/.../link/unlink）
  locales/
    zh/question.json
    en/question.json
  types/
    index.ts                        # 加 Question / QuestionLink type
```

### App.tsx 改动（Tab 体系）

ReaderTab 之外引入 QuestionDetailTab：

```ts
type AppTab =
  | { kind: "library" }
  | { kind: "reader"; resourceId: string }
  | { kind: "question"; questionId: string }   // 新增
  | { kind: "settings" };
```

- `activeTabId` 编码：`q:${questionId}`（与 ResourceId 区分）
- `sessionState` 持久化 question tab：`ReaderTabState` 改造或新增 `QuestionTabState`（结构简单：只有 `questionId`，无 scroll/zoom），都进 `sessionState.tabs[]`
- 懒挂载策略沿用：只激活时挂载 `<QuestionDetailView>`

> **会话持久化向后兼容**：`sessionState` 现有 `readerTabs: ReaderTabState[]`，要扩展成 tagged union `tabs: AppTabState[]`。bump version 1 → 2，迁移函数把旧 `readerTabs` 当作 `{kind:'reader', ...}` 一并塞进 `tabs`，避免重启丢 tab。

### Sidebar 集成

`Sidebar` 现有结构：FolderTree + TagSection。在它们之间或之下插入 `QuestionSection`：

```
┌─ Sidebar
│  ├─ Folders
│  ├─ Tags
│  └─ Questions          ← 新增
│     ├─ ▼ 进行中 (3)
│     │   ├─ ● 微服务可观测性     [12]
│     │   └─ ● 估值模型           [5]
│     └─ ▶ 已归档 (2)
└─
```

- 默认展开"进行中"，折叠"已归档"
- 顶部「+」按钮 → `QuestionEditDialog` 创建
- 右键单项菜单：编辑 / 归档（unarchive）/ 删除（弹确认）
- 点击单项 → 打开 QuestionDetailTab

### QuestionDetailView

```
┌─ Title  [✏️]  [📁归档]  [🗑️]
│  Description (Markdown render，点击进入编辑)
├──────────────────────────────────
│  关联 (17)
│
│  📄 资料 (8)
│  ├─ [标题1]               [reason 单行预览]   [×]
│  ├─ [标题2]               ...
│
│  🖍 高亮 (6)
│  ├─ "高亮原文 snippet..."  来自《标题1》       [×]
│  │   reason: ...
│
│  💬 评论 (3)
│  ├─ "评论内容..."          于《标题2》的"...."  [×]
└─
```

- 每条链接点击 → 打开对应资料/跳到高亮（复用 `openResource(id, highlightId?)`）
- reason 行可点击展开为 textarea + Markdown 预览切换（同 `AnnotationPanel` 编辑模式）
- 右上「📁归档」根据当前 status 显示「归档」or「取消归档」
- 删除走 `plugin-dialog::ask`，提示"将删除问题及其全部关联（关联条目本身不会删除）"

### ResourceList 右键菜单接入

`ResourceContextMenu`（现有组件）新增菜单项「关联到问题…」：
- 打开 `LinkToQuestionPopover`
- popover 内容：搜索框 + 现有 active questions 列表（多选）+ 底部「+ 新建问题」
- 选中后立即 `cmd.linkToQuestion`，每条带空 reason
- 已关联的项显示 ✓，再次点击 unlink

### i18n key 草案（`src/locales/zh/question.json`）

```json
{
  "title": "问题",
  "active": "进行中",
  "archived": "已归档",
  "createQuestion": "新建问题",
  "editQuestion": "编辑问题",
  "deleteQuestion": "删除问题",
  "archiveQuestion": "归档",
  "unarchiveQuestion": "取消归档",
  "titlePlaceholder": "问题标题",
  "descriptionPlaceholder": "问题描述（支持 Markdown）",
  "links": "关联",
  "linksByType": {
    "resource": "资料 ({{count}})",
    "highlight": "高亮 ({{count}})",
    "comment": "评论 ({{count}})"
  },
  "reasonPlaceholder": "为什么相关？（可选）",
  "linkToQuestion": "关联到问题…",
  "unlinkConfirm": "取消关联？",
  "deleteConfirm": "删除问题「{{title}}」？将一并删除 {{count}} 条关联，被关联的资料/高亮/评论本身不会被删除。",
  "emptyActive": "暂无进行中的问题",
  "emptyArchived": "暂无已归档的问题",
  "emptyLinks": "暂无关联",
  "noQuestionsToLink": "暂无问题，先创建一个？"
}
```

`en/question.json` 等价镜像。

### `i18n.ts` 注册新命名空间

```ts
import questionZh from "./locales/zh/question.json";
import questionEn from "./locales/en/question.json";
// resources.zh.question = questionZh; resources.en.question = questionEn;
// ns: [..., "question"]
```

`src/types/i18next.d.ts` 的 `Resources` interface 加 `question: typeof questionZh`。

## 实施步骤（Phase 1 推进顺序）

每一步独立可编译可运行，可单独 commit：

1. **DB migration + Rust CRUD + 单测**
   - 新增 `008_questions.sql`
   - 实现 `questions.rs` 全部函数 + 单测（覆盖 create/update/archive/unarchive/delete/link/unlink/级联/LWW HLC）
   - 修 `resources/highlights/comments.rs` 软删调 `cascade_soft_delete_for_target`
   - 改 `lib.rs::test_*` 中的版本断言 7 → 8
   - **验收**：`cargo test -p shibei-db` 全过

2. **同步 apply 端兼容**（同步开关下）
   - `crates/shibei-sync/src/apply.rs` 增加对 `question` / `question_link` entity_type 的处理（payload → upsert 调 questions.rs；DELETE 调软删；三层 LWW 保护对齐 highlights/comments）
   - 单测：sync_log 导出/再导入 round-trip
   - **验收**：`cargo test -p shibei-sync` 全过；本地两个临时 DB 模拟双向同步

3. **events crate + Tauri commands**
   - 加 2 个事件常量
   - 新建 `src-tauri/src/commands/questions.rs`，注册到 `lib.rs invoke_handler!`
   - 每个 mutation 在 DB 写入后 `emit_event(&app, DATA_QUESTION_CHANGED, ...)`
   - **验收**：`cargo check` 过 + 手动 invoke 一次走通

4. **前端 `cmd` 封装 + types + i18n**
   - `src/lib/questions.ts` 全部 invoke wrapper（参考 `src/lib/commands.ts`）
   - `src/types/index.ts` 加 Question / QuestionLink type
   - `src/lib/events.ts` 加事件常量 + payload type
   - 注册 i18n 命名空间，zh/en 都写好
   - **验收**：`tsc --noEmit` 过

5. **Tab 体系扩展**
   - `App.tsx` AppTab union 改造，新增 `question` kind
   - `sessionState.ts` v1 → v2 迁移（旧 readerTabs → tabs[]）
   - 测试启动后旧 session 文件能正确升级
   - **验收**：手动重启应用，session 恢复正常

6. **Sidebar QuestionSection**
   - `useQuestions` hook（含 QUESTION_CHANGED 订阅）
   - QuestionSection + QuestionItem + QuestionEditDialog
   - 右键菜单走现有 `ContextMenu` + `useFlipPosition`
   - **验收**：可创建/编辑/归档/删除，sidebar 实时刷新

7. **QuestionDetailView**
   - `useQuestionLinks` hook
   - QuestionDetailView 全套组件
   - 点击链接打开/跳转复用现有 `openResource`
   - **验收**：能从 sidebar 打开 Tab，看到关联列表，能解除关联，能编辑 reason

8. **ResourceList 右键 → 关联到问题**
   - `LinkToQuestionPopover` 组件
   - `ResourceContextMenu` 加菜单项
   - **验收**：选中资料 → 右键 → 选问题 → 详情页能看到这条关联

9. **手动端到端走查**
   - 创建问题 → 关联资料 → 打开详情 → 解除关联 → 归档 → 在 sidebar 切换分组 → 删除 → 确认级联

## 验收清单（DoD）

- [ ] migration 008 跑通，旧库无缝升级
- [ ] `cargo test --workspace` 全过；`cargo clippy --workspace -- -D warnings` 无 warning
- [ ] `tsc --noEmit` 无错误
- [ ] 单测覆盖：questions.rs ≥ 8 个 case（create/update/archive/unarchive/delete/link/unlink/cascade）
- [ ] 资料软删后 → 详情页相关链接消失（且 sync_log 写入 unlink 条目）
- [ ] 问题软删后 → 全部关联同步软删
- [ ] Sidebar 创建/编辑/归档/删除全部走通且实时更新
- [ ] 关联到问题入口可用，反查暂不验（Phase 2）
- [ ] Session 持久化兼容：旧 readerTabs 升级为新 tabs[] 不丢
- [ ] i18n zh/en 完整，无硬编码 CJK

## 风险与已知问题

- **sessionState 版本升级**：v1→v2 迁移函数必须谨慎，旧文件解析失败要静默回落 DEFAULT_STATE 而非崩溃。**风险等级：中**——按 session-persistence-design.md 既定的"失效兜底"模式实现即可
- **同步未联调**：Phase 1 写完所有 sync_log 但不验证 S3 上传/拉取的端到端正确性，留到 Phase 3。如果用户在 Phase 1 开同步会写垃圾 sync_log 行——加 Phase 1 验收要求"测试环境关闭同步"或"sync apply 容忍 unknown entity_type"。**采取后者**（apply.rs 已有此模式）
- **级联在多 entity 大量删除时的事件风暴**：删一个 question 带 100 条 link 会发 100 次 QUESTION_LINK_CHANGED——hook 侧靠 React batching + setState 合并；如果实测有明显卡顿，再加合并事件 `QUESTIONS_BULK_CHANGED`。Phase 1 不预先优化
- **新建 question 时的 UNIQUE 冲突**：title 不强制唯一（与 tag 的"name unique"不同）——重名 question 允许存在，用户可自行区分。如未来需求改变再加 unique constraint

## 后续阶段预告

- **Phase 2（约 3-5 天）**
  - AnnotationPanel 内为高亮/评论建立关联入口
  - PreviewPanel 反查（"被以下问题引用"）
  - MCP 5 个工具：list/get/manage/link/unlink
  - Deep link `shibei://open/question/{id}`
  - 单实例 + onOpenUrl 路径接入

- **Phase 3（约 2-3 天）**
  - FTS5 索引 question.title + description
  - 搜索结果集成（query 命中 question 时显示）
  - 同步联调（双端 round-trip + 加密路径验证）

- **Phase 4（鸿蒙端，预计 1 周）**
  - 鸿蒙 NAPI 暴露 question commands
  - ArkTS 端 sidebar + detail 简化版
  - 同步路径复用桌面 sync_log
