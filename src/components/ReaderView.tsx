import type { Resource } from "@/types";
import styles from "./ReaderView.module.css";

interface ReaderViewProps {
  resource: Resource;
}

export function ReaderView({ resource }: ReaderViewProps) {
  return (
    <div className={styles.container}>
      <div className={styles.reader}>
        {/* Meta bar */}
        <div className={styles.metaBar}>
          <span className={styles.metaTitle}>{resource.title}</span>
          <a
            className={styles.metaUrl}
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {resource.domain ?? new URL(resource.url).hostname}
          </a>
          <span className={styles.metaTime}>
            {new Date(resource.created_at).toLocaleDateString()}
          </span>
        </div>

        {/* MHTML content */}
        <iframe
          className={styles.iframe}
          src={`shibei://localhost/resource/${resource.id}`}
          title={resource.title}
        />
      </div>

      {/* Annotation panel (Phase 6) */}
      <div className={styles.annotationPanel}>
        <span style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
          标注面板（Phase 6）
        </span>
      </div>
    </div>
  );
}
