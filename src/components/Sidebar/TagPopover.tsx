import { useState, useEffect, useRef } from "react";
import styles from "./TagPopover.module.css";

const PRESET_COLORS = [
  "#EF4444",
  "#F97316",
  "#EAB308",
  "#22C55E",
  "#14B8A6",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
];

interface TagPopoverProps {
  initialName?: string;
  initialColor?: string;
  position: { x: number; y: number };
  onSave: (name: string, color: string) => void;
  onClose: () => void;
}

export function TagPopover({
  initialName = "",
  initialColor = PRESET_COLORS[5],
  position,
  onSave,
  onClose,
}: TagPopoverProps) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const trimmedName = name.trim();

  return (
    <div
      ref={ref}
      className={styles.popover}
      style={{ top: position.y, left: position.x }}
    >
      <input
        ref={inputRef}
        className={styles.nameInput}
        type="text"
        placeholder="标签名称"
        maxLength={30}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && trimmedName) {
            onSave(trimmedName, color);
          }
        }}
      />
      <div className={styles.colorGrid}>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            className={`${styles.colorDot} ${c === color ? styles.selected : ""}`}
            style={{ backgroundColor: c }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className={styles.actions}>
        <button className={styles.cancelBtn} onClick={onClose}>
          取消
        </button>
        <button
          className={styles.saveBtn}
          disabled={!trimmedName}
          onClick={() => onSave(trimmedName, color)}
        >
          保存
        </button>
      </div>
    </div>
  );
}
