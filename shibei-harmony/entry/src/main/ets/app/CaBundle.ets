// Copies the Mozilla root CA bundle out of the HAP's resources/rawfile into
// the per-app sandbox so the Rust side can point `SSL_CERT_FILE` at a
// readable path. Replaces the previous approach of `include_bytes!`-ing
// cacert.pem into `libshibei_core.so` — the HAP rawfile slot cuts ~300 KB
// off the .so and lets us refresh the bundle without a Rust rebuild.
//
// The extraction only runs once per cold start (idempotent via a size
// check), so the ~226 KB read/write is amortised.

import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const RAWFILE_NAME = 'ca-bundle.pem';
const SANDBOX_FILENAME = 'ca-bundle.pem';

export async function extractCaBundle(ctx: common.UIAbilityContext): Promise<string> {
  const dest = `${ctx.filesDir}/${SANDBOX_FILENAME}`;
  const bytes = await ctx.resourceManager.getRawFileContent(RAWFILE_NAME);

  // Skip the write if the file already has the right size — a release
  // update would change the size if the CA bundle was refreshed.
  let needsWrite = true;
  try {
    const stat = await fileIo.stat(dest);
    if (stat.size === bytes.byteLength) {
      needsWrite = false;
    }
  } catch (_err) {
    // Missing file is the normal first-launch case; fall through to write.
  }

  if (needsWrite) {
    const file = await fileIo.open(
      dest,
      fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC,
    );
    try {
      await fileIo.write(file.fd, bytes.buffer);
    } finally {
      await fileIo.close(file);
    }
    hilog.info(0x0000, 'shibei', 'CA bundle extracted to sandbox (%{public}d bytes)',
      bytes.byteLength);
  }

  return dest;
}
