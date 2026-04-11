import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { ALL_RESOURCES_ID, type Resource, type Tag, type SearchResult } from "@/types";
import * as cmd from "@/lib/commands";
import { DataEvents } from "@/lib/events";

export function useResources(
  folderId: string | null,
  sortBy: "created_at" | "annotated_at" = "created_at",
  sortOrder: "asc" | "desc" = "desc",
  searchQuery: string = "",
  selectedTagIds: string[] = [],
) {
  const { t } = useTranslation('lock');
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceTags, setResourceTags] = useState<Record<string, Tag[]>>({});
  const [matchedBodyMap, setMatchedBodyMap] = useState<Record<string, boolean>>({});
  const [snippetMap, setSnippetMap] = useState<Record<string, string | null>>({});
  const [matchFieldsMap, setMatchFieldsMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!folderId) {
      setResources([]);
      setResourceTags({});
      setMatchedBodyMap({});
      setSnippetMap({});
      setMatchFieldsMap({});
      return;
    }
    setLoading(true);
    try {
      let list: Resource[];
      let bodyMap: Record<string, boolean> = {};
      let snippets: Record<string, string | null> = {};
      let matchFields: Record<string, string[]> = {};
      if (searchQuery.length >= 2) {
        const searchResults: SearchResult[] = await cmd.searchResources(
          searchQuery,
          folderId === ALL_RESOURCES_ID ? null : folderId,
          selectedTagIds,
          sortBy,
          sortOrder,
        );
        list = searchResults;
        for (const sr of searchResults) {
          bodyMap[sr.id] = sr.matchedBody;
          snippets[sr.id] = sr.snippet;
          matchFields[sr.id] = sr.matchFields;
        }
      } else if (folderId === ALL_RESOURCES_ID) {
        list = await cmd.listAllResources(sortBy, sortOrder, selectedTagIds);
      } else {
        list = await cmd.listResources(folderId, sortBy, sortOrder, selectedTagIds);
      }
      setResources(list);
      setMatchedBodyMap(bodyMap);
      setSnippetMap(snippets);
      setMatchFieldsMap(matchFields);
      // Fetch tags for all resources in parallel
      const tagEntries = await Promise.all(
        list.map(async (r) => {
          const tags = await cmd.getTagsForResource(r.id);
          return [r.id, tags] as const;
        }),
      );
      setResourceTags(Object.fromEntries(tagEntries));
    } catch (err) {
      console.error("Failed to load resources:", err);
      toast.error(t('loadResourcesFailed'));
    } finally {
      setLoading(false);
    }
  }, [folderId, sortBy, sortOrder, searchQuery, selectedTagIds]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh on domain events
  useEffect(() => {
    const u1 = listen(DataEvents.RESOURCE_CHANGED, () => { refresh(); });
    const u2 = listen(DataEvents.TAG_CHANGED, () => { refresh(); });
    const u3 = listen(DataEvents.SYNC_COMPLETED, () => { refresh(); });
    const u4 = listen(DataEvents.ANNOTATION_CHANGED, () => {
      if (searchQuery.length >= 2) refresh();
    });
    return () => {
      u1.then((f) => f());
      u2.then((f) => f());
      u3.then((f) => f());
      u4.then((f) => f());
    };
  }, [refresh, searchQuery]);

  return { resources, resourceTags, matchedBodyMap, snippetMap, matchFieldsMap, loading, refresh };
}
