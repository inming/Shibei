import { useCallback, useState } from "react";

/**
 * A boolean "collapsed" flag persisted to localStorage under
 * `shibei-collapse:{key}`. Used by detail-view sections so a user's fold
 * preference sticks across questions and remounts (a purely local flag would
 * reset every time you switch questions or the preview panel remounts, making
 * collapsing nearly useless). Defaults to expanded.
 */
export function useCollapsible(
  key: string,
  defaultCollapsed = false,
): [boolean, (collapsed: boolean) => void] {
  const storageKey = `shibei-collapse:${key}`;
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? defaultCollapsed : v === "1";
    } catch {
      return defaultCollapsed;
    }
  });
  const setCollapsed = useCallback(
    (next: boolean) => {
      setCollapsedState(next);
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // ignore quota / availability errors — collapse is a non-critical pref
      }
    },
    [storageKey],
  );
  return [collapsed, setCollapsed];
}
