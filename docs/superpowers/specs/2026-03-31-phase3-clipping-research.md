# Phase 3: Web Page Clipping/Archiving Technical Research

## 1. Chrome `pageCapture.saveAsMHTML()` API

### Manifest V3 Status

**Available in MV3.** The API is listed in the current Chrome Extensions MV3 reference. It returns `Promise<Blob | undefined>` (Chrome 116+).

### Permissions

Requires `"pageCapture"` in the manifest `permissions` array.

### How It Works

```js
// In service worker (background.js)
const blob = await chrome.pageCapture.saveAsMHTML({ tabId });
// blob is a Blob containing the full MHTML
```

The API captures the **entire visible tab** including all subresources (images, CSS, fonts) into a single MHTML file (RFC 2557 multipart format).

### Service Worker Compatibility

The API is callable from the MV3 service worker. It takes a `tabId` and returns a Blob. The service worker does not need DOM access -- it delegates to the browser's internal page serialization engine.

### Limitations and Edge Cases

| Limitation | Detail |
|-----------|--------|
| **Full page only** | No option to capture a DOM subtree or selected region |
| **Tab must exist** | Requires an active tab ID; cannot capture in-memory HTML |
| **Dynamic content** | Captures the current rendered state, but lazy-loaded images that haven't loaded yet will be missing |
| **Service worker lifecycle** | MV3 service workers can be terminated after 30 seconds of inactivity. For very large pages, the MHTML generation might take time. The `chrome.pageCapture` call keeps the SW alive while running, but the subsequent upload to the local server must also complete before termination |
| **CSP/sandboxed pages** | Works on most pages, but `chrome://`, `chrome-extension://`, and some enterprise-policy-restricted pages may fail |
| **iframes** | Cross-origin iframes are included in MHTML but may have incomplete resources depending on CORS policies |
| **File size** | Image-heavy pages can produce MHTML files of 10-50MB+. Base64 encoding of binary parts inflates size ~33% |
| **No progress callback** | The API is all-or-nothing; no way to show progress for large pages |
| **MHTML rendering** | Chrome docs state: "For security reasons a MHTML file can only be loaded from the file system" and "can only be loaded in the main frame." This means rendering MHTML requires a custom protocol or file:// URL, not a simple blob URL |

### MHTML Format Notes

MHTML is a MIME multipart format:
```
From: <Saved by Chrome>
Subject: Page Title
MIME-Version: 1.0
Content-Type: multipart/related; boundary="----=_Part_123"

------=_Part_123
Content-Type: text/html
Content-Location: https://example.com/page

<html>...</html>

------=_Part_123
Content-Type: image/png
Content-Transfer-Encoding: base64
Content-Location: https://example.com/image.png

iVBORw0KGgo...

------=_Part_123--
```

Each subresource (CSS, images, fonts, JS) is a separate MIME part with its original URL as `Content-Location`. The HTML references resources by their original URLs, and the MHTML viewer resolves them to the corresponding MIME parts.

---

## 2. Zotero Connector

### Architecture

Zotero Connectors (browser extensions for Chrome/Firefox/Safari) communicate with the Zotero desktop app via **HTTP on `127.0.0.1:23119`**. All communication is **connector-initiated** -- the desktop app never pushes to the extension.

Key endpoints:
- `POST /connector/saveSnapshot` -- save a web page snapshot
- `POST /connector/saveItems` -- save bibliographic items
- `GET /connector/ping` -- health check
- `POST /connector/saveSingleFile` -- save SingleFile output (see below)

### How It Captures Web Pages

**Zotero adopted SingleFile** as its primary page capture engine (replacing its older snapshot mechanism). The flow is:

1. The connector injects SingleFile scripts into the page via content scripts
2. SingleFile processes the DOM in the content script context, fetching and inlining all resources
3. The resulting single HTML blob is sent to the background script
4. The background script POSTs the data to the Zotero desktop app's HTTP server at `127.0.0.1:23119`
5. For large payloads, the connector uses **multipart/form-data** encoding, converting SingleFile's binary arrays to Blobs before appending to FormData

Zotero also **throttles SingleFile's fetch requests** -- their code notes that "Singlefile likes to fire off 50 requests at once which doesn't seem healthy in general."

### Storage Format

Zotero stores snapshots as **single HTML files** (SingleFile output) in its data directory. The output is a self-contained HTML file with all resources inlined (base64 images, inline CSS, inline fonts). This replaced their older approach that stored snapshots as directories of files.

### Key Takeaway for Shibei

Zotero's architecture is **very similar to what Shibei plans**: browser extension -> HTTP POST to local server -> desktop app stores the file. The major difference is that Zotero uses SingleFile (single HTML) rather than Chrome's `pageCapture.saveAsMHTML()`.

---

## 3. SingleFile

### Overview

SingleFile (by gildas-lormeau, ~30k GitHub stars) is the most mature open-source solution for saving complete web pages as single files. It has a dedicated **MV3-compatible version** (SingleFile-MV3). Zotero adopted it as their primary snapshot engine.

**Note:** The user-provided GitHub URLs (`niclasgrunwald/singlefile` and `niclasgrunwald/singlefile-core`) are 404. The correct repositories are:
- Main: `github.com/gildas-lormeau/SingleFile`
- Core engine: `github.com/niclasgrunwald/single-file-core` (also 404 -- actual core is embedded in the main repo or at `github.com/niclasgrunwald/single-file-core`)
- MV3 version: `github.com/niclasgrunwald/SingleFile-MV3`

### Technical Approach

SingleFile works entirely in the **content script context** (runs on the page DOM):

1. **DOM Serialization**: Traverses the entire DOM tree, capturing the computed state
2. **CSS Processing**: 
   - Parses all stylesheets (inline, linked, @import chains)
   - Resolves CSS `url()` references (background images, fonts)
   - Removes unused CSS rules (tree-shaking based on which selectors match elements in the DOM)
   - Inlines everything as `<style>` blocks
3. **Image Handling**:
   - Fetches all images (img src, srcset, CSS backgrounds, favicons)
   - Converts to base64 data URIs and inlines them
   - Handles lazy-loaded images by scrolling or triggering load events
4. **Font Handling**:
   - Fetches web fonts referenced in @font-face rules
   - Converts to base64 data URIs
5. **Canvas/SVG**: Serializes canvas elements to data URIs, inlines SVG
6. **Shadow DOM**: Traverses and serializes shadow roots
7. **Minification**: Minifies HTML and CSS to reduce file size
8. **Frame Handling**: Recursively processes iframes and embeds

### Output Formats

- **Standard HTML**: Single `.html` file with everything inlined via base64 data URIs. Works in any browser without extensions. No JavaScript needed to render.
- **Self-extracting ZIP**: Compressed HTML that decompresses itself on load (smaller than base64 approach, but requires JS to render)
- Can also output MHTML and WebArchive formats

### SingleFile vs pageCapture.saveAsMHTML()

| Aspect | SingleFile | pageCapture.saveAsMHTML() |
|--------|-----------|--------------------------|
| **Execution context** | Content script (page DOM) | Browser internal API (service worker call) |
| **Output format** | Standard HTML (or ZIP/MHTML) | MHTML only |
| **Resource handling** | Fetches and inlines everything explicitly | Browser handles it internally |
| **Lazy-loaded images** | Has mechanisms to trigger lazy loading before capture | Captures current state only |
| **CSS pruning** | Removes unused CSS | Includes all CSS as-is |
| **Fidelity** | Very high -- captures computed styles | High -- but some dynamic content may be missed |
| **File size** | Often smaller (due to CSS pruning, minification) | Often larger (no optimization) |
| **Rendering compatibility** | Standard HTML -- works everywhere | MHTML -- needs MHTML-aware viewer |
| **Region selection** | Can be adapted to process a DOM subtree | Full page only |
| **Complexity** | Complex library (~10k+ LOC) | One API call |
| **Maintenance** | Third-party dependency | Chrome built-in |

### Using SingleFile as a Library

SingleFile's core engine can be used programmatically:

```js
// In content script
const options = {
  removeHiddenElements: true,
  removeUnusedStyles: true,
  removeUnusedFonts: true,
  compressHTML: true,
  // ... many options
};
const pageData = await singlefile.getPageData(options);
// pageData.content is the complete HTML string
// pageData.title, pageData.filename available too
```

The core engine (`single-file-core`) is designed to be embeddable. You provide a DOM and fetch implementation, and it handles the rest.

---

## 4. Area/Region Selection Saving

Three approaches compared:

### Approach A: Full MHTML + Region Marker

**How it works:** Save the entire page as MHTML, store a CSS selector or XPath identifying the selected region. When rendering, inject a script that highlights/scrolls to the region.

**Pros:**
- Simplest implementation -- reuse the full-page save pipeline
- Original context preserved (surrounding content viewable)
- No resource extraction complexity

**Cons:**
- Wastes storage (full page for a small region)
- Region identification can be fragile if the page structure is unusual
- Not a true "clip" -- user sees the full page with a highlighted section

**Implementation:**
```json
{
  "content_type": "mhtml",
  "selection": {
    "css_selector": "#article > .paragraph:nth-child(3)",
    "xpath": "/html/body/div[2]/article/p[3]",
    "bounding_rect": { "top": 200, "left": 50, "width": 600, "height": 400 }
  }
}
```

### Approach B: Extract DOM Subtree + Package Resources

**How it works:** In content script, extract the selected DOM subtree, resolve all its resource references, fetch them, and package as a self-contained HTML fragment.

**Pros:**
- Clean result -- only the selected content
- Smaller file size
- True clipping experience

**Cons:**
- **Most complex to implement**: Must resolve inherited CSS, extract only relevant styles, handle relative URLs, fetch cross-origin resources
- Styles may break: The subtree inherits styles from ancestors that won't be included. Need to compute and inline all inherited/cascading styles
- Layout may differ from original (missing parent flex/grid context)

**Implementation sketch:**
```js
// Content script
function extractRegion(element) {
  const clone = element.cloneNode(true);
  const computedStyles = getComputedStylesDeep(element); // recursive
  // Fetch images, resolve URLs, inline styles...
  return packageAsHTML(clone, computedStyles);
}
```

### Approach C: SingleFile-like Approach on DOM Subset

**How it works:** Use SingleFile's core engine (or a similar approach) but scoped to a selected DOM subtree instead of `document`.

**Pros:**
- Leverages proven resource resolution logic
- High fidelity -- SingleFile already handles edge cases
- Produces standard HTML output

**Cons:**
- SingleFile's core expects to process a full document; scoping to a subtree requires forking or wrapping
- Still needs to handle inherited styles from ancestor elements

**Implementation:** 
- Option 1: Clone the selected subtree into a new document, apply computed styles, then run SingleFile on that document
- Option 2: Run SingleFile on the full page, then extract the relevant section from the output (essentially Approach A with post-processing)

### Recommendation for Area Selection

**For v1.1+, use Approach A (Full page + region marker) with SingleFile output.** Rationale:

1. It reuses the full-page save pipeline, minimizing new code
2. The viewing experience is actually better -- user sees the clip in context, with the selected region highlighted and auto-scrolled
3. Storage cost is acceptable for a personal tool (most pages are 1-5MB)
4. If a "clip only" view is later desired, a rendering-time extraction can crop to the region

For a future v2 "true clip" feature, Approach C is the right path, but it requires significant investment in handling inherited styles and layout context.

---

## 5. MHTML vs Single HTML (with Inlined Resources)

### MHTML

**Format:** MIME multipart (RFC 2557). Each resource is a separate MIME part. The HTML references resources by original URL; the MHTML viewer resolves them internally.

**Pros:**
- Native Chrome API (`pageCapture.saveAsMHTML()`) -- one function call
- Binary resources stored efficiently (base64 within MIME parts, but no double-encoding)
- Well-understood standard format

**Cons:**
- **Rendering requires MHTML-aware viewer.** Browsers can render MHTML from `file://` only. In Tauri:
  - **macOS (WKWebView):** WKWebView does **not** natively support MHTML rendering. You would need to parse the MHTML on the Rust side, extract the HTML and resources, then serve them via a custom protocol handler that resolves resource URLs to the correct MIME parts. This is a significant implementation effort.
  - **Windows (WebView2):** WebView2 (Chromium-based) has better MHTML support, but loading from custom protocols may still require parsing.
- Parsing MHTML is non-trivial -- need a MIME multipart parser in Rust
- Cannot be opened directly in any browser without file:// or a browser that specifically supports it
- No CSS pruning or optimization

### Single HTML (SingleFile Output)

**Format:** Standard HTML file with all resources inlined as base64 data URIs in `src="data:..."` attributes and `url(data:...)` CSS values.

**Pros:**
- **Renders in any HTML viewer** -- no special parser needed. Works directly in WKWebView, WebView2, any browser
- In Tauri, just serve the HTML via custom protocol (`shibei://resource/{id}`) and it renders perfectly
- CSS is pruned (unused rules removed), HTML is minified -- often smaller than MHTML
- Single standard HTML file -- easy to export, share, open externally
- Proven approach (Zotero adopted it)
- Can handle lazy-loaded images better than pageCapture

**Cons:**
- Requires running SingleFile in the content script (more code in the extension)
- Dependency on third-party library (though very mature and well-maintained)
- Base64 encoding inflates binary resources by ~33% (though CSS pruning often compensates)
- Processing time is visible to the user (seconds, not instant like pageCapture)
- Potential issues with very complex pages (rare edge cases)

### Head-to-Head for Shibei

| Factor | MHTML (pageCapture) | Single HTML (SingleFile) |
|--------|---------------------|--------------------------|
| **Implementation effort (extension)** | Minimal -- one API call | Moderate -- integrate SingleFile lib |
| **Implementation effort (Tauri reader)** | **High** -- need MHTML parser + custom resource resolver | **Low** -- serve HTML, it just works |
| **WKWebView (macOS) rendering** | Does not work natively | Works perfectly |
| **WebView2 (Windows) rendering** | Partial support | Works perfectly |
| **File quality** | Good | Better (CSS pruning, lazy-load handling) |
| **File size** | Larger | Smaller (typically) |
| **Region selection (v1.1+)** | Cannot scope to a region | Can potentially scope to subtree |
| **External viewability** | Only Chrome can open | Any browser can open |
| **Maintenance risk** | Chrome built-in (stable) | Third-party library (actively maintained, 30k stars) |

### Critical Finding: WKWebView + MHTML

**This is the most important finding of this research.** On macOS, Tauri uses WKWebView, which **does not support MHTML natively**. If you use `pageCapture.saveAsMHTML()`, you will need to:

1. Parse the MHTML file in Rust (implement or find a MIME multipart parser)
2. Extract the main HTML document and all resource parts
3. Implement a custom protocol handler that:
   - Serves the main HTML for `shibei://resource/{id}`
   - Intercepts all subresource requests and serves the correct MIME part based on the `Content-Location` URL matching

This is a **substantial amount of work** and a major source of potential bugs (URL matching, encoding issues, relative URLs, etc.).

With SingleFile HTML output, the Tauri custom protocol handler simply reads the file and returns it. All resources are already inlined. Done.

---

## 6. Recommendations

### MVP: Full Page Save

**Use SingleFile, not pageCapture.saveAsMHTML().**

Rationale:
1. **WKWebView compatibility** is the deciding factor. MHTML does not render in WKWebView without building a custom MHTML parser and resource server in Rust. SingleFile HTML output works immediately.
2. **Better quality** -- SingleFile handles lazy-loaded images, prunes unused CSS, and produces cleaner output
3. **Zotero validates this approach** -- they switched from their custom snapshot engine to SingleFile for the same reasons
4. **Simpler Tauri reader** -- just serve the HTML file via custom protocol, inject annotation scripts, done
5. **Region selection path** -- SingleFile can be adapted for subtree capture in v1.1+

**Implementation plan:**

1. **Extension:** Bundle SingleFile's core engine (or the single-file-core library) as a content script dependency
2. **Capture flow:**
   ```
   User clicks extension -> Content script runs SingleFile -> 
   SingleFile produces HTML string -> Background script receives it ->
   POST to Tauri HTTP server (base64 encoded) -> 
   Tauri saves as .html file + SQLite metadata
   ```
3. **Tauri reader:** Custom protocol `shibei://resource/{id}` reads the `.html` file from disk and returns it with `Content-Type: text/html`
4. **Annotation injection:** `with_initialization_script()` works on standard HTML -- no CSP issues since the saved file has no CSP headers

**Changes to design doc:**
- Change storage format from `snapshot.mhtml` to `snapshot.html`
- Change `content_type` values from `"mhtml"` to `"html"` (full page) and keep `"html_fragment"` for region selection
- Remove the need for MHTML parsing in Rust backend
- Add SingleFile as an extension dependency

### v1.1+: Area Selection Save

**Use Approach A: Full page SingleFile save + region marker.**

1. User enters selection mode (content script adds overlay)
2. User clicks a DOM element to select it
3. Content script records a stable selector (CSS selector path + text content fingerprint)
4. Full page is saved with SingleFile (same as MVP flow)
5. Region metadata is stored alongside the resource:
   ```json
   {
     "selection": {
       "css_selector": ".article-body > p:nth-child(3)",
       "text_fingerprint": "first 50 chars of selected text...",
       "bounding_rect": { "top": 200, "left": 50, "width": 600, "height": 400 }
     }
   }
   ```
6. Tauri reader injects a script that scrolls to and highlights the selected region
7. UI provides a toggle between "full page view" and "selection only view" (the latter hides everything outside the selected region via CSS)

This approach requires minimal new code beyond the selection UI overlay, and reuses the entire MVP save pipeline.

### Fallback Consideration

If integrating SingleFile proves too complex for MVP (large dependency, licensing concerns, etc.), a **hybrid approach** is viable:

1. Use `pageCapture.saveAsMHTML()` for capture (one API call, no dependencies)
2. In the Tauri backend, parse MHTML and **convert to single HTML** before storage:
   - Use a Rust MHTML parser (crate `mail-parser` or custom)
   - Extract HTML + resources
   - Rewrite resource URLs to inline data URIs
   - Save the converted single HTML file

This gives you the simplicity of pageCapture on the extension side while still getting the WKWebView-compatible HTML output. The downside is the conversion step adds complexity to the Rust backend.

---

## 7. Licensing

- **SingleFile** is licensed under **AGPL-3.0**. This is important: if you distribute Shibei with SingleFile bundled, AGPL requires you to make the source code available. For a personal tool this may not matter, but for any future distribution it does. The `single-file-core` engine may have different licensing terms -- check before integrating.
- **pageCapture API** has no licensing concerns (Chrome built-in).

If AGPL is a concern, the fallback approach (pageCapture + server-side MHTML-to-HTML conversion) avoids the licensing issue entirely.

---

## 8. Summary Decision Matrix

| Criterion | pageCapture + MHTML | SingleFile HTML | pageCapture + convert to HTML |
|-----------|-------------------|-----------------|-------------------------------|
| Extension complexity | Low | Moderate | Low |
| Backend complexity | **High** (MHTML parser) | Low | Moderate (MHTML parser + converter) |
| WKWebView rendering | Needs parser | Works directly | Works directly |
| Capture quality | Good | Better | Good (same as pageCapture) |
| Region selection path | Blocked | Possible | Blocked (same as pageCapture) |
| Dependencies | None | SingleFile (AGPL) | MHTML parser crate |
| **Total effort** | **High** | **Low-Moderate** | **Moderate** |

**Primary recommendation: SingleFile HTML for MVP.**
**Fallback: pageCapture + Rust MHTML-to-HTML converter if AGPL is a concern.**
