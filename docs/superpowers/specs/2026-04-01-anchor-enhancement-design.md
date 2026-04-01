# v1.1.1 Anchor 系统增强 — 设计文档

## 背景

当前 annotator 使用两级锚点策略：`TextPositionSelector`（字符偏移量）→ `TextQuoteSelector`（prefix + exact + suffix 全文搜索）。大部分网页工作正常，但在特定页面存在定位失败的情况——高亮创建成功但重新打开后无法渲染（`resolveAnchor` 找不到对应文本位置）。失败时静默跳过，用户无感知。

### 行业调研结论

| 工具 | 锚定策略 | 特点 |
|------|---------|------|
| **Hypothesis** | RangeSelector + TextPosition + TextQuote，3 级 fallback + Bitap 模糊匹配 | 10 年打磨，业界标杆 |
| **Omnivore** | TextQuote + Position + 百分比位置 | 先用 Readability 清洗 HTML |
| **Diigo** | XPath + 文本偏移 | 有动态内容检测 |
| **Shibei 当前** | TextPosition + TextQuote，2 级 fallback，indexOf 精确匹配 | 和 Hypothesis 同架构，缺少模糊匹配和失败反馈 |

关键数据：Hypothesis 在活网页上的 orphan rate 约 27%。但 **Shibei 标注的是 SingleFile 冻结快照**，文档不会变化，理论上锚定应 100% 可靠。实际失败来自 DOM 结构边界情况（隐藏元素、脚本文本、零宽字符干扰偏移量计算）。

**结论**：文本锚定方案本身可以收敛，不需要换截图方案。需要加固实现 + 增加失败可视化。

---

## 设计方案

分 3 个层次，互相独立，逐步交付。

---

### 层次 1：失败可视化

**目标**：anchor 解析失败时，用户能在 AnnotationPanel 看到明确提示，而不是高亮静默消失。

#### 1.1 Annotator → React 回传解析结果

当前 annotator 收到 `shibei:render-highlights` 后逐个解析并渲染，失败时只 `console.warn`。

**改动**：batch render 完成后，回传一条 `shibei:render-result` 消息：

```typescript
// annotator.ts — 新增 outbound message
interface RenderResultMsg {
  type: "shibei:render-result";
  failedIds: string[];  // 解析失败的 highlight IDs
}
```

在 `shibei:render-highlights` 的 handler 末尾，收集所有失败的 ID 并 postMessage 回 parent。

#### 1.2 ReaderView 接收并维护失败状态

```typescript
// ReaderView.tsx
const [failedHighlightIds, setFailedHighlightIds] = useState<Set<string>>(new Set());

// 在 message listener 中处理：
case "shibei:render-result":
  setFailedHighlightIds(new Set(msg.failedIds));
  break;
```

将 `failedHighlightIds` 通过 props 传递给 AnnotationPanel。

#### 1.3 AnnotationPanel 显示失败标记

对 `failedHighlightIds` 中的 highlight，在 HighlightEntry 组件中：
- 高亮文本显示为灰色（而非原高亮色）
- 追加一个"定位失败"的小标签
- 点击时不触发 scroll-to-highlight（因为 DOM 中不存在对应元素）

#### 涉及文件

| 文件 | 改动内容 |
|------|---------|
| `src/annotator/annotator.ts` | `render-highlights` handler 收集 failedIds，回传 `shibei:render-result` |
| `src/components/ReaderView.tsx` | 监听 `shibei:render-result`，维护 `failedHighlightIds` state |
| `src/components/AnnotationPanel.tsx` | 接收 `failedHighlightIds` prop，渲染失败标记 |
| `src/components/AnnotationPanel.module.css` | 失败状态样式（灰色、标签） |

---

### 层次 2：getTextNodes 健壮性加固

**目标**：修复隐藏元素、脚本标签、零宽字符等导致的偏移量计算错误。

#### 2.1 问题分析

当前 `getTextNodes(root)` 使用 `TreeWalker(SHOW_TEXT)` 遍历所有文本节点，包括：
- `<script>`、`<style>`、`<noscript>` 内的代码/样式文本
- `display:none`、`visibility:hidden` 元素内的文本
- 零宽字符（`\u200B`、`\uFEFF`、`\u200C`、`\u200D`）

这些文本用户不可见、不可选，但参与了偏移量计算。当用户选中可见文本并创建高亮时，`computeTextOffset` 计算的 start/end 包含了这些不可见文本的长度。如果这些不可见文本在不同渲染条件下有变化（如 SingleFile 处理前后），偏移量就会错位。

#### 2.2 改动方案

给 `getTextNodes` 增加 `NodeFilter` 回调，过滤不应参与偏移量计算的节点：

```typescript
// annotator.ts — 改造 getTextNodes
const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

function getTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      // 跳过被排除标签内的文本
      const parent = node.parentElement;
      if (parent && EXCLUDED_TAGS.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      // 跳过隐藏元素内的文本
      if (parent) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    nodes.push(node as Text);
  }
  return nodes;
}
```

#### 2.3 零宽字符标准化

在 `getBodyText()` 中剔除零宽字符，避免干扰偏移量：

```typescript
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;

function getBodyText(): string {
  return getTextNodes(document.body)
    .map((n) => (n.textContent ?? "").replace(ZERO_WIDTH_RE, ""))
    .join("");
}
```

同时 `computeTextOffset` 和 `resolveByPosition` 中涉及 `textContent.length` 的地方也要用标准化后的长度。

#### 2.4 兼容性

**关键约束**：创建 anchor 和解析 anchor 必须用同一套过滤 + 标准化规则。

- 新规则生效后创建的 anchor：偏移量基于过滤后的文本，`resolveByPosition` 可正确解析
- 旧 anchor（基于未过滤文本）：`resolveByPosition` 可能偏移错位，但会验证 `range.toString() === exact`，验证失败后 fallback 到 `resolveByQuote`，用 exact 文本搜索定位
- 因此**旧数据不需要迁移**，quote fallback 天然兼容

#### 2.5 getComputedStyle 性能考量

`getComputedStyle` 每次调用会触发样式计算。对大文档可能有性能影响。

缓解方案：
- 只在 `render-highlights`（页面加载时一次性批量）和 `computeAnchor`（用户选中文本时）调用
- 实际上 TreeWalker 遍历过程中浏览器已缓存样式计算结果，开销可接受
- 如果实测发现性能问题，可改为只检查祖先链中的 `EXCLUDED_TAGS`（不需要 getComputedStyle），作为降级方案

#### 涉及文件

| 文件 | 改动内容 |
|------|---------|
| `src/annotator/annotator.ts` | `getTextNodes` 加 NodeFilter；`getBodyText` 加零宽字符标准化；`computeTextOffset` / `resolveByPosition` 适配标准化文本长度 |

---

### 层次 3：模糊匹配

**目标**：`resolveByQuote` 从 `indexOf` 精确匹配升级为近似匹配，容忍轻微文本差异。

#### 3.1 算法选型

| 算法 | 复杂度 | 特点 |
|------|--------|------|
| **Bitap（shift-or）** | O(n × m/w)，w=字长 | Hypothesis 使用，支持编辑距离阈值，适合短-中长度模式 |
| Levenshtein + 滑动窗口 | O(n × m) | 直观但较慢，适合短文本 |
| 余弦相似度 / n-gram | O(n) | 适合长文本相似性判断，不适合精确定位 |

**选择 Bitap**：和 Hypothesis 同款，代码量约 60-80 行，无外部依赖，性能适合 annotator 场景。

#### 3.2 实现方案

由于 annotator.ts 是打包嵌入 HTML 的独立 IIFE 脚本，不能 import npm 包。需要内联实现 Bitap 搜索：

```typescript
// annotator.ts — 新增
interface FuzzyMatch {
  start: number;
  end: number;
  errors: number;  // 编辑距离
}

/**
 * Bitap 近似字符串搜索。
 * 在 text 中查找 pattern 的所有近似匹配（编辑距离 ≤ maxErrors）。
 * 返回最佳匹配（错误最少；同等错误数时取最靠近 positionHint 的）。
 */
function fuzzySearch(
  text: string,
  pattern: string,
  maxErrors: number,
  positionHint?: number,
): FuzzyMatch | null {
  // Bitap 算法实现
  // pattern 长度限制：≤ 64 字符（JavaScript 位运算限制）
  // 超长 pattern 截断后搜索
  // ...
}
```

#### 3.3 resolveByQuote 改造

```typescript
function resolveByQuote(anchor: Anchor): Range | null {
  const bodyText = getBodyText();
  const { exact, prefix, suffix } = anchor.text_quote;

  // Step 1: 精确匹配（快速路径，和现在一样）
  const contextStr = prefix + exact + suffix;
  const exactIdx = bodyText.indexOf(contextStr);
  if (exactIdx !== -1) {
    const start = exactIdx + prefix.length;
    return resolveByPosition({
      text_position: { start, end: start + exact.length },
      text_quote: anchor.text_quote,
    });
  }

  // Step 2: 只搜 exact 文本（精确匹配）
  const simpleIdx = bodyText.indexOf(exact);
  if (simpleIdx !== -1) {
    return resolveByPosition({
      text_position: { start: simpleIdx, end: simpleIdx + exact.length },
      text_quote: anchor.text_quote,
    });
  }

  // Step 3: 模糊匹配 exact 文本
  const maxErrors = Math.min(32, Math.floor(exact.length / 5));
  const match = fuzzySearch(bodyText, exact, maxErrors, anchor.text_position.start);
  if (!match) return null;

  // 用 prefix/suffix 验证上下文
  const candidatePrefix = bodyText.slice(Math.max(0, match.start - prefix.length), match.start);
  const candidateSuffix = bodyText.slice(match.end, Math.min(bodyText.length, match.end + suffix.length));
  // 上下文至少有一半匹配才接受
  if (similarity(candidatePrefix, prefix) < 0.5 && similarity(candidateSuffix, suffix) < 0.5) {
    return null;
  }

  return resolveByPosition({
    text_position: { start: match.start, end: match.end },
    text_quote: { ...anchor.text_quote, exact: bodyText.slice(match.start, match.end) },
  });
}
```

#### 3.4 Bitap 限制与应对

- **模式长度限制**：JavaScript 位运算限于 32 位整数。超过 32 字符的 pattern 需要分块或使用 BigInt。Hypothesis 的 `approx-string-match` 用多 word 方式支持到 256 字符。
- **Shibei 应对**：大部分高亮文本 < 200 字符。超长高亮可截取前 64 字符做模糊搜索定位起点，再用完整文本验证。
- **编辑距离阈值**：对冻结快照用 `exact.length / 5`（比 Hypothesis 的 `length / 2` 更保守），避免误匹配。

#### 3.5 多候选评分

模糊搜索可能返回多个候选。评分规则（参考 Hypothesis）：

| 因素 | 权重 | 说明 |
|------|------|------|
| 编辑距离 | 50 | 错误越少越好 |
| prefix 匹配度 | 20 | 前缀上下文相似度 |
| suffix 匹配度 | 20 | 后缀上下文相似度 |
| 位置距离 | 10 | 与 text_position.start 的距离，越近越好 |

#### 涉及文件

| 文件 | 改动内容 |
|------|---------|
| `src/annotator/annotator.ts` | 新增 `fuzzySearch` 函数（Bitap 实现）；改造 `resolveByQuote`；新增 `similarity` 辅助函数 |

---

## 实施顺序

```
层次 1（失败可视化）→ 层次 2（getTextNodes 加固）→ 层次 3（模糊匹配）
```

每个层次独立可交付、可测试。层次 1 完成后用户就能感知到哪些高亮有问题；层次 2 修复主要的根因；层次 3 是兜底增强。

## 测试策略

- **层次 1**：手动验证——构造一个 anchor 偏移量故意错位的 highlight 记录，确认 AnnotationPanel 显示"定位失败"
- **层次 2**：构造含 `<script>`、`display:none`、零宽字符的 HTML fixture，验证 anchor 创建和解析的一致性
- **层次 3**：构造轻微修改的文本（增删空格、替换标点），验证模糊匹配能正确定位；验证阈值不会导致误匹配

## 不做的事情

- **不加 XPath/CSS Selector 第三级锚点**：对冻结快照收益不大，增加复杂度
- **不做截图方案**：不可搜索、不可编辑，与产品定位不符
- **不做 anchor 数据迁移**：旧数据通过 quote fallback 天然兼容
- **不引入外部 npm 依赖**：annotator 是独立 IIFE 脚本，Bitap 内联实现
