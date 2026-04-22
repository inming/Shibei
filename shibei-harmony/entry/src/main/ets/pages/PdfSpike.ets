import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

// Throwaway Phase-3b spike page. Verifies that ArkWeb's onInterceptRequest
// catches requests to a custom scheme (shibei-pdf://) and that pdfjs can
// consume the returned bytes to render a page. Delete this file and its
// main_pages.json / EntryAbility.ets edits once the spike passes.
// SPIKE: reverted in Task 0 Step 8

@Entry
@Component
struct PdfSpike {
  private webController: webview.WebviewController = new webview.WebviewController();
  @State loaded: boolean = false;

  build() {
    Stack() {
      Web({
        src: $rawfile('pdf-spike/spike.html'),
        controller: this.webController,
      })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .onInterceptRequest((event: OnInterceptRequestEvent) => this.handleIntercept(event))
        .onPageEnd(() => { this.loaded = true; })
        .width('100%')
        .height('100%');
    }
    .width('100%').height('100%');
  }

  // Returning null lets ArkWeb proceed with its default handling (i.e. the
  // initial load of spike.html itself falls through since its URL doesn't
  // start with shibei-pdf://). Any URL on the custom scheme is answered
  // with the bundled sample.pdf read via resourceManager.
  private handleIntercept(event: OnInterceptRequestEvent): WebResourceResponse | null {
    const url = event.request.getRequestUrl();
    if (!url.startsWith('shibei-pdf://')) {
      return null;
    }
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const bytes: Uint8Array = ctx.resourceManager.getRawFileContentSync('pdf-spike/sample.pdf');
      hilog.info(0x0000, 'shibei', 'spike intercept %{public}s → %{public}d bytes',
        url, bytes.byteLength);
      const resp = new WebResourceResponse();
      resp.setResponseMimeType('application/pdf');
      resp.setResponseEncoding('');
      resp.setResponseCode(200);
      resp.setReasonMessage('OK');
      // pdfjs's XHR status check reports (0) unless the response carries
      // proper HTTP-shaped headers. Content-Length is also needed or
      // pdfjs's range-request fallback kicks in and hangs.
      resp.setResponseHeader([
        { headerKey: 'Content-Type', headerValue: 'application/pdf' },
        { headerKey: 'Content-Length', headerValue: String(bytes.byteLength) },
        { headerKey: 'Access-Control-Allow-Origin', headerValue: '*' },
        { headerKey: 'Cache-Control', headerValue: 'no-store' },
      ]);
      // setResponseData accepts ArrayBuffer on API 11+. The Uint8Array's
      // underlying buffer is what pdfjs ultimately consumes.
      resp.setResponseData(bytes.buffer);
      resp.setResponseIsReady(true);
      return resp;
    } catch (err) {
      hilog.error(0x0000, 'shibei', 'spike intercept fail %{public}s',
        (err as Error).message);
      return null;
    }
  }
}
