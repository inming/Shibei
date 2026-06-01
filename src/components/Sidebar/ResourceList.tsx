import React, { useState, useCallback, useRef, useEffect } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { useResources } from "@/hooks/useResources";
import * as cmd from "@/lib/commands";
import type { Resource, Tag, Question } from "@/types";
import { ALL_RESOURCES_ID } from "@/types";
import { listen } from "@tauri-apps/api/event";
import { DataEvents } from "@/lib/events";
import { ResourceListSkeleton } from "@/components/Skeleton";
import { Modal } from "@/components/Modal";
import { ResourceContextMenu } from "@/components/Sidebar/ResourceContextMenu";
import { ResourceEditDialog } from "@/components/Sidebar/ResourceEditDialog";
import { ContextMenu } from "@/components/ContextMenu";
import { importFileToFolder } from "@/lib/importFile";
import { buildFolderDeepLink } from "@/lib/deepLink";
import { FilterChips } from "@/components/Sidebar/FilterChips";
import toast from "react-hot-toast";
import styles from "./ResourceList.module.css";

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={styles.highlight}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

interface ResourceListProps {
  folderId: string | null;
  selectedResourceIds: Set<string>;
  filterTagIds: string[];
  onFilterTagsChange: (ids: string[]) => void;
  sortBy: "created_at" | "annotated_at" | "content_time";
  sortOrder: "asc" | "desc";
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectResource: (resource: Resource, resources: Resource[], event: { metaKey: boolean; shiftKey: boolean }) => void;
  onOpen: (resource: Resource) => void;
  /** Open a question in a Tab (double-click on the chip, deep-link parity). */
  onOpenQuestion?: (question: Question) => void;
  /** Single-click on the chip: switch to questions mode + select for preview. */
  onSelectQuestion?: (question: Question) => void;
  onSortByChange: (sortBy: "created_at" | "annotated_at" | "content_time") => void;
  onSortOrderChange: (sortOrder: "asc" | "desc") => void;
  initialScrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
}

function DraggableResourceItem({ resource, isSelected, searchQuery, snippet, matchFields, tags, highlightCount, displayDate, onClick, onDoubleClick, onContextMenu }: {
  resource: Resource;
  isSelected: boolean;
  searchQuery: string;
  snippet: string | null;
  matchFields: string[];
  tags: Tag[];
  highlightCount: number;
  /** Pre-formatted date shown in the meta row (reflects the active sort). */
  displayDate: string;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation('sidebar');
  const { t: tSearch } = useTranslation('search');
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: resource.id,
    data: { type: "resource", title: resource.title },
  });

  return (
    <div
      ref={setNodeRef}
      className={`${styles.item} ${isSelected ? styles.itemSelected : ""}`}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="option"
      aria-selected={isSelected}
    >
      <div className={styles.itemTitle}>
        {resource.selection_meta && <span className={styles.clipBadge} title={t('clipBadgeTitle')}>&#9986;</span>}
        {searchQuery.length >= 2 ? highlightMatch(resource.title, searchQuery) : resource.title}
      </div>
      {matchFields.length > 0 && (
        <div className={styles.matchTags}>
          {matchFields.includes('body') && <span className={styles.matchTag}>{tSearch('bodyMatch')}</span>}
          {matchFields.includes('highlights') && <span className={styles.matchTag}>{tSearch('highlightsMatch')}</span>}
          {matchFields.includes('comments') && <span className={styles.matchTag}>{tSearch('commentsMatch')}</span>}
        </div>
      )}
      {snippet && (
        <div className={styles.snippet}>
          {highlightMatch(snippet, searchQuery)}
        </div>
      )}
      <div className={styles.itemMeta}>
        <span className={styles.metaLeft}>
          {tags.slice(0, 3).map(tag => (
            <span key={tag.id} className={styles.tagDot} style={{ backgroundColor: tag.color }} />
          ))}
          {(() => { let host = resource.domain; if (!host) { try { host = new URL(resource.url).hostname; } catch { host = resource.url; } } return searchQuery.length >= 2 ? highlightMatch(host, searchQuery) : host; })()}
        </span>
        <span className={styles.metaRight}>
          {highlightCount > 0 && (
            <span className={styles.annotationCount}>{highlightCount}</span>
          )}
          {displayDate}
        </span>
      </div>
    </div>
  );
}

export function ResourceList({ folderId, selectedResourceIds, filterTagIds, onFilterTagsChange, sortBy, sortOrder, searchQuery, onSearchChange, onSelectResource, onOpen, onOpenQuestion, onSelectQuestion, onSortByChange, onSortOrderChange, initialScrollTop, onScrollTopChange }: ResourceListProps) {
  const { t } = useTranslation('sidebar');
  const { t: tSearch } = useTranslation('search');
  const { t: tReader } = useTranslation('reader');
  const { t: tQuestion } = useTranslation('question');
  const [inputValue, setInputValue] = useState(searchQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const composingRef = useRef(false);

  const { resources, resourceTags, annotationCounts, snippetMap, matchFieldsMap, loading } = useResources(
    folderId,
    sortBy,
    sortOrder,
    searchQuery,
    filterTagIds,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const didRestoreScrollRef = useRef(false);
  const scrollPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore list scroll position once, after the first batch of resources renders.
  useEffect(() => {
    if (didRestoreScrollRef.current) return;
    if (loading) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    if (typeof initialScrollTop === "number" && initialScrollTop > 0) {
      el.scrollTop = initialScrollTop;
    }
    didRestoreScrollRef.current = true;
  }, [loading, initialScrollTop]);

  // Persist scroll position as the user scrolls (debounced 300ms).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !onScrollTopChange) return;
    const onScroll = () => {
      if (scrollPersistTimerRef.current) clearTimeout(scrollPersistTimerRef.current);
      const top = el.scrollTop;
      scrollPersistTimerRef.current = setTimeout(() => {
        onScrollTopChange(top);
      }, 300);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (scrollPersistTimerRef.current) clearTimeout(scrollPersistTimerRef.current);
    };
  }, [onScrollTopChange]);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [contextResourceIds, setContextResourceIds] = useState<string[]>([]);
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null);
  const [editingResource, setEditingResource] = useState<Resource | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const filteredResources = resources;

  const MIN_SEARCH_CHARS = 2;

  // Sibling search: questions matching the same query. Surfaces above the
  // resource list as a chip row so users can pivot to a question without
  // leaving the search context.
  const [matchedQuestions, setMatchedQuestions] = useState<Question[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (searchQuery.length < MIN_SEARCH_CHARS) {
      setMatchedQuestions([]);
      return;
    }
    cmd.searchQuestions(searchQuery)
      .then((qs) => { if (!cancelled) setMatchedQuestions(qs); })
      .catch(() => { if (!cancelled) setMatchedQuestions([]); });
    return () => { cancelled = true; };
  }, [searchQuery]);

  // Refresh question chips when questions mutate while the query is active.
  useEffect(() => {
    if (searchQuery.length < MIN_SEARCH_CHARS) return;
    const refresh = () => {
      cmd.searchQuestions(searchQuery).then(setMatchedQuestions).catch(() => {});
    };
    const u1 = listen(DataEvents.QUESTION_CHANGED, refresh);
    const u2 = listen(DataEvents.SYNC_COMPLETED, refresh);
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
    };
  }, [searchQuery]);

  function handleSearchInput(value: string) {
    setInputValue(value);
    // Don't trigger search while IME is composing
    if (composingRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.length >= MIN_SEARCH_CHARS || value.length === 0) {
      debounceRef.current = setTimeout(() => {
        onSearchChange(value);
      }, 300);
    } else if (searchQuery.length >= MIN_SEARCH_CHARS) {
      onSearchChange("");
    }
  }

  function handleCompositionEnd(e: React.CompositionEvent<HTMLInputElement>) {
    composingRef.current = false;
    // Trigger search with the committed text
    handleSearchInput(e.currentTarget.value);
  }

  useEffect(() => {
    // Only sync external resets (X button already handles both directly).
    // Don't override user's typed input when search clears due to threshold.
    if (searchQuery !== "" ) {
      setInputValue(searchQuery);
    }
  }, [searchQuery]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function handleContextMenu(e: React.MouseEvent, resource: Resource) {
    e.preventDefault();
    e.stopPropagation();

    // If right-clicked item is not in selection, single-select it
    if (!selectedResourceIds.has(resource.id)) {
      onSelectResource(resource, filteredResources, { metaKey: false, shiftKey: false });
      setContextResourceIds([resource.id]);
    } else {
      setContextResourceIds(Array.from(selectedResourceIds));
    }

    setContextMenu({ x: e.clientX, y: e.clientY });
  }

  const handleDelete = useCallback(async () => {
    setDeleteConfirm(false);
    setContextMenu(null);
    try {
      for (const id of contextResourceIds) {
        await cmd.deleteResource(id);
      }
    } catch (err: unknown) {
      toast.error(t('deleteFailed_resource', { message: err instanceof Error ? err.message : String(err) }));
    }
  }, [contextResourceIds]);

  const handleMove = useCallback(async (targetFolderId: string) => {
    setContextMenu(null);
    try {
      for (const id of contextResourceIds) {
        await cmd.moveResource(id, targetFolderId);
      }
    } catch (err: unknown) {
      toast.error(t('moveFailed', { message: err instanceof Error ? err.message : String(err) }));
    }
  }, [contextResourceIds]);

  const handleEdit = useCallback(() => {
    if (contextResourceIds.length !== 1) return;
    const resource = resources.find((r) => r.id === contextResourceIds[0]);
    if (resource) {
      setEditingResource(resource);
    }
    setContextMenu(null);
  }, [contextResourceIds, resources]);

  const isSingleSelect = contextResourceIds.length === 1;

  const isRealFolder = folderId !== null && folderId !== ALL_RESOURCES_ID;

  function copyCurrentFolderLink() {
    if (!folderId) return;
    navigator.clipboard.writeText(buildFolderDeepLink(folderId));
    toast.success(t('contextLinkCopied'));
  }

  function handleListContextMenu(e: React.MouseEvent) {
    if (!folderId) return;
    // Resource items' onContextMenu calls stopPropagation (see handleContextMenu above),
    // so this handler only fires when right-clicking empty area or the emptyState placeholder.
    e.preventDefault();
    setEmptyMenu({ x: e.clientX, y: e.clientY });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (filteredResources.length === 0) return;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Find the last selected resource index
      let currentIndex = -1;
      for (let i = filteredResources.length - 1; i >= 0; i--) {
        if (selectedResourceIds.has(filteredResources[i].id)) {
          currentIndex = i;
          break;
        }
      }

      let nextIndex: number;
      if (e.key === "ArrowDown") {
        nextIndex = currentIndex < filteredResources.length - 1 ? currentIndex + 1 : currentIndex;
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : 0;
      }

      onSelectResource(filteredResources[nextIndex], filteredResources, { metaKey: false, shiftKey: false });
    } else if (e.key === "Enter") {
      // Open the last selected resource
      for (let i = filteredResources.length - 1; i >= 0; i--) {
        if (selectedResourceIds.has(filteredResources[i].id)) {
          onOpen(filteredResources[i]);
          break;
        }
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedResourceIds.size > 0) {
        setContextResourceIds(Array.from(selectedResourceIds));
        setDeleteConfirm(true);
      }
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.searchBox}>
        <span className={styles.searchIcon}>&#128269;</span>
        <input
          className={styles.searchInput}
          type="text"
          placeholder={tSearch('placeholder')}
          value={inputValue}
          onChange={(e) => handleSearchInput(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={handleCompositionEnd}
        />
        {inputValue && (
          <button
            className={styles.searchClear}
            onClick={() => {
              setInputValue("");
              onSearchChange("");
            }}
            aria-label={tSearch('clearSearch')}
          >
            &#10005;
          </button>
        )}
      </div>
      <FilterChips
        folderId={folderId === ALL_RESOURCES_ID ? null : folderId}
        filterTagIds={filterTagIds}
        onChange={onFilterTagsChange}
      />
      <div className={styles.header}>
        <span className={styles.title}>
          {t('resources')}
          {selectedResourceIds.size > 1 && (
            <span className={styles.selectionCount}>{t('selectedCount', { count: selectedResourceIds.size })}</span>
          )}
        </span>
        <div className={styles.sortControls}>
          <select
            className={styles.sortSelect}
            value={sortBy}
            onChange={(e) => onSortByChange(e.target.value as "created_at" | "annotated_at" | "content_time")}
          >
            <option value="created_at">{t('sortByCreatedAt')}</option>
            <option value="content_time">{t('sortByContentTime')}</option>
            <option value="annotated_at">{t('sortByAnnotatedAt')}</option>
          </select>
          <button
            className={styles.sortOrderBtn}
            onClick={() => onSortOrderChange(sortOrder === "desc" ? "asc" : "desc")}
            title={sortOrder === "desc" ? t('sortDesc') : t('sortAsc')}
          >
            {sortOrder === "desc" ? "↓" : "↑"}
          </button>
        </div>
      </div>
      <div ref={scrollContainerRef} className={styles.listScroll} onContextMenu={handleListContextMenu}>
        {searchQuery.length >= MIN_SEARCH_CHARS && matchedQuestions.length > 0 && (onOpenQuestion || onSelectQuestion) && (
          <div className={styles.matchedQuestionsBar}>
            <span className={styles.matchedQuestionsLabel}>
              {tSearch('matchedQuestions', { defaultValue: '问题' })}:
            </span>
            <div className={styles.matchedQuestionsChips}>
              {matchedQuestions.map((q) => (
                <button
                  key={q.id}
                  className={`${styles.matchedQuestionChip} ${q.status === 'archived' ? styles.matchedQuestionChipArchived : ''}`}
                  // Single click → switch to questions mode + select for preview.
                  // Double click → open Tab (deep-link parity).
                  // Tooltip explains the affordance to discover the dual interaction.
                  onClick={() => {
                    if (onSelectQuestion) onSelectQuestion(q);
                    else if (onOpenQuestion) onOpenQuestion(q);
                  }}
                  onDoubleClick={() => onOpenQuestion?.(q)}
                  title={tQuestion('chipHint')}
                >
                  <span className={styles.matchedQuestionDot} />
                  <span>{q.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!folderId && (
          <div className={styles.empty}>{t('selectFolderHint')}</div>
        )}
        {loading && <ResourceListSkeleton />}
        {folderId && !loading && filteredResources.length === 0 && (
          <div className={styles.emptyState}>
            {searchQuery.length >= MIN_SEARCH_CHARS ? (
              <>
                <div className={styles.emptyTitle}>{t('noSearchResults')}</div>
                <div className={styles.emptyHint}>{t('noSearchResultsHint')}</div>
              </>
            ) : (
              <>
                <div className={styles.emptyTitle}>{t('emptyFolder')}</div>
                <div className={styles.emptyHint}>{t('emptyFolderHint')}</div>
              </>
            )}
          </div>
        )}
        <div
          ref={listRef}
          tabIndex={0}
          role="listbox"
          aria-label={t('resourceList')}
          onKeyDown={handleKeyDown}
        >
          {filteredResources.map((resource) => (
            <DraggableResourceItem
              key={resource.id}
              resource={resource}
              isSelected={selectedResourceIds.has(resource.id)}
              searchQuery={searchQuery}
              snippet={snippetMap[resource.id] ?? null}
              matchFields={matchFieldsMap[resource.id] ?? []}
              tags={resourceTags[resource.id] ?? []}
              highlightCount={annotationCounts[resource.id]?.highlights ?? 0}
              displayDate={
                sortBy === "content_time" && resource.content_time
                  ? new Date(`${resource.content_time}T00:00:00`).toLocaleDateString()
                  : new Date(resource.created_at).toLocaleDateString()
              }
              onClick={(e) => onSelectResource(resource, filteredResources, { metaKey: e.metaKey, shiftKey: e.shiftKey })}
              onDoubleClick={() => onOpen(resource)}
              onContextMenu={(e) => handleContextMenu(e, resource)}
            />
          ))}
        </div>
      </div>

      {emptyMenu && folderId && (
        <ContextMenu
          x={emptyMenu.x}
          y={emptyMenu.y}
          items={[
            ...(isRealFolder ? [{
              label: tReader("importFile"),
              onClick: () => importFileToFolder(folderId),
            }] : []),
            {
              label: t('contextCopyLink'),
              onClick: copyCurrentFolderLink,
            },
          ]}
          onClose={() => setEmptyMenu(null)}
        />
      )}

      {contextMenu && folderId && (
        <ResourceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          resourceIds={contextResourceIds}
          currentFolderId={folderId}
          isSingleSelect={isSingleSelect}
          onEdit={handleEdit}
          onDelete={() => {
            setContextMenu(null);
            setDeleteConfirm(true);
          }}
          onMove={handleMove}
          onTagsChanged={() => {}}
          onClose={() => setContextMenu(null)}
        />
      )}

      {editingResource && (
        <ResourceEditDialog
          resource={editingResource}
          onSave={() => {}}
          onClose={() => setEditingResource(null)}
        />
      )}

      {deleteConfirm && (
        <Modal title={t('confirmDelete')} onClose={() => setDeleteConfirm(false)}>
          <p>
            {isSingleSelect
              ? t('deleteResourceConfirm')
              : t('deleteResourcesConfirm', { count: contextResourceIds.length })}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button
              style={{
                padding: "6px 14px",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                background: "none",
                color: "var(--color-text-primary)",
                fontSize: "var(--font-size-sm)",
                cursor: "pointer",
              }}
              onClick={() => setDeleteConfirm(false)}
            >
              {t('cancel', { ns: 'common' })}
            </button>
            <button
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: 4,
                background: "var(--color-danger)",
                color: "white",
                fontSize: "var(--font-size-sm)",
                cursor: "pointer",
              }}
              onClick={handleDelete}
            >
              {t('delete', { ns: 'common' })}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
