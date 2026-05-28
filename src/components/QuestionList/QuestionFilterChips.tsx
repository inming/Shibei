import { useTranslation } from "react-i18next";
import type { QuestionFilter } from "@/lib/sessionState";
import styles from "./QuestionFilterChips.module.css";

interface QuestionFilterChipsProps {
  value: QuestionFilter;
  counts: { active: number; archived: number; all: number };
  onChange: (next: QuestionFilter) => void;
}

const OPTIONS: { value: QuestionFilter; labelKey: "filter.active" | "filter.archived" | "filter.all" }[] = [
  { value: "active", labelKey: "filter.active" },
  { value: "archived", labelKey: "filter.archived" },
  { value: "all", labelKey: "filter.all" },
];

/**
 * Single-select radio-like chip row that sits above the question list and
 * filters it by status. Mirrors the visual weight of ResourceList's tag
 * filter chips so the two list modes feel like the same shape.
 */
export function QuestionFilterChips({ value, counts, onChange }: QuestionFilterChipsProps) {
  const { t } = useTranslation("question");
  return (
    <div className={styles.row} role="radiogroup">
      {OPTIONS.map((opt) => {
        const selected = opt.value === value;
        const count = counts[opt.value];
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`${styles.chip} ${selected ? styles.chipSelected : ""}`}
            onClick={() => onChange(opt.value)}
          >
            <span className={styles.label}>{t(opt.labelKey)}</span>
            <span className={styles.count}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
