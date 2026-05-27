export type DeepLinkTarget =
  | { kind: "resource"; resourceId: string; highlightId?: string }
  | { kind: "folder"; folderId: string }
  | { kind: "question"; questionId: string };

const RESOURCE_PREFIX = "shibei://open/resource/";
const FOLDER_PREFIX = "shibei://open/folder/";
const QUESTION_PREFIX = "shibei://open/question/";

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    console.warn("Deep link decode failed", err);
    return null;
  }
}

export function buildResourceDeepLink(resourceId: string, highlightId?: string): string {
  const base = `${RESOURCE_PREFIX}${encodeURIComponent(resourceId)}`;
  return highlightId ? `${base}?highlight=${encodeURIComponent(highlightId)}` : base;
}

export function buildFolderDeepLink(folderId: string): string {
  return `${FOLDER_PREFIX}${encodeURIComponent(folderId)}`;
}

export function buildQuestionDeepLink(questionId: string): string {
  return `${QUESTION_PREFIX}${encodeURIComponent(questionId)}`;
}

export function parseShibeiDeepLink(url: string): DeepLinkTarget | null {
  if (url.startsWith(RESOURCE_PREFIX)) {
    const rest = url.slice(RESOURCE_PREFIX.length);
    const [encodedResourceId, query = ""] = rest.split("?", 2);
    const resourceId = safeDecode(encodedResourceId);
    if (!resourceId) return null;

    const highlightPair = query.split("&").find((pair) => pair.split("=", 1)[0] === "highlight");
    const highlight = highlightPair ? safeDecode(highlightPair.slice("highlight=".length)) : undefined;
    if (highlight === null) return null;
    return {
      kind: "resource",
      resourceId,
      highlightId: highlight || undefined,
    };
  }

  if (url.startsWith(FOLDER_PREFIX)) {
    const encodedFolderId = url.slice(FOLDER_PREFIX.length).split("?", 1)[0];
    const folderId = safeDecode(encodedFolderId);
    if (!folderId) return null;
    return { kind: "folder", folderId };
  }

  if (url.startsWith(QUESTION_PREFIX)) {
    const encodedQuestionId = url.slice(QUESTION_PREFIX.length).split("?", 1)[0];
    const questionId = safeDecode(encodedQuestionId);
    if (!questionId) return null;
    return { kind: "question", questionId };
  }

  return null;
}
