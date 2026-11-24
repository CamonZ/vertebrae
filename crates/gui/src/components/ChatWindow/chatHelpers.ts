import type {
  LocalChatHarnessInfo,
  LocalChatHarnessKind,
} from "../../bindings";
import type { LocalChatLifecycle } from "../../stores/chatStore";

export const LOCAL_CHAT_UNAVAILABLE_MESSAGE =
  "No local chat provider is available. Check Settings → Providers & Models.";
export const LOCAL_CHAT_HARNESS_UNAVAILABLE_MESSAGE =
  "This chat session's harness is no longer available.";

const externalAgentCapabilities = {
  inferTitle: false,
  interruptInPlace: true,
  nativeSettings: true,
  recoverQueue: true,
};

const managedHarnessCapabilities = {
  inferTitle: true,
  interruptInPlace: false,
  nativeSettings: false,
  recoverQueue: false,
};

export function localChatCapabilities(harness: LocalChatHarnessKind) {
  return harness === "acp" ? externalAgentCapabilities : managedHarnessCapabilities;
}

export function harnessDisplayName(harness: LocalChatHarnessKind): string {
  switch (harness) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "acp":
      return "ACP agent";
  }
}

export function lifecycleLabel(lifecycle: LocalChatLifecycle): string {
  switch (lifecycle) {
    case "starting":
      return "Starting";
    case "resuming":
      return "Resuming";
    case "sending":
      return "Sending";
    case "streaming":
      return "Streaming";
    case "compacting":
      return "Compacting";
    case "closing":
      return "Closing";
    case "closed":
      return "Closed";
    case "error":
      return "Failed";
    case "idle":
      return "Ready";
  }
}

export function isSessionHarnessLocked(session: {
  backendSessionId: string | null;
  providerResumeId: string | null;
  queuedMessages?: readonly string[];
}): boolean {
  return !!session.backendSessionId || !!session.providerResumeId || !!session.queuedMessages?.length;
}

export function isHarnessSelectable(
  info: LocalChatHarnessInfo,
  currentHarness: LocalChatHarnessKind,
  locked: boolean
): boolean {
  if (locked) return info.harness === currentHarness;
  return info.available;
}
