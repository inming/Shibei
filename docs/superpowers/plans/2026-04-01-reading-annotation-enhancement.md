# Reading & Annotation Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resource preview panel (click-to-preview, double-click-to-open), resource-level notes, comment editing, and delete confirmation dialogs to the reading & annotation UI.

**Architecture:** All backend APIs already exist. Work is 100% frontend: new PreviewPanel component, useAnnotations hook extension, AnnotationPanel enhancements, and wiring changes in LibraryView/App/ResourceList/ReaderView. Each of the 4 features is an independent task with its own commit.

**Tech Stack:** React + TypeScript, CSS Modules, Vitest + React Testing Library. Tauri invoke wrappers in `src/lib/commands.ts` (no changes needed).

**Design spec:** `docs/superpowers/specs/2026-04-01-reading-annotation-enhancement-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/components/PreviewPanel.tsx` | Resource preview: metadata card + highlight list with expandable comments |
| Create | `src/components/PreviewPanel.module.css` | Styles for PreviewPanel |
| Modify | `src/components/Layout.tsx` | Add selectedResource state, wire single-click/double-click, render PreviewPanel |
| Modify | `src/App.tsx` | Extend openResource to accept optional highlightId |
| Modify | `src/components/ReaderView.tsx` | Accept initialHighlightId prop, scroll on load |
| Modify | `src/components/Sidebar/ResourceList.tsx` | Split onClick into onSelect (click) + onOpen (double-click) |
| Modify | `src/hooks/useAnnotations.ts` | Add editComment method |
| Modify | `src/components/AnnotationPanel.tsx` | Add notes section, comment editing, delete confirmation |
| Modify | `src/components/AnnotationPanel.module.css` | Styles for notes section, edit mode, edit button |

---

### Task 1: ResourceList click/double-click split + LibraryView selectedResource state

Change ResourceList so single-click selects (triggers `onSelect`) and double-click opens (triggers `onOpen`). LibraryView tracks `selectedResource` and passes it down. The right column still shows the placeholder for now — PreviewPanel comes in Task 2.

**Files:**
- Modify: `src/components/Sidebar/ResourceList.tsx`
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Update ResourceList props and event handling**

In `src/components/Sidebar/ResourceList.tsx`, rename `onSelectResource` to `onSelect` and add `onOpen`:

```tsx
interface ResourceListProps {
  folderId: string | null;
  selectedResourceId: string | null;
  onSelect: (resource: Resource) => void;
  onOpen: (resource: Resource) => void;
}

export function ResourceList({ folderId, selectedResourceId, onSelect, onOpen }: ResourceListProps) {
```

Update the resource item's event handlers (the `<div key={resource.id} ...>` around line 37):

```tsx
        <div
          key={resource.id}
          className={`${styles.item} ${selectedResourceId === resource.id ? styles.itemSelected : ""}`}
          onClick={() => onSelect(resource)}
          onDoubleClick={() => onOpen(resource)}
        >
```

- [ ] **Step 2: Update LibraryView to track selectedResource**

Replace the entire `src/components/Layout.tsx` with:

```tsx
import { useState } from "react";
import type { Resource } from "@/types";
import { FolderTree } from "@/components/Sidebar/FolderTree";
import { TagFilter } from "@/components/Sidebar/TagFilter";
import { ResourceList } from "@/components/Sidebar/ResourceList";
import styles from "./Layout.module.css";

interface LibraryViewProps {
  onOpenResource: (resource: Resource, highlightId?: string) => void;
}

export function LibraryView({ onOpenResource }: LibraryViewProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);

  return (
    <div className={styles.layout}>
      {/* Col 1: Folder tree + Tags */}
      <div className={styles.sidebar}>
        <FolderTree
          selectedFolderId={selectedFolderId}
          onSelectFolder={(id) => {
            setSelectedFolderId(id);
            setSelectedResource(null);
          }}
        />
        <TagFilter />
      </div>

      {/* Col 2: Resource list */}
      <div className={styles.listPanel}>
        <ResourceList
          folderId={selectedFolderId}
          selectedResourceId={selectedResource?.id ?? null}
          onSelect={setSelectedResource}
          onOpen={(resource) => onOpenResource(resource)}
        />
      </div>

      {/* Col 3: Preview or placeholder */}
      <div className={styles.main}>
        {selectedResource ? (
          <div className={styles.mainPlaceholder}>
            预览面板 — 下一步实现
          </div>
        ) : (
          <div className={styles.mainPlaceholder}>
            双击资料在新标签页中打开阅读
          </div>
        )}
      </div>
    </div>
  );
}
```

Key changes: `onOpenResource` signature now includes optional `highlightId`, `selectedResource` state added, folder change clears selection, ResourceList gets `onSelect`/`onOpen` split.

- [ ] **Step 3: Update App.tsx openResource to accept highlightId**

In `src/App.tsx`, update the `openResource` callback (around line 18):

```tsx
  const openResource = useCallback((resource: Resource, highlightId?: string) => {
    setReaderTabs((prev) => {
      const next = new Map(prev);
      if (!next.has(resource.id)) {
        next.set(resource.id, { resource, initialHighlightId: highlightId ?? null });
      }
      return next;
    });
    setActiveTabId(resource.id);
  }, []);
```

Update the `ReaderTab` interface (line 10):

```tsx
interface ReaderTab {
  resource: Resource;
  initialHighlightId: string | null;
}
```

Update the ReaderView render (around line 59):

```tsx
            <ReaderView
              resource={readerTabs.get(activeTabId)!.resource}
              initialHighlightId={readerTabs.get(activeTabId)!.initialHighlightId}
            />
```

- [ ] **Step 4: Update ReaderView to accept and use initialHighlightId**

In `src/components/ReaderView.tsx`, update the props interface (line 9):

```tsx
interface ReaderViewProps {
  resource: Resource;
  initialHighlightId: string | null;
}
```

Update the function signature (line 19):

```tsx
export function ReaderView({ resource, initialHighlightId }: ReaderViewProps) {
```

Add an effect after the existing `iframeReady` effect (after line 90) to scroll to the initial highlight once the iframe is ready and highlights are rendered:

```tsx
  // Scroll to initial highlight if specified
  useEffect(() => {
    if (initialHighlightId && iframeReady && highlights.length > 0 && iframeRef.current?.contentWindow) {
      setActiveHighlightId(initialHighlightId);
      iframeRef.current.contentWindow.postMessage(
        { type: "shibei:scroll-to-highlight", id: initialHighlightId },
        "*",
      );
    }
  }, [initialHighlightId, iframeReady, highlights]);
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run existing tests**

Run: `cd /Users/work/workspace/Shibei && npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Manual verification**

Launch the app with `cargo tauri dev`. Verify:
1. Single-click a resource → it gets selected (highlighted in list), right panel says "预览面板 — 下一步实现"
2. Double-click a resource → opens in reader Tab as before
3. Changing folder clears the selection

- [ ] **Step 8: Commit**

```bash
git add src/components/Sidebar/ResourceList.tsx src/components/Layout.tsx src/App.tsx src/components/ReaderView.tsx
git commit -m "feat: split resource click/double-click, add selectedResource state and initialHighlightId support"
```

---

### Task 2: PreviewPanel component

Create the PreviewPanel component that shows resource metadata and highlight list with expandable comments. Wire it into LibraryView.

**Files:**
- Create: `src/components/PreviewPanel.tsx`
- Create: `src/components/PreviewPanel.module.css`
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Create PreviewPanel.module.css**

Create `src/components/PreviewPanel.module.css`:

```css
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: var(--spacing-lg);
}

.metaSection {
  margin-bottom: var(--spacing-lg);
}

.metaTitle {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
  margin-bottom: var(--spacing-xs);
  word-break: break-word;
}

.metaDomain {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.divider {
  border: none;
  border-top: 1px solid var(--color-border-light);
  margin: 0 0 var(--spacing-md) 0;
}

.sectionLabel {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--spacing-sm);
}

.highlightItem {
  padding: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
  border-radius: 4px;
  border-left: 3px solid transparent;
  cursor: pointer;
  transition: background 0.15s;
}

.highlightItem:hover {
  background: var(--color-bg-hover);
}

.highlightText {
  font-size: var(--font-size-sm);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.highlightMeta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--spacing-xs);
  font-size: 11px;
  color: var(--color-text-muted);
}

.commentToggle {
  color: var(--color-accent);
  cursor: pointer;
  font-size: 11px;
}

.commentToggle:hover {
  text-decoration: underline;
}

.commentList {
  margin-top: var(--spacing-xs);
  padding-left: var(--spacing-sm);
  border-left: 1px solid var(--color-border-light);
}

.commentItem {
  padding: var(--spacing-xs) 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.4;
}

.empty {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
  padding: var(--spacing-xl);
}
```

- [ ] **Step 2: Create PreviewPanel.tsx**

Create `src/components/PreviewPanel.tsx`:

```tsx
import { useState } from "react";
import type { Resource } from "@/types";
import { useAnnotations } from "@/hooks/useAnnotations";
import styles from "./PreviewPanel.module.css";

interface PreviewPanelProps {
  resource: Resource;
  onOpenInReader: (highlightId?: string) => void;
}

export function PreviewPanel({ resource, onOpenInReader }: PreviewPanelProps) {
  const { highlights, getCommentsForHighlight, loading } = useAnnotations(resource.id);
  const [expandedHighlightId, setExpandedHighlightId] = useState<string | null>(null);

  const domain = resource.domain ?? (() => {
    try { return new URL(resource.url).hostname; } catch { return resource.url; }
  })();

  return (
    <div className={styles.panel}>
      {/* Meta section */}
      <div className={styles.metaSection}>
        <div className={styles.metaTitle}>{resource.title}</div>
        <div className={styles.metaDomain}>
          {domain} · {new Date(resource.created_at).toLocaleDateString()}
        </div>
      </div>

      <hr className={styles.divider} />

      {/* Highlights section */}
      <div className={styles.sectionLabel}>
        高亮 ({loading ? "..." : highlights.length})
      </div>

      {!loading && highlights.length === 0 && (
        <div className={styles.empty}>暂无高亮标注</div>
      )}

      {highlights.map((hl) => {
        const comments = getCommentsForHighlight(hl.id);
        const isExpanded = expandedHighlightId === hl.id;

        return (
          <div
            key={hl.id}
            className={styles.highlightItem}
            style={{ borderLeftColor: hl.color }}
            onClick={() => onOpenInReader(hl.id)}
          >
            <div className={styles.highlightText}>{hl.text_content}</div>
            <div className={styles.highlightMeta}>
              <span>{new Date(hl.created_at).toLocaleDateString()}</span>
              {comments.length > 0 && (
                <span
                  className={styles.commentToggle}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedHighlightId(isExpanded ? null : hl.id);
                  }}
                >
                  💬 {comments.length} 条评论 {isExpanded ? "▲" : "▼"}
                </span>
              )}
            </div>

            {isExpanded && comments.length > 0 && (
              <div className={styles.commentList} onClick={(e) => e.stopPropagation()}>
                {comments.map((c) => (
                  <div key={c.id} className={styles.commentItem}>
                    {c.content}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Wire PreviewPanel into LibraryView**

In `src/components/Layout.tsx`, add the import at the top:

```tsx
import { PreviewPanel } from "@/components/PreviewPanel";
```

Replace the `{/* Col 3: Preview or placeholder */}` block with:

```tsx
      {/* Col 3: Preview or placeholder */}
      <div className={styles.main}>
        {selectedResource ? (
          <PreviewPanel
            resource={selectedResource}
            onOpenInReader={(highlightId) => onOpenResource(selectedResource, highlightId)}
          />
        ) : (
          <div className={styles.mainPlaceholder}>
            双击资料在新标签页中打开阅读
          </div>
        )}
      </div>
```

- [ ] **Step 4: Verify compilation**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run tests**

Run: `cd /Users/work/workspace/Shibei && npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Manual verification**

Launch `cargo tauri dev`. Verify:
1. Single-click a resource → right panel shows title, domain, date, and highlight list
2. Click a highlight → opens reader Tab and scrolls to that highlight
3. Highlights with comments show "💬 N 条评论 ▼" — click to expand/collapse
4. Resource with no highlights shows "暂无高亮标注"
5. Double-click still opens reader Tab directly

- [ ] **Step 7: Commit**

```bash
git add src/components/PreviewPanel.tsx src/components/PreviewPanel.module.css src/components/Layout.tsx
git commit -m "feat: add PreviewPanel component with metadata and highlight list"
```

---

### Task 3: useAnnotations editComment + AnnotationPanel comment editing

Add `editComment` to the hook, then add inline edit UI to each comment in AnnotationPanel.

**Files:**
- Modify: `src/hooks/useAnnotations.ts`
- Modify: `src/components/AnnotationPanel.tsx`
- Modify: `src/components/AnnotationPanel.module.css`
- Modify: `src/components/ReaderView.tsx`

- [ ] **Step 1: Add editComment to useAnnotations**

In `src/hooks/useAnnotations.ts`, add after the `removeComment` callback (after line 73):

```tsx
  const editComment = useCallback(
    async (id: string, content: string) => {
      try {
        await cmd.updateComment(id, content);
        setComments((prev) =>
          prev.map((c) =>
            c.id === id ? { ...c, content, updated_at: new Date().toISOString() } : c,
          ),
        );
      } catch (err) {
        console.error("Failed to update comment:", err);
      }
    },
    [],
  );
```

Add `editComment` to the return object (line 85 area):

```tsx
  return {
    highlights,
    comments,
    resourceNotes,
    loading,
    refresh,
    addHighlight,
    removeHighlight,
    addComment,
    removeComment,
    editComment,
    getCommentsForHighlight,
  };
```

- [ ] **Step 2: Add CSS for edit mode**

Append to `src/components/AnnotationPanel.module.css`:

```css
.editBtn {
  color: var(--color-text-muted);
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 3px;
  margin-right: var(--spacing-xs);
}

.editBtn:hover {
  background: var(--color-accent);
  color: white;
}
```

- [ ] **Step 3: Add onEditComment prop and edit UI to AnnotationPanel**

In `src/components/AnnotationPanel.tsx`, update `AnnotationPanelProps` interface (line 5):

```tsx
interface AnnotationPanelProps {
  highlights: Highlight[];
  getCommentsForHighlight: (highlightId: string) => Comment[];
  activeHighlightId: string | null;
  onClickHighlight: (id: string) => void;
  onDeleteHighlight: (id: string) => void;
  onAddComment: (highlightId: string | null, content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
}
```

Update the destructuring in the component function (line 15):

```tsx
export function AnnotationPanel({
  highlights,
  getCommentsForHighlight,
  activeHighlightId,
  onClickHighlight,
  onDeleteHighlight,
  onAddComment,
  onDeleteComment,
  onEditComment,
}: AnnotationPanelProps) {
```

Pass `onEditComment` to HighlightEntry (inside the map, around line 41):

```tsx
          <HighlightEntry
            key={hl.id}
            highlight={hl}
            comments={getCommentsForHighlight(hl.id)}
            isActive={activeHighlightId === hl.id}
            ref={activeHighlightId === hl.id ? activeRef : null}
            onClick={() => onClickHighlight(hl.id)}
            onDelete={() => onDeleteHighlight(hl.id)}
            onAddComment={(content) => onAddComment(hl.id, content)}
            onDeleteComment={onDeleteComment}
            onEditComment={onEditComment}
          />
```

Update HighlightEntryProps (line 58):

```tsx
interface HighlightEntryProps {
  highlight: Highlight;
  comments: Comment[];
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onAddComment: (content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
}
```

Update the HighlightEntry forwardRef destructuring (line 71):

```tsx
const HighlightEntry = forwardRef<HTMLDivElement, HighlightEntryProps>(
  function HighlightEntry(
    { highlight, comments, isActive, onClick, onDelete, onAddComment, onDeleteComment, onEditComment },
    ref,
  ) {
    const [showInput, setShowInput] = useState(false);
    const [commentText, setCommentText] = useState("");
    const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
```

Replace the comments rendering section (lines 107-123) with:

```tsx
        {/* Comments */}
        {comments.length > 0 && (
          <div className={styles.commentSection} onClick={(e) => e.stopPropagation()}>
            {comments.map((c) => (
              <div key={c.id} className={styles.commentItem}>
                {editingCommentId === c.id ? (
                  <div>
                    <textarea
                      className={styles.commentInput}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (editText.trim()) {
                            onEditComment(c.id, editText.trim());
                            setEditingCommentId(null);
                          }
                        }
                        if (e.key === "Escape") {
                          setEditingCommentId(null);
                        }
                      }}
                    />
                    <div className={styles.commentActions}>
                      <button
                        className={styles.submitBtn}
                        onClick={() => {
                          if (editText.trim()) {
                            onEditComment(c.id, editText.trim());
                            setEditingCommentId(null);
                          }
                        }}
                      >
                        保存
                      </button>
                      <button
                        className={styles.cancelBtn}
                        onClick={() => setEditingCommentId(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.commentContent}>{c.content}</div>
                    <div className={styles.commentMeta}>
                      <span>{new Date(c.created_at).toLocaleDateString()}</span>
                      <span>
                        <button
                          className={styles.editBtn}
                          onClick={() => {
                            setEditingCommentId(c.id);
                            setEditText(c.content);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className={styles.deleteBtn}
                          onClick={() => onDeleteComment(c.id)}
                        >
                          删除
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
```

- [ ] **Step 4: Wire onEditComment in ReaderView**

In `src/components/ReaderView.tsx`, destructure `editComment` from useAnnotations (line 25 area):

```tsx
  const {
    highlights,
    getCommentsForHighlight,
    addHighlight,
    removeHighlight,
    addComment,
    removeComment,
    editComment,
  } = useAnnotations(resource.id);
```

Pass it to AnnotationPanel (around line 178):

```tsx
      <AnnotationPanel
        highlights={highlights}
        getCommentsForHighlight={getCommentsForHighlight}
        activeHighlightId={activeHighlightId}
        onClickHighlight={handlePanelClickHighlight}
        onDeleteHighlight={handleDeleteHighlight}
        onAddComment={(hlId, content) => addComment(hlId, content)}
        onDeleteComment={removeComment}
        onEditComment={editComment}
      />
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run tests**

Run: `cd /Users/work/workspace/Shibei && npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useAnnotations.ts src/components/AnnotationPanel.tsx src/components/AnnotationPanel.module.css src/components/ReaderView.tsx
git commit -m "feat: add comment editing with inline edit UI"
```

---

### Task 4: Resource-level notes in AnnotationPanel

Add a "笔记" section at the bottom of AnnotationPanel showing resource-level notes (comments with `highlight_id === null`) with add/edit/delete.

**Files:**
- Modify: `src/components/AnnotationPanel.tsx`
- Modify: `src/components/AnnotationPanel.module.css`
- Modify: `src/components/ReaderView.tsx`

- [ ] **Step 1: Add CSS for notes section**

Append to `src/components/AnnotationPanel.module.css`:

```css
.notesSection {
  border-top: 1px solid var(--color-border-light);
  padding: var(--spacing-sm);
}

.notesHeader {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--spacing-sm);
}

.noteItem {
  padding: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
  background: var(--color-bg-primary);
  border-radius: 4px;
}

.noteContent {
  font-size: var(--font-size-sm);
  line-height: 1.4;
  white-space: pre-wrap;
}

.noteMeta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--spacing-xs);
  font-size: 11px;
  color: var(--color-text-muted);
}

.noteInput {
  width: 100%;
  padding: var(--spacing-xs);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: var(--font-size-sm);
  resize: vertical;
  min-height: 40px;
  font-family: inherit;
}

.noteInput:focus {
  outline: none;
  border-color: var(--color-accent);
}
```

- [ ] **Step 2: Update AnnotationPanel props to include notes data**

In `src/components/AnnotationPanel.tsx`, update the props interface:

```tsx
interface AnnotationPanelProps {
  highlights: Highlight[];
  getCommentsForHighlight: (highlightId: string) => Comment[];
  resourceNotes: Comment[];
  activeHighlightId: string | null;
  onClickHighlight: (id: string) => void;
  onDeleteHighlight: (id: string) => void;
  onAddComment: (highlightId: string | null, content: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, content: string) => void;
}
```

Update the destructuring:

```tsx
export function AnnotationPanel({
  highlights,
  getCommentsForHighlight,
  resourceNotes,
  activeHighlightId,
  onClickHighlight,
  onDeleteHighlight,
  onAddComment,
  onDeleteComment,
  onEditComment,
}: AnnotationPanelProps) {
```

- [ ] **Step 3: Add notes section to AnnotationPanel render**

After the closing `</div>` of the `.list` div (after the highlights map), and before the closing `</div>` of the `.panel` div, add:

```tsx
      {/* Notes section */}
      <NotesSection
        notes={resourceNotes}
        onAdd={(content) => onAddComment(null, content)}
        onEdit={onEditComment}
        onDelete={onDeleteComment}
      />
```

- [ ] **Step 4: Create NotesSection component**

Add after the `HighlightEntry` component (before the end of the file):

```tsx
interface NotesSectionProps {
  notes: Comment[];
  onAdd: (content: string) => void;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
}

function NotesSection({ notes, onAdd, onEdit, onDelete }: NotesSectionProps) {
  const [noteText, setNoteText] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  function handleSubmit() {
    if (!noteText.trim()) return;
    onAdd(noteText.trim());
    setNoteText("");
  }

  return (
    <div className={styles.notesSection}>
      <div className={styles.notesHeader}>📝 笔记 ({notes.length})</div>

      {notes.map((note) => (
        <div key={note.id} className={styles.noteItem}>
          {editingNoteId === note.id ? (
            <div>
              <textarea
                className={styles.noteInput}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (editText.trim()) {
                      onEdit(note.id, editText.trim());
                      setEditingNoteId(null);
                    }
                  }
                  if (e.key === "Escape") setEditingNoteId(null);
                }}
              />
              <div className={styles.commentActions}>
                <button
                  className={styles.submitBtn}
                  onClick={() => {
                    if (editText.trim()) {
                      onEdit(note.id, editText.trim());
                      setEditingNoteId(null);
                    }
                  }}
                >
                  保存
                </button>
                <button className={styles.cancelBtn} onClick={() => setEditingNoteId(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={styles.noteContent}>{note.content}</div>
              <div className={styles.noteMeta}>
                <span>{new Date(note.created_at).toLocaleDateString()}</span>
                <span>
                  <button
                    className={styles.editBtn}
                    onClick={() => {
                      setEditingNoteId(note.id);
                      setEditText(note.content);
                    }}
                  >
                    编辑
                  </button>
                  <button className={styles.deleteBtn} onClick={() => onDelete(note.id)}>
                    删除
                  </button>
                </span>
              </div>
            </>
          )}
        </div>
      ))}

      {/* Add note input */}
      <div style={{ marginTop: notes.length > 0 ? "var(--spacing-xs)" : 0 }}>
        <textarea
          className={styles.noteInput}
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="添加笔记..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        {noteText.trim() && (
          <div className={styles.commentActions}>
            <button className={styles.submitBtn} onClick={handleSubmit}>
              保存
            </button>
            <button
              className={styles.cancelBtn}
              onClick={() => setNoteText("")}
            >
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Pass resourceNotes from ReaderView**

In `src/components/ReaderView.tsx`, add `resourceNotes` to the useAnnotations destructuring:

```tsx
  const {
    highlights,
    getCommentsForHighlight,
    resourceNotes,
    addHighlight,
    removeHighlight,
    addComment,
    removeComment,
    editComment,
  } = useAnnotations(resource.id);
```

Add the `resourceNotes` prop to AnnotationPanel:

```tsx
      <AnnotationPanel
        highlights={highlights}
        getCommentsForHighlight={getCommentsForHighlight}
        resourceNotes={resourceNotes}
        activeHighlightId={activeHighlightId}
        onClickHighlight={handlePanelClickHighlight}
        onDeleteHighlight={handleDeleteHighlight}
        onAddComment={(hlId, content) => addComment(hlId, content)}
        onDeleteComment={removeComment}
        onEditComment={editComment}
      />
```

- [ ] **Step 6: Verify compilation**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Run tests**

Run: `cd /Users/work/workspace/Shibei && npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/components/AnnotationPanel.tsx src/components/AnnotationPanel.module.css src/components/ReaderView.tsx
git commit -m "feat: add resource-level notes section in AnnotationPanel"
```

---

### Task 5: Delete confirmation with Modal

Replace all direct delete calls in AnnotationPanel with Modal confirmation dialogs. Show associated comment count when deleting a highlight.

**Files:**
- Modify: `src/components/AnnotationPanel.tsx`

- [ ] **Step 1: Add delete confirmation state and Modal to AnnotationPanel**

In `src/components/AnnotationPanel.tsx`, add the Modal import at the top:

```tsx
import { Modal } from "@/components/Modal";
```

Add a type and state inside the `AnnotationPanel` component function, before the `activeRef`:

```tsx
  type DeleteConfirm = {
    type: "highlight" | "comment" | "note";
    id: string;
    commentCount?: number;
  };
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null);
```

Add a helper to get confirmation message, and the confirm handler, after the state:

```tsx
  function getDeleteMessage(confirm: DeleteConfirm): string {
    switch (confirm.type) {
      case "highlight":
        return confirm.commentCount
          ? `确定删除此高亮标注？关联的 ${confirm.commentCount} 条评论也会一并删除。`
          : "确定删除此高亮标注？";
      case "comment":
        return "确定删除此评论？";
      case "note":
        return "确定删除此笔记？";
    }
  }

  function handleConfirmDelete() {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === "highlight") {
      onDeleteHighlight(deleteConfirm.id);
    } else {
      onDeleteComment(deleteConfirm.id);
    }
    setDeleteConfirm(null);
  }
```

- [ ] **Step 2: Pass setDeleteConfirm to HighlightEntry and NotesSection**

Update the HighlightEntry usage in the highlights map to pass a `onRequestDelete` callback instead of direct `onDelete`/`onDeleteComment`:

```tsx
          <HighlightEntry
            key={hl.id}
            highlight={hl}
            comments={getCommentsForHighlight(hl.id)}
            isActive={activeHighlightId === hl.id}
            ref={activeHighlightId === hl.id ? activeRef : null}
            onClick={() => onClickHighlight(hl.id)}
            onDelete={() =>
              setDeleteConfirm({
                type: "highlight",
                id: hl.id,
                commentCount: getCommentsForHighlight(hl.id).length,
              })
            }
            onAddComment={(content) => onAddComment(hl.id, content)}
            onDeleteComment={(id) => setDeleteConfirm({ type: "comment", id })}
            onEditComment={onEditComment}
          />
```

Update the NotesSection usage:

```tsx
      <NotesSection
        notes={resourceNotes}
        onAdd={(content) => onAddComment(null, content)}
        onEdit={onEditComment}
        onDelete={(id) => setDeleteConfirm({ type: "note", id })}
      />
```

- [ ] **Step 3: Add Modal render at the bottom of AnnotationPanel**

Add just before the final closing `</div>` of the `.panel` div:

```tsx
      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <Modal title="确认删除" onClose={() => setDeleteConfirm(null)}>
          <p style={{ marginBottom: "var(--spacing-lg)", fontSize: "var(--font-size-base)" }}>
            {getDeleteMessage(deleteConfirm)}
          </p>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", justifyContent: "flex-end" }}>
            <button
              onClick={() => setDeleteConfirm(null)}
              style={{
                padding: "6px 16px",
                borderRadius: "4px",
                fontSize: "var(--font-size-sm)",
                background: "var(--color-bg-tertiary)",
                cursor: "pointer",
              }}
            >
              取消
            </button>
            <button
              onClick={handleConfirmDelete}
              style={{
                padding: "6px 16px",
                borderRadius: "4px",
                fontSize: "var(--font-size-sm)",
                background: "var(--color-danger)",
                color: "white",
                cursor: "pointer",
              }}
            >
              删除
            </button>
          </div>
        </Modal>
      )}
```

- [ ] **Step 4: Verify compilation**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run tests**

Run: `cd /Users/work/workspace/Shibei && npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Manual verification**

Launch `cargo tauri dev`. Verify:
1. Click delete on a highlight → Modal shows "确定删除此高亮标注？关联的 N 条评论也会一并删除。"
2. Click delete on a comment → Modal shows "确定删除此评论？"
3. Click delete on a note → Modal shows "确定删除此笔记？"
4. Clicking "取消" closes Modal without deleting
5. Clicking "删除" performs the deletion
6. Pressing Escape closes the Modal

- [ ] **Step 7: Commit**

```bash
git add src/components/AnnotationPanel.tsx
git commit -m "feat: add delete confirmation Modal for highlights, comments, and notes"
```

---

### Task 6: Final integration test and cleanup

Verify all 4 features work together end-to-end.

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/work/workspace/Shibei && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run TypeScript check**

Run: `cd /Users/work/workspace/Shibei && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run Rust checks (ensure backend still compiles)**

Run: `cd /Users/work/workspace/Shibei && cargo check && cargo clippy`
Expected: No errors or warnings

- [ ] **Step 4: Full manual test**

Launch `cargo tauri dev` and verify the complete flow:

1. **Preview panel**: Click resource → metadata + highlights in right panel. Double-click → opens Tab.
2. **Highlight navigation**: Click highlight in preview → opens Tab and scrolls to it.
3. **Notes**: In reader Tab, scroll to bottom of AnnotationPanel → add a note → it appears. Edit it. Delete it (with confirmation).
4. **Comment editing**: Add a comment on a highlight → click edit → modify → save. Verify text updates.
5. **Delete confirmation**: Delete a highlight with comments → Modal mentions comment count. Cancel works. Confirm deletes.

- [ ] **Step 5: Update roadmap**

In `docs/superpowers/specs/2026-03-31-shibei-roadmap.md`, mark the 4 items as done:

```markdown
### 阅读与标注
- [x] **资料预览面板** — 资料库单击资料在右侧面板显示标注/评论，双击打开阅读器 Tab
- [x] **资料级笔记** — 不关联高亮的独立笔记（后端已支持 highlight_id=NULL），AnnotationPanel 增加笔记区域
- [x] **评论编辑** — 后端 `updateComment` 已有，前端加编辑按钮
- [x] **标注删除确认** — 高亮和评论删除加确认提示
```

- [ ] **Step 6: Commit roadmap update**

```bash
git add docs/superpowers/specs/2026-03-31-shibei-roadmap.md
git commit -m "docs: mark reading & annotation features as complete in roadmap"
```
