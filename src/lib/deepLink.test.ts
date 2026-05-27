import { describe, expect, it } from "vitest";
import {
  buildFolderDeepLink,
  buildQuestionDeepLink,
  buildResourceDeepLink,
  parseShibeiDeepLink,
} from "@/lib/deepLink";

describe("parseShibeiDeepLink", () => {
  it("parses resource links", () => {
    expect(parseShibeiDeepLink("shibei://open/resource/res-1")).toEqual({
      kind: "resource",
      resourceId: "res-1",
      highlightId: undefined,
    });
  });

  it("parses resource highlight links", () => {
    expect(parseShibeiDeepLink("shibei://open/resource/res-1?highlight=hl-1")).toEqual({
      kind: "resource",
      resourceId: "res-1",
      highlightId: "hl-1",
    });
  });

  it("parses folder links", () => {
    expect(parseShibeiDeepLink("shibei://open/folder/__inbox__")).toEqual({
      kind: "folder",
      folderId: "__inbox__",
    });
  });

  it("parses question links", () => {
    expect(parseShibeiDeepLink("shibei://open/question/q-1")).toEqual({
      kind: "question",
      questionId: "q-1",
    });
    expect(parseShibeiDeepLink("shibei://open/question/abc%2Fdef")).toEqual({
      kind: "question",
      questionId: "abc/def",
    });
  });

  it("decodes path segments and query values", () => {
    expect(parseShibeiDeepLink("shibei://open/folder/a%2Fb%20c")).toEqual({
      kind: "folder",
      folderId: "a/b c",
    });
    expect(parseShibeiDeepLink("shibei://open/resource/res%2F1?highlight=hl%202")).toEqual({
      kind: "resource",
      resourceId: "res/1",
      highlightId: "hl 2",
    });
  });

  it("returns null for malformed or unsupported links", () => {
    expect(parseShibeiDeepLink("https://example.com")).toBeNull();
    expect(parseShibeiDeepLink("shibei://open/tag/tag-1")).toBeNull();
    expect(parseShibeiDeepLink("shibei://open/folder/%E0%A4%A")).toBeNull();
    expect(parseShibeiDeepLink("shibei://open/resource/res-1?highlight=%E0%A4%A")).toBeNull();
    expect(parseShibeiDeepLink("shibei://open/resource/abc?other=1")).toEqual({
      kind: "resource",
      resourceId: "abc",
      highlightId: undefined,
    });
  });

  it("preserves plus signs in highlight values", () => {
    expect(parseShibeiDeepLink("shibei://open/resource/res-1?highlight=hl+2")).toEqual({
      kind: "resource",
      resourceId: "res-1",
      highlightId: "hl+2",
    });
  });

  it("ignores unsupported query keys after highlight", () => {
    expect(parseShibeiDeepLink("shibei://open/resource/res-1?highlight=hl-1&other=1")).toEqual({
      kind: "resource",
      resourceId: "res-1",
      highlightId: "hl-1",
    });
  });
});

describe("deeplink builders", () => {
  it("builds folder links", () => {
    expect(buildFolderDeepLink("__all__")).toBe("shibei://open/folder/__all__");
    expect(buildFolderDeepLink("a/b c")).toBe("shibei://open/folder/a%2Fb%20c");
  });

  it("builds resource links", () => {
    expect(buildResourceDeepLink("res-1")).toBe("shibei://open/resource/res-1");
    expect(buildResourceDeepLink("res/1", "hl 2")).toBe("shibei://open/resource/res%2F1?highlight=hl%202");
  });

  it("builds question links", () => {
    expect(buildQuestionDeepLink("q-1")).toBe("shibei://open/question/q-1");
    expect(buildQuestionDeepLink("a/b c")).toBe("shibei://open/question/a%2Fb%20c");
  });
});
