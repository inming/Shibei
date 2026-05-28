# Questions Navigation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote "问题" from a Sidebar sub-section to a library-mode peer of folders. Desktop middle column hosts the question list (chip-filtered, flat); third-column PreviewPanel hosts question detail; double-click still opens a Tab. Mobile keeps the FolderDrawer entry but stops pushing a new page — Library's main area swaps in a QuestionListView. The `pages/Questions.ets` standalone page is removed.

**Architecture:** Introduce `libraryMode: "resources" | "questions"` in session state and propagate it through `Layout` (desktop) and `Library.ets` (mobile). The Sidebar entry and FolderDrawer entry only flip `mode`; the actual question list is a new component (`QuestionList` / `QuestionListView`) that mirrors `ResourceList`'s UX (search + chip filter + flat list). `QuestionDetailView` gets a `variant` prop so PreviewPanel and Tab share the same implementation.

**Tech Stack:** React + TypeScript + Vitest (desktop), ArkTS/ArkUI + `@ohos.data.preferences` (mobile), existing question NAPI commands, no DB / backend / sync / event changes.

---

## Source Spec

- `docs/superpowers/specs/2026-05-28-questions-navigation-redesign-design.md`

## File Map

**Desktop — create:**
- `src/components/QuestionList/QuestionList.tsx` + `.module.css`
- `src/components/QuestionList/QuestionFilterChips.tsx` + `.module.css`
- `src/components/QuestionList/QuestionListItem.tsx` + `.module.css` (port from `src/components/Sidebar/QuestionItem.tsx`)
- `src/components/QuestionList/QuestionList.test.tsx`
- `src/components/Sidebar/QuestionEntry.tsx` + `.module.css`
- `src/lib/sessionState.test.ts` (extend if exists; create otherwise)

**Desktop — modify:**
- `src/lib/sessionState.ts`: schema v2 + migration from v1
- `src/components/Layout.tsx`: mode state + middle-column / preview branching + sidebar entry wiring
- `src/components/Sidebar/Sidebar.tsx`: replace `<QuestionSection>` with `<QuestionEntry>`
- `src/components/PreviewPanel.tsx`: question-preview branch
- `src/components/QuestionDetail/QuestionDetailView.tsx`: add `variant?: "tab" | "preview"` prop
- `src/components/Sidebar/ResourceList.tsx`: question chip single/double-click behavior change
- `src/App.tsx`: wire create-question side effect (mode + select, no Tab); keep deep-link Tab behavior
- `src/locales/zh/sidebar.json` + `src/locales/en/sidebar.json`: "问题" entry label
- `src/locales/zh/question.json` + `src/locales/en/question.json`: chip labels + "open in tab" / empty-state strings

**Desktop — delete:**
- `src/components/Sidebar/QuestionSection.tsx`
- `src/components/Sidebar/QuestionSection.module.css`
- `src/components/Sidebar/QuestionItem.tsx` (moved to `QuestionList/QuestionListItem.tsx`)
- `src/components/Sidebar/QuestionItem.module.css`

**Mobile — create:**
- `shibei-harmony/entry/src/main/ets/components/QuestionListView.ets`
- `shibei-harmony/entry/src/main/ets/components/QuestionFilterChips.ets`

**Mobile — modify:**
- `shibei-harmony/entry/src/main/ets/pages/Library.ets`: mode state + view branch + `setMode` method
- `shibei-harmony/entry/src/main/ets/components/FolderDrawer.ets`: rewire question entry click; highlight reflects mode
- `shibei-harmony/entry/src/main/ets/app/SessionState.ets`: add `library.mode` + `library.questionFilter`
- `shibei-harmony/entry/src/main/ets/entryability/EntryAbility.ets`: remove any hardcoded `pages/Questions` reference (grep first)
- `shibei-harmony/entry/src/main/resources/{zh_CN,en_US,base}/element/string.json`: chip labels

**Mobile — delete:**
- `shibei-harmony/entry/src/main/ets/pages/Questions.ets`
- entry in `shibei-harmony/entry/src/main/resources/base/profile/main_pages.json` for `pages/Questions`

---

## Task 1: Session State Schema v2 + Migration

**Goal:** Land the new fields (`mode`, `questionFilter`, `selectedQuestionId`, `questionListScrollTop`) and a stable v1 → v2 migration before any UI work depends on them.

**Files:**
- Modify: `src/lib/sessionState.ts`
- Create or modify: `src/lib/sessionState.test.ts`

- [ ] **Step 1: Read current `sessionState.ts` in full**

Understand the existing v1 schema, default state, `loadSessionState` / `saveSessionState` flow, `updateReaderTab` / `removeReaderTab` / `addQuestionTab` / `removeQuestionTab` helpers, and the existing storage key (`shibei-session-state`).

- [ ] **Step 2: Write failing migration tests**

Create or extend `src/lib/sessionState.test.ts`. Cover:

```ts
describe("sessionState v1 → v2 migration", () => {
  it("treats absent version as v1 and fills defaults", () => {
    localStorage.setItem("shibei-session-state", JSON.stringify({
      activeTabId: "library",
      readerTabs: [],
      questionTabs: [],
      library: {
        selectedFolderId: "__inbox__",
        filterTagIds: [],
        selectedResourceId: null,
        listScrollTop: 120,
      },
    }));
    const state = loadSessionState();
    expect(state.version).toBe(2);
    expect(state.library.mode).toBe("resources");
    expect(state.library.resourceListScrollTop).toBe(120);
    expect(state.library.questionFilter).toBe("active");
    expect(state.library.selectedQuestionId).toBeNull();
    expect(state.library.questionListScrollTop).toBe(0);
  });

  it("falls back to default state on unknown questionFilter value", () => {
    localStorage.setItem("shibei-session-state", JSON.stringify({
      version: 2,
      library: { mode: "questions", questionFilter: "garbage" },
    }));
    const state = loadSessionState();
    expect(state.library.questionFilter).toBe("active");
  });

  it("falls back to resources mode when mode value is invalid", () => {
    localStorage.setItem("shibei-session-state", JSON.stringify({
      version: 2,
      library: { mode: "x" },
    }));
    const state = loadSessionState();
    expect(state.library.mode).toBe("resources");
  });

  it("returns DEFAULT_STATE on malformed JSON", () => {
    localStorage.setItem("shibei-session-state", "{not json");
    const state = loadSessionState();
    expect(state).toEqual(DEFAULT_STATE);
  });
});

describe("sessionState v2 writers", () => {
  it("saveSessionState merges library partial shallowly", () => {
    saveSessionState({ library: { mode: "questions" } });
    expect(loadSessionState().library.mode).toBe("questions");
    saveSessionState({ library: { selectedQuestionId: "q-1" } });
    const s = loadSessionState();
    expect(s.library.mode).toBe("questions");
    expect(s.library.selectedQuestionId).toBe("q-1");
  });
});
```

- [ ] **Step 3: Run tests and confirm failure**

```bash
npm test -- src/lib/sessionState.test.ts
```

Expected: FAIL — fields and migration not yet present.

- [ ] **Step 4: Implement schema v2**

Update `sessionState.ts`:

1. Bump `SESSION_VERSION` to `2`.
2. Add to `LibraryState` (or whatever the inline struct is called):
   - `mode: "resources" | "questions"`
   - `questionFilter: "active" | "archived" | "all"`
   - `selectedQuestionId: string | null`
   - `questionListScrollTop: number`
   - Rename `listScrollTop` → `resourceListScrollTop`. Keep the field exported under the new name; do not preserve the old field on writes.
3. `DEFAULT_STATE.library` defaults: `mode: "resources"`, `questionFilter: "active"`, `selectedQuestionId: null`, `questionListScrollTop: 0`, `resourceListScrollTop: 0`.
4. In `loadSessionState`:
   - Parse JSON; on any parse error return `DEFAULT_STATE`.
   - Normalize: if `version !== 2`, route through a `migrateFromV1` helper that:
     - Copies `library.listScrollTop` to `library.resourceListScrollTop` (default 0 if missing)
     - Fills new fields with defaults
     - Validates `mode` against `["resources", "questions"]`, falls back to `"resources"`
     - Validates `questionFilter` against `["active", "archived", "all"]`, falls back to `"active"`
   - Even when `version === 2`, validate `mode` / `questionFilter` enum values (defensive against corrupted writes).
5. `saveSessionState` already does shallow merge for `library`; no API change needed.

- [ ] **Step 5: Verify tests pass**

```bash
npm test -- src/lib/sessionState.test.ts
```

- [ ] **Step 6: Check TypeScript compiles app-wide**

```bash
npx tsc --noEmit
```

Expected: compile errors at every site that referenced `library.listScrollTop`. Fix them in this same task — rename to `resourceListScrollTop`. (Likely call sites: `Layout.tsx`, `ResourceList.tsx`.) This keeps Task 1 self-contained; downstream tasks don't have to grep for stale field names.

---

## Task 2: i18n Keys

**Goal:** Add all new UI strings up front so subsequent UI tasks can `t("…")` without round-tripping.

**Files:**
- Modify: `src/locales/zh/sidebar.json`
- Modify: `src/locales/en/sidebar.json`
- Modify: `src/locales/zh/question.json`
- Modify: `src/locales/en/question.json`

- [ ] **Step 1: Add Sidebar entry strings**

In `sidebar.json` (both zh + en), add:

```json
{
  "questionsEntry": "问题"  // en: "Questions"
}
```

- [ ] **Step 2: Add chip + preview + empty-state strings**

In `question.json` (both zh + en), add:

```json
{
  "filter": {
    "active": "进行中",
    "archived": "已归档",
    "all": "全部"
  },
  "preview": {
    "emptyState": "选择问题以查看详情",
    "openInTab": "在 Tab 中打开"
  },
  "list": {
    "searchPlaceholder": "搜索问题…",
    "createButton": "新建问题"
  },
  "chipHint": "单击预览，双击在 Tab 中打开"
}
```

English mirrors (`Active` / `Archived` / `All` / `Select a question to view details` / `Open in tab` / `Search questions…` / `New question` / `Click to preview, double-click to open in tab`).

- [ ] **Step 3: Verify i18n type augmentation still compiles**

```bash
npx tsc --noEmit
```

The `src/types/i18next.d.ts` `CustomTypeOptions` declaration may need a touch if it enumerates known keys — check it.

---

## Task 3: `QuestionDetailView` Variant Prop

**Goal:** Make the existing detail view usable both as a Tab pane and as a PreviewPanel pane without forking.

**Files:**
- Modify: `src/components/QuestionDetail/QuestionDetailView.tsx`
- Modify: `src/components/QuestionDetail/QuestionDetailView.module.css` (add `.compact` variant class if needed)

- [ ] **Step 1: Read the current component**

Identify: the title bar / close-tab button / description block / link list / edit affordances. Note where chrome differs from content.

- [ ] **Step 2: Add `variant` prop with default**

```tsx
interface QuestionDetailViewProps {
  question: Question;
  onOpenResource: (...) => void;
  onClose?: () => void;
  onOpenInTab?: (question: Question) => void;  // NEW — only used by preview variant
  variant?: "tab" | "preview";                 // NEW
}
```

Default `variant = "tab"` so all current call sites continue to work unchanged.

- [ ] **Step 3: Branch chrome by variant**

- `variant === "tab"`: render close button (existing); do not render "Open in Tab" button
- `variant === "preview"`: hide close button; render an "Open in Tab ↗" button in the header (calls `onOpenInTab?.(question)`); apply a `.compact` density class on the root if it materially helps the cramped layout (use spacing tokens, not hardcoded px)

Editing affordances (title / description / link reason / unlink) stay enabled in **both** variants — preview is full-function per spec section "QuestionDetailView 的 `variant` prop".

- [ ] **Step 4: Smoke test**

Either write a Vitest unit asserting both variants render without throwing, or check by importing in Storybook/dev. Minimum: render both branches with the same fixture and confirm chrome differs.

---

## Task 4: `QuestionList` + Filter Chips + List Item

**Goal:** The new middle-column component. Pure presentation + a few callbacks; data flows in from `Layout`.

**Files:**
- Create: `src/components/QuestionList/QuestionListItem.tsx` + `.module.css` (porting from `src/components/Sidebar/QuestionItem.tsx`)
- Create: `src/components/QuestionList/QuestionFilterChips.tsx` + `.module.css`
- Create: `src/components/QuestionList/QuestionList.tsx` + `.module.css`
- Create: `src/components/QuestionList/QuestionList.test.tsx`

- [ ] **Step 1: Port `QuestionItem` to `QuestionListItem`**

Move the file. Adjust props:

```tsx
interface QuestionListItemProps {
  question: Question;
  selected: boolean;                         // NEW — drives middle-column row highlight
  onClick: (question: Question) => void;     // single click → select
  onDoubleClick: (question: Question) => void;  // double click → open Tab
  onContextMenu: (e: MouseEvent, question: Question) => void;
}
```

Selected styling reuses ResourceList row-selected token (look up the className in `ResourceList.module.css`; reuse the same CSS variable or class fragment for consistency).

Existing right-click context menu logic stays inline; the action items are unchanged.

- [ ] **Step 2: Implement `QuestionFilterChips`**

```tsx
type QuestionFilter = "active" | "archived" | "all";

interface QuestionFilterChipsProps {
  value: QuestionFilter;
  counts: { active: number; archived: number; all: number };
  onChange: (next: QuestionFilter) => void;
}
```

Render three buttons in a row, single-select. Selected chip has accent background; counts in `<span class="badge">`. Use spacing tokens from `variables.css`; thin scrollbar policy doesn't apply (no overflow expected).

Match the visual weight of `ResourceList`'s tag filter chip strip — copy the class structure rather than inventing a new look.

- [ ] **Step 3: Implement `QuestionList` shell**

```tsx
interface QuestionListProps {
  filter: QuestionFilter;
  onFilterChange: (next: QuestionFilter) => void;
  selectedQuestionId: string | null;
  onSelect: (question: Question) => void;
  onOpenInTab: (question: Question) => void;
  onCreate: (createdQuestion: Question) => void;  // creation side-effect handler
  initialScrollTop: number;
  onScrollChange: (scrollTop: number) => void;    // 300ms debounce upstream or inside
}
```

Layout:

```
sticky header {
  [search input full-width] [+ button]
  <QuestionFilterChips />
}
scrollable body {
  flat list of <QuestionListItem />
}
```

Data:

- `const { active, archived } = useQuestions();`
- Compute `displayed: Question[]` from `filter`:
  - `"active"` → `active`
  - `"archived"` → `archived`
  - `"all"` → `[...active, ...archived]` sorted by `updated_at` desc
- When search query length >= 2: call `cmd.searchQuestions(query)`; intersect with `displayed` by id (i.e. apply chip filter to FTS results — per spec, search is bounded by chip)
- Empty state when list is empty (different copy for "no questions yet" vs "no search results")

Scroll persistence:

- On mount, set `scrollContainerRef.current.scrollTop = initialScrollTop`
- On scroll, call `onScrollChange(scrollTop)` (parent debounces 300ms before saving to session)

+ button:

- Opens `QuestionEditDialog` (existing)
- On success → call `onCreate(newQuestion)`. Parent decides the side effect (set chip to "active", select the new question). Keep `QuestionList` itself dumb about navigation.

- [ ] **Step 4: Tests for `QuestionList`**

Create `QuestionList.test.tsx` using React Testing Library. Cover:

```ts
it("renders active questions by default", () => { ... });
it("switches displayed set when chip changes", () => { ... });
it("calls onSelect on single click and onOpenInTab on double click", () => { ... });
it("intersects search results with chip filter", async () => {
  // mock cmd.searchQuestions to return [q1, q2]; active = [q1]; chip = "active";
  // displayed must be [q1]
});
it("renders 'no search results' empty state when search has no hits", () => { ... });
it("restores initialScrollTop on mount", () => { ... });
```

Mock `useQuestions` via a small fake hook or context.

- [ ] **Step 5: Run tests**

```bash
npm test -- src/components/QuestionList/
```

---

## Task 5: Sidebar Entry + Layout Mode Wiring

**Goal:** Plug `QuestionList` into the middle column and rewire the sidebar.

**Files:**
- Create: `src/components/Sidebar/QuestionEntry.tsx` + `.module.css`
- Modify: `src/components/Sidebar/Sidebar.tsx`
- Modify: `src/components/Layout.tsx`
- Delete (at end of task): `src/components/Sidebar/QuestionSection.tsx` + `.module.css`, `src/components/Sidebar/QuestionItem.tsx` + `.module.css`

- [ ] **Step 1: Build `QuestionEntry`**

```tsx
interface QuestionEntryProps {
  active: boolean;             // true when libraryMode === "questions"
  count: number;               // active question count
  onClick: () => void;
}
```

Single row: icon + label (`t("sidebar:questionsEntry")`) + count badge on the right. Selected styling uses the same token as a selected folder row (look at `FolderTree.tsx`).

Position in Sidebar layout: between FolderTree and Trash, with the existing `.separator` rule applied above.

- [ ] **Step 2: Update `Sidebar.tsx`**

- Remove `<QuestionSection ... />` import + render
- Import + render `<QuestionEntry active={libraryMode === "questions"} count={activeCount} onClick={onSelectQuestionsMode} />`
- Props plumbing: `libraryMode` and `onSelectQuestionsMode` come from `Layout`; `activeCount` from `useQuestions().active.length`

Don't drop the existing onClick handlers for folders — folder click should still call back to `Layout` to set `mode = "resources"`.

- [ ] **Step 3: Update `Layout.tsx` state**

Add state hooks initialized from session:

```tsx
const initial = useMemo(() => loadSessionState(), []);
const [mode, setModeState] = useState(initial.library.mode);
const [questionFilter, setQuestionFilterState] = useState(initial.library.questionFilter);
const [selectedQuestionId, setSelectedQuestionId] = useState(initial.library.selectedQuestionId);

const setMode = useCallback((next: LibraryMode) => {
  setModeState(next);
  saveSessionState({ library: { mode: next } });
}, []);

const setQuestionFilter = useCallback((next: QuestionFilter) => {
  setQuestionFilterState(next);
  saveSessionState({ library: { questionFilter: next } });
}, []);

const selectQuestion = useCallback((q: Question | null) => {
  setSelectedQuestionId(q?.id ?? null);
  saveSessionState({ library: { selectedQuestionId: q?.id ?? null } });
}, []);
```

- [ ] **Step 4: Branch middle column rendering**

In Layout's middle column slot:

```tsx
{mode === "resources" ? (
  <ResourceList ... existing props ... />
) : (
  <QuestionList
    filter={questionFilter}
    onFilterChange={setQuestionFilter}
    selectedQuestionId={selectedQuestionId}
    onSelect={selectQuestion}
    onOpenInTab={openQuestion}
    onCreate={handleQuestionCreated}
    initialScrollTop={initial.library.questionListScrollTop}
    onScrollChange={persistQuestionScroll}
  />
)}
```

`openQuestion` is the existing handler in `App.tsx` (passed down).

`handleQuestionCreated(q)` does: `setQuestionFilter("active")` + `selectQuestion(q)`. **Does not** call `openQuestion`. (See Task 8 for the full creation matrix.)

`persistQuestionScroll`: 300ms debounce wrapping `saveSessionState({ library: { questionListScrollTop: n } })`. Reuse any existing debounce util in the codebase (e.g. `setTimeout` + ref), or copy the pattern from how `ResourceList` persists `resourceListScrollTop`.

- [ ] **Step 5: Sidebar entry → setMode wiring**

`onSelectQuestionsMode` in Layout: `() => setMode("questions")`. No other state mutated — `selectedFolderId` / `filterTagIds` are preserved in session so resource mode picks up where it left off.

Folder click in Sidebar: existing handler already sets `selectedFolderId`; just add `setMode("resources")` at the top.

- [ ] **Step 6: Delete obsolete files**

```bash
rm src/components/Sidebar/QuestionSection.tsx src/components/Sidebar/QuestionSection.module.css
rm src/components/Sidebar/QuestionItem.tsx src/components/Sidebar/QuestionItem.module.css
```

(QuestionItem's logic was ported to `QuestionListItem` in Task 4.)

- [ ] **Step 7: Compile + smoke**

```bash
npx tsc --noEmit
npm test
```

Manually launch and verify: clicking "问题" entry → middle column swaps; clicking a folder → swaps back.

---

## Task 6: PreviewPanel Question Branch

**Goal:** When `mode === "questions"` and a question is selected, render `QuestionDetailView` with `variant="preview"`.

**Files:**
- Modify: `src/components/PreviewPanel.tsx`
- Modify: `src/components/Layout.tsx` (pass `mode` + `selectedQuestionId` down to PreviewPanel)

- [ ] **Step 1: Extend `PreviewPanel` props**

```tsx
interface PreviewPanelProps {
  // existing
  resource: Resource | null;
  onOpenResource: ...;
  // new
  mode: "resources" | "questions";
  selectedQuestionId: string | null;
  onOpenQuestionInTab: (question: Question) => void;
}
```

- [ ] **Step 2: Implement branching**

```tsx
if (mode === "questions") {
  const question = useQuestion(selectedQuestionId);  // existing hook; gates on null
  if (!question) return <EmptyState text={t("question:preview.emptyState")} />;
  return (
    <QuestionDetailView
      question={question}
      variant="preview"
      onOpenResource={onOpenResource}
      onOpenInTab={onOpenQuestionInTab}
    />
  );
}
// existing resource path
```

If `useQuestion` doesn't exist yet (the survey mentioned `useQuestions` / `useQuestionLinks` but not a single-question hook), either: (a) consume `useQuestions()` and `.find()` by id; (b) add a tiny `useQuestion(id)` hook in `src/hooks/useQuestion.ts` that subscribes to `QUESTION_CHANGED` and refetches by id. (b) is cleaner; (a) is fine for v1.

- [ ] **Step 3: Wire from Layout**

Pass `mode={mode}`, `selectedQuestionId={selectedQuestionId}`, `onOpenQuestionInTab={openQuestion}` to `<PreviewPanel ... />`.

- [ ] **Step 4: Edge case — selected question deleted**

In `Layout`, subscribe to `QUESTION_CHANGED`. When the event signals a delete and `event.payload.id === selectedQuestionId`, call `selectQuestion(null)`. Otherwise PreviewPanel will get a null question lookup and show empty state, which is acceptable but jarring.

Verify against existing `QUESTION_CHANGED` payload shape (see `src/lib/events.ts`). If the payload doesn't include the changed id, just clear `selectedQuestionId` when the looked-up question becomes null on next render — also fine.

- [ ] **Step 5: Smoke test**

Click a question → preview shows; double-click → Tab opens AND preview persists (both should show the same data); delete the previewed question via right-click → preview clears to empty state.

---

## Task 7: ResourceList Question Chip Behavior

**Goal:** Library-mode search-result question chips: single click switches mode + selects; double click opens Tab.

**Files:**
- Modify: `src/components/Sidebar/ResourceList.tsx`
- Modify: `src/components/Layout.tsx` (extend props passed down)

- [ ] **Step 1: Read existing chip rendering**

Find the question chip row that renders when `searchQuery.length >= 2`. Locate the current click handler (likely passes `onOpenQuestion={openQuestion}` from `Layout`).

- [ ] **Step 2: Rewire chip handlers**

In `ResourceList.tsx`, change chip rendering to bind:

```tsx
onClick={() => onSelectQuestion(q)}       // NEW behavior: mode + select
onDoubleClick={() => onOpenQuestion(q)}   // existing: open Tab
title={t("question:chipHint")}
```

The chip prop interface adds `onSelectQuestion: (q: Question) => void`.

- [ ] **Step 3: Wire from Layout**

Build a callback that does both `setMode("questions")` and `selectQuestion(q)` then pass as `onSelectQuestion`:

```tsx
const selectQuestionFromChip = useCallback((q: Question) => {
  setMode("questions");
  selectQuestion(q);
}, [setMode, selectQuestion]);
```

Pass to `<ResourceList onSelectQuestion={selectQuestionFromChip} onOpenQuestion={openQuestion} />`.

- [ ] **Step 4: Manual verification**

In library mode, type ≥ 2 chars matching a question title → chip appears. Single click → mode swaps, question selected in preview. Double click on another chip → Tab opens.

---

## Task 8: Creation Side-Effect Matrix

**Goal:** Lock down the three creation entry points so each does exactly what the spec requires.

**Files:**
- Verify (modify if needed): `src/components/QuestionList/QuestionList.tsx` (already wired in Task 4–5)
- Modify: `src/components/Sidebar/ResourceList.tsx` — right-click "关联到问题 → 新建并关联" path
- Verify (no change expected): deep link handler in `src/App.tsx`

- [ ] **Step 1: QuestionList + button**

Already wired in Task 5 to `handleQuestionCreated`:
- `setQuestionFilter("active")` ✓
- `selectQuestion(q)` ✓
- **Does NOT** call `openQuestion` ✓

Verify by hand: from a folder selected (resources mode), click sidebar "问题" entry, click +, create question → should see it selected with PreviewPanel populated; no new Tab opened.

- [ ] **Step 2: ResourceList "create and link" path**

Find the existing handler that creates a question and links it to a resource from the right-click menu. Verify it:
- Does NOT call `setMode("questions")`
- Does NOT call `selectQuestion(q)`
- Does NOT call `openQuestion(q)`
- Stays in resources mode with the same selected resource

Spec rationale: user's attention is on the resource; quietly creating + linking should not yank them out of context.

Adjust if any of those side-effects exist today.

- [ ] **Step 3: Deep link `shibei://open/question/{id}`**

Verify in `App.tsx` deep-link handler: this path **continues** to call `openQuestion(q)` (i.e. opens a Tab). External entry points should land in the deepest view.

Side check: deep link does NOT switch `mode` away from whatever the user was in — Tabs are mode-orthogonal. (The active Tab automatically takes focus; the underlying library mode persists for when the user closes the Tab.)

- [ ] **Step 4: Test the matrix**

| Entry point             | Tab opens? | Mode changes? | Selection changes? |
|-------------------------|------------|----------------|----------------------|
| QuestionList +          | no         | → questions    | new question         |
| ResourceList right-click| no         | no             | no (stays on resource) |
| Deep link               | yes        | no             | n/a (Tab is independent)|

Walk through all three manually. Document any deviation in the task notes.

---

## Task 9: Mobile — Library Mode + QuestionListView

**Goal:** Mobile Library page becomes mode-aware; question list is a new builder; FolderDrawer entry only flips mode.

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/app/SessionState.ets`
- Create: `shibei-harmony/entry/src/main/ets/components/QuestionFilterChips.ets`
- Create: `shibei-harmony/entry/src/main/ets/components/QuestionListView.ets`
- Modify: `shibei-harmony/entry/src/main/ets/pages/Library.ets`
- Modify: `shibei-harmony/entry/src/main/ets/components/FolderDrawer.ets`
- Modify: `shibei-harmony/entry/src/main/resources/{zh_CN,en_US,base}/element/string.json`

- [ ] **Step 1: Extend `SessionState.ets`**

Add to the persisted JSON shape:

```ts
library: {
  ...existing,
  mode?: "resources" | "questions",            // optional, default "resources"
  questionFilter?: "active" | "archived" | "all",  // optional, default "active"
}
```

`save({ library: { mode, questionFilter } })` and `load()` (deserialize with defaults; validate enum values; on bad values fall back to defaults silently — same policy as desktop).

- [ ] **Step 2: i18n strings (rooms 3)**

In all three `string.json` files add:

```json
{
  "name": "question_filter_active",  "value": "进行中"  // base: 进行中, zh_CN: 进行中, en_US: Active
},
{ "name": "question_filter_archived", "value": "已归档" },  // en: Archived
{ "name": "question_filter_all",      "value": "全部" },    // en: All
{ "name": "question_list_search_placeholder", "value": "搜索问题…" },  // en: Search questions…
{ "name": "question_list_create",     "value": "新建问题" }  // en: New question
```

- [ ] **Step 3: Build `QuestionFilterChips.ets`**

ArkUI component, three buttons in a Row, single-select. Each button takes `label` + `count` + `selected` props + `onSelect` callback. Selected state uses `app.color.accent_primary` token; unselected uses `text_secondary`. Reuse the spacing tokens from the existing FilterChips on resources, if one exists.

- [ ] **Step 4: Build `QuestionListView.ets`**

Layout:

```
Column {
  Row { TextInput(search) }
  QuestionFilterChips(...)
  List {
    ForEach(displayed) { q => Row { dot + title } .onClick(gotoDetail).gesture(LongPress → menu) }
  }
}
.relativeContainer or Stack to overlay FAB at bottom-right
```

Data:

- Subscribe to `QuestionService.subscribeList()` (existing); maintain `active: Question[]` + `archived: Question[]`
- `displayed`: same chip-derived projection as desktop
- Search >= 2 chars: call `QuestionService.search(query)` (NAPI wrapper of `cmd_search_questions`) and intersect with chip filter
- Click row: `router.pushUrl({ url: "pages/QuestionDetail", params: { id: q.id } })`
- LongPress row: dialog menu (edit / copy link / archive / delete / cancel) — port verbatim from `pages/Questions.ets`
- FAB: `router.pushUrl({ url: "pages/QuestionEdit", params: { mode: "create" } })`
- Lifecycle: `aboutToAppear` reads session for initial filter; `aboutToDisappear` unsubscribes

- [ ] **Step 5: Update `Library.ets`**

Add state:

```ts
@State libraryMode: "resources" | "questions" = SessionState.get().library.mode ?? "resources";
@State questionFilter: "active" | "archived" | "all" = SessionState.get().library.questionFilter ?? "active";

setMode(next: "resources" | "questions") {
  this.libraryMode = next;
  SessionState.save({ library: { mode: next } });
}
```

Main area branches:

```tsx
if (this.libraryMode === "resources") {
  ResourceListView(...)
} else {
  QuestionListView({ filter: this.questionFilter, onFilterChange: ... })
}
```

In `consumePendingDeepLink`: if pending link is a folder, force `setMode("resources")` before selecting; if it's a question deep link, push `QuestionDetail` directly (no mode change needed — Tab-equivalent semantics).

- [ ] **Step 6: Update `FolderDrawer.ets`**

The bottom "问题" row:
- onClick handler changes from `router.pushUrl({ url: "pages/Questions" })` to `closeDrawer(); library.setMode("questions");` — needs a callback prop or shared state from Library to FolderDrawer
- Visual highlight binds to `libraryMode === "questions"`
- When `libraryMode === "questions"`, folder rows in the drawer render without the selected highlight (so the drawer truthfully shows where the user is)

Wire `setMode` from Library through to FolderDrawer as a prop (e.g. `onSelectQuestionsMode: () => void`).

- [ ] **Step 7: Build + install + UI test**

Per CLAUDE.md harmony workflow:

```bash
export JAVA_HOME=$(/usr/libexec/java_home)
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
export NODE_HOME=/Applications/DevEco-Studio.app/Contents/tools/node
export PATH="$JAVA_HOME/bin:$NODE_HOME/bin:$PATH"
HVIGOR=/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw
HDC=$DEVECO_SDK_HOME/default/openharmony/toolchains/hdc

cd shibei-harmony
$HVIGOR --sync --no-daemon
$HVIGOR assembleHap --no-daemon 2>&1 | tee /tmp/harmony-build.log
$HDC install entry/build/default/outputs/default/entry-default-signed.hap
$HDC shell aa force-stop com.shibei.harmony.phase0
$HDC shell aa start -a EntryAbility -b com.shibei.harmony.phase0
```

UI smoke:
- Open drawer → tap "问题" → drawer closes, Library main area shows question list
- Tap a question → QuestionDetail pushed
- Back → still in questions mode
- Tap folder in drawer → drawer closes, Library shows resource list
- Kill + restart → mode persists

---

## Task 10: Mobile — Delete `pages/Questions.ets`

**Goal:** Remove the now-unused full-screen Questions page and its route.

**Files:**
- Delete: `shibei-harmony/entry/src/main/ets/pages/Questions.ets`
- Modify: `shibei-harmony/entry/src/main/resources/base/profile/main_pages.json`

- [ ] **Step 1: Grep for references**

```bash
grep -rn "pages/Questions" shibei-harmony/entry/src/main/
grep -rn 'url:\s*"pages/Questions"' shibei-harmony/entry/src/main/
grep -rn "pages/Questions\\b" shibei-harmony/entry/src/main/  # boundary to exclude QuestionDetail / QuestionEdit
```

Expected residual sites: `FolderDrawer.ets` (already removed in Task 9), `EntryAbility.ets` (deep-link routing), maybe a navigation helper.

- [ ] **Step 2: Clean references**

For each hit:
- If it's the old FolderDrawer call → already changed in Task 9
- If it's deep-link dispatch in `EntryAbility.ets` → the question deep link should push `QuestionDetail` (already correct in Phase 1, just verify)
- Anything else → migrate or delete case by case

- [ ] **Step 3: Delete the page file**

```bash
rm shibei-harmony/entry/src/main/ets/pages/Questions.ets
```

- [ ] **Step 4: Remove from `main_pages.json`**

Edit `shibei-harmony/entry/src/main/resources/base/profile/main_pages.json` and drop the `"pages/Questions"` entry. Keep `"pages/QuestionDetail"` and `"pages/QuestionEdit"`.

- [ ] **Step 5: Rebuild + install + verify**

```bash
$HVIGOR clean --no-daemon
$HVIGOR --sync --no-daemon
$HVIGOR assembleHap --no-daemon
```

Verify build succeeds (no compile error referencing the deleted page). Install and confirm the drawer entry still works.

Check `.hvigor/report/report-<latest>.json` for any ArkTS errors if assemble fails. (Spec: harmony report path documented in CLAUDE.md.)

---

## Task 11: Manual Regression Pass

**Goal:** Walk through the acceptance criteria from the spec. This is a checkpoint task — no code changes.

**Files:** none (verification only)

- [ ] **Step 1: Desktop acceptance — run through spec criteria 1–13**

Source: `docs/superpowers/specs/2026-05-28-questions-navigation-redesign-design.md` §"验收标准" desktop list.

For each numbered item, manually exercise the flow in `npm run tauri dev`. Note any deviation.

- [ ] **Step 2: Mobile acceptance — run through spec criteria 1–10**

Source: same spec, mobile list. Use installed HAP on physical device per Task 9 Step 7.

- [ ] **Step 3: Session state corruption probes**

Quick checks of resilience:
1. Edit `~/Library/Application Support/shibei/` … wait, session state is in localStorage on desktop. Open DevTools, run `localStorage.setItem("shibei-session-state", "{not json")` and reload → app must boot with default state, not crash.
2. Set `localStorage.setItem("shibei-session-state", JSON.stringify({ version: 2, library: { mode: "garbage" }}))` and reload → mode should fall back to "resources".
3. Mobile: kill app via task manager, reopen → restored mode persists.

- [ ] **Step 4: Cross-mode no-leak check**

In resources mode, select resource A. Switch to questions mode, select question Q1. Switch back to resources mode. Resource A should still be selected and previewed. Switch back to questions — Q1 still selected.

- [ ] **Step 5: Sign-off**

If all checks pass, mark this plan complete. If any criterion fails, file a follow-up task or fix inline (re-tick the relevant earlier task as needed).

---

## Out of Scope (for this plan)

- Sorting UI on QuestionList (hardcoded `updated_at` desc; revisit if user asks)
- Pinned questions / favorites
- Multi-select on QuestionList
- Question list scrollTop persistence on mobile (parity gap with resources, file separately if wanted)
- Onboarding tooltip for the new sidebar entry
- Migration of legacy `library.listScrollTop` key beyond a one-shot in-memory rename (storage gets cleaned on next write)
