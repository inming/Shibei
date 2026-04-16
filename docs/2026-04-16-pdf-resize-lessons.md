# PDF Resize 技术总结

> 在 Tauri (WKWebView + WebView2) 桌面应用中，用 pdfjs-dist v5 渲染 PDF 页面时遇到的 resize 相关问题和解决方案。

## 核心难题

在可滚动容器中渲染 PDF 页面，窗口 resize 时需要同时保证：**页面缩放正确**、**滚动位置不丢**、**canvas 不冲突**、**跨平台一致**。这四个目标互相牵扯。

---

## 坑 1：JS 计算高度 vs CSS 实际高度不同步

**现象**：resize 后部分页面大小不对，canvas 溢出或缩进容器。

**原因**：`container.clientWidth` 在浏览器 resize 时**立即更新**，但 React state 和 JSX 渲染是**异步**的。`renderPage` 读到新宽度，但 page container div 还是旧尺寸。

**解决**：page container 用 CSS `aspect-ratio` 代替 JS 计算的 inline height。浏览器自动保持宽高比，无需 React 参与布局。

```css
/* 浏览器实时计算高度，不依赖 JS */
style={{ aspectRatio: `${info.width} / ${info.height}` }}
```

**教训**：能用 CSS 做的布局，不要用 JS 算。JS 和 DOM 之间有 React render 这个时间差。

---

## 坑 2：canvas `height: auto` 在 HiDPI 下撑开容器

**现象**：Windows 上页面高度是预期的 2 倍，scrollTop 指向第 187 页但用户以为在第 93 页。

**原因**：HiDPI (dpr=2) 下 canvas 像素高度是显示高度的 2 倍。CSS `height: auto` 按 canvas 的**像素尺寸**算出的 intrinsic height 覆盖了 `aspect-ratio` 的偏好高度。CSS 规范里 `aspect-ratio` 只是 *preferred*，content 可以撑高。

```
canvas.height = 1768px (2x for HiDPI)
CSS height: auto → 1768px  ← 撑开了容器！
aspect-ratio 期望 → 884px  ← 被忽略
```

**解决**：canvas 用 `height: 100%` 填充容器，而不是 `auto`。

**教训**：`aspect-ratio` 不是硬约束。子元素的 intrinsic size 可以覆盖它。

---

## 坑 3：同一 canvas 并发渲染

**现象**：Windows resize 后报 "Cannot use the same canvas during multiple render() operations"。

**原因**：`renderPage` 是 async 函数。resize debounce 清除 `renderedPagesRef` 后调用 `renderVisiblePages()`，但旧的 `renderPage` 调用还在 `await page.render()` 中，两者对同一个 canvas 并发渲染。

**解决**：每次 `renderPage` 创建**新 canvas**，渲染完成后 `replaceChild` 替换旧的。加 generation counter 丢弃过期结果。

```javascript
const canvas = document.createElement("canvas"); // 新 canvas
await page.render({ canvas, viewport }).promise;
if (renderGenRef.current !== gen) return; // 过期，丢弃
pageDiv.replaceChild(canvas, oldCanvas); // 原子替换
```

**教训**：async 函数 + 可变共享状态 = 竞态条件。用"创建新对象 + 原子替换"代替"修改旧对象"。

---

## 坑 4：WebKit vs Chromium scroll 行为差异

**现象**：同样的 scroll 恢复逻辑，Windows 正确但 Mac 跳页，或反过来。

**原因**：CSS layout 变化（`aspect-ratio` 导致页面变高/变矮）时，两个引擎处理 `scrollTop` 的方式不同：

| | Chromium (Windows) | WebKit (Mac) |
|---|---|---|
| layout 后 scrollTop | **不变**（用户看到更前面的内容） | **按比例调整**（用户看到同一页） |
| 需要手动调整？ | ✅ 是 | ❌ 否（调了反而错） |

**解决**：每次 scroll 保存 `fraction = scrollTop / scrollHeight`。resize 后检测浏览器是否已调整：

```javascript
const currentFraction = container.scrollTop / container.scrollHeight;
if (Math.abs(currentFraction - savedFraction) > 0.005) {
  // 浏览器没调整（Chromium）→ 手动恢复
  container.scrollTop = savedFraction * container.scrollHeight;
}
// 否则浏览器已调整（WebKit）→ 跳过
```

**教训**：不要假设浏览器在 layout reflow 时的 scroll 行为。检测而不是猜测。

---

## 坑 5：`--total-scale-factor` CSS 变量缺失

**现象**：Windows 上文本层 span 位置和 canvas 不对齐，选中 "Performance" 但标注存的是 "al Perform"。

**原因**：PDF.js v5 的 TextLayer 用 CSS 变量 `--total-scale-factor` 计算字体大小和 span 位置。这个变量应由 `PDFPageView` 设置，但我们没用官方 viewer。变量为空 → 所有 `calc()` 无效 → font-size 回退到浏览器默认 14px → 所有 span 大小一样、位置全错。

**解决**：手动设置 `--scale-factor` 和 `--total-scale-factor`：

```javascript
pageDiv.style.setProperty("--scale-factor", String(scale));
pageDiv.style.setProperty("--total-scale-factor", String(scale));
```

**教训**：用第三方库的内部组件（TextLayer 而非完整 PDFViewer）时，要看它依赖哪些外部配置。CSS 变量缺失不会报错，只会静默降级。

---

## 坑 6：`getTextContent()` vs `streamTextContent()`

**现象**：Mac 上文本层完全为空（无 span），不能选择文本。

**原因**：pdfjs-dist v5 的 `TextLayer` 构造函数要求 `textContentSource` 是 `ReadableStream`。`page.getTextContent()` 返回的是已解析对象，传给 TextLayer 后报 "undefined is not a function (readableStream)" 但被静默吞掉。

**解决**：`page.streamTextContent()` 代替 `page.getTextContent()`。

**教训**：大版本升级后 API 签名可能变。错误被静默吞掉时，加日志是唯一的排查手段。

---

## 架构演进

| 阶段 | 方案 | 问题 |
|------|------|------|
| v1 | JS 算高度，inline style，`window.resize` | React timing 不同步 |
| v2 | `layoutWidth` state + `layoutWidthRef` | 连续 resize 时 ref 和 state 不一致 |
| v3 | CSS `aspect-ratio` + `ResizeObserver` | canvas `height:auto` 撑高容器 |
| v4 | + canvas `height:100%` + 新 canvas 策略 + fraction 检测 | ✅ 最终方案 |

**最终方案的原则**：
- **CSS 管布局**（aspect-ratio），JS 只管渲染质量（canvas/textLayer）
- **新建代替复用**（canvas），避免并发冲突
- **检测代替假设**（scroll fraction 差值），处理跨平台差异
