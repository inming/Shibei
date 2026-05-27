import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { useQuestions } from "@/hooks/useQuestions";
import { QuestionEditDialog } from "@/components/Sidebar/QuestionEditDialog";
import * as cmd from "@/lib/commands";
import type { Question, QuestionTargetType } from "@/types";
import styles from "./LinkToQuestionSubMenu.module.css";

interface LinkToQuestionSubMenuProps {
  /**
   * Items to link. For Phase 1 the only entry point is the ResourceList right-
   * click, so all items are resources; the future highlight/comment entry
   * points (Phase 2) can pass `target_type` of their respective kind.
   */
  targetType: QuestionTargetType;
  targetIds: string[];
  onClose: () => void;
}

export function LinkToQuestionSubMenu({
  targetType,
  targetIds,
  onClose,
}: LinkToQuestionSubMenuProps) {
  const { t } = useTranslation("question");
  const { active } = useQuestions();
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  /** Set of question ids that already have an alive link to *every* target. */
  const [fullyLinked, setFullyLinked] = useState<Set<string>>(new Set());

  // For each active question, mark it as "already linked" when EVERY target
  // already references it. Mixed states show as not linked so a click can
  // still complete the missing edges.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const perTarget = await Promise.all(
          targetIds.map((id) => cmd.listQuestionsForTarget(targetType, id)),
        );
        if (cancelled) return;
        const counts = new Map<string, number>();
        for (const list of perTarget) {
          for (const q of list) {
            counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
          }
        }
        const all = new Set<string>();
        for (const [qid, n] of counts) {
          if (n === targetIds.length) all.add(qid);
        }
        setFullyLinked(all);
      } catch {
        // best-effort; UI still works without check marks
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetType, targetIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return active;
    return active.filter((x) => x.title.toLowerCase().includes(q));
  }, [active, query]);

  const handleToggle = useCallback(
    async (question: Question) => {
      try {
        const isLinked = fullyLinked.has(question.id);
        for (const tid of targetIds) {
          if (isLinked) {
            // Unlink: find the alive link for this target and remove it.
            const links = await cmd.listQuestionLinks(question.id);
            const match = links.find(
              (l) => l.target_type === targetType && l.target_id === tid,
            );
            if (match) await cmd.unlinkQuestion(match.id);
          } else {
            await cmd.linkToQuestion(question.id, targetType, tid);
          }
        }
        onClose();
      } catch (err) {
        console.error(err);
        toast.error(t("operationFailed"));
      }
    },
    [fullyLinked, targetIds, targetType, onClose, t],
  );

  return (
    <>
      <div className={styles.submenu}>
        <div className={styles.searchWrap}>
          <input
            className={styles.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            autoFocus
          />
        </div>
        <div className={styles.list}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>
              {active.length === 0 ? t("noQuestionsToLink") : ""}
            </div>
          ) : (
            filtered.map((q) => (
              <button key={q.id} className={styles.item} onClick={() => handleToggle(q)}>
                <span className={styles.dot} />
                <span className={styles.label}>{q.title}</span>
                {fullyLinked.has(q.id) && <span className={styles.check}>✓</span>}
              </button>
            ))
          )}
        </div>
        <div className={styles.separator} />
        <button className={styles.createEntry} onClick={() => setCreateOpen(true)}>
          {t("createInline")}
        </button>
      </div>
      {createOpen && (
        <QuestionEditDialog
          question={null}
          onClose={() => setCreateOpen(false)}
          onCreated={async (q) => {
            // Auto-link the newly created question to all targets, then close
            // the parent context menu.
            try {
              for (const tid of targetIds) {
                await cmd.linkToQuestion(q.id, targetType, tid);
              }
            } catch (err) {
              console.error(err);
              toast.error(t("operationFailed"));
            }
            setCreateOpen(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
