# 鸿蒙端 v2.4 收尾——会话持久化 / 同步刷新 / Deep Link 设计文档

- 日期：2026-04-24
- 范围：`shibei-harmony/entry/src/main/ets/`
- 目标：补上移动端 MVP 发布前的三个高优缺口

## 一、背景

鸿蒙移动端核心能力已全部就位（48 个 NAPI 命令、7 个页面、5 个服务层）。但三个缺口影响日常可用性：

1. **会话持久化**：app 被 kill 后，打开的 Reader 页、资料库选中态全部丢失，需回到 Library 重选
2. **同步后列表刷新不全**：自动同步完成后 ResourceList 已自动刷新，但 FolderDrawer 没有订阅 `onDataChanged`，新文件夹不出现
3. **Deep Link**：不支持 `shibei://open/resource/{id}?highlight={hlId}` 唤起，也不支持复制链接

其中 Reader 的滚动位置和 PDF 缩放已有独立持久化（`ReaderScrollState.ets` / `ReaderZoomState.ets` map 到 `shibei_prefs`），会话持久化只需补"哪个资源在 Reader 中"和"资料库选择状态"。

---

## 二、会话持久化

### 2.1 存储 Schema

新增 `entry/src/main/ets/app/SessionState.ets`——纯工具函数模块，非服务层。

`shibei_prefs` 单 key `PREF_SESSION_STATE`（已在 `AppStorageKeys.ets:10` 声明），JSON value：

```typescript
interface SessionState {
  version: 1;
  /** 用户是否在 Reader 页。true = 冷启动应 push Reader 页。 */
  inReader: boolean;
  /** Reader 页打开的资源 ID。null 当 inReader=false。 */
  readerResourceId: string | null;
  library: {
    selectedFolderId: string;
    selectedTagIds: string[];
    selectedResourceId: string | null;
    listScrollTop?: number;
  };
}

const DEFAULT_STATE: SessionState = {
  version: 1,
  inReader: false,
  readerResourceId: null,
  library: {
    selectedFolderId: '__all__',
    selectedTagIds: [],
    selectedResourceId: null,
  },
};
```

**说明**：Reader 的 `scrollY` / `pdfZoom` / `pdfPage` 等不在此 schema 中——它们已由 `ReaderScrollState.ets` 和 `ReaderZoomState.ets` 独立管理（per-resource map 到 `shibei_prefs`）。会话持久化不复制这些数据。

### 2.2 API

```typescript
export namespace SessionState {
  /** 从 preferences 反序列化，坏数据 → DEFAULT_STATE。 */
  export async function load(ctx: common.UIAbilityContext): Promise<SessionState>;

  /** 写入 preferences。合并语义：传入 patch 与当前值浅合并写入。 */
  export async function save(ctx: common.UIAbilityContext, patch: Partial<SessionState>): Promise<void>;

  /** 清除 session → DEFAULT_STATE → flush。销毁所有持久化状态。 */
  export async function clear(ctx: common.UIAbilityContext): Promise<void>;
}
```

实现要点：
- `load()` 读 `shibei_prefs` → JSON.parse → version 校验 → 字段级 fallback
- `save()` 先 load → 浅合并 patch → JSON.stringify → `store.put(KEY, json)` → `flush()`
- `clear()` 写 DEFAULT_STATE 并 flush
- 所有首选项操作 catch + hilog.warn，不抛异常

### 2.3 写入点

| 触发方 | 写入内容 | 时机 |
|--------|---------|------|
| `Library` | `library.selectedFolderId` | folder 选择变更时，立即 save |
| `Library` | `library.selectedTagIds` | tag 选中变更时，立即 save |
| `Library` | `library.selectedResourceId` | 点击资料行（preview 选中），立即 save |
| `Library` | `inReader` / `readerResourceId` | `router.pushUrl('pages/Reader', ...)` 调用后立即 save |
| `Reader` | 退出（back）→ `inReader = false` | 仅显式返回（系统 back / 顶部 `←`）通过 `leaveReader()` save |
| `EntryAbility` | flush pending debounce | `onBackground` 立即 flush（清除未落盘的 timer） |

**Reader scroll/zoom 写入**：保持现状，`ReaderScrollState.saveReaderScroll()` 和 `ReaderZoomState.saveReaderZoom()` 继续写 `shibei_prefs` 各自 key，不与 session state 冲突。

### 2.4 恢复点

**Cold start → Library 路由后**：

`Library.aboutToAppear()`:
1. `state = await SessionState.load(ctx)`
2. 恢复 `this.selectedFolderId` / `this.selectedTagIds` / `this.selectedResourceId`
3. 如果 `state.inReader` 且 `state.readerResourceId` 非空且资料存在：
   `router.pushUrl('pages/Reader', { resourceId: state.readerResourceId })`

**Reader 恢复滚动**：Reader 已有的 `restoredScroll` 逻辑（`getReaderScroll()` in `handleReady`）和 `ensurePdfReady` 的 zoom 注入继续工作，无需改动。

**Re-entry guard**：Library 首次恢复后设 `private restoredOnce = true`，避免从 Settings 返回时重复 push Reader。

### 2.5 失效兜底

- `shibei_prefs.getPreference()` 失败 → 返回 DEFAULT_STATE
- JSON.parse 失败 → 返回 DEFAULT_STATE
- version ≠ 1 → 返回 DEFAULT_STATE
- `readerResourceId` 对应的资料已被删除（`getResource` 返回 null）→ 不 push Reader，清除 session inReader

### 2.6 文件变更清单

| 文件 | 改动 |
|------|------|
| `app/SessionState.ets` | **新增**，~80 行 |
| `pages/Library.ets` | 加恢复逻辑（~35 行），退出 Reader 回退时写 session |
| `pages/Reader.ets` | `leaveReader()` 在显式返回时写 `inReader=false`；`aboutToDisappear` 只 flush scroll/zoom |
| `components/ResourceList.ets` | 长按菜单新增复制 `shibei://open/resource/{id}` |

---

## 三、同步刷新完整性

### 3.1 现状

`ShibeiService.syncMetadata()` 成功且 `applied > 0 || downloaded > 0` 时调 `notifyDataChanged()`（`ShibeiService.ets:367-368`）。`ResourceList` 已订阅：

```typescript
// ResourceList.ets:24
this.unsubDataChanged = ShibeiService.instance.onDataChanged(() => this.reload());
```

### 3.2 缺口

`FolderDrawer` 没有订阅 `onDataChanged`。自动同步新创建/删除了文件夹后，抽屉列表不更新。FolderDrawer 只在手动触发 `syncNow()` 成功后显式调 `this.reload()`（`FolderDrawer.ets:52`）。

### 3.3 方案

`FolderDrawer.aboutToAppear()` 和 `aboutToDisappear()` 加订阅/取消，与 ResourceList 模式一致。

### 3.4 文件变更

| 文件 | 改动 |
|------|------|
| `components/FolderDrawer.ets` | 加 `onDataChanged` 订阅/取消（~8 行） |

---

## 四、Deep Link

### 4.1 URI 格式

```
shibei://open/resource/{resourceId}?highlight={highlightId}
```

`highlightId` 为可选查询参数。

### 4.2 Inbound：接收 URI

**入口**：`EntryAbility.onCreate(want)`（冷启动）和 `EntryAbility.onNewWant(want)`（热启动，应用已在前台）

**路由决策**：

```
收到 URI
  ├─ 当前处于锁屏态（LockScreen / E2eeUnlockGate）
  │    → AppStorage.set(KEY_PENDING_DEEP_LINK, uri)
  │    → 等解锁后消费
  │
  ├─ 冷启动（EntryAbility.onCreate）
  │    → AppStorage.set(KEY_PENDING_DEEP_LINK, uri)
  │    → 正常路由（Onboard→...→Library）
  │    → 各 Gate 解锁成功后消费
  │
  └─ 热启动 + 已解锁
       ├─ Library 可见 → 直接 push Reader
       ├─ Reader 已开 → router.replaceUrl 当前 Reader 页（切资料）
       └─ Settings/Search 可见 → 暂存，用户返回 Library 后消费
```

### 4.3 暂存与消费

暂存介质：`AppStorage` key `KEY_PENDING_DEEP_LINK`（已在 `AppStorageKeys.ets:5` 声明），值类型 `string`。

**消费点**（解锁/就绪后自动触发）：

| 位置 | 触发时机 |
|------|---------|
| `Onboard Step 4 → enterLibrary` | 不清 pending URI，路由到 Library 后由 Library 消费 |
| `LockScreen` PIN/bio 解锁成功 | 不直接消费，路由到 Library 后由 Library 消费 |
| `E2eeUnlockGate` 解锁成功 | 不直接消费，路由到 Library 后由 Library 消费 |
| `Library.aboutToAppear` | 首次渲染完成后（冷启动已无锁） |

消费逻辑：
```
uri = AppStorage.get(KEY_PENDING_DEEP_LINK)
if (!uri) return
AppStorage.set(KEY_PENDING_DEEP_LINK, '')  // 消费即清除
解析 resourceId + highlightId
pushReader(resourceId, highlightId)
```

### 4.4 URI 解析

```typescript
function parseDeepLinkUri(uri: string): { resourceId: string; highlightId?: string } | null {
  const match = uri.match(/^shibei:\/\/open\/resource\/([^?]+)(?:\?highlight=(.+))?$/);
  if (!match) return null;
  return { resourceId: match[1], highlightId: match[2] || undefined };
}
```

### 4.5 Outbound：复制链接

**位置**：`ResourceItem` 长按菜单（已有缓存相关菜单项）

新加一项"复制链接"，写入系统剪贴板：

```typescript
import { pasteboard } from '@kit.BasicServicesKit';

const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN,
  `shibei://open/resource/${resourceId}`);
pasteboard.getSystemPasteboard().setData(data).then(() => {
  promptAction.showToast({ message: I18n.t($r('app.string.reader_link_copied')) });
});
```

`pasteboard.setData` 不需要额外权限（HarmonyOS NEXT sandbox 内写入），已在 Reader.ets 验证可用。

**ResourceItem 长按菜单现有结构**：`promptAction.showDialog` 含"缓存此资料"/"缓存此文件夹"/"取消"。新项插入在"取消"之前。

### 4.6 module.json5 注册 scheme

在 `skills` 数组中新增一项，注册 `shibei` URI scheme：

```json5
{
  "actions": ["ohos.want.action.viewData"],
  "uris": [
    { "scheme": "shibei", "host": "open" }
  ]
}
```

### 4.7 Reader highlightId 参数

`ReaderParams` 已有 `resourceId?: string`，新增 `highlightId?: string`。Reader 收到后等 ready 后跳转到对应 highlight。

### 4.8 文件变更

| 文件 | 改动 |
|------|------|
| `entryability/EntryAbility.ets` | `onCreate` 暂存 URI；`onNewWant` 锁屏态暂存、已解锁态直接 push Reader |
| `pages/Library.ets` | `aboutToAppear` 尾调用 `consumePendingDeepLink` |
| `pages/Onboard.ets` | 保持 pending deep link，进入 Library 后消费 |
| `pages/LockScreen.ets` | 无需改动，解锁后进入 Library 消费 |
| `pages/E2eeUnlockGate.ets` | 无需改动，解锁后进入 Library 消费 |
| `pages/Reader.ets` | 支持 `highlightId` route param + initial scroll-to-highlight |
| `components/ResourceItem.ets` | 长按菜单加"复制链接"项 |
| `module.json5` | 新增 `shibei` scheme skill |
| `app/AppStorageKeys.ets` | 已有 `KEY_PENDING_DEEP_LINK`，无需改动 |
| i18n zh/en | 新增 `reader.link_copied`，可能还有 `resource_list.copy_link` |

---

## 五、i18n 新增文案

| key | zh | en |
|-----|----|----|
| `reader.link_copied` | 链接已复制 | Link copied |

资源文件：`shibei-harmony/entry/src/main/resources/{zh_CN,en_US,base}/element/string.json`

---

## 六、测试要点

### 会话持久化
- [ ] 打开 Reader 页 → kill app → 重启 → 自动恢复 Reader 页
- [ ] 资料库选中 folder → kill → 重启 → folder 选中态恢复
- [ ] Reader scroll 位置恢复（已有 `ReaderScrollState` + `restoredScroll` 逻辑，此处验证回归）
- [ ] PDF zoom 恢复（已有 `ReaderZoomState`，验证回归）
- [ ] 坏 JSON / version 不匹配 → 静默回退 DEFAULT_STATE，不 crash
- [ ] 恢复的 resource 已删除 → 不 push Reader

### 同步刷新
- [ ] 自动同步后有新文件夹 → FolderDrawer 自动刷新
- [ ] 下拉刷新后 FolderDrawer 和 ResourceList 都刷新

### Deep Link
- [ ] 冷启动收到 URI → Onboard 流程后自动打开目标资料
- [ ] 锁屏态收到 URI → 解锁后自动打开
- [ ] 已解锁热启动收到 URI → Library 直接 push Reader
- [ ] 已在 Reader 中收到新 URI → replaceUrl 切资料
- [ ] 复制链接 → 剪贴板有 `shibei://open/resource/{id}`
- [ ] `highlight` 参数 → Reader 跳转到对应标注

---

## 七、不涉及

- `data:resource-changed` / `data:folder-changed` / `data:tag-changed` 等桌面领域事件的通用 NAPI 转发——移动端 MVP 不含用户触发这些变动的 UI，未来有需求时再加
- 资料库列表的搜索建议/历史
- 注解面板的关闭动画优化

---

**文档结束。**
