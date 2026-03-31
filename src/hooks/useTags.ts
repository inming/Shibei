import { useState, useEffect, useCallback } from "react";
import type { Tag } from "@/types";
import * as cmd from "@/lib/commands";

export function useTags() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await cmd.listTags();
      setTags(data);
    } catch (err) {
      console.error("Failed to load tags:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { tags, loading, refresh };
}
