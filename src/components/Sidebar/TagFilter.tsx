import { useTags } from "@/hooks/useTags";
import styles from "./TagFilter.module.css";

export function TagFilter() {
  const { tags } = useTags();

  return (
    <div className={styles.section}>
      <div className={styles.title}>标签</div>
      {tags.length === 0 ? (
        <div className={styles.empty}>暂无标签</div>
      ) : (
        <div className={styles.tagList}>
          {tags.map((tag) => (
            <span key={tag.id} className={styles.tag}>
              <span className={styles.dot} style={{ background: tag.color }} />
              {tag.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
