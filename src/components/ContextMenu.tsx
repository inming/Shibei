import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./ContextMenu.module.css";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const MARGIN = 4;
    let left = x;
    let top = y;
    if (top + rect.height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
    }
    if (left + rect.width > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
    }
    setAdjustedPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={styles.menu} style={{ top: adjustedPos.top, left: adjustedPos.left }} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          className={`${styles.menuItem} ${item.danger ? styles.danger : ""}`}
          role="menuitem"
          onClick={() => {
            const action = item.onClick;
            onClose();
            setTimeout(action, 0);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
