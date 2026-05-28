import { useTranslation } from "react-i18next";
import { useQuestions } from "@/hooks/useQuestions";
import styles from "./QuestionEntry.module.css";

interface QuestionEntryProps {
  /** True when `libraryMode === "questions"` — drives the selected look. */
  active: boolean;
  onClick: () => void;
}

/**
 * Single-row Sidebar entry that takes the user into question-mode (middle
 * column swaps to <QuestionList>). Replaces the v1 <QuestionSection> which
 * inlined the entire question list inside the Sidebar.
 *
 * Visual weight mirrors <FolderTree> folder rows + the trash button so the
 * three navigation surfaces feel like peers.
 */
export function QuestionEntry({ active, onClick }: QuestionEntryProps) {
  const { t } = useTranslation("sidebar");
  const { active: activeQs } = useQuestions();

  return (
    <button
      type="button"
      className={`${styles.entry} ${active ? styles.entryActive : ""}`}
      onClick={onClick}
      title={t("questionsEntry")}
    >
      <span className={styles.icon}>❓</span>
      <span className={styles.label}>{t("questionsEntry")}</span>
      <span className={styles.count}>{activeQs.length}</span>
    </button>
  );
}
