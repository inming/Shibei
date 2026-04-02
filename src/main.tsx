import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@/styles/global.css";
import { debugLog } from "@/lib/commands";

// Flush early errors captured in index.html before React loaded
const earlyErrors = (window as unknown as { __earlyErrors?: Array<Record<string, unknown>> }).__earlyErrors;
if (earlyErrors) {
  for (const err of earlyErrors) {
    debugLog(`early-${err.type}`, err);
  }
  earlyErrors.length = 0;
}

// Capture console.error and uncaught exceptions to debug log
const origError = console.error;
console.error = (...args: unknown[]) => {
  origError.apply(console, args);
  debugLog("console.error", args.map(String).join(" "));
};

window.addEventListener("error", (e) => {
  debugLog("uncaught-error", { message: e.message, filename: e.filename, lineno: e.lineno });
});

window.addEventListener("unhandledrejection", (e) => {
  debugLog("unhandled-rejection", String(e.reason));
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
