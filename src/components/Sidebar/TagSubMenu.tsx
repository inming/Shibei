import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTags } from "@/hooks/useTags";
import * as cmd from "@/lib/commands";
import toast from "react-hot-toast";
import styles from "./TagSubMenu.module.css";

interface TagSubMenuProps {
  resourceIds: string[];
  onClose: () => void;
  onTagsChanged: () => void;
}

export function TagSubMenu({ resourceIds, onClose, onTagsChanged }: TagSubMenuProps) {
  const { t } = useTranslation('sidebar');
  const { tags } = useTags();
  const [assignedTagIds, setAssignedTagIds] = useState<Set<string>>(new Set());

  const loadAssigned = useCallback(async () => {
    if (resourceIds.length === 1) {
      try {
        const resourceTags = await cmd.getTagsForResource(resourceIds[0]);
        setAssignedTagIds(new Set(resourceTags.map((t) => t.id)));
      } catch {
        setAssignedTagIds(new Set());
      }
    } else {
      setAssignedTagIds(new Set());
    }
  }, [resourceIds]);

  useEffect(() => {
    loadAssigned();
  }, [loadAssigned]);

  const handleToggle = useCallback(async (tagId: string) => {
    try {
      const isAssigned = assignedTagIds.has(tagId);
      for (const resourceId of resourceIds) {
        if (isAssigned) {
          await cmd.removeTagFromResource(resourceId, tagId);
        } else {
          await cmd.addTagToResource(resourceId, tagId);
        }
      }
      onTagsChanged();
      onClose();
    } catch (err) {
      toast.error(t('tagOperationFailed'));
    }
  }, [resourceIds, assignedTagIds, onTagsChanged, onClose]);

  if (tags.length === 0) {
    return <div className={styles.empty}>{t('noTags')}</div>;
  }

  return (
    <div className={styles.submenu}>
      {tags.map((tag) => (
        <button
          key={tag.id}
          className={styles.item}
          onClick={() => handleToggle(tag.id)}
        >
          <span className={styles.dot} style={{ backgroundColor: tag.color }} />
          <span className={styles.label}>{tag.name}</span>
          {assignedTagIds.has(tag.id) && <span className={styles.check}>✓</span>}
        </button>
      ))}
    </div>
  );
}
