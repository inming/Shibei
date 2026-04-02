import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@/styles/global.css";
import { debugLog } from "@/lib/commands";

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
