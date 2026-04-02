import styles from "./Skeleton.module.css";

interface SkeletonProps {
  width?: string;
  height?: string;
  borderRadius?: string;
}

export function Skeleton({ width = "100%", height = "16px", borderRadius = "4px" }: SkeletonProps) {
  return (
    <div
      className={styles.skeleton}
      style={{ width, height, borderRadius }}
    />
  );
}

export function ResourceListSkeleton() {
  return (
    <div className={styles.listSkeleton}>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className={styles.itemSkeleton}>
          <Skeleton width="70%" height="14px" />
          <Skeleton width="40%" height="12px" />
        </div>
      ))}
    </div>
  );
}

export function PreviewPanelSkeleton() {
  return (
    <div className={styles.previewSkeleton}>
      <Skeleton width="60%" height="20px" />
      <Skeleton width="100%" height="12px" />
      <Skeleton width="100%" height="12px" />
      <Skeleton width="80%" height="12px" />
    </div>
  );
}
