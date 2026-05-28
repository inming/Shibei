import { useEffect, useRef } from "react";
import { useFlipPosition } from "@/hooks/useFlipPosition";
import { LinkToQuestionSubMenu } from "@/components/Sidebar/LinkToQuestionSubMenu";
import type { QuestionTargetType } from "@/types";
import styles from "./LinkToQuestionPopover.module.css";

interface LinkToQuestionPopoverProps {
  x: number;
  y: number;
  targetType: QuestionTargetType;
  targetIds: string[];
  onClose: () => void;
}

/**
 * Floating, viewport-clamped wrapper around LinkToQuestionSubMenu used by
 * surfaces (comments, resource notes) that don't have their own multi-item
 * context menu to hang the picker off as a submenu. Closes on outside click
 * or Escape.
 */
export function LinkToQuestionPopover({
  x,
  y,
  targetType,
  targetIds,
  onClose,
}: LinkToQuestionPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFlipPosition(ref, x, y);

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

  return (
    <div
      ref={ref}
      className={styles.popover}
      style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <LinkToQuestionSubMenu
        targetType={targetType}
        targetIds={targetIds}
        onClose={onClose}
      />
    </div>
  );
}
