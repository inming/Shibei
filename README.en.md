<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Shibei" width="128" />
</p>

<h1 align="center">Shibei · 拾贝</h1>

<p align="center">
  <strong>A read-only personal reference library — clip web pages & PDFs, highlight, annotate in Markdown, local-first, end-to-end encrypted sync, AI-native.</strong>
</p>

<p align="center">
  <a href="README.md">中文</a> · <strong>English</strong> ·
  <a href="LICENSE">AGPL-3.0</a>
</p>

---

## What is it

Shibei is a **read-only personal reference library** desktop app that **treats AI as a first-class citizen from day one**. It saves articles, technical documents, and PDFs you encounter online to your local disk, lets you read them with their original layout preserved, lets you highlight and annotate with Markdown — **and then exposes everything you've collected, annotated, and noted to Claude / Cursor / Windsurf / OpenCode via a bundled MCP Server**. Like Zotero without the citation-management complexity; like Joplin but with immutable snapshots so the content you see today is what you'll see five years from now; unlike either, **it was never designed to be a silo that only humans can read.**

### Design principles

- **AI-native**: your library is long-term memory for your AI workflow, not a dead archive. The MCP Server is built in, not bolted on: 9 tools covering search / fetch / annotate / organize; plain text is extracted at save time; structured metadata (tags, folders, highlight anchors) is inherently AI-friendly; one-click auto-configuration into the major AI clients
- **Read-only**: imported content is never rewritten; annotations live alongside, not inside — AI always reads the original snapshot, untainted by later edits
- **Local-first**: everything lives in local SQLite + filesystem; cloud sync is opt-in; AI calls go over local stdio, so sensitive material never leaves your machine
- **Original layout**: web pages are saved as single inlined HTML via SingleFile — offline, identical to the source
- **Annotations decoupled from content**: re-importing or re-syncing the source never loses your highlights, and never pollutes the text you hand to AI

## Features

**Clipping & import**
- Chrome extension: one-click save the current page (full page)
- Region clip: hover → click to pick a DOM subtree → extracted with ancestor chain for style inheritance
- Local PDF import (right-click → "Import file")
- Snapshots stored as SingleFile HTML, all assets inlined

**Reading**
- Custom protocol `shibei://resource/{id}` renders snapshots in a WebView
- PDFs rendered with pdfjs-dist (canvas + text layer + text selection)
- Immersive mode (scroll down hides meta bar) + top progress bar
- Reader / annotation panel split pane with drag-to-resize and collapse

**Annotations**
- Highlights (8 colors × light/dark variants)
- Per-highlight comments with Markdown rendering (react-markdown + remark-gfm)
- Resource-level notes, also Markdown
- Deep-linkable: `shibei://open/resource/{id}?highlight={hlId}`

**Organization & search**
- Folder hierarchy (drag-and-drop, multi-select, system-preset Inbox)
- Tags (multi-color, multi-select OR filter)
- Full-text search: FTS5 trigram across title / URL / description / highlights / comments / snapshot body — with match-field tags and snippet highlighting

**Sync & security**
- S3-compatible cloud sync (HLC clock + LWW conflict resolution)
- End-to-end encryption: XChaCha20-Poly1305, Argon2id-derived password, master key `Zeroizing`-protected at runtime
- App lock screen (password unlock; deep links buffered until unlocked)
- Local backup & restore (zip: manifest + database + snapshots)

**AI integration**
- Bundled MCP Server (9 tools: `search_resources` / `get_resource` / `get_annotations` / `get_resource_content` / `list_folders` / `list_tags` / `update_resource` / `manage_tags` / `manage_notes`)
- One-click auto-configuration into Claude Desktop / Cursor / Windsurf / OpenCode, with diff preview before writing

**Polish**
- Dark mode (`light` / `dark` / `system`, CSS variable swap)
- Bilingual (i18next, 11 namespaces — zh / en)
- Session persistence: tabs, scroll positions, library selection all restored on restart
- Viewport-aware context menus (`useFlipPosition` / `useSubmenuPosition` hooks + ResizeObserver for async submenu content)
- Single-instance with deep-link forwarding

## Stack

| Layer | Tech |
|-------|------|
| Desktop | Tauri 2.x (Rust backend) |
| Frontend | React 19 + TypeScript + Vite |
| Database | SQLite (rusqlite bundled, FTS5 trigram, r2d2 pool) |
| Local HTTP | axum (127.0.0.1:21519, extension-only) |
| Browser extension | Chrome MV3 + SingleFile |
| PDF rendering | pdfjs-dist 5.x |
| PDF text extraction | `pdf-extract` crate (with `catch_unwind`) |
| Cloud storage | `rust-s3`, custom endpoints supported |
| Crypto | `chacha20poly1305` + `argon2` + `hkdf` + `zeroize` |
| MCP | `@modelcontextprotocol/sdk` (Node.js stdio) |
| i18n | i18next + react-i18next |
| Markdown | react-markdown + remark-gfm |

## Quick start

### Prerequisites

- Node.js ≥ 20
- Rust stable (with `cargo`)
- macOS / Linux / Windows (verified on macOS Sequoia)

### Dev

```bash
npm install
npm run tauri dev

# With debug log (frontend debugLog writes to {data_dir}/debug.log)
VITE_DEBUG=1 npm run tauri dev
```

### Release build

```bash
npm run tauri build
# Artifacts at src-tauri/target/release/bundle/
```

### Install the Chrome extension (dev)

1. Open `chrome://extensions/`, enable Developer mode
2. Click "Load unpacked", pick the `extension/` directory
3. Start the desktop app, click the extension icon to verify the connection

The extension talks to the desktop app via `chrome.runtime.sendMessage` → Background Service Worker → `127.0.0.1:21519`. Only the background's `chrome-extension://` origin is exempt from Chrome's Private Network Access prompt, so all local HTTP calls are funneled through it.

### Tests

```bash
# Frontend (Vitest)
npx vitest run --dir src

# Backend (Cargo)
cd src-tauri && cargo test

# Type check
npx tsc --noEmit
```

## Layout

```
src-tauri/          Rust backend (Tauri core + commands + db + sync + storage)
src/                React frontend (components / hooks / lib / locales)
extension/          Chrome extension (MV3 + SingleFile)
mcp/                MCP Server (Node.js, stdio transport)
docs/               Design docs & implementation plans (Chinese)
```

Architecture, DB migrations, sync conflict resolution, etc. documented in [CLAUDE.md](CLAUDE.md) and [`docs/superpowers/specs/`](docs/superpowers/specs/).

## License

[AGPL-3.0](LICENSE) © inming. Because snapshots are packaged with [SingleFile](https://github.com/gildas-lormeau/SingleFile) (AGPL-3.0), this project is AGPL-3.0 as well.
