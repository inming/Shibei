import styles from "./SelectionToolbar.module.css";

const LIGHT_COLORS = [
  "#FFEB3B", // yellow
  "#81C784", // green
  "#64B5F6", // blue
  "#FF8A65", // orange
  "#CE93D8", // purple
];

const DARK_COLORS = [
  "#F9A825", // dark yellow
  "#388E3C", // dark green
  "#1565C0", // dark blue
  "#D84315", // dark orange
  "#7B1FA2", // dark purple
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
      <div className={styles.row}>
        <span className={styles.rowLabel} title="浅色页面">☀︎</span>
        {LIGHT_COLORS.map((color) => (
          <button
            key={color}
            className={styles.colorBtn}
            style={{ background: color }}
            onClick={() => onSelectColor(color)}
            title={color}
          />
        ))}
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel} title="深色页面">☾</span>
        {DARK_COLORS.map((color) => (
          <button
            key={color}
            className={styles.colorBtn}
            style={{ background: color }}
            onClick={() => onSelectColor(color)}
            title={color}
          />
        ))}
      </div>
    </div>
  );
}

export { LIGHT_COLORS, DARK_COLORS };
