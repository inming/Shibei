# 问题研究笔记（Question Research Notes）设计文档

**日期**：2026-06-02
**范围**：为「问题（Question）」新增**多条、带时间戳的 markdown 研究笔记**，作为用户（及经 MCP 委托的 AI agent）针对某个问题、基于积累的资料沉淀思考与阶段总结的载体。
**当前阶段**：Phase 1（桌面端核心闭环：DB + 同步 + 后端 + MCP 读写 + 桌面 UI）
**关联文档**：
- 问题系统设计：`docs/superpowers/specs/2026-05-27-questions-system-design.md`
- 同步机制：`docs/superpowers/specs/2026-04-07-sync-mechanism-review.md`
- 数据事件机制：`docs/superpowers/specs/2026-04-03-unified-data-events-design.md`
- 会话持久化：`docs/superpowers/specs/2026-04-17-session-persistence-design.md`

## 背景与动机

问题系统已经能把资料 / 高亮 / 评论关联到一个研究焦点上（`question_links`），并通过 `get_question(include_linked=true)` 给 AI 提供结构化证据做阶段总结。但目前**缺少一个让用户沉淀自己思考的地方**：

- `questions.description` 语义是「这个问题是什么 / 研究范围」，相对固定，不适合承载随资料积累不断生长的思考。
- 关联条目的 `reason` 是「这条证据为什么相关」，粒度太碎，且依附于单条 link，无法表达跨多份资料的综合判断。

用户诉求：**针对某个问题，把积累资料后产生的思考与阶段总结记录下来、能沉淀**。经确认采用如下产品形态：

- **多条、带时间戳的笔记流水**（类似研究日志），而非单篇覆盖式文档——便于增量积累、回看思考演变，且与 AI 追加写入天然契合。
- 笔记为 **markdown 纯文本**，复用现有 `MarkdownContent` 渲染。
- **MCP 可读可写**：AI agent 读问题 + 关联证据后起草阶段总结，直接写成一条笔记沉淀，用户再在 app 内精修。这呼应「薄数据层 + 把计算委托给外部 agent」的既定偏好。
- UI 文案命名 **「研究笔记」**，刻意区别于项目里既有的「笔记 = 资料级 comment（`highlight_id` 为 NULL 的 comment）」概念。

## 目标与非目标

### Phase 1 目标（桌面端核心闭环）

- DB：新增 `question_notes` 表（migration 011），完全对齐现有 `question_links` 的 sync_log / HLC / 软删除模式
- 后端 CRUD（`crates/shibei-db/src/questions.rs`）+ 单测覆盖
- **同步全链路接入**（不只是写 sync_log，而是 upsert / 软删 / 拓扑排序 / 全量快照 / compaction 五处都补齐）+ round-trip 单测
- 领域事件 `data:question-note-changed`
- Tauri commands + 前端 `cmd` 封装 + `useQuestionNotes` hook
- 桌面 UI：`QuestionDetailView` 内新增「研究笔记」区（卡片列表 + 新建/编辑/删除，最新在上，markdown 编辑/预览切换）
- HTTP API + MCP：`get_question` 输出带笔记；新工具 `manage_question_notes`（create/update/delete）
- i18n：`question` 命名空间补 key，zh/en 同步
- **搜索架构预留**（见下节）：笔记 CRUD 与同步 apply 从 Phase 1 起就调用 `rebuild_question_search_index(question_id)` 的 hook 点，使 Phase 3 加索引时只改「读什么」、不动「在哪触发」

### Phase 2 目标（鸿蒙端对齐）

- NAPI 4 命令（create/update/delete/list question note）经 `shibei-napi-codegen` 生成（**改后必须 rebuild native .so**）
- `QuestionService.ets` 笔记缓存 + 订阅；`QuestionDetail.ets` 笔记卡片区 + 编辑入口 + 长按菜单
- 同步路径复用桌面 sync_log，无新增

### Phase 3 目标（全文搜索）

- 笔记内容并入问题全文搜索（详见「搜索架构与升级路径」节，Phase 1 已做好接入点）

### 非目标

- 单篇覆盖式「总结」字段 → 不做（已选多条流水模型）
- 笔记之间的父子 / 层级 / 标签 → 永不
- 笔记关联到具体 link / 高亮（「这条笔记针对那条证据」）→ Phase 1 不做；笔记是问题级的综合思考。未来如需可加 `question_note_links`，不影响当前 schema
- 笔记富文本 / 附件 / 图片上传 → 不做（纯 markdown 文本，图片语法按现有 `MarkdownContent` 渲染为链接文本）
- AI 自动触发写笔记（定时 / 抓取后自动总结）→ 永不；写入永远是用户或 agent 的显式动作
- 笔记历史版本 / diff → 不做（软删除即历史下限）

## 数据模型

### 新增 migration `011_question_notes.sql`

```sql
-- Question research notes: multiple timestamped markdown notes per question,
-- where the user (or an MCP-delegated AI agent) deposits synthesized thinking
-- and stage summaries built from the question's accumulated materials.
--
-- Each note is an INDEPENDENT sync entity (id-based HLC LWW), mirroring
-- question_links. This isolates note edits from the parent question row, so a
-- note edit on one device never clobbers a title/status edit on another.
--
-- No FOREIGN KEY: same rationale as the other sync tables — remote apply
-- ordering may not be parent-first; the question_id link is enforced in code.
-- Cascade on question delete is handled in delete_question (code), not by SQL.
CREATE TABLE question_notes (
  id           TEXT PRIMARY KEY,                -- uuid v4
  question_id  TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',        -- markdown
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  hlc          TEXT,                            -- sync LWW; nullable like question_links.hlc
  deleted_at   TEXT
);

CREATE INDEX idx_qnotes_question ON question_notes(question_id)
  WHERE deleted_at IS NULL;
```

### 关键设计点

- **独立同步实体（核心）**：与 `question_links` 同构。每条笔记按 `id` 做 HLC LWW，比 link 更简单——**没有 UNIQUE 约束**（同一问题下允许任意多条笔记），所以 upsert 不需要冲突解析，直接照抄 `upsert_question` 的 id-based LWW 即可。
- **与 `description` / `reason` 正交**：description 是问题定义，reason 是单条证据的注解，note 是问题级的综合思考流水。三者互不替代。
- **排序：`created_at DESC`（最新在上）**。按创建时间倒序，编辑已有笔记**不**改变其位置（不按 `updated_at` 排序），保证流水稳定。
- **无 FK，级联在代码层**：`delete_question` 软删问题时，同 txn 级联软删其全部 alive 笔记（与现有 link 级联同一套路），每条写一条 sync_log DELETE。
- **`content NOT NULL DEFAULT ''`**：空内容笔记在数据层合法（便于 agent 先建后填的边界情况）；前端创建时 trim 后为空则不提交（见 UI 节）。
- **`hlc` 可空**：未开同步时为 NULL，开同步后经 `SyncContext` 写入（对齐 `question_links`）。

### 级联规则

| 触发事件 | 对 question_notes 的处理 |
|---|---|
| `delete_question(id)`（软删） | 同 txn 软删所有 `question_id = id` 的 note，每条写 sync_log DELETE |
| `archive_question` / `unarchive_question` | **不动 notes**（与 link 一致，归档保留历史） |
| compaction（90 天后物理清理） | 物理删 question_notes 中：①已软删超期的；②dangling（所属 question 已被 purge） |

> 资料 / 高亮 / 评论的软删**不影响** question_notes——笔记挂在 question 上，不挂这些 target，所以无反向级联（区别于 `question_links`）。

## 后端实现

### `crates/shibei-db/src/questions.rs` 新增

照抄本文件内 `QuestionLink` 那套（struct / CRUD / sync_log / HLC tick / 单测）：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionNote {
    pub id: String,
    pub question_id: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

// ── question_notes: CRUD ──
/// 验证 question alive（同 `link`），插入并写 sync_log INSERT。
pub fn create_question_note(conn: &Connection, question_id: &str, content: &str,
                            sync_ctx: Option<&SyncContext>) -> Result<QuestionNote, DbError>;
/// UPDATE content + updated_at + hlc，写 sync_log UPDATE。
pub fn update_question_note(conn: &Connection, note_id: &str, content: &str,
                            sync_ctx: Option<&SyncContext>) -> Result<(), DbError>;
/// 软删（set deleted_at），写 sync_log DELETE（payload = 删前快照）。
pub fn delete_question_note(conn: &Connection, note_id: &str,
                            sync_ctx: Option<&SyncContext>) -> Result<(), DbError>;
pub fn get_question_note(conn: &Connection, note_id: &str) -> Result<QuestionNote, DbError>;
/// 某问题所有 alive 笔记，ORDER BY created_at DESC（最新在上）。
pub fn list_question_notes(conn: &Connection, question_id: &str)
    -> Result<Vec<QuestionNote>, DbError>;
```

`delete_question`（本文件 292 行附近）在级联 link 之后，**追加一段对称的 notes 级联**：收集 `question_id = id AND deleted_at IS NULL` 的 note id，逐条软删 + 每条 `write_sync_log(.., "question_note", .., "DELETE", ..)`（与现有 link 级联逐条 DELETE 完全一致）。

`create_question_note` 内部刷新 FTS hook（搜索预留）：写入成功后 `let _ = super::search::rebuild_question_search_index(conn, question_id);`（Phase 1 该函数只索引 title+description，调用幂等无害；Phase 3 让它把笔记并进去后此处自动生效）。`update_question_note` / `delete_question_note` 同样在结尾调一次（delete 用删前快照拿到的 `question_id`）。

### sync_log entity types

| entity_type | 何时写入 |
|---|---|
| `question_note` | create / update / delete（含 delete_question 级联） |

### 同步引擎接入（`crates/shibei-sync/src/engine.rs`）—— 五处都要补

这是本设计**最容易遗漏**的部分。仅写 sync_log 不够，远端 apply / 全量快照 / 排序 / 清理都要认识新实体：

1. **upsert 路由**（`upsert_entity` match，~1273 行）：
   ```rust
   "question_note" => self.upsert_question_note(conn, entity_id, payload, hlc),
   ```
2. **新增 `upsert_question_note`**（照抄 `upsert_question` ~1562 行，**比 question_link 简单**，无 UNIQUE 冲突解析）：
   ```rust
   // 字段：question_id, content, created_at, updated_at
   // INSERT ... ON CONFLICT(id) DO UPDATE SET content, updated_at, hlc, deleted_at=NULL
   //   WHERE excluded.hlc > COALESCE(question_notes.hlc, '')
   ```
3. **软删路由**（`soft_delete_entity` 的表名 match，~1699 行）：
   ```rust
   "question_note" => "question_notes",
   ```
4. **拓扑排序**（`order_for_entity_type`，~2310 行）：`question_note` 排在 `question`（=5）**之后**（依赖 `question_id`，与 `question_link` 同级或之后即可，例如 `=7`）。DELETE 走反序由现有逻辑处理。
5. **全量快照**（snapshot 结构体 + export 查询 + import 循环，~520 / ~882 行）：snapshot 加 `question_notes: Vec<…>` 字段；export 查所有 alive 笔记；import 时**在 questions 之后** upsert（`self.upsert_entity(conn, "question_note", id, note, hlc)`）。
6. **compaction / purge**（~1847 行）：`"question"` 物理清理分支追加 `DELETE FROM question_notes WHERE question_id = ?1`；新增 `"question_note"` 分支 `DELETE FROM question_notes WHERE id = ?1 AND deleted_at IS NOT NULL`。

> **同步对端兼容**：旧客户端遇到未知 `question_note` 的 sync_log 行会在 `upsert_entity` 的 `_ => Ok(())` 静默跳过（既有机制），无需版本协商。

### 事件系统扩展

**`crates/shibei-events/src/lib.rs`** 新增：
```rust
pub const DATA_QUESTION_NOTE_CHANGED: &str = "data:question-note-changed";
```

**`src/lib/events.ts`** 同步新增：
```ts
QUESTION_NOTE_CHANGED: "data:question-note-changed",

export interface QuestionNoteChangedPayload {
  action: "created" | "updated" | "deleted";
  question_id: string;
  note_id?: string;
}
```

> **为什么独立事件而非复用 `data:question-changed`**：笔记变更不影响 sidebar 问题列表（标题 / 状态 / 关联数都没变），复用会让 sidebar 每次存笔记都无谓 refresh。独立事件让订阅精确——只有打开该问题详情的 `useQuestionNotes` 才响应。

发射矩阵：

| Command | 事件 | action |
|---|---|---|
| create_question_note | QUESTION_NOTE_CHANGED | created |
| update_question_note | QUESTION_NOTE_CHANGED | updated |
| delete_question_note | QUESTION_NOTE_CHANGED | deleted |
| delete_question 级联 | 已发 QUESTION_CHANGED(deleted)（关闭 Tab，详情整体卸载，无需逐条 note 事件） | — |

### Tauri commands（`src-tauri/src/commands/questions.rs`）

```rust
#[tauri::command] pub async fn cmd_list_question_notes(state, question_id: String)
    -> Result<Vec<QuestionNote>, String>;
#[tauri::command] pub async fn cmd_create_question_note(app, state, question_id: String, content: String)
    -> Result<QuestionNote, String>;
#[tauri::command] pub async fn cmd_update_question_note(app, state, note_id: String, content: String)
    -> Result<(), String>;
#[tauri::command] pub async fn cmd_delete_question_note(app, state, note_id: String)
    -> Result<(), String>;
```

- 注册进 `lib.rs` 的 `invoke_handler!`。
- 每个 mutation 在 DB 写入成功后 `emit_event(&app, DATA_QUESTION_NOTE_CHANGED, payload)`。
- update / delete 需要 `question_id` 填事件 payload → 先 `get_question_note` 拿到（或让 db 函数返回）。

### HTTP API（`src-tauri/src/server/questions.rs` + `mod.rs` 路由）

镜像现有 `question-links` 的 handler 与路由（`mod.rs` ~230 行 Questions 区块下追加）：

| 方法 + 路径 | handler | body | 返回 |
|---|---|---|---|
| `GET /api/questions/{id}/notes` | `handle_list_question_notes` | — | `QuestionNote[]` |
| `POST /api/questions/{id}/notes` | `handle_create_question_note` | `{ content }` | `{ note_id }` |
| `PUT /api/question-notes/{id}` | `handle_update_question_note` | `{ content }` | ok |
| `DELETE /api/question-notes/{id}` | `handle_delete_question_note` | — | ok |

HTTP handler 走 `SyncContext`（同现有 question handler），保证 MCP 写入也进 sync_log。

## MCP 实现（可读可写）

`mcp/src/tools/questions.ts` + `mcp/src/types.ts`：

1. **`get_question` 输出带笔记（读）**：在 description 之后、linked evidence 之前，插入「## 研究笔记」区，逐条输出 `created_at` + content（最新在上）。笔记是高价值的人/机思考，**始终输出**（不 gate `include_linked`）。需在 `get_question` handler 内多发一次 `GET /api/questions/{id}/notes`（或后端把 notes 并进某个聚合端点；Phase 1 用独立请求即可，问题详情读取不在热路径）。

2. **新工具 `manage_question_notes`（写/追加）**：
   ```
   action: "create" | "update" | "delete"
   question_id?: string   // create 必填
   note_id?: string       // update / delete 必填
   content?: string       // create / update 必填
   ```
   - create → `POST /api/questions/{question_id}/notes` → 返回 note_id
   - update → `PUT /api/question-notes/{note_id}`
   - delete → `DELETE /api/question-notes/{note_id}`
   - 工具描述里点明用途：「读 `get_question(include_linked=true)` 拿到问题与全部证据后，把综合的阶段总结 / 思考写成一条研究笔记沉淀；这是 AI 阶段总结的落地出口」。

3. `types.ts` 加 `QuestionNote` 类型；MCP 工具计数从 17 → 18（CLAUDE.md 架构要点同步更新）。

## 桌面前端实现

### 新增 / 改动文件

```
src/
  hooks/
    useQuestionNotes.ts             # 列某问题的笔记 + 订阅 QUESTION_NOTE_CHANGED(按 question_id 过滤) + SYNC_COMPLETED
  components/
    QuestionDetail/
      QuestionNotesSection.tsx      # 「研究笔记」区：列表 + 新建按钮 + 空态
      QuestionNoteCard.tsx          # 单条卡片：MarkdownContent 渲染 + 时间戳 + 编辑/删除；编辑态 textarea + 预览切换
  lib/
    commands.ts                     # 4 个 invoke wrapper
    events.ts                       # QUESTION_NOTE_CHANGED + payload type
  types/
    index.ts                        # QuestionNote interface
  locales/{zh,en}/question.json     # 文案
```

### `QuestionDetailView` 集成

在 `header`（标题/描述/操作）与 `linksSection`（关联列表）**之间**插入 `<QuestionNotesSection questionId={question.id} onOpenResource={...} />`。版面：

```
┌─ 标题  [编辑][归档][复制链接][删除]
│  状态徽章
│  Description (markdown)
├───────────────────────────────────
│  研究笔记 (N)                        [+ 新建研究笔记]
│  ┌─ 2026-06-02 14:30          [编辑][删除]
│  │  （markdown 渲染的思考内容…）
│  ├─ 2026-05-30 09:12          [编辑][删除]
│  │  …
├───────────────────────────────────
│  关联 (17)
│  📄 资料 …
```

- **编辑模式**：复用 `AnnotationPanel` 评论那套 markdown 编辑——textarea + 「预览/编辑」切换按钮 + 保存/取消。
- **新建**：点「+ 新建研究笔记」在区顶展开一张空编辑卡；trim 后为空则取消不提交。
- **删除**：`plugin-dialog::ask` 二次确认（文案 `deleteNoteConfirm`）。
- **最新在上**：后端已 `created_at DESC`，前端直接渲染顺序。
- **刷新**：`useQuestionNotes` 订阅 `QUESTION_NOTE_CHANGED`（过滤本问题 id）+ `SYNC_COMPLETED`（远端同步带来的笔记），与 `useResolvedQuestionLinks` 同款自动刷新模式。
- **preview variant**：`QuestionDetailView` 同时用于 PreviewPanel 的 preview 模式；笔记区在 preview 下也渲染（紧凑 padding），保持与 tab 一致。

### i18n key 草案（`src/locales/zh/question.json` 追加）

```json
{
  "notesHeader": "研究笔记",
  "addNote": "新建研究笔记",
  "editNote": "编辑笔记",
  "deleteNote": "删除笔记",
  "deleteNoteConfirm": "删除这条研究笔记？此操作不可撤销。",
  "notePlaceholder": "记录针对这个问题的思考与阶段总结（支持 Markdown）",
  "emptyNotes": "还没有研究笔记。积累资料后，在这里沉淀你的思考。",
  "noteSave": "保存",
  "noteCancel": "取消",
  "notePreview": "预览",
  "noteEdit": "编辑"
}
```
`en/question.json` 等价镜像。文案命名统一用「研究笔记」与既有「笔记（资料级 comment）」区分。

## 搜索架构与升级路径（Phase 3 预留）

用户要求：搜索放到二阶段，但**架构上提前考虑，别影响后续升级**。设计如下，使 Phase 3 成为**纯增量**改动：

### 决策：搜索命中返回「问题」，而非「单条笔记」

与现有 `question_index`（trigram，索引 title + description → 命中返回 question）一致：笔记内容并入问题的 FTS 行，命中后打开问题详情即可看到全部笔记。理由：①与现有问题搜索 UX 一致；②笔记是问题的从属内容，问题才是搜索的自然落点；③无需新建搜索结果类型 / 合并逻辑。（若未来要做笔记级跳转，可再加 `question_note_index`，不影响本决策。）

### Phase 1 已做的预留（近零成本）

- 笔记内容以 **plain markdown TEXT 存于 `question_notes.content`**，本身即可全文索引，Phase 3 **无需改 notes 表**。
- 笔记 CRUD（`questions.rs`）与同步 apply 从 Phase 1 起就**调用 `rebuild_question_search_index(conn, question_id)` 这个 hook 点**（Phase 1 它只索引 title+description，幂等无害）。Phase 3 只改这个函数**读什么**（让它 `SELECT` 并拼接该问题所有 alive 笔记的 content），调用点一行都不用动。

### Phase 3 才做的改动（届时）

- migration 012：FTS5 无法 `ALTER ADD COLUMN`，故 **DROP + 重建 `question_index`** 增加 `notes_text` 列。**as-built 偏差**：不走「重置 `config:question_fts_initialized` + boot pass」——因为**鸿蒙端没有 question-FTS boot pass**（只有 resource-FTS 的），重置 flag 会让鸿蒙索引空掉。改为**在迁移内 SQL 回填**（`INSERT INTO question_index SELECT q.id, q.title, …, group_concat(笔记.content) …`），平台无关、原子重建两端索引，且不动 flag。
- `rebuild_question_search_index`：聚合 title + description + 该问题所有 alive 笔记 content 进 `notes_text`。
- **同步 FTS 触发补一处**：`engine.rs` 的 `affected_question_ids`（~1188 行）目前只对 `entity_type == "question"` 收集 id；Phase 3 追加：`"question_note"` 时把 `payload["question_id"]` 也塞进 `affected_question_ids`（payload 自带 question_id，2 行改动）。
- 前端搜索结果对 question 命中已有展示，notes_text 命中复用同一路径，无新 UI。

## 实施步骤（Phase 1，每步独立可编译可提交）

1. **DB migration + Rust CRUD + 单测**
   - 新增 `011_question_notes.sql`；`migration.rs` 注册，version 10 → 11；改 `lib.rs::test_*` 版本断言 10 → 11
   - 实现 5 个 `question_note` 函数 + `delete_question` 级联补丁
   - 单测：create/list（验证 created_at DESC）/update/delete/级联（delete_question 带 notes）/HLC 单调/sync_log emission/create 到不存在的 question 报错
   - **验收**：`cargo test -p shibei-db` 全过
2. **同步引擎接入（五处）+ round-trip 单测**
   - upsert 路由 + `upsert_question_note` + soft_delete 表映射 + 拓扑排序 + 全量快照 + compaction
   - 单测：两临时 DB，A 建问题+笔记 → 导出 sync_log → B apply → B 见笔记；编辑/删除/LWW 冲突收敛；全量快照 round-trip 带笔记
   - **验收**：`cargo test -p shibei-sync` 全过
3. **events + Tauri commands**
   - `shibei-events` 加常量；4 个 `cmd_*_question_note` 注册 invoke_handler，写后 emit
   - **验收**：`cargo check` 过 + 手动 invoke 走通
4. **HTTP API**
   - `server/questions.rs` 4 个 handler + `mod.rs` 路由
   - **验收**：`curl` 四个端点 round-trip
5. **MCP**
   - `get_question` 输出带笔记；新工具 `manage_question_notes`；`types.ts` 加类型
   - **验收**：MCP inspector / 实跑 agent 建+读一条笔记
6. **前端 cmd + types + events + i18n**
   - `commands.ts` 4 wrapper；`types/index.ts` 加 `QuestionNote`；`events.ts` 加常量+payload；`question.json` zh/en
   - **验收**：`tsc --noEmit` 过
7. **桌面 UI**
   - `useQuestionNotes` hook；`QuestionNotesSection` + `QuestionNoteCard`；接入 `QuestionDetailView`
   - **验收**：详情页能新建/编辑/删除笔记，最新在上，markdown 渲染正确，事件实时刷新
8. **手动端到端**
   - 建问题 → 关联资料 → 写两条笔记（确认倒序）→ 编辑 → 删除 → 经 MCP 让 agent 追加一条 → 详情页实时出现 → （若开同步）双端 round-trip

## 验收清单（DoD）

- [ ] migration 011 跑通，旧库无缝升级（version 10 → 11）
- [ ] `cargo test --workspace` 全过；`cargo clippy --workspace -- -D warnings` 无 warning
- [ ] `tsc --noEmit` 无错误
- [ ] questions.rs 单测覆盖 question_note ≥ 7 case（create/list-DESC/update/delete/cascade/hlc/sync_log）
- [ ] shibei-sync round-trip 单测：增量 sync_log + 全量快照两条路径都带笔记
- [ ] 删除问题 → 其笔记全部软删 + 每条写 sync_log DELETE
- [ ] 桌面详情页新建/编辑/删除走通且实时刷新（事件，无手动 refresh）
- [ ] MCP `manage_question_notes` 三动作可用；`get_question` 输出含笔记
- [ ] i18n zh/en 完整，无硬编码 CJK
- [ ] Phase 1 已在笔记 CRUD + sync apply 接上 `rebuild_question_search_index(question_id)` 调用点（搜索预留）
- [ ] CLAUDE.md 架构要点：Questions 系统段落补充研究笔记；MCP 工具数 17 → 18

## 风险与已知问题

- **同步接入遗漏**：本设计最大风险是只写了 sync_log 却漏接 upsert / 快照 / 排序 / compaction 之一，导致笔记「能产生 sync_log 但远端收不到 / 全量同步丢失 / purge 残留」。**缓解**：Phase 1 步骤 2 强制 round-trip 单测覆盖增量 + 全量两条路径；DoD 显式列出五处。
- **拓扑排序依赖**：`question_note` 必须排在 `question` 之后 apply（引用 question_id）。**缓解**：`order_for_entity_type` 给定大于 question 的序号；全量快照 import 也在 questions 之后。
- **事件风暴（删问题带 N 条笔记）**：级联软删每条写 sync_log DELETE（同步必需），但 **UI 层不逐条发 QUESTION_NOTE_CHANGED**——`delete_question` 已发 QUESTION_CHANGED(deleted) 关闭 Tab、整页卸载，无需 note 事件。
- **空笔记**：数据层允许 `content=''`（agent 先建后填）；前端创建时 trim 为空则不提交，避免误产生空卡片。
- **搜索预留的幂等性**：Phase 1 在笔记 CRUD 里调 `rebuild_question_search_index` 时该问题 FTS 行只含 title+description，反复 rebuild 幂等无副作用；若担心多余开销，可在 Phase 1 用 `let _ =` 包裹（best-effort，与现有 FTS 调用一致）。

## 后续阶段预告

- **Phase 2（鸿蒙端，约 2-3 天）**：4 个 NAPI 命令（codegen）+ rebuild .so；`QuestionService.ets` 笔记缓存/订阅；`QuestionDetail.ets` 笔记卡片区 + 编辑页/底部 sheet + 长按菜单（编辑/删除）。
- **Phase 3（搜索，约 1 天）**：migration 012 重建 `question_index` 加 `notes_text`；`rebuild_question_search_index` 聚合笔记；`affected_question_ids` 补 question_note 分支；boot 重建 pass。
