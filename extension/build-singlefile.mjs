// Bundle SingleFile core into a single IIFE for content script injection
import { build } from "esbuild";

await build({
  entryPoints: ["node_modules/single-file-core/single-file.js"],
  bundle: true,
  format: "iife",
  globalName: "SingleFile",
  outfile: "lib/single-file-bundle.js",
  platform: "browser",
  target: "chrome120",
});

console.log("SingleFile bundled to lib/single-file-bundle.js");
