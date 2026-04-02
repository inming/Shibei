import { useEffect, useRef } from "react";
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
    <div ref={ref} className={styles.menu} style={{ top: y, left: x }} role="menu">
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
