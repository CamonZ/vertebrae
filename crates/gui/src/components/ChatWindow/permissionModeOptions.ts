import type { LocalChatHarnessInfo, PermissionMode } from "../../bindings";
import type { ChatSession } from "../../stores/chatStore";

type PermissionModeOption = {
  value: PermissionMode;
  label: string;
};

const CLAUDE_PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  { value: "default", label: "Ask before edits" },
  { value: "accept_edits", label: "Edit automatically" },
  { value: "plan", label: "Plan mode" },
  { value: "auto", label: "Auto mode" },
  { value: "dont_ask", label: "Don't ask" },
  { value: "bypass_permissions", label: "Bypass permissions" },
];

const CODEX_PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  { value: "default", label: "Ask for approval" },
  { value: "auto", label: "Approve for me" },
  { value: "bypass_permissions", label: "Full access" },
];

/** The permission modes a chat offers, from its harness catalog. */
export function permissionModeOptions(
  harness: ChatSession["harness"],
  catalogOptions?: LocalChatHarnessInfo["permission_modes"]
) {
  // New catalogs always report the provider-owned options. Keep the legacy
  // fallback for older cached/test catalogs that predate permission_modes.
  if (catalogOptions) {
    return catalogOptions.map((mode) => ({
      value: mode.id,
      label: mode.label,
    }));
  }
  return harness === "codex"
    ? CODEX_PERMISSION_MODE_OPTIONS
    : CLAUDE_PERMISSION_MODE_OPTIONS;
}
