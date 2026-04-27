import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as cmd from "@/lib/commands";
import type { TagWithCount } from "@/types";
import { useFlipPosition } from "@/hooks/useFlipPosition";
import styles from "./FilterChips.module.css";

interface FilterChipsProps {
  folderId: string | null;
  filterTagIds: string[];
  onChange: (ids: string[]) => void;
}

export function FilterChips({ folderId, filterTagIds, onChange }: FilterChipsProps) {
  const { t } = useTranslation("sidebar");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [allTags, setAllTags] = useState<TagWithCount[]>([]);
  const [searchText, setSearchText] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useFlipPosition(popoverRef, 0, 0); // position is set via CSS relative to button

  const loadTags = useCallback(async () => {
    try {
      const tags = await cmd.listTagsInFolder(folderId);
      setAllTags(tags);
    } catch {
      setAllTags([]);
    }
  }, [folderId]);

  useEffect(() => {
    if (popoverOpen) {
      loadTags();
      setSearchText("");
    }
  }, [popoverOpen, loadTags]);

  // Click outside + Escape to close popover
  useEffect(() => {
    if (!popoverOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopoverOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [popoverOpen]);

  const toggleTag = useCallback((tagId: string) => {
    if (filterTagIds.includes(tagId)) {
      onChange(filterTagIds.filter((id) => id !== tagId));
    } else {
      onChange([...filterTagIds, tagId]);
    }
  }, [filterTagIds, onChange]);

  const filteredTags = searchText
    ? allTags.filter(
        (t) => t.name.toLowerCase().includes(searchText.toLowerCase()),
      )
    : allTags;

  const selectedTags = allTags.filter((t) => filterTagIds.includes(t.id));

  return (
    <div className={styles.filterBar}>
      <button
        ref={buttonRef}
        className={styles.filterBtn}
        onClick={() => setPopoverOpen(!popoverOpen)}
        title={t("filterTags")}
      >
        <span className={styles.filterIcon}>&#127991;</span>
        <span>+</span>
      </button>

      {selectedTags.length > 0 && (
        <div className={styles.chips}>
          {selectedTags.map((tag) => (
            <span key={tag.id} className={styles.chip}>
              <span
                className={styles.chipDot}
                style={{ backgroundColor: tag.color }}
              />
              <span className={styles.chipName}>{tag.name}</span>
              <button
                className={styles.chipRemove}
                onClick={() => toggleTag(tag.id)}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}

      {popoverOpen && (
        <div
          ref={popoverRef}
          className={styles.popover}
          style={{
            position: "fixed",
            top: (buttonRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
            left: buttonRef.current?.getBoundingClientRect().left ?? 0,
          }}
        >
          {allTags.length > 8 && (
            <input
              className={styles.searchInput}
              type="text"
              placeholder={t("searchTags")}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              autoFocus
            />
          )}
          <div className={styles.tagList}>
            {filteredTags.map((tag) => (
              <button
                key={tag.id}
                className={`${styles.tagItem} ${
                  filterTagIds.includes(tag.id) ? styles.tagSelected : ""
                }`}
                onClick={() => toggleTag(tag.id)}
              >
                <span
                  className={styles.tagDot}
                  style={{ backgroundColor: tag.color }}
                />
                <span className={styles.tagName}>{tag.name}</span>
                <span className={styles.tagCount}>{tag.count}</span>
              </button>
            ))}
            {filteredTags.length === 0 && (
              <div className={styles.empty}>{t("noTags")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
