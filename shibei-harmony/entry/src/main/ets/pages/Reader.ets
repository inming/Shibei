import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { promptAction } from '@kit.ArkUI';
import { common, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { pasteboard, BusinessError } from '@kit.BasicServicesKit';
import { media } from '@kit.MediaKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { ShibeiService, Resource, Comment, Highlight } from '../services/ShibeiService';
import { AnnotationsService } from '../services/AnnotationsService';
import {
  AnnotationBridge,
  SelectionPayload,
  ClickPayload,
  ReadyPayload,
  ZoomPayload,
} from '../components/AnnotationBridge';
import { AnnotationPanel } from '../components/AnnotationPanel';
import { AnnotationsBundle } from '../services/ShibeiService';
import { I18n } from '../services/I18n';
import { getReaderScroll, saveReaderScroll } from '../app/ReaderScrollState';
import {
  getReaderZoom,
  saveReaderZoom,
  clampZoom,
  PDF_ZOOM_MIN,
  PDF_ZOOM_MAX,
  PDF_ZOOM_DEFAULT,
  PDF_ZOOM_STEP,
} from '../app/ReaderZoomState';
import { SessionState } from '../app/SessionState';

// Route param shape.
interface ReaderParams { resourceId?: string; highlightId?: string; }

// Palette shown in the selection action bar. Order left→right matches
// the desktop picker. Yellow is the first tap position since it's the
// historical default.
//
// `value` is the CSS color used both as paint and as data key for
// createHighlight — it MUST NOT change without coordinating with desktop
// annotation storage. The palette only renders colored circles, so no
// label field is needed; if a future tooltip/a11y pass needs one,
// look up reader_hl_color_{yellow,green,blue,pink} via I18n.t.
interface HlColor { value: string; }
const HL_COLORS: HlColor[] = [
  { value: '#ffeb3b' },
  { value: '#81c784' },
  { value: '#64b5f6' },
  { value: '#f48fb1' },
];

// Audio playback speeds. Limited to the AVPlayer PlaybackSpeed enum values
// (no 1.5x — the enum jumps 1.25 → 1.75).
const AUDIO_SPEEDS: number[] = [0.75, 1.0, 1.25, 1.75, 2.0];
const AUDIO_SKIP_MS: number = 15000;

// Transcript (transcript.json) shape — mirrors the desktop format.
interface TranscriptSegment { start: number; end: number; text: string; }
interface TranscriptDoc { version?: number; language?: string; segments?: TranscriptSegment[]; }
// Just the fields we read off an audio highlight's opaque anchor.
interface AudioAnchorLite { type?: string; start?: number; end?: number; }

// Header row shape for WebResourceResponse.setResponseHeader. ArkTS strict
// mode rejects inline object-literal types, so we pin the shape here.
interface WebHeader { headerKey: string; headerValue: string; }

@Entry
@Component
struct Reader {
  @State resource: Resource | null = null;
  @State loading: boolean = true;
  @State loadError: string = '';
  @State bundle: AnnotationsBundle = { highlights: [], comments: [] };
  @State panelOpen: boolean = false;
  // When the user taps a highlight in the Web, we open the panel AND tell it
  // which card to flash + scroll to. Cleared by AnnotationPanel once the
  // flash animation settles so the next tap on the same id re-fires.
  @State focusedHighlightId: string = '';
  @State pendingSelection: SelectionPayload | null = null;
  @State commentDialogOpen: boolean = false;
  @State commentDialogId: string | null = null;  // null = new resource-level note
  // Set when "+ 评论" is tapped on a highlight card — attaches the new
  // comment to that highlight. null means a free-standing resource note.
  @State commentDialogHighlightId: string | null = null;
  @State commentDialogDraft: string = '';
  // PDF branch state (Phase 3b). pdfDownloading covers the
  // ensurePdfDownloaded RPC to S3; pdfReady flips true once the bytes are
  // confirmed on disk and the shell can load. pdfError holds an i18n-style
  // code for the retry panel.
  @State pdfReady: boolean = false;
  @State pdfDownloading: boolean = false;
  @State pdfError: string = '';
  // PDF zoom is the shell's zoomFactor, initialized from prefs inside
  // ensurePdfReady so the Web src (built in PdfContent) already carries
  // ?zoom=X on first render — avoids an initial 1.0 rebuild.
  @State pdfZoom: number = PDF_ZOOM_DEFAULT;
  // Debounce persistence of zoom changes — a rapid tap on +/- shouldn't
  // flush preferences N times. Same 500ms cadence as scroll save.
  private zoomSaveTimer: number = -1;

  // Audio branch state (Phase C). audioReady flips true once the AVPlayer
  // reaches 'prepared' and duration is known; the transport gates on it.
  @State audioReady: boolean = false;
  @State audioDownloading: boolean = false;
  @State audioError: string = '';
  @State isPlaying: boolean = false;
  @State currentTimeMs: number = 0;
  @State durationMs: number = 0;
  @State playbackSpeed: number = 1.0;
  private avPlayer: media.AVPlayer | null = null;
  private audioFd: number = -1;
  // True while the user is dragging the seek bar — suppresses timeUpdate so the
  // thumb doesn't fight the finger.
  private seeking: boolean = false;
  // Transcript segments (empty if not transcribed / not synced yet).
  @State segments: TranscriptSegment[] = [];
  // Currently-playing segment for karaoke follow; -1 = none.
  @State activeSeg: number = -1;
  private transcriptScroller: Scroller = new Scroller();

  private webController: webview.WebviewController = new webview.WebviewController();
  private bridge: AnnotationBridge = new AnnotationBridge({
    onSelection: (p: SelectionPayload) => this.handleSelection(p),
    onClick: (p: ClickPayload) => this.handleClick(p),
    onReady: (p: ReadyPayload) => this.handleReady(p),
    onZoom: (p: ZoomPayload) => this.handleZoom(p),
  });
  private unsubscribe: (() => void) | null = null;
  // Debounce scroll persistence — onScroll fires continuously during a
  // flick and we don't want to hammer preferences.
  private scrollSaveTimer: number = -1;
  private lastScrollY: number = 0;
  private restoredScroll: boolean = false;
  private initialHighlightId: string = '';

  aboutToAppear(): void {
    const raw = router.getParams();
    const params: ReaderParams = raw ? (raw as ReaderParams) : {};
    const id = params.resourceId ?? '';
    // highlightId from deep link — flashed after the page is ready.
    this.initialHighlightId = params.highlightId ?? '';
    if (!id) {
      this.loadError = 'error.missingResourceId';
      this.loading = false;
      return;
    }
    try {
      this.resource = ShibeiService.instance.getResource(id);
      if (!this.resource) {
        this.loadError = 'error.resourceNotFound';
        this.loading = false;
        return;
      }
      // Branch HTML vs PDF. PDFs skip the synchronous getResourceHtml
      // (no HTML snapshot on disk) and instead kick off ensurePdfReady
      // which may download snapshot.pdf via S3 sync. The Reader shell is
      // shown immediately; the inner Stack drives the download/error/ready
      // state.
      //
      // HTML gets the same treatment (§7.2): Phase 5.1's sync engine no
      // longer pulls snapshots eagerly, so first read may need to fetch
      // from S3. Keep the `loading` flag up during download — annotator
      // load + paint waits on it.
      if (this.resource.resource_type === 'pdf') {
        this.loading = false;
        this.ensurePdfReady(id);
      } else if (this.resource.resource_type === 'audio') {
        this.loading = false;
        this.ensureAudioReady(id);
      } else {
        this.ensureHtmlReady(id);
      }
    } catch (err) {
      this.loadError = (err as Error).message;
      this.loading = false;
      hilog.error(0x0000, 'shibei', 'Reader init fail: %{public}s', this.loadError);
      return;
    }
    // Load cached annotations; fire-and-forget refresh.
    AnnotationsService.instance.load(id).then((b: AnnotationsBundle) => {
      this.bundle = b;
      this.paintHighlights();
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'annotations load fail: %{public}s', err.message);
    });
    this.unsubscribe = AnnotationsService.instance.subscribe(id, (b: AnnotationsBundle) => {
      this.bundle = b;
      this.paintHighlights();
    });
  }

  aboutToDisappear(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.unsubscribe = null;
    // Flush any pending scroll save so we don't lose the last 500ms.
    if (this.scrollSaveTimer !== -1) {
      clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = -1;
      this.flushScroll();
    }
    if (this.zoomSaveTimer !== -1) {
      clearTimeout(this.zoomSaveTimer);
      this.zoomSaveTimer = -1;
      this.flushZoom();
    }
    this.releaseAudio();
  }

  // System back / edge swipe: if the annotation panel is open, the first
  // back closes it (consume). If it's already closed, let the OS pop the
  // route to Library. Save inReader=false only on explicit back — NOT in
  // aboutToDisappear (which fires on task-switcher kill too).
  onBackPress(): boolean {
    if (this.panelOpen) {
      this.setPanelOpen(false);
      return true;
    }
    this.leaveReader();
    return true;
  }

  private async leaveReader(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await SessionState.save(ctx, { inReader: false, readerResourceId: null });
    router.back();
  }

  private flushScroll(): void {
    if (!this.resource) return;
    const ctx = getContext(this) as common.UIAbilityContext;
    saveReaderScroll(ctx, this.resource.id, this.lastScrollY).catch(() => {});
  }

  private scheduleScrollSave(): void {
    if (this.scrollSaveTimer !== -1) clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = setTimeout(() => {
      this.scrollSaveTimer = -1;
      this.flushScroll();
    }, 500);
  }

  private flushZoom(): void {
    if (!this.resource) return;
    const ctx = getContext(this) as common.UIAbilityContext;
    saveReaderZoom(ctx, this.resource.id, this.pdfZoom).catch(() => {});
  }

  private scheduleZoomSave(): void {
    if (this.zoomSaveTimer !== -1) clearTimeout(this.zoomSaveTimer);
    this.zoomSaveTimer = setTimeout(() => {
      this.zoomSaveTimer = -1;
      this.flushZoom();
    }, 500);
  }

  // Drive the shell's zoomFactor from ArkTS. Clamp here so the Web side
  // never sees an out-of-range value; the shell also clamps defensively.
  private applyPdfZoom(next: number): void {
    const z = clampZoom(next);
    if (Math.abs(z - this.pdfZoom) < 0.001) return;
    this.pdfZoom = z;
    this.webController.runJavaScript(
      `window.__shibeiReader && window.__shibeiReader.setZoom(${z});`
    ).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'setZoom fail: %{public}s', err.message);
    });
    this.scheduleZoomSave();
  }

  private async restoreScrollIfNeeded(): Promise<void> {
    if (this.restoredScroll || !this.resource) return;
    this.restoredScroll = true;
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const y = await getReaderScroll(ctx, this.resource.id);
      if (y > 0) {
        // scrollTo in pixels; Web's own scroll offset accepts 0-based y.
        this.webController.scrollTo(0, y);
      }
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'restoreScroll fail: %{public}s',
        (err as Error).message);
    }
  }

  /// Ensure snapshot.html is on disk, pulling via sync if missing (§7.2).
  /// Fast path when the file already exists. On failure we fall through to
  /// loadError so Reader shows the error card instead of a blank page.
  ///
  /// The HTML itself is NOT preloaded into ArkTS memory anymore — the Web
  /// component navigates to `shibei-html://resource/{id}` and our
  /// `handleHtmlIntercept` serves the bytes straight from NAPI when
  /// Chromium asks. This bypasses ArkWeb's silent string-size ceiling on
  /// `loadData(string)` that broke ~28 MB pages.
  private async ensureHtmlReady(id: string): Promise<void> {
    try {
      await ShibeiService.instance.ensureHtmlDownloaded(id);
      this.loading = false;
    } catch (err) {
      this.loadError = (err as Error).message;
      this.loading = false;
      hilog.warn(0x0000, 'shibei', 'ensureHtmlReady fail %{public}s: %{public}s',
        id, this.loadError);
    }
  }

  /// Retry handler for the HTML error card. Clears error + resets
  /// loading flag so the Stack returns to the spinner branch, then
  /// re-runs ensureHtmlReady. No-op if resource failed to load at all
  /// (e.g. bad route params) — the retry button still shows but the
  /// subsequent attempt will re-raise the same error.
  private retryHtmlLoad(): void {
    if (!this.resource) return;
    this.loadError = '';
    this.loading = true;
    this.ensureHtmlReady(this.resource.id);
  }

  // Ensure the PDF is on local disk. Fast path (file exists) resolves
  // immediately; slow path pulls via shibei-sync's download_snapshot and
  // the UI sits on the "正在下载 PDF…" panel during the RPC. On any error
  // we surface the message into `pdfError` so the retry button appears.
  private async ensurePdfReady(id: string): Promise<void> {
    this.pdfError = '';
    this.pdfDownloading = true;
    try {
      // Load the saved zoom BEFORE flipping pdfReady — the Web src in
      // PdfContent embeds `?zoom=X` and is evaluated exactly once, so
      // the shell sees the final zoom on first pdfjs init and we skip
      // the would-be 1.0 → saved rebuild.
      const ctx = getContext(this) as common.UIAbilityContext;
      const savedZoom = await getReaderZoom(ctx, id);
      this.pdfZoom = clampZoom(savedZoom);
      await ShibeiService.instance.ensurePdfDownloaded(id);
      this.pdfReady = true;
      this.pdfDownloading = false;
    } catch (err) {
      this.pdfError = (err as Error).message;
      this.pdfDownloading = false;
      hilog.warn(0x0000, 'shibei', 'ensurePdfReady fail %{public}s: %{public}s',
        id, this.pdfError);
    }
  }

  // ── Audio branch (Phase C) ──────────────────────────────────

  // Ensure the audio file is on disk (download if missing), then start the
  // AVPlayer from its file descriptor. Audio plays directly from the sandbox
  // file — no bytes cross the NAPI boundary (unlike pdf/html).
  private async ensureAudioReady(id: string): Promise<void> {
    this.audioError = '';
    this.audioDownloading = true;
    try {
      const path = await ShibeiService.instance.ensureAudioDownloaded(id);
      this.audioDownloading = false;
      this.loadTranscript(id);
      await this.initAvPlayer(path);
    } catch (err) {
      this.audioDownloading = false;
      this.audioError = (err as Error).message;
      hilog.warn(0x0000, 'shibei', 'ensureAudioReady fail %{public}s: %{public}s',
        id, this.audioError);
    }
  }

  private async initAvPlayer(path: string): Promise<void> {
    const player: media.AVPlayer = await media.createAVPlayer();
    this.avPlayer = player;

    player.on('stateChange', (state: media.AVPlayerState) => {
      if (state === 'initialized') {
        player.prepare();
      } else if (state === 'prepared') {
        this.durationMs = player.duration;
        this.audioReady = true;
      } else if (state === 'playing') {
        this.isPlaying = true;
      } else if (state === 'paused' || state === 'completed') {
        this.isPlaying = false;
      }
    });
    player.on('timeUpdate', (time: number) => {
      if (!this.seeking) {
        this.currentTimeMs = time;
        this.updateActiveSeg(true);
      }
    });
    player.on('durationUpdate', (d: number) => {
      this.durationMs = d;
    });
    player.on('error', (err: BusinessError) => {
      this.audioError = `error.audioPlayback:${err.code}`;
      hilog.error(0x0000, 'shibei', 'AVPlayer error: %{public}d %{public}s',
        err.code, err.message);
    });

    // Open the sandbox file read-only and hand AVPlayer the fd. Setting fdSrc
    // drives the player to 'initialized' → prepare() → 'prepared'.
    const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    this.audioFd = file.fd;
    player.fdSrc = { fd: file.fd };
  }

  private togglePlay(): void {
    const p = this.avPlayer;
    if (!p || !this.audioReady) return;
    if (this.isPlaying) {
      p.pause();
    } else {
      p.play();
    }
  }

  private seekTo(ms: number): void {
    const p = this.avPlayer;
    if (!p || !this.audioReady) return;
    const clamped = Math.max(0, Math.min(ms, this.durationMs));
    p.seek(clamped, media.SeekMode.SEEK_CLOSEST);
    this.currentTimeMs = clamped;
    this.updateActiveSeg(false);
  }

  private skipBy(deltaMs: number): void {
    this.seekTo(this.currentTimeMs + deltaMs);
  }

  private applySpeed(speed: number): void {
    const p = this.avPlayer;
    if (!p || !this.audioReady) return;
    this.playbackSpeed = speed;
    p.setSpeed(this.speedEnum(speed));
  }

  private speedEnum(speed: number): media.PlaybackSpeed {
    if (speed <= 0.75) return media.PlaybackSpeed.SPEED_FORWARD_0_75_X;
    if (speed <= 1.0) return media.PlaybackSpeed.SPEED_FORWARD_1_00_X;
    if (speed <= 1.25) return media.PlaybackSpeed.SPEED_FORWARD_1_25_X;
    if (speed <= 1.75) return media.PlaybackSpeed.SPEED_FORWARD_1_75_X;
    return media.PlaybackSpeed.SPEED_FORWARD_2_00_X;
  }

  private releaseAudio(): void {
    const p = this.avPlayer;
    this.avPlayer = null;
    if (p) {
      p.release().catch((err: Error) => {
        hilog.warn(0x0000, 'shibei', 'AVPlayer release fail: %{public}s', err.message);
      });
    }
    if (this.audioFd >= 0) {
      try {
        fs.closeSync(this.audioFd);
      } catch (err) {
        hilog.warn(0x0000, 'shibei', 'audio fd close fail: %{public}s', (err as Error).message);
      }
      this.audioFd = -1;
    }
  }

  private formatMs(ms: number): string {
    const totalSec = ms > 0 ? Math.floor(ms / 1000) : 0;
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    const mm = m < 10 ? `0${m}` : `${m}`;
    const ss = s < 10 ? `0${s}` : `${s}`;
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  private loadTranscript(id: string): void {
    try {
      const raw = ShibeiService.instance.getTranscript(id);
      if (!raw) {
        this.segments = [];
        return;
      }
      const doc = JSON.parse(raw) as TranscriptDoc;
      this.segments = doc.segments ?? [];
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'loadTranscript fail: %{public}s', (err as Error).message);
      this.segments = [];
    }
  }

  // Recompute the active (currently-playing) segment; when `follow` and playing,
  // keep it centered in the transcript list (karaoke scroll).
  private updateActiveSeg(follow: boolean): void {
    if (this.segments.length === 0) return;
    const t = this.currentTimeMs / 1000;
    let idx = -1;
    for (let i = 0; i < this.segments.length; i++) {
      if (t >= this.segments[i].start && t < this.segments[i].end) {
        idx = i;
        break;
      }
    }
    if (idx === this.activeSeg) return;
    this.activeSeg = idx;
    if (follow && this.isPlaying && idx >= 0) {
      this.transcriptScroller.scrollToIndex(idx, true, ScrollAlign.CENTER);
    }
  }

  // Translucent tint (#AARRGGBB) for a transcript segment overlapped by a
  // highlight, or '' if none. Half-open overlap so a highlight ending on a
  // boundary doesn't bleed into the neighbor; point markers tint their segment.
  private highlightTintForSeg(seg: TranscriptSegment): string {
    for (const h of this.bundle.highlights) {
      const a = h.anchor as AudioAnchorLite;
      if (!a || a.type !== 'audio' || typeof a.start !== 'number') continue;
      const end = typeof a.end === 'number' ? a.end : a.start;
      const covered = end <= a.start
        ? (a.start >= seg.start && a.start < seg.end)
        : (a.start < seg.end && seg.start < end);
      if (covered) return `#66${h.color.replace('#', '')}`;
    }
    return '#00000000';
  }

  // Start time (ms) of an audio highlight's anchor, or -1 if not an audio anchor.
  private audioAnchorStartMs(h: Highlight): number {
    const a = h.anchor as AudioAnchorLite;
    if (a && a.type === 'audio' && typeof a.start === 'number') {
      return Math.round(a.start * 1000);
    }
    return -1;
  }

  private paintHighlights(): void {
    if (!this.resource || this.resource.resource_type === 'audio') {
      return;
    }
    const json = JSON.stringify(this.bundle.highlights);
    // Escape single quotes and backslashes for safe interpolation into the JS string.
    const safe = json.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    this.webController.runJavaScript(`window.__shibei && window.__shibei.paintHighlights('${safe}');`)
      .catch((err: Error) => {
        hilog.warn(0x0000, 'shibei', 'paintHighlights fail: %{public}s', err.message);
      });
  }

  private handleSelection(p: SelectionPayload): void {
    if (p.collapsed || !p.textContent || !p.anchor) {
      this.pendingSelection = null;
      return;
    }
    this.pendingSelection = p;
  }

  private handleClick(p: ClickPayload): void {
    if (!p.highlightId) {
      return;
    }
    // Re-setting to the same id wouldn't re-fire AnnotationPanel's
    // @Watch; prepend an incrementing counter so every tap triggers the
    // flash even if the user keeps tapping the same highlight.
    this.focusedHighlightId = `${Date.now()}:${p.highlightId}`;
    this.setPanelOpen(true);
  }

  /// Toggle AnnotationPanel inside animateTo so the SideBarContainer width
  /// and the scrim interpolate. 260ms / FastOutSlowIn matches the folder
  /// drawer on Library for visual parity.
  private setPanelOpen(open: boolean): void {
    animateTo({ duration: 260, curve: Curve.FastOutSlowIn }, () => {
      this.panelOpen = open;
    });
  }

  // Shell-driven zoom settle — fired after pinch gestures resolve OR after
  // our own applyPdfZoom → setZoom round-trip. In both cases we mirror the
  // value into @State so the toolbar percentage stays truthful, and debounce
  // a prefs save. The runJavaScript path is NOT invoked here (shell already
  // has the state); would cause a redundant rebuild.
  private handleZoom(p: ZoomPayload): void {
    if (typeof p.zoom !== 'number') return;
    const z = clampZoom(p.zoom);
    if (Math.abs(z - this.pdfZoom) < 0.001) return;
    this.pdfZoom = z;
    this.scheduleZoomSave();
  }

  private handleReady(_: ReadyPayload): void {
    this.paintHighlights();
    // Web reports DOMContentLoaded inside the iframe; safe to restore scroll now.
    // PDF shell also emits 'ready' via window.shibeiBridge once pdfjs has
    // finished the initial document parse, so this path covers both branches.
    this.restoreScrollIfNeeded();
    // Flash the highlight from a deep link, if any.
    if (this.initialHighlightId) {
      this.flashHighlight(this.initialHighlightId);
      this.initialHighlightId = '';
    }
  }

  private createHighlightWithColor(color: string): void {
    const sel = this.pendingSelection;
    if (!sel || !this.resource || !sel.textContent || !sel.anchor) {
      return;
    }
    try {
      AnnotationsService.instance.createHighlight(
        this.resource.id,
        sel.textContent,
        sel.anchor,
        color,
      );
      this.pendingSelection = null;
      if (!this.isAudio()) {
        this.webController.runJavaScript(`window.__shibei && window.__shibei.clearSelection();`)
          .catch(() => {});
      }
    } catch (err) {
      promptAction.showToast({
        message: I18n.t($r('app.string.reader_create_failed'), (err as Error).message),
      });
    }
  }

  private isAudio(): boolean {
    return !!this.resource && this.resource.resource_type === 'audio';
  }

  private flashHighlight(id: string): void {
    // Audio has no Web component bound to webController — runJavaScript would
    // throw synchronously (the .catch can't help). Instead, seek to the
    // highlight's start time.
    if (this.isAudio()) {
      const h = this.bundle.highlights.find((x: Highlight) => x.id === id);
      if (h) {
        const ms = this.audioAnchorStartMs(h);
        if (ms >= 0) this.seekTo(ms);
      }
      return;
    }
    this.webController.runJavaScript(`window.__shibei && window.__shibei.flashHighlight('${id}');`)
      .catch(() => {});
  }

  private deleteHighlight(id: string): void {
    if (!this.resource) {
      return;
    }
    try {
      AnnotationsService.instance.deleteHighlight(this.resource.id, id);
      if (!this.isAudio()) {
        this.webController.runJavaScript(`window.__shibei && window.__shibei.removeHighlight('${id}');`)
          .catch(() => {});
      }
    } catch (err) {
      promptAction.showToast({ message: (err as Error).message });
    }
  }

  private changeHighlightColor(id: string, color: string): void {
    if (!this.resource) return;
    try {
      AnnotationsService.instance.updateHighlightColor(this.resource.id, id, color);
      // Service notify → subscribe fires → paintHighlights runs. No extra
      // runJavaScript needed; the repaint redraws the span background.
    } catch (err) {
      promptAction.showToast({ message: (err as Error).message });
    }
  }

  // Implicit Want → system default browser. Errors surface as a toast so
  // the user knows the tap registered (silent failures look like a UI
  // bug). Used by the AnnotationPanel MetaRow's URL single-tap.
  private openUrlExternal(url: string): void {
    if (!url) return;
    const ctx = getContext(this) as common.UIAbilityContext;
    const want: Want = {
      action: 'ohos.want.action.viewData',
      uri: url,
    };
    ctx.startAbility(want).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'startAbility(viewData) fail: %{public}s', err.message);
      promptAction.showToast({
        message: I18n.t($r('app.string.common_open_failed')),
      });
    });
  }

  // Long-press URL → copy. Reuses common_copy_success which currently
  // reads "链接已复制" — semantically fine for any link string.
  private copyUrlToClipboard(url: string): void {
    if (!url) return;
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, url);
    pasteboard.getSystemPasteboard().setData(data).then(() => {
      promptAction.showToast({
        message: I18n.t($r('app.string.common_copy_success')),
      });
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'copy url fail: %{public}s', err.message);
      promptAction.showToast({
        message: I18n.t($r('app.string.common_copy_failed')),
      });
    });
  }

  private copyHighlightLink(id: string): void {
    if (!this.resource) return;
    const url = `shibei://open/resource/${this.resource.id}?highlight=${id}`;
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, url);
    pasteboard.getSystemPasteboard().setData(data).then(() => {
      promptAction.showToast({
        message: I18n.t($r('app.string.common_copy_success')),
      });
    }).catch((err: Error) => {
      hilog.warn(0x0000, 'shibei', 'pasteboard setData fail: %{public}s', err.message);
      promptAction.showToast({
        message: I18n.t($r('app.string.common_copy_failed')),
      });
    });
  }

  // ArkWeb intercept for `shibei-html://resource/{id}`. The HTML branch
  // sets the Web's src to this URL on first mount; Chromium fires this
  // handler for the top-level navigation and we hand back the
  // annotator-injected bytes from NAPI. Routing through bytes (rather than
  // `loadData(string)`) bypasses ArkWeb's silent ~tens-of-MB string-size
  // ceiling that left 28 MB snapshots blank.
  //
  // Same HTTP-shaped response contract as `handlePdfIntercept` — status 200
  // + reason "OK" + Content-Type / Content-Length / CORS headers. Returning
  // null on size==0 lets ArkWeb surface a normal load failure that
  // `.onErrorReceive` can catch.
  private handleHtmlIntercept(event: OnInterceptRequestEvent): WebResourceResponse | null {
    const url = event.request.getRequestUrl();
    if (!url.startsWith('shibei-html://resource/')) {
      return null;
    }
    const id = url.slice('shibei-html://resource/'.length);
    try {
      const bytes = ShibeiService.instance.getResourceHtmlBytes(id);
      if (bytes.byteLength === 0) {
        hilog.warn(0x0000, 'shibei', 'html intercept empty bytes for %{public}s', id);
        return null;
      }
      const resp = new WebResourceResponse();
      resp.setResponseMimeType('text/html');
      resp.setResponseEncoding('utf-8');
      resp.setResponseCode(200);
      resp.setReasonMessage('OK');
      const headers: WebHeader[] = [
        { headerKey: 'Content-Type', headerValue: 'text/html; charset=utf-8' },
        { headerKey: 'Content-Length', headerValue: String(bytes.byteLength) },
        { headerKey: 'Access-Control-Allow-Origin', headerValue: '*' },
        { headerKey: 'Cache-Control', headerValue: 'no-store' },
      ];
      resp.setResponseHeader(headers);
      resp.setResponseData(bytes.buffer);
      resp.setResponseIsReady(true);
      return resp;
    } catch (err) {
      hilog.error(0x0000, 'shibei', 'html intercept fail %{public}s: %{public}s',
        id, (err as Error).message);
      return null;
    }
  }

  // ArkWeb intercept for `shibei-pdf://resource/{id}`. pdfjs (inside the
  // shell) issues an XHR to that URL after shell.html loads; we answer
  // with the PDF bytes from NAPI. Returning null for any other URL lets
  // ArkWeb's default handler take the $rawfile loads of shell.html /
  // main.js / pdf-bundle.js / etc. through.
  //
  // The response MUST be HTTP-shaped (explicit status 200 + reason "OK" +
  // Content-Type / Content-Length / CORS headers) or pdfjs sees status 0
  // and reports "Unexpected server response (0)". The spike at 563368a
  // nailed this down — see its commit message for the full story.
  private handlePdfIntercept(event: OnInterceptRequestEvent): WebResourceResponse | null {
    const url = event.request.getRequestUrl();
    if (!url.startsWith('shibei-pdf://resource/')) {
      return null;
    }
    const id = url.slice('shibei-pdf://resource/'.length);
    try {
      const bytes = ShibeiService.instance.getPdfBytes(id);
      if (bytes.byteLength === 0) {
        hilog.warn(0x0000, 'shibei', 'intercept empty bytes for %{public}s', id);
        return null;
      }
      const resp = new WebResourceResponse();
      resp.setResponseMimeType('application/pdf');
      resp.setResponseEncoding('');
      resp.setResponseCode(200);
      resp.setReasonMessage('OK');
      const headers: WebHeader[] = [
        { headerKey: 'Content-Type', headerValue: 'application/pdf' },
        { headerKey: 'Content-Length', headerValue: String(bytes.byteLength) },
        { headerKey: 'Access-Control-Allow-Origin', headerValue: '*' },
        { headerKey: 'Cache-Control', headerValue: 'no-store' },
      ];
      resp.setResponseHeader(headers);
      resp.setResponseData(bytes.buffer);
      resp.setResponseIsReady(true);
      return resp;
    } catch (err) {
      hilog.error(0x0000, 'shibei', 'intercept fail %{public}s: %{public}s',
        id, (err as Error).message);
      return null;
    }
  }

  build() {
    Stack() {
      if (this.loading) {
        Column() {
          Text(I18n.t($r('app.string.common_loading')))
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else if (this.loadError) {
        Column() {
          Text(I18n.t($r('app.string.common_load_failed'), I18n.translateError(this.loadError)))
            .fontColor($r('sys.color.ohos_id_color_warning'));
          // Retry only makes sense for transient failures (network /
          // snapshot missing). Terminal ones like resourceNotFound still
          // show the button — a second try is cheap and harmless.
          Button(I18n.t($r('app.string.common_retry'))).margin({ top: 12 })
            .onClick(() => this.retryHtmlLoad());
        }.width('100%').height('100%').justifyContent(FlexAlign.Center);
      } else {
        SideBarContainer(SideBarContainerType.Overlay) {
          // SideBarContainer convention: FIRST child = side bar, SECOND = content.
          // We put AnnotationPanel first (drawer) and the top-bar+Web column second.
          AnnotationPanel({
            bundle: this.bundle,
            resource: this.resource,
            focusedHighlightId: this.focusedHighlightId,
            onTapHighlight: (id: string) => {
              // Auto-close the drawer on folded / overlay layouts — user
              // expects the tap to "jump" them to the passage, and keeping
              // the drawer open covers the page they just navigated to.
              this.setPanelOpen(false);
              this.flashHighlight(id);
              // Trigger panel-side flash+persist so the card stays highlighted
              // when the drawer is reopened later.
              this.focusedHighlightId = `${Date.now()}:${id}`;
            },
            onDeleteHighlight: (id: string) => this.deleteHighlight(id),
            onChangeHighlightColor: (id: string, color: string) =>
              this.changeHighlightColor(id, color),
            onCopyHighlightLink: (id: string) => this.copyHighlightLink(id),
            onAddHighlightComment: (hlId: string) => {
              this.commentDialogId = null;
              this.commentDialogHighlightId = hlId;
              this.commentDialogDraft = '';
              this.commentDialogOpen = true;
            },
            onAddResourceComment: () => {
              this.commentDialogId = null;
              this.commentDialogHighlightId = null;
              this.commentDialogDraft = '';
              this.commentDialogOpen = true;
            },
            onEditComment: (id: string) => {
              const c = this.bundle.comments.find((x: Comment) => x.id === id);
              if (!c) return;
              this.commentDialogId = id;
              this.commentDialogHighlightId = c.highlight_id;
              this.commentDialogDraft = c.content;
              this.commentDialogOpen = true;
            },
            onOpenUrl: (url: string) => this.openUrlExternal(url),
            onCopyUrl: (url: string) => this.copyUrlToClipboard(url),
            onDeleteComment: (id: string) => {
              if (!this.resource) {
                return;
              }
              try {
                AnnotationsService.instance.deleteComment(this.resource.id, id);
              } catch (err) {
                promptAction.showToast({ message: (err as Error).message });
              }
            },
          });

          // Main content: branch between HTML and PDF. Both branches share
          // the TopBar + SelectionPalette builders; only the inner Web (or
          // download/error panel) differs.
          if (this.resource && this.resource.resource_type === 'pdf') {
            this.PdfContent();
          } else if (this.resource && this.resource.resource_type === 'audio') {
            this.AudioContent();
          } else {
            this.HtmlContent();
          }
        }
        .showSideBar(this.panelOpen)
        .autoHide(true)
        .onChange((value: boolean) => {
          // Fired when SideBarContainer toggles visibility (including
          // tap-outside auto-dismiss on Overlay type). Keep panelOpen in sync
          // so the ☰ toggle state matches what's actually drawn.
          this.panelOpen = value;
        })
        .sideBarWidth(280)
        .minSideBarWidth(240)
        .maxSideBarWidth(360)
        .sideBarPosition(SideBarPosition.End)
        .showControlButton(false)
        .width('100%').height('100%');
      }
    }
    .width('100%').height('100%')
    .bindSheet($$this.commentDialogOpen, this.CommentSheet(), {
      // SheetType.BOTTOM forces the drawer-style sheet on wide layouts
      // (unfolded Mate X5 defaults to CENTER, looking like a modal window).
      // Detents let the user drag between medium (~half screen) and large.
      preferType: SheetType.BOTTOM,
      detents: [SheetSize.MEDIUM, SheetSize.LARGE],
      showClose: true,
      dragBar: true,
      title: {
        title: this.commentDialogId
          ? I18n.t($r('app.string.reader_note_edit'))
          : I18n.t($r('app.string.reader_note_new')),
      },
    });
  }

  // Top bar: back button + title + (PDF only) zoom toolbar + annotations drawer toggle.
  // Shared by both HTML and PDF branches; keep it thin and depend only on @State
  // fields already reactive to the bundle/resource.
  @Builder TopBar() {
    Row() {
      Text('←').fontSize(22)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .width(44).height(44).textAlign(TextAlign.Center)
        .onClick(() => this.leaveReader());
      Text(this.resource ? this.resource.title : '')
        .fontSize(15).fontWeight(FontWeight.Medium).layoutWeight(1)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
      // Zoom toolbar: only shown once the PDF shell is actually loaded.
      // Pre-ready (downloading / error) the buttons would be no-ops since
      // the webview hasn't registered __shibeiReader yet, and the visual
      // clutter would distract from the download status panel.
      if (this.resource && this.resource.resource_type === 'pdf' && this.pdfReady) {
        this.ZoomToolbar();
      }
      Text(`☰ ${this.bundle.highlights.length + this.resourceNoteCount()}`)
        .fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .padding({ left: 8, right: 8 }).height(44)
        .onClick(() => { this.setPanelOpen(!this.panelOpen); });
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .padding({ left: 4, right: 4 });
  }

  private resourceNoteCount(): number {
    return this.bundle.comments.filter((c: Comment) => !c.highlight_id).length;
  }

  // PDF zoom controls: [−] [N%] [+]. Percentage tap resets to 1.0.
  // Buttons are 36x44 for comfortable thumb hit targets; the row itself
  // stays compact so it doesn't crowd the title at narrow widths.
  @Builder ZoomToolbar() {
    Row() {
      Text('−')
        .fontSize(20)
        .fontColor(this.pdfZoom <= PDF_ZOOM_MIN + 0.001
          ? $r('sys.color.ohos_id_color_text_tertiary')
          : $r('sys.color.ohos_id_color_text_primary'))
        .width(36).height(44).textAlign(TextAlign.Center)
        .onClick(() => {
          if (this.pdfZoom <= PDF_ZOOM_MIN + 0.001) return;
          this.applyPdfZoom(this.pdfZoom - PDF_ZOOM_STEP);
        });
      Text(`${Math.round(this.pdfZoom * 100)}%`)
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .width(44).height(44).textAlign(TextAlign.Center)
        .onClick(() => this.applyPdfZoom(PDF_ZOOM_DEFAULT));
      Text('+')
        .fontSize(20)
        .fontColor(this.pdfZoom >= PDF_ZOOM_MAX - 0.001
          ? $r('sys.color.ohos_id_color_text_tertiary')
          : $r('sys.color.ohos_id_color_text_primary'))
        .width(36).height(44).textAlign(TextAlign.Center)
        .onClick(() => {
          if (this.pdfZoom >= PDF_ZOOM_MAX - 0.001) return;
          this.applyPdfZoom(this.pdfZoom + PDF_ZOOM_STEP);
        });
    }
    .padding({ left: 4, right: 4 });
  }

  // Floating highlight-color palette. Shown only when the inner Web has
  // reported a non-collapsed selection. Identical in both HTML and PDF
  // branches — the color → createHighlight path is anchor-agnostic.
  @Builder SelectionPalette() {
    Row() {
      ForEach(HL_COLORS, (c: HlColor) => {
        Stack() {
          Text('')
            .width(32).height(32)
            .backgroundColor(c.value)
            .borderRadius(16)
            .border({ width: 2, color: $r('sys.color.ohos_id_color_background') });
        }
        .width(44).height(44)
        .margin({ left: 6, right: 6 })
        .onClick(() => this.createHighlightWithColor(c.value));
      }, (c: HlColor) => c.value);
    }
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .borderRadius(28)
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .shadow({ radius: 12, color: $r('app.color.shadow_default'), offsetY: 2 })
    .position({ x: 0, y: '85%' })
    .margin({ left: 16, right: 16 })
    .justifyContent(FlexAlign.Center);
  }

  // HTML branch: top-level navigation to `shibei-html://resource/{id}` —
  // `handleHtmlIntercept` serves the annotator-injected bytes back from
  // NAPI. This replaces the older `loadData(string)` path, which silently
  // failed on snapshots over ArkWeb's undocumented string-size ceiling
  // (~tens of MB → blank Reader).
  @Builder HtmlContent() {
    Column() {
      this.TopBar();

      // Web area
      Stack() {
        Web({
          src: `shibei-html://resource/${this.resource ? this.resource.id : ''}`,
          controller: this.webController,
        })
          .domStorageAccess(true)
          .javaScriptAccess(true)
          // Let Chromium follow the system ColorMode for ArkUI media queries
          // (snapshot author's own styles still win). We leave
          // forceDarkAccess at its default (false) so Chromium's forced
          // dark-mode filter does NOT invert the saved page content —
          // mirrors desktop behavior where the iframe stays authentic and
          // only an optional invert filter is offered.
          .darkMode(WebDarkMode.Auto)
          .onControllerAttached(() => {
            // Expose bridge before page loads so annotator-mobile.js
            // sees window.shibeiBridge on first evaluation. The src-based
            // navigation kicks off after onControllerAttached returns, so
            // the proxy is in place before the page parses.
            this.webController.registerJavaScriptProxy(
              this.bridge, 'shibeiBridge', ['emit'],
            );
          })
          .onInterceptRequest((ev: OnInterceptRequestEvent) => this.handleHtmlIntercept(ev))
          .onErrorReceive((event) => {
            // Surface failures that otherwise leave the Reader blank — the
            // pre-intercept code path silently swallowed loadData rejections.
            // We log richly but don't change loadError once the page is
            // parsed; subresource failures (e.g. broken data: URIs in the
            // snapshot) shouldn't blank the whole Reader.
            const err = event.error;
            const url = event.request ? event.request.getRequestUrl() : '';
            hilog.warn(0x0000, 'shibei',
              'html onErrorReceive url=%{public}s info=%{public}s',
              url, err && err.getErrorInfo ? err.getErrorInfo() : '');
          })
          .onScroll((ev: OnScrollEvent) => {
            this.lastScrollY = ev.yOffset;
            this.scheduleScrollSave();
          })
          .width('100%').height('100%')
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'));

        // Tap-catcher scrim. Only renders when the annotation drawer is
        // open. ArkWeb's Web captures all touches, so SideBarContainer's
        // autoHide never fires when the user taps the page area. This
        // transparent layer sits on top of the Web only while the drawer
        // is visible, catches the tap, and closes the drawer. Uses a
        // near-transparent fill (not pure Color.Transparent) so the hit
        // test actually registers.
        if (this.panelOpen) {
          Column()
            .width('100%').height('100%')
            .backgroundColor($r('app.color.surface_tap_invisible'))
            .onClick(() => { this.setPanelOpen(false); });
        }

        // Floating selection action bar — shown when user has an active
        // selection. Tap a color circle to create a highlight with that color.
        if (this.pendingSelection !== null && !this.pendingSelection.collapsed) {
          this.SelectionPalette();
        }
      }
      .layoutWeight(1).width('100%');
    }
    .width('100%').height('100%');
  }

  // PDF branch: loads `pdf-shell/shell.html?id=<resourceId>` from rawfile;
  // pdfjs inside the shell XHRs `shibei-pdf://resource/{id}` which our
  // handlePdfIntercept answers with bytes from NAPI. The download/error
  // panels cover the pre-ready states — on first open of a resource that
  // hasn't been synced to this device yet we sit on "正在下载 PDF…" until
  // ensurePdfDownloaded resolves.
  @Builder PdfContent() {
    Column() {
      this.TopBar();

      Stack() {
        if (this.pdfDownloading) {
          Column() {
            Text(I18n.t($r('app.string.reader_pdf_downloading')))
              .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
          }.width('100%').height('100%').justifyContent(FlexAlign.Center);
        } else if (this.pdfError) {
          Column() {
            Text(I18n.t($r('app.string.reader_pdf_download_failed'), I18n.translateError(this.pdfError)))
              .fontColor($r('sys.color.ohos_id_color_warning'));
            Button(I18n.t($r('app.string.common_retry'))).margin({ top: 12 })
              .onClick(() => {
                if (this.resource) this.ensurePdfReady(this.resource.id);
              });
          }.width('100%').height('100%').justifyContent(FlexAlign.Center);
        } else if (this.pdfReady && this.resource) {
          Web({
            // zoom is appended so the shell reads its initial zoomFactor
            // from the URL query and computes the first scale with that
            // value, avoiding a flash-of-1.0 → saved rebuild. pdfZoom has
            // already been loaded from prefs in ensurePdfReady before
            // pdfReady flips true.
            //
            // loadingText is the localized "Loading…" string, injected so
            // the shell's status div stays in sync with the app's current
            // locale (ArkTS resolves the resource; main.js applies it
            // before pdfjs gets a chance to overwrite with progress).
            src: $rawfile(`pdf-shell/shell.html?id=${this.resource.id}`
              + `&zoom=${this.pdfZoom}`
              + `&loadingText=${encodeURIComponent(I18n.t($r('app.string.common_loading')))}`),
            controller: this.webController,
          })
            .domStorageAccess(true)
            .javaScriptAccess(true)
            // Disable ArkWeb's native pinch-to-zoom so our own touchmove
            // handler in main.js gets the gesture cleanly and can drive
            // pdfjs to re-render at the new scale. ArkWeb's native zoom
            // does a CSS transform scale — fine for HTML but blurs the
            // PDF canvas since pdfjs would still be rendering at the old
            // scale underneath.
            .zoomAccess(false)
            // Follow system ColorMode for pdf-shell's own chrome (background
            // behind pages, status text) — style.css has prefers-color-scheme
            // rules. PDF canvas content itself stays authentic (white page).
            .darkMode(WebDarkMode.Auto)
            .onControllerAttached(() => {
              // Same bridge contract as HTML — pdf-annotator-mobile.js
              // speaks the identical SelectionPayload / ClickPayload /
              // ReadyPayload protocol via window.shibeiBridge.emit.
              this.webController.registerJavaScriptProxy(
                this.bridge, 'shibeiBridge', ['emit'],
              );
            })
            .onInterceptRequest((ev: OnInterceptRequestEvent) => this.handlePdfIntercept(ev))
            .onScroll((ev: OnScrollEvent) => {
              this.lastScrollY = ev.yOffset;
              this.scheduleScrollSave();
            })
            .onConsole((ev: OnConsoleEvent) => {
              // Surface the shell's console.log into hilog so we can
              // diagnose width / scale issues from ssh+hdc.
              hilog.info(0x0000, 'shibei', 'pdf-shell: %{public}s',
                ev.message.getMessage());
              return false;  // still propagate to the default handler
            })
            .width('100%').height('100%')
            .backgroundColor($r('sys.color.ohos_id_color_sub_background'));
        }

        // Tap-catcher scrim (mirrors HtmlContent). The PDF shell's
        // scrollable `<div id="pages">` captures touches the same way the
        // HTML iframe does, so we need the same workaround to close the
        // drawer by tapping the page area.
        if (this.panelOpen) {
          Column()
            .width('100%').height('100%')
            .backgroundColor($r('app.color.surface_tap_invisible'))
            .onClick(() => { this.setPanelOpen(false); });
        }

        if (this.pendingSelection !== null && !this.pendingSelection.collapsed) {
          this.SelectionPalette();
        }
      }
      .layoutWeight(1).width('100%');
    }
    .width('100%').height('100%');
  }

  @Builder AudioContent() {
    Column() {
      this.TopBar();
      if (this.audioDownloading) {
        Column() {
          Text(I18n.t($r('app.string.common_loading')))
            .fontColor($r('sys.color.ohos_id_color_text_tertiary'));
        }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center);
      } else if (this.audioError) {
        Column() {
          Text(I18n.t($r('app.string.common_load_failed'), I18n.translateError(this.audioError)))
            .fontColor($r('sys.color.ohos_id_color_warning'))
            .textAlign(TextAlign.Center).padding(16);
          Button(I18n.t($r('app.string.common_retry'))).margin({ top: 12 })
            .onClick(() => { if (this.resource) this.ensureAudioReady(this.resource.id); });
        }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center);
      } else if (this.segments.length > 0) {
        // Player pinned to top; transcript scrolls below.
        this.PlayerControls();
        this.TranscriptList();
      } else {
        // No transcript — center the player.
        Column() {
          this.PlayerControls();
        }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center);
      }
    }.width('100%').height('100%');
  }

  @Builder PlayerControls() {
    Column() {
      // Seek bar + current / total time
      Row() {
        Text(this.formatMs(this.currentTimeMs)).fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width(56).textAlign(TextAlign.Center);
        Slider({
          value: this.currentTimeMs,
          min: 0,
          max: this.durationMs > 0 ? this.durationMs : 1,
          step: 1000,
        })
          .layoutWeight(1)
          .enabled(this.audioReady)
          .selectedColor($r('sys.color.ohos_id_color_emphasize'))
          .onChange((value: number, mode: SliderChangeMode) => {
            if (mode === SliderChangeMode.Begin || mode === SliderChangeMode.Moving) {
              this.seeking = true;
              this.currentTimeMs = value;
            } else if (mode === SliderChangeMode.End) {
              this.seeking = false;
              this.seekTo(value);
            }
          });
        Text(this.formatMs(this.durationMs)).fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width(56).textAlign(TextAlign.Center);
      }.width('100%').padding({ left: 12, right: 12 });

      // Transport: -15s · play/pause · +15s
      Row() {
        Text('« 15').fontSize(16)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(64).height(48).textAlign(TextAlign.Center)
          .onClick(() => this.skipBy(-AUDIO_SKIP_MS));
        Button() {
          Text(this.isPlaying ? '⏸' : '▶').fontSize(26).fontColor(Color.White);
        }
          .type(ButtonType.Circle).width(64).height(64)
          .backgroundColor($r('sys.color.ohos_id_color_emphasize'))
          .margin({ left: 24, right: 24 })
          .enabled(this.audioReady)
          .onClick(() => this.togglePlay());
        Text('15 »').fontSize(16)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width(64).height(48).textAlign(TextAlign.Center)
          .onClick(() => this.skipBy(AUDIO_SKIP_MS));
      }.width('100%').justifyContent(FlexAlign.Center).margin({ top: 20, bottom: 20 });

      // Speed selector
      Row() {
        ForEach(AUDIO_SPEEDS, (sp: number) => {
          Text(`${sp}×`).fontSize(13)
            .fontColor(this.playbackSpeed === sp
              ? Color.White
              : $r('sys.color.ohos_id_color_text_secondary'))
            .backgroundColor(this.playbackSpeed === sp
              ? $r('sys.color.ohos_id_color_emphasize')
              : $r('sys.color.ohos_id_color_component_normal'))
            .padding({ left: 10, right: 10, top: 5, bottom: 5 })
            .borderRadius(12).margin({ left: 4, right: 4 })
            .onClick(() => this.applySpeed(sp));
        }, (sp: number) => sp.toString());
      }.width('100%').justifyContent(FlexAlign.Center);
    }.width('100%').padding({ top: 16, bottom: 8 });
  }

  // Transcript: tap a line to seek; the playing line stays highlighted and
  // auto-scrolls (karaoke). Segments overlapping a highlight are tinted.
  @Builder TranscriptList() {
    List({ scroller: this.transcriptScroller, space: 2 }) {
      ForEach(this.segments, (seg: TranscriptSegment, i: number) => {
        ListItem() {
          Text(seg.text)
            .fontSize(15).lineHeight(24).width('100%')
            .padding({ left: 12, right: 12, top: 5, bottom: 5 })
            .fontColor(i === this.activeSeg
              ? $r('sys.color.ohos_id_color_text_primary')
              : $r('sys.color.ohos_id_color_text_secondary'))
            .fontWeight(i === this.activeSeg ? FontWeight.Medium : FontWeight.Normal)
            .backgroundColor(this.highlightTintForSeg(seg))
            .borderRadius(4)
            .border({
              width: { left: 3 },
              color: { left: i === this.activeSeg ? $r('sys.color.ohos_id_color_emphasize') : Color.Transparent },
            })
            .onClick(() => this.seekTo(Math.round(seg.start * 1000)));
        }
      }, (seg: TranscriptSegment, i: number) => `${i}`);
    }
    .layoutWeight(1).width('100%')
    .padding({ left: 8, right: 8, bottom: 16 })
    .scrollBar(BarState.Auto);
  }

  @Builder CommentSheet() {
    Column() {
      TextArea({
        text: this.commentDialogDraft,
        placeholder: I18n.t($r('app.string.reader_note_placeholder')),
      })
        .fontSize(15)
        .width('100%')
        .height(160)
        // Pop the keyboard the instant the sheet slides up. Without
        // defaultFocus the user has to tap the area first, which feels
        // wrong for a "write a note" sheet — they just tapped a button
        // that said add note.
        .defaultFocus(true)
        .onChange((v: string) => { this.commentDialogDraft = v; });
      Row() {
        Text(I18n.t($r('app.string.common_cancel')))
          .fontSize(15)
          .padding({ left: 20, right: 20, top: 10, bottom: 10 })
          .onClick(() => {
            this.commentDialogOpen = false;
            this.commentDialogDraft = '';
            this.commentDialogId = null;
            this.commentDialogHighlightId = null;
          });
        Text(I18n.t($r('app.string.common_save')))
          .fontSize(15).fontColor($r('sys.color.ohos_id_color_emphasize'))
          .padding({ left: 20, right: 20, top: 10, bottom: 10 })
          .onClick(() => this.saveComment());
      }
      .width('100%').justifyContent(FlexAlign.End);
    }
    .width('100%').padding(16);
  }

  private saveComment(): void {
    if (!this.resource) return;
    const content = this.commentDialogDraft.trim();
    if (!content) {
      this.commentDialogOpen = false;
      return;
    }
    try {
      if (this.commentDialogId) {
        AnnotationsService.instance.updateComment(this.resource.id, this.commentDialogId, content);
      } else {
        // commentDialogHighlightId is set when "+ 评论" is tapped on a
        // highlight card; null path saves as a resource-level note.
        AnnotationsService.instance.createComment(
          this.resource.id,
          this.commentDialogHighlightId,
          content,
        );
      }
      this.commentDialogOpen = false;
      this.commentDialogDraft = '';
      this.commentDialogId = null;
      this.commentDialogHighlightId = null;
    } catch (err) {
      promptAction.showToast({ message: (err as Error).message });
    }
  }
}
