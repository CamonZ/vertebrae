import { useDebugStore } from "../stores/debugStore";

const KNOWN_CRATE_ROOTS = new Set([
  "gui",
  "gui_lib",
  "vertebrae_core",
  "vertebrae_harness_claude",
  "vertebrae_harness_codex",
  "vertebrae_harness_core",
  "vertebrae_sacrum_client",
]);

export interface DebugLogLocation {
  target?: string;
  message: string;
}

/** Add a renderer-side diagnostic to the in-app Debug Console. */
export function addDebugLog(
  message: string,
  level: "INFO" | "WARN" | "ERROR" = "INFO"
): void {
  useDebugStore.getState().addLog({
    timestamp: Date.now(),
    level,
    crateName: "gui",
    target: "gui::renderer",
    message,
  });
}

/** Split the target prefix added by the Tauri Webview log formatter. */
export function splitDebugLogTarget(message: string): DebugLogLocation {
  const match = message.match(/^\[([^\]]+)\]\s+([\s\S]*)$/);
  if (!match) return { message };

  const target = match[1].trim();
  const root = target.split("::", 1)[0];
  if (!target.includes("::") && !KNOWN_CRATE_ROOTS.has(root)) {
    return { message };
  }
  return { target, message: match[2] };
}

export function crateNameFromTarget(target: string | undefined): string {
  if (!target) return "unattributed";
  const root = target.split("::", 1)[0];
  if (root === "gui" || root === "gui_lib") return "gui-tauri";
  return root.replace(/^vertebrae_/, "").replace(/_/g, "-");
}

export function inferDebugCrate(message: string): string {
  return crateNameFromTarget(splitDebugLogTarget(message).target);
}

export function formatDebugLogMessage(message: string): string {
  return splitDebugLogTarget(message).message;
}
