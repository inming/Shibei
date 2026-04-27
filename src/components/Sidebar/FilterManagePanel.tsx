import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as cmd from "@/lib/commands";
import type { Tag } from "@/types";
import { useFlipPosition } from "@/hooks/useFlipPosition";
import styles from "./FilterChips.module.css";

interface ManagePanelProps {
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  onRefresh?: () => void;
}

export function FilterManagePanel({ onClose, anchorRef, onRefresh }: ManagePanelProps) {
  const { t } = useTranslation("sidebar");
  const [tags, setTags] = useState<Tag[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useFlipPosition(ref, 0, 0);

  const loadTags = useCallback(async () => {
    try { setTags(await cmd.listTags()); } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadTags(); }, [loadTags]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(t("deleteTagConfirm", { name }))) return;
    try { await cmd.deleteTag(id); loadTags(); onRefresh?.(); } catch { /* toast via event */ }
  };

  const handleCreate = async () => {
    const name = prompt(t("tagNamePlaceholder"));
    if (!name || !name.trim()) return;
    try {
      await cmd.createTag(name.trim(), "#888888");
      loadTags();
      onRefresh?.();
    } catch { /* toast via event */ }
  };

  return (
    <div
      ref={ref}
      className={styles.managePanel}
      style={{
        position: "fixed",
        top: (anchorRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
        right: (anchorRef.current?.getBoundingClientRect().right ?? 0),
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.manageList}>
        {tags.length === 0 && (
          <div className={styles.manageEmpty}>{t("noTags")}</div>
        )}
        {tags.map((tag) => (
          <div key={tag.id} className={styles.manageItem}>
            <span className={styles.manageDot} style={{ backgroundColor: tag.color }} />
            <span className={styles.manageName}>{tag.name}</span>
            <button
              className={styles.manageActionBtn}
              title={t("deleteTag")}
              onClick={() => handleDelete(tag.id, tag.name)}
            >
              &#10005;
            </button>
          </div>
        ))}
      </div>
      <button className={styles.manageCreateBtn} onClick={handleCreate}>
        + {t("newTag")}
      </button>
    </div>
  );
}
