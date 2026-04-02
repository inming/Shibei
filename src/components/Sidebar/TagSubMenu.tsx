import { useState, useEffect, useCallback } from "react";
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
  const { tags } = useTags();
  const [assignedTagIds, setAssignedTagIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    // For single resource, show which tags are assigned
    if (resourceIds.length === 1) {
      cmd.getTagsForResource(resourceIds[0]).then((resourceTags) => {
        setAssignedTagIds(new Set(resourceTags.map((t) => t.id)));
      });
    }
  }, [resourceIds]);

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
      toast.error("标签操作失败");
    }
  }, [resourceIds, assignedTagIds, onTagsChanged, onClose]);

  if (tags.length === 0) {
    return <div className={styles.empty}>暂无标签</div>;
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
