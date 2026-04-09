import { useEffect, useRef } from "react";
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

  if (!highlight) return null;

  return (
    <div ref={ref} className={styles.menu} style={{ top: position.top, left: position.left }}>
      <div className={styles.colorRow}>
        <span className={styles.rowLabel} title="浅色页面">☀︎</span>
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
        <span className={styles.rowLabel} title="深色页面">☾</span>
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
          toast.success("链接已复制");
          onClose();
        }}
      >
        复制链接
      </button>
      <button className={`${styles.item} ${styles.danger}`} onClick={onDelete}>
        删除标注
      </button>
    </div>
  );
}
