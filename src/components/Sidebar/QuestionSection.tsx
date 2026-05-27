import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Question } from "@/types";
import { useQuestions } from "@/hooks/useQuestions";
import { QuestionItem } from "@/components/Sidebar/QuestionItem";
import { QuestionEditDialog } from "@/components/Sidebar/QuestionEditDialog";
import styles from "./QuestionSection.module.css";

interface QuestionSectionProps {
  onOpenQuestion: (question: Question) => void;
}

export function QuestionSection({ onOpenQuestion }: QuestionSectionProps) {
  const { t } = useTranslation("question");
  const { active, archived, loading } = useQuestions();
  const [activeOpen, setActiveOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState<"create" | Question | null>(null);

  const openCreate = useCallback(() => setEditorOpen("create"), []);
  const closeEditor = useCallback(() => setEditorOpen(null), []);

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <span className={styles.headerLeft}>{t("sectionTitle")}</span>
        <button className={styles.addBtn} onClick={openCreate} title={t("createQuestion")}>
          +
        </button>
      </div>

      <div className={styles.group}>
        <button className={styles.groupHeader} onClick={() => setActiveOpen((v) => !v)}>
          <span className={`${styles.caret} ${activeOpen ? styles.caretOpen : ""}`}>›</span>
          <span>{t("active")} ({active.length})</span>
        </button>
        {activeOpen && (
          <div className={styles.list}>
            {active.length === 0 ? (
              <div className={styles.empty}>{loading ? "" : t("emptyActive")}</div>
            ) : (
              active.map((q) => (
                <QuestionItem
                  key={q.id}
                  question={q}
                  onOpen={onOpenQuestion}
                  onEdit={(q) => setEditorOpen(q)}
                />
              ))
            )}
          </div>
        )}
      </div>

      <div className={styles.group}>
        <button className={styles.groupHeader} onClick={() => setArchivedOpen((v) => !v)}>
          <span className={`${styles.caret} ${archivedOpen ? styles.caretOpen : ""}`}>›</span>
          <span>{t("archived")} ({archived.length})</span>
        </button>
        {archivedOpen && (
          <div className={styles.list}>
            {archived.length === 0 ? (
              <div className={styles.empty}>{t("emptyArchived")}</div>
            ) : (
              archived.map((q) => (
                <QuestionItem
                  key={q.id}
                  question={q}
                  onOpen={onOpenQuestion}
                  onEdit={(q) => setEditorOpen(q)}
                />
              ))
            )}
          </div>
        )}
      </div>

      {editorOpen !== null && (
        <QuestionEditDialog
          question={editorOpen === "create" ? null : editorOpen}
          onClose={closeEditor}
          onCreated={(q) => {
            onOpenQuestion(q);
            setActiveOpen(true);
          }}
        />
      )}
    </div>
  );
}
