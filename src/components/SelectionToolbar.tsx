import styles from "./SelectionToolbar.module.css";

const HIGHLIGHT_COLORS = [
  "#FFEB3B", // yellow
  "#81C784", // green
  "#64B5F6", // blue
  "#FF8A65", // orange
  "#CE93D8", // purple
];

interface SelectionToolbarProps {
  position: { top: number; left: number };
  onSelectColor: (color: string) => void;
}

export function SelectionToolbar({ position, onSelectColor }: SelectionToolbarProps) {
  return (
    <div
      className={styles.toolbar}
      style={{ top: position.top, left: position.left }}
    >
      {HIGHLIGHT_COLORS.map((color) => (
        <button
          key={color}
          className={styles.colorBtn}
          style={{ background: color }}
          onClick={() => onSelectColor(color)}
          title={color}
        />
      ))}
    </div>
  );
}
