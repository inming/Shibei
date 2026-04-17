#!/usr/bin/env node
// Ensure mcp/bundle/index.mjs exists before Tauri build/dev.
// Tauri validates resource paths at config load time, so this file must exist.
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpDir = join(root, "mcp");
const bundle = join(mcpDir, "bundle", "index.mjs");
const nodeModules = join(mcpDir, "node_modules");
const force = process.argv.includes("--force");

if (existsSync(bundle) && !force) {
  process.exit(0);
}

console.log("[shibei] Building mcp/bundle/index.mjs...");

if (!existsSync(nodeModules)) {
  console.log("[shibei] Installing mcp dependencies...");
  execSync("npm install", { cwd: mcpDir, stdio: "inherit" });
}

execSync("npm run bundle", { cwd: mcpDir, stdio: "inherit" });
