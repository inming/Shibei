# Folder Deeplink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add copyable directory links and support opening `shibei://open/folder/{folderId}` on desktop and HarmonyOS.

**Architecture:** Desktop gets a small pure TypeScript deeplink helper so URL parsing/building is tested outside React, then `App.tsx` forwards folder-open requests into `LibraryView`. HarmonyOS mirrors the same URL shape directly in `Library.ets` and adds pasteboard copy from `FolderDrawer.ets`.

**Tech Stack:** React + TypeScript + Vitest, Tauri deep-link plugin, ArkTS/ArkUI, HarmonyOS pasteboard, existing i18n resources.

---

## Source Spec

- `docs/superpowers/specs/2026-05-24-folder-deeplink-design.md`

## File Map

- Create `src/lib/deepLink.ts`: pure desktop helper for building and parsing Shibei deeplink URLs.
- Create `src/lib/deepLink.test.ts`: Vitest coverage for resource, highlight, folder, encoded IDs, malformed URLs.
- Modify `src/App.tsx`: use the parser, route folder links to the library tab, keep existing resource behavior.
- Modify `src/components/Layout.tsx`: accept a folder-open request and update library state after validating the folder.
- Modify `src/components/Sidebar/FolderTree.tsx`: add copy-link actions for `__all__`, `__inbox__`, and normal folders.
- Modify `src/locales/zh/sidebar.json` and `src/locales/en/sidebar.json`: add the folder-not-found toast text only.
- Modify `shibei-harmony/entry/src/main/ets/pages/Library.ets`: parse and consume folder deeplinks.
- Modify `shibei-harmony/entry/src/main/ets/components/FolderDrawer.ets`: add folder copy-link actions to long-press menus.
- Modify `shibei-harmony/entry/src/main/resources/{zh_CN,en_US,base}/element/string.json`: add folder-not-found text.

## Task 1: Desktop Deeplink Helper

**Files:**
- Create: `src/lib/deepLink.ts`
- Create: `src/lib/deepLink.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/deepLink.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildFolderDeepLink, buildResourceDeepLink, parseShibeiDeepLink } from "@/lib/deepLink";

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
    expect(parseShibeiDeepLink("shibei://open/resource/abc?other=1")).toEqual({
      kind: "resource",
      resourceId: "abc",
      highlightId: undefined,
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test -- src/lib/deepLink.test.ts
```

Expected: FAIL because `src/lib/deepLink.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/lib/deepLink.ts`:

```ts
export type DeepLinkTarget =
  | { kind: "resource"; resourceId: string; highlightId?: string }
  | { kind: "folder"; folderId: string };

const RESOURCE_PREFIX = "shibei://open/resource/";
const FOLDER_PREFIX = "shibei://open/folder/";

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

export function parseShibeiDeepLink(url: string): DeepLinkTarget | null {
  if (url.startsWith(RESOURCE_PREFIX)) {
    const rest = url.slice(RESOURCE_PREFIX.length);
    const [encodedResourceId, query = ""] = rest.split("?", 2);
    const resourceId = safeDecode(encodedResourceId);
    if (!resourceId) return null;

    const params = new URLSearchParams(query);
    const highlight = params.get("highlight") ?? undefined;
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

  return null;
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run:

```bash
npm test -- src/lib/deepLink.test.ts
```

Expected: PASS for all tests in `deepLink.test.ts`.

- [ ] **Step 5: Commit**

Only commit if the user explicitly asked for commits. If committing, run:

```bash
git add src/lib/deepLink.ts src/lib/deepLink.test.ts
git commit -m "feat: add shibei deeplink helper"
```

## Task 2: Desktop Folder Deeplink Opening

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/Layout.tsx`
- Modify: `src/locales/zh/sidebar.json`
- Modify: `src/locales/en/sidebar.json`
- Test: `src/lib/deepLink.test.ts` from Task 1 remains the parser regression test.

- [ ] **Step 1: Add i18n text for missing folders**

In `src/locales/zh/sidebar.json`, add this key near the folder error keys after `renameFailed`:

```json
"folderNotFound": "目录不存在或已删除",
```

In `src/locales/en/sidebar.json`, add the matching key after `renameFailed`:

```json
"folderNotFound": "Folder not found or deleted",
```

- [ ] **Step 2: Update `App.tsx` imports and state**

Add this import near the existing lib imports:

```ts
import { parseShibeiDeepLink } from "@/lib/deepLink";
```

Add this interface near `ReaderTab`:

```ts
interface FolderOpenRequest {
  folderId: string;
  ts: number;
}
```

Add this state near the other top-level state:

```ts
const [folderOpenRequest, setFolderOpenRequest] = useState<FolderOpenRequest | null>(null);
```

- [ ] **Step 3: Replace the inline regex deeplink handler**

Replace `handleDeepLinkUrl` in `src/App.tsx` with:

```ts
const handleDeepLinkUrl = useCallback(async (url: string) => {
  const target = parseShibeiDeepLink(url);
  if (!target) return;

  if (target.kind === "folder") {
    setActiveTabId(LIBRARY_TAB_ID);
    saveSessionState({ activeTabId: LIBRARY_TAB_ID });
    setFolderOpenRequest({ folderId: target.folderId, ts: Date.now() });
    return;
  }

  try {
    const resource = await cmd.getResource(target.resourceId);
    if (resource) {
      openResource(resource, target.highlightId);
    }
  } catch (err) {
    console.error("Deep link: resource not found", target.resourceId, err);
  }
}, [openResource]);
```

Update the comment immediately above the effect to:

```ts
// Deep link handler:
// - shibei://open/resource/{id}?highlight={hlId}
// - shibei://open/folder/{id}
```

- [ ] **Step 4: Pass the folder request to `LibraryView`**

In the `LibraryView` JSX in `src/App.tsx`, add the prop:

```tsx
<LibraryView
  onOpenResource={openResource}
  onOpenSettings={openSettings}
  lockEnabled={lockEnabled}
  onLock={() => setLocked(true)}
  folderOpenRequest={folderOpenRequest}
/>
```

- [ ] **Step 5: Update `LibraryView` props and type**

In `src/components/Layout.tsx`, add this interface above `LibraryViewProps`:

```ts
interface FolderOpenRequest {
  folderId: string;
  ts: number;
}
```

Add the prop:

```ts
interface LibraryViewProps {
  onOpenResource: (resource: Resource, highlightId?: string) => void;
  onOpenSettings: (section?: "sync" | "encryption") => void;
  lockEnabled?: boolean;
  onLock?: () => void;
  folderOpenRequest?: FolderOpenRequest | null;
}
```

Update the function signature:

```ts
export function LibraryView({ onOpenResource, onOpenSettings, lockEnabled, onLock, folderOpenRequest }: LibraryViewProps) {
```

- [ ] **Step 6: Add the folder-open effect in `Layout.tsx`**

Add this ref after `const sync = useSync();`:

```ts
const handledFolderOpenTsRef = useRef<number | null>(null);
```

Add this effect after the mount hydration effect and before `persistLibrary`:

```ts
useEffect(() => {
  if (!folderOpenRequest) return;
  if (handledFolderOpenTsRef.current === folderOpenRequest.ts) return;
  handledFolderOpenTsRef.current = folderOpenRequest.ts;

  let cancelled = false;
  (async () => {
    const folderId = folderOpenRequest.folderId;
    if (folderId !== ALL_RESOURCES_ID && folderId !== INBOX_FOLDER_ID) {
      try {
        await cmd.getFolder(folderId);
      } catch {
        if (!cancelled) toast.error(t("folderNotFound"));
        return;
      }
    }

    if (cancelled) return;
    setSelectedFolderId(folderId);
    setFilterTagIds([]);
    setShowTrash(false);
    setSelectedResource(null);
    setSelectedResourceIds(new Set());
    setLastClickedResourceId(null);
  })();

  return () => { cancelled = true; };
}, [folderOpenRequest, t]);
```

- [ ] **Step 7: Run TypeScript check**

Run:

```bash
npm run build
```

Expected: `tsc` and `vite build` complete successfully. If the full build is slow, do not replace it with a weaker check unless the user approves; project rules require frontend compile verification.

- [ ] **Step 8: Run deeplink parser tests**

Run:

```bash
npm test -- src/lib/deepLink.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Only commit if the user explicitly asked for commits. If committing, run:

```bash
git add src/App.tsx src/components/Layout.tsx src/locales/zh/sidebar.json src/locales/en/sidebar.json src/lib/deepLink.test.ts src/lib/deepLink.ts
git commit -m "feat: open folder deeplinks on desktop"
```

## Task 3: Desktop Folder Link Copy UI

**Files:**
- Modify: `src/components/Sidebar/FolderTree.tsx`
- Test: manual desktop UI verification; parser builder coverage comes from `src/lib/deepLink.test.ts`.

- [ ] **Step 1: Import the folder link builder**

In `src/components/Sidebar/FolderTree.tsx`, add:

```ts
import { buildFolderDeepLink } from "@/lib/deepLink";
```

- [ ] **Step 2: Add a helper to copy folder links**

Inside `FolderTree`, after `handleContextMenu`, add:

```ts
function copyFolderLink(folderId: string) {
  navigator.clipboard.writeText(buildFolderDeepLink(folderId));
  toast.success(t("contextLinkCopied"));
}
```

- [ ] **Step 3: Add right-click support to the All Resources button**

In the `allResources` button JSX, add:

```tsx
onContextMenu={(e) => handleContextMenu(e, ALL_RESOURCES_ID, t("allResources"))}
```

The button should now start like this:

```tsx
<button
  className={`${styles.allResources} ${selectedFolderId === ALL_RESOURCES_ID ? styles.allResourcesActive : ""}`}
  onClick={() => onSelectFolder(ALL_RESOURCES_ID)}
  onContextMenu={(e) => handleContextMenu(e, ALL_RESOURCES_ID, t("allResources"))}
>
```

- [ ] **Step 4: Update `menuItems` for `__all__`, `__inbox__`, and normal folders**

Replace the `menuItems` construction with:

```ts
const menuItems: MenuItem[] = contextMenu
  ? contextMenu.folderId === ALL_RESOURCES_ID
    ? [
        {
          label: t("contextCopyLink"),
          onClick: () => copyFolderLink(contextMenu.folderId),
        },
      ]
    : contextMenu.folderId === INBOX_FOLDER_ID
      ? [
          {
            label: t("importFile", { ns: "reader" }),
            onClick: () => importPdfToFolder(contextMenu.folderId),
          },
          {
            label: t("contextCopyLink"),
            onClick: () => copyFolderLink(contextMenu.folderId),
          },
        ]
      : [
          {
            label: t("newSubfolder"),
            onClick: () => {
              setSubfolderTarget(contextMenu.folderId);
              setSubfolderName("");
            },
          },
          {
            label: t("importFile", { ns: "reader" }),
            onClick: () => importPdfToFolder(contextMenu.folderId),
          },
          {
            label: t("contextCopyLink"),
            onClick: () => copyFolderLink(contextMenu.folderId),
          },
          {
            label: t("edit", { ns: "common" }),
            onClick: () => setEditFolder({ id: contextMenu.folderId, name: contextMenu.folderName }),
          },
          {
            label: t("delete", { ns: "common" }),
            danger: true,
            onClick: () => setDeleteFolder({ id: contextMenu.folderId, name: contextMenu.folderName }),
          },
        ]
  : [];
```

- [ ] **Step 5: Run verification**

Run:

```bash
npm test -- src/lib/deepLink.test.ts
npm run build
```

Expected: parser tests pass and frontend build succeeds.

- [ ] **Step 6: Manual desktop UI check**

Start the app if needed:

```bash
npm run tauri dev
```

Expected manual results:

- Right-click “全部资料 / All Resources” shows “复制链接 / Copy Link”.
- Right-click “收件箱 / Inbox” shows existing import action and copy link.
- Right-click a normal folder shows existing folder actions plus copy link.
- Copied links match `shibei://open/folder/__all__`, `shibei://open/folder/__inbox__`, or `shibei://open/folder/{id}`.

- [ ] **Step 7: Commit**

Only commit if the user explicitly asked for commits. If committing, run:

```bash
git add src/components/Sidebar/FolderTree.tsx
git commit -m "feat: copy folder links on desktop"
```

## Task 4: Harmony Folder Deeplink Opening

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/pages/Library.ets`
- Modify: `shibei-harmony/entry/src/main/resources/zh_CN/element/string.json`
- Modify: `shibei-harmony/entry/src/main/resources/en_US/element/string.json`
- Modify: `shibei-harmony/entry/src/main/resources/base/element/string.json`

- [ ] **Step 1: Add Harmony i18n text**

Add this string entry to all three string resource files near the other `sidebar_*` keys.

For `zh_CN` and `base`:

```json
{ "name": "sidebar_folder_not_found", "value": "目录不存在或已删除" },
```

For `en_US`:

```json
{ "name": "sidebar_folder_not_found", "value": "Folder not found or deleted" },
```

- [ ] **Step 2: Add helper methods to `Library.ets`**

In `shibei-harmony/entry/src/main/ets/pages/Library.ets`, add these private methods before `consumePendingDeepLink()`:

```ts
private decodeDeepLinkSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'deepLink decode fail: %{public}s', (err as Error).message);
    return null;
  }
}

private folderExistsForDeepLink(folderId: string): boolean {
  if (folderId === '__all__' || folderId === INBOX_FOLDER_ID) return true;
  try {
    return ShibeiService.instance.listFolders().some((f: Folder) => f.id === folderId);
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'deepLink folder validate fail: %{public}s', (err as Error).message);
    return false;
  }
}

private openFolderDeepLink(folderId: string): void {
  if (!this.folderExistsForDeepLink(folderId)) {
    promptAction.showToast({ message: I18n.t($r('app.string.sidebar_folder_not_found')) });
    return;
  }
  this.onFolderPick(folderId);
}
```

If `Folder` is not already imported in `Library.ets`, add it to the existing `ShibeiService` import from `../services/ShibeiService`.

- [ ] **Step 3: Extend `consumePendingDeepLink()`**

In `consumePendingDeepLink()`, after clearing `KEY_PENDING_DEEP_LINK` and before matching resource links, add:

```ts
const folderMatch = uri.match(/^shibei:\/\/open\/folder\/([^?]+)(?:\?.*)?$/);
if (folderMatch) {
  const folderId = this.decodeDeepLinkSegment(folderMatch[1]);
  if (folderId) this.openFolderDeepLink(folderId);
  return;
}
```

Then update the existing resource parsing to decode IDs:

```ts
const match = uri.match(/^shibei:\/\/open\/resource\/([^?]+)(?:\?highlight=(.+))?$/);
if (!match) return;
const resourceId = this.decodeDeepLinkSegment(match[1]);
const highlightId = match[2] ? this.decodeDeepLinkSegment(match[2]) ?? undefined : undefined;
if (!resourceId) return;
```

Keep the existing `SessionState.save` and `router.pushUrl` code, using the decoded `resourceId` and `highlightId`.

- [ ] **Step 4: Build Harmony app**

Run from workspace root with the project-required environment:

```bash
export JAVA_HOME=$(/usr/libexec/java_home)
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
export NODE_HOME=/Applications/DevEco-Studio.app/Contents/tools/node
export PATH="$JAVA_HOME/bin:$NODE_HOME/bin:$PATH"
HVIGOR=/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw
```

Then run:

```bash
$HVIGOR assembleHap --no-daemon
```

Use `workdir=/Users/inming/workspace/Shibei/shibei-harmony`. Expected: build succeeds and writes the signed HAP.

- [ ] **Step 5: Commit**

Only commit if the user explicitly asked for commits. If committing, run:

```bash
git add shibei-harmony/entry/src/main/ets/pages/Library.ets shibei-harmony/entry/src/main/resources/zh_CN/element/string.json shibei-harmony/entry/src/main/resources/en_US/element/string.json shibei-harmony/entry/src/main/resources/base/element/string.json
git commit -m "feat: open folder deeplinks on harmony"
```

## Task 5: Harmony Folder Link Copy UI

**Files:**
- Modify: `shibei-harmony/entry/src/main/ets/components/FolderDrawer.ets`

- [ ] **Step 1: Import pasteboard**

In `FolderDrawer.ets`, add:

```ts
import { pasteboard } from '@kit.BasicServicesKit';
```

- [ ] **Step 2: Add folder deeplink builder and copy method**

Inside `FolderDrawer`, after `pick(id: string)`, add:

```ts
private buildFolderLink(folderId: string): string {
  return `shibei://open/folder/${encodeURIComponent(folderId)}`;
}

private copyFolderLink(folderId: string): void {
  try {
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.buildFolderLink(folderId));
    pasteboard.getSystemPasteboard().setData(data).then(() => {
      promptAction.showToast({ message: I18n.t($r('app.string.common_copy_success')) });
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'folder link pasteboard set fail: %{public}s', err.message);
      promptAction.showToast({ message: I18n.t($r('app.string.common_copy_failed')) });
    });
  } catch (err) {
    hilog.warn(0x0000, 'shibei', 'copyFolderLink fail: %{public}s', (err as Error).message);
    promptAction.showToast({ message: I18n.t($r('app.string.common_copy_failed')) });
  }
}
```

- [ ] **Step 3: Replace `onLongPressFolder` with menu-based behavior**

Replace `onLongPressFolder(item: DrawerItem)` with:

```ts
private onLongPressFolder(item: DrawerItem): void {
  if (item.id === ALL_RESOURCES_ID) {
    promptAction.showDialog({
      title: item.label,
      buttons: [
        { text: I18n.t($r('app.string.annotation_copy_link')), color: $r('app.color.accent_primary_alt') },
        { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
      ],
    }).then((r) => {
      if (r.index === 0) this.copyFolderLink(item.id);
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'folder menu dismissed: %{public}s', err.message);
    });
    return;
  }

  const folderId = item.id;
  const folderLabel = item.label;
  promptAction.showDialog({
    title: folderLabel,
    message: I18n.t($r('app.string.cache_folder_confirm_body'), folderLabel),
    buttons: [
      { text: I18n.t($r('app.string.cache_folder_confirm_ok')), color: $r('app.color.accent_primary') },
      { text: I18n.t($r('app.string.annotation_copy_link')), color: $r('app.color.accent_primary_alt') },
      { text: I18n.t($r('app.string.common_cancel')), color: $r('app.color.text_secondary') },
    ],
  }).then(async (r) => {
    if (r.index === 1) {
      this.copyFolderLink(folderId);
      return;
    }
    if (r.index !== 0) return;
    promptAction.showToast({ message: I18n.t($r('app.string.cache_toast_folder_started')) });
    try {
      const summary = await ShibeiService.instance.preloadFolder(folderId);
      promptAction.showToast({
        message: I18n.t(
          $r('app.string.cache_toast_folder_done'),
          summary.ok, summary.failed, summary.skipped,
        ),
      });
    } catch (err) {
      const code: string = err instanceof ShibeiError ? err.code : (err as Error).message;
      promptAction.showToast({
        message: I18n.t($r('app.string.cache_toast_folder_failed'), I18n.translateError(code)),
      });
    }
  }).catch((err: Error) => {
    hilog.warn(0x0000, 'shibei', 'folder menu dismissed: %{public}s', err.message);
  });
}
```

- [ ] **Step 4: Build Harmony app**

Run with the same environment as Task 4:

```bash
$HVIGOR assembleHap --no-daemon
```

Use `workdir=/Users/inming/workspace/Shibei/shibei-harmony`. Expected: build succeeds.

- [ ] **Step 5: Optional device UI verification**

If a Harmony device is connected, run:

```bash
HDC=/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc
HAP=/Users/inming/workspace/Shibei/shibei-harmony/entry/build/default/outputs/default/entry-default-signed.hap
BUNDLE=com.shibei.harmony.phase0
$HDC install "$HAP"
$HDC shell aa force-stop $BUNDLE
$HDC shell aa start -a EntryAbility -b $BUNDLE
```

Expected manual results:

- Long-press `All Resources` shows Copy Link and Cancel.
- Long-press `Inbox` or a normal folder shows cache, Copy Link, and Cancel.
- Copy action shows the existing copy-success toast.

- [ ] **Step 6: Commit**

Only commit if the user explicitly asked for commits. If committing, run:

```bash
git add shibei-harmony/entry/src/main/ets/components/FolderDrawer.ets
git commit -m "feat: copy folder links on harmony"
```

## Task 6: Final Verification

**Files:**
- No source changes expected in this task.

- [ ] **Step 1: Run desktop tests**

Run:

```bash
npm test -- src/lib/deepLink.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run desktop build**

Run:

```bash
npm run build
```

Expected: annotator build, TypeScript compile, and Vite build complete successfully.

- [ ] **Step 3: Run Harmony build**

Run:

```bash
export JAVA_HOME=$(/usr/libexec/java_home)
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
export NODE_HOME=/Applications/DevEco-Studio.app/Contents/tools/node
export PATH="$JAVA_HOME/bin:$NODE_HOME/bin:$PATH"
HVIGOR=/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw
$HVIGOR assembleHap --no-daemon
```

Use `workdir=/Users/inming/workspace/Shibei/shibei-harmony`. Expected: build succeeds.

- [ ] **Step 4: Review diff**

Run:

```bash
git diff -- src src-tauri shibei-harmony docs/superpowers
```

Expected: diff only contains the helper, tests, desktop deeplink UI/opening changes, Harmony deeplink UI/opening changes, i18n strings, and this plan/spec documentation.

- [ ] **Step 5: Report results**

Report:

- Which verification commands were run and their exact pass/fail status.
- Whether desktop manual copy/open checks were performed.
- Whether Harmony device UI verification was performed or only `assembleHap` was run.
- Any pre-existing unrelated worktree changes observed but not touched.
