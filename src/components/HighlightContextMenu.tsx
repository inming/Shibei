import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import type { Highlight } from "@/types";
import { LIGHT_COLORS, DARK_COLORS } from "@/components/SelectionToolbar";
import styles from "./HighlightContextMenu.module.css";

interface HighlightContextMenuProps {
  position: { top: number; left: number };
  highlight: Highlight | null;
  resourceId: string;
  onChangeColor: (color: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function HighlightContextMenu({
  position,
  highlight,
  resourceId,
  onChangeColor,
  onDelete,
  onClose,
}: HighlightContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const { t } = useTranslation('annotation');

  if (!highlight) return null;

  return (
    <div ref={ref} className={styles.menu} style={{ top: position.top, left: position.left }}>
      <div className={styles.colorRow}>
        <span className={styles.rowLabel} title={t('lightPage')}>☀︎</span>
        {LIGHT_COLORS.map((c) => (
          <button
            key={c}
            className={`${styles.colorBtn} ${c === highlight.color ? styles.colorBtnActive : ""}`}
            style={{ background: c }}
            onClick={() => onChangeColor(c)}
          />
        ))}
      </div>
      <div className={styles.colorRow}>
        <span className={styles.rowLabel} title={t('darkPage')}>☾</span>
        {DARK_COLORS.map((c) => (
          <button
            key={c}
            className={`${styles.colorBtn} ${c === highlight.color ? styles.colorBtnActive : ""}`}
            style={{ background: c }}
            onClick={() => onChangeColor(c)}
          />
        ))}
      </div>
      <div className={styles.separator} />
      <button
        className={styles.item}
        onClick={() => {
          navigator.clipboard.writeText(
            `shibei://open/resource/${resourceId}?highlight=${highlight.id}`
          );
          toast.success(t('linkCopied'));
          onClose();
        }}
      >
        {t('copyLink')}
      </button>
      <button className={`${styles.item} ${styles.danger}`} onClick={onDelete}>
        {t('deleteAnnotation')}
      </button>
    </div>
  );
}
