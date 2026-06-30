import type {
  LocalChatHarnessInfo,
  LocalChatHarnessKind,
} from "../../bindings";
import type { LocalChatLifecycle } from "../../stores/chatStore";

export function harnessDisplayName(harness: LocalChatHarnessKind): string {
  switch (harness) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
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
}): boolean {
  return !!session.backendSessionId || !!session.providerResumeId;
}

export function isHarnessSelectable(
  info: LocalChatHarnessInfo,
  currentHarness: LocalChatHarnessKind,
  locked: boolean
): boolean {
  if (locked) return info.harness === currentHarness;
  return info.available;
}
