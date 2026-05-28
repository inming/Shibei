import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import type { Question } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";
import type { QuestionFilter } from "@/lib/sessionState";
import { useQuestions } from "@/hooks/useQuestions";
import { QuestionEditDialog } from "@/components/Sidebar/QuestionEditDialog";
import { QuestionListItem } from "./QuestionListItem";
import { QuestionFilterChips } from "./QuestionFilterChips";
import styles from "./QuestionList.module.css";

interface QuestionListProps {
  filter: QuestionFilter;
  onFilterChange: (next: QuestionFilter) => void;
  selectedQuestionId: string | null;
  /** Single-click row → preview in third column. */
  onSelect: (question: Question) => void;
  /** Double-click row (or right-click "Open in tab") → open Question Tab. */
  onOpenInTab: (question: Question) => void;
  /**
   * Fired after a question is successfully created via the + button. The
   * parent (Layout) decides the side effect — typically: switch chip to
   * "active" + select the new question for preview. Importantly, this does
   * NOT open a Tab in the new design (use deep link if you want a Tab).
   */
  onCreate: (created: Question) => void;
  initialScrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_CHARS = 2;
const SCROLL_PERSIST_DEBOUNCE_MS = 300;

/**
 * Middle-column view that lists questions, replacing the old Sidebar
 * QuestionSection. Lays out like ResourceList: sticky header (search + create)
 * + sticky filter chip strip + flat scrollable list.
 *
 * The list is `chip ∩ search`:
 *   - chip filter picks the candidate set (active / archived / all)
 *   - search FTS (≥ 2 chars) returns matches across status; we intersect
 *     against the candidate set so the chip remains authoritative (see spec
 *     §"搜索行为详解 — Questions 模式")
 */
export function QuestionList({
  filter,
  onFilterChange,
  selectedQuestionId,
  onSelect,
  onOpenInTab,
  onCreate,
  initialScrollTop,
  onScrollTopChange,
}: QuestionListProps) {
  const { t } = useTranslation("question");
  const { active, archived, loading } = useQuestions();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchHits, setSearchHits] = useState<Question[]>([]);
  const [editorOpen, setEditorOpen] = useState<"create" | Question | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollAppliedRef = useRef(false);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  // Run FTS search when debouncedQuery >= MIN_SEARCH_CHARS, else clear.
  useEffect(() => {
    if (debouncedQuery.length < MIN_SEARCH_CHARS) {
      setSearchHits([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const hits = await cmd.searchQuestions(debouncedQuery);
        if (!cancelled) setSearchHits(hits);
      } catch (err) {
        console.error("searchQuestions failed:", err);
        if (!cancelled) setSearchHits([]);
      }
    })();
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  // Re-run search on QUESTION_CHANGED / SYNC_COMPLETED so chip counts and
  // search hits stay fresh without rebuilding the hook.
  useEffect(() => {
    if (debouncedQuery.length < MIN_SEARCH_CHARS) return;
    const u1 = listen(DataEvents.QUESTION_CHANGED, async () => {
      try {
        const hits = await cmd.searchQuestions(debouncedQuery);
        setSearchHits(hits);
      } catch { /* swallow */ }
    });
    const u2 = listen(DataEvents.SYNC_COMPLETED, async () => {
      try {
        const hits = await cmd.searchQuestions(debouncedQuery);
        setSearchHits(hits);
      } catch { /* swallow */ }
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [debouncedQuery]);

  // Build the displayed list: filter chip ∩ (search hits or all-in-chip).
  const displayed = useMemo<Question[]>(() => {
    const candidates = (() => {
      if (filter === "active") return active;
      if (filter === "archived") return archived;
      // "all": active first (more relevant), archived after
      return [...active, ...archived];
    })();
    if (debouncedQuery.length < MIN_SEARCH_CHARS) return candidates;
    const allowed = new Set(candidates.map((q) => q.id));
    return searchHits.filter((q) => allowed.has(q.id));
  }, [filter, active, archived, debouncedQuery, searchHits]);

  const counts = useMemo(
    () => ({ active: active.length, archived: archived.length, all: active.length + archived.length }),
    [active, archived],
  );

  // Restore scroll position once on mount (after the first render where the
  // list has produced its layout).
  useEffect(() => {
    if (initialScrollAppliedRef.current) return;
    if (!scrollRef.current) return;
    if (typeof initialScrollTop !== "number") return;
    initialScrollAppliedRef.current = true;
    scrollRef.current.scrollTop = initialScrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialScrollTop, displayed.length]);

  const handleScroll = useCallback(() => {
    if (!onScrollTopChange) return;
    if (!scrollRef.current) return;
    const top = scrollRef.current.scrollTop;
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    scrollDebounceRef.current = setTimeout(() => {
      onScrollTopChange(top);
    }, SCROLL_PERSIST_DEBOUNCE_MS);
  }, [onScrollTopChange]);

  useEffect(() => {
    return () => {
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    };
  }, []);

  const handleEdit = useCallback((q: Question) => setEditorOpen(q), []);
  const openCreate = useCallback(() => setEditorOpen("create"), []);
  const closeEditor = useCallback(() => setEditorOpen(null), []);

  const isSearching = debouncedQuery.length >= MIN_SEARCH_CHARS;
  const emptyMessage = isSearching ? t("list.emptySearch") : t("list.emptyAll");

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder={t("list.searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button
          type="button"
          className={styles.createBtn}
          onClick={openCreate}
          title={t("list.createButton")}
        >
          +
        </button>
      </div>

      <QuestionFilterChips value={filter} counts={counts} onChange={onFilterChange} />

      <div ref={scrollRef} className={styles.listScroll} onScroll={handleScroll}>
        {displayed.length === 0 ? (
          <div className={styles.empty}>{loading && !isSearching ? "" : emptyMessage}</div>
        ) : (
          displayed.map((q) => (
            <QuestionListItem
              key={q.id}
              question={q}
              selected={q.id === selectedQuestionId}
              onClick={onSelect}
              onDoubleClick={onOpenInTab}
              onOpenInTab={onOpenInTab}
              onEdit={handleEdit}
            />
          ))
        )}
      </div>

      {editorOpen !== null && (
        <QuestionEditDialog
          question={editorOpen === "create" ? null : editorOpen}
          onClose={closeEditor}
          onCreated={(q) => onCreate(q)}
        />
      )}
    </div>
  );
}
