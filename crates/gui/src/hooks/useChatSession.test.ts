import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type LocalChatHarnessInfo } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import { initialProviderReplayState } from "../stores/providerReplay";
import { useLocalChatDefaultsStore } from "../utils/localChatDefaults";
import { clearPersistedLocalChatSessions } from "../utils/localChatPersistence";
import { useChatSession } from "./useChatSession";

vi.mock("./useLocalChat", () => ({
  useLocalChat: (id: string) => ({
    session: useChatStore((state) => state.sessions[id]),
    isActive: false,
  }),
}));

const codex: LocalChatHarnessInfo = {
  harness: "codex",
  label: "Codex",
  available: true,
  unavailable_reason: null,
  default_model_id: "gpt-test",
  default_reasoning_effort: null,
  models: [
    {
      id: "gpt-test",
      label: "Test",
      supported_speed_tier_ids: ["default", "fast"],
    },
  ],
  speed_tiers: [
    { id: "default", label: "Standard", is_default: true },
    { id: "fast", label: "Fast", is_default: false },
  ],
  reasoning_efforts: [],
  permission_modes: [],
  personality_options: [],
  supports_resume: true,
};

function conversation(path: string, tier?: string) {
  const id = useChatStore.getState().openSession("Conversation", path);
  useChatStore.getState().setSessionHarness(id, "codex");
  useChatStore.getState().setSessionSelectedModel(id, "gpt-test");
  useChatStore.getState().setProviderResumeId(id, path);
  if (tier) useChatStore.getState().setSessionSpeedTier(id, tier);
  return id;
}

beforeEach(() => {
  localStorage.clear();
  clearPersistedLocalChatSessions();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useLocalChatDefaultsStore.setState({ defaults: {}, defaultProvider: null });
  vi.spyOn(commands, "getSupportedLocalChatHarnesses").mockResolvedValue({
    status: "ok",
    data: {
      default_harness: "codex",
      default_provider: "openai",
      harnesses: [codex],
      providers: [],
    },
  });
});
afterEach(() => vi.restoreAllMocks());

describe("composer conversation speed", () => {
  it.each(["fast", "default"])(
    "preserves %s after reopening despite opposite global defaults",
    async (tier) => {
      const id = conversation("/repo/reopen", tier);
      const opposite = tier === "fast" ? "default" : "fast";
      useLocalChatDefaultsStore.setState({
        defaults: { openai: { speedTier: opposite } },
      });
      vi.spyOn(commands, "loadLocalChatSessionReplay").mockResolvedValue({
        status: "ok",
        data: {
          events: [],
          cache_key: "revision",
          next_cursor: null,
          has_more: false,
        },
      });
      useChatStore.setState({ sessions: {}, activeSessionId: null });
      useChatStore.getState().openSession("Reopen", "/repo/reopen");
      const other = conversation("/repo/other", opposite);
      const { result, rerender } = renderHook(
        ({ sessionId }) => useChatSession(sessionId),
        { initialProps: { sessionId: id } }
      );
      await waitFor(() => expect(result.current.speedTiers).toHaveLength(2));
      expect(result.current.selectedSpeedTier).toBe(tier);
      rerender({ sessionId: other });
      expect(result.current.selectedSpeedTier).toBe(opposite);
      rerender({ sessionId: id });
      expect(result.current.selectedSpeedTier).toBe(tier);
    }
  );

  it("keeps legacy speed unknown and waits for initial recovery before resume", async () => {
    const id = conversation("/repo/legacy");
    useLocalChatDefaultsStore.setState({
      defaults: { openai: { speedTier: "fast" } },
    });
    const session = useChatStore.getState().sessions[id];
    useChatStore.setState({
      sessions: {
        [id]: { ...session, providerReplay: initialProviderReplayState(1) },
      },
    });
    const { result } = renderHook(() => useChatSession(id));
    await waitFor(() => expect(result.current.speedTiers).toHaveLength(2));
    expect(result.current.selectedSpeedTier).toBeUndefined();
    expect(result.current.shouldStartOrResume).toBe(false);
    act(() => useChatStore.setState({ sessions: { [id]: { ...session } } }));
    expect(result.current.selectedSpeedTier).toBeUndefined();
    expect(result.current.shouldStartOrResume).toBe(true);
  });
});
