import { hilog } from '@kit.PerformanceAnalysisKit';

// Named interface for rect coordinates — avoids arkts-no-obj-literals-as-types.
export interface RectPayload {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Payloads emitted by annotator-mobile.js.
// Every field may be absent on error paths — guard in the handler.
export interface SelectionPayload {
  collapsed?: boolean;
  textContent?: string;
  anchor?: Object;
  rectJson?: RectPayload;
}

export interface ClickPayload {
  highlightId?: string;
  rectJson?: RectPayload;
}

export interface ReadyPayload {
  resourceId?: string;
}

export interface BridgeHandlers {
  onSelection: (p: SelectionPayload) => void;
  onClick: (p: ClickPayload) => void;
  onReady: (p: ReadyPayload) => void;
}

/// The object that gets wired into the WebView via registerJavaScriptProxy.
/// `emit(type, json)` is called from annotator-mobile.js; we route by `type`.
/// Sync-only because registerJavaScriptProxy doesn't support async returns.
export class AnnotationBridge {
  private handlers: BridgeHandlers;

  constructor(handlers: BridgeHandlers) {
    this.handlers = handlers;
  }

  emit(type: string, json: string): void {
    try {
      const payload = JSON.parse(json) as Object;
      if (type === 'selection') {
        this.handlers.onSelection(payload as SelectionPayload);
      } else if (type === 'click') {
        this.handlers.onClick(payload as ClickPayload);
      } else if (type === 'ready') {
        this.handlers.onReady(payload as ReadyPayload);
      } else {
        hilog.warn(0x0000, 'shibei', 'bridge unknown type=%{public}s', type);
      }
    } catch (err) {
      hilog.warn(0x0000, 'shibei', 'bridge parse fail: %{public}s', (err as Error).message);
    }
  }
}
