import { useEffect, useMemo } from "react";
import type { GateDraft, GateField, LocalChatGateBinding } from "../bindings";
import {
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
  useChatStore,
} from "../stores/chatStore";
import { useUIStore } from "../stores/uiStore";
import type { GateChatStatus } from "../utils/gateChat";
import {
  remainingFields,
  stallBaselineMs,
  stalledUserTurns,
  steeringHintText,
  steeringTier,
  type GateSteeringTier,
} from "../utils/gateDraft";
import { sendGateHiddenTurn } from "./useGateChat";

export interface GateSteering {
  tier: GateSteeringTier;
  /** Completed user turns since the draft last changed. */
  stalledTurns: number;
  /** Fields the draft still needs, with their questions. */
  remaining: GateField[];
  /** Restart the stall count ("Keep going"). */
  keepGoing: () => void;
}

/**
 * Steers a stalled draftable gate chat from draft progress. The stall count
 * is the user's completed turns since the draft last changed, the gate was
 * re-entered, or the user chose to keep going; past the soft threshold one
 * hidden hint is sent per stall, and the form and escape tiers are rendered
 * by the caller.
 */
export function useGateSteering(
  sessionId: string,
  gate: LocalChatGateBinding,
  status: GateChatStatus,
  draft: GateDraft | null
): GateSteering {
  const session = useChatStore((state) => state.sessions[sessionId]);
  const setGateSteering = useChatStore((state) => state.setGateSteering);
  const thresholds = useUIStore((state) => state.gateSteeringThresholds);

  const busy = session
    ? isLocalChatLifecycleBusy(getLocalChatLifecycle(session))
    : false;
  const resetAt = session?.gateSteering?.resetAt ?? null;
  const softHintBaseline = session?.gateSteering?.softHintBaseline ?? null;
  const baseline = stallBaselineMs(
    status.draftUpdatedAt,
    status.waitingSince,
    resetAt
  );
  const stalledTurns = useMemo(
    () => stalledUserTurns(session?.messages ?? [], baseline, busy),
    [baseline, busy, session?.messages]
  );
  const remaining = useMemo(
    () => remainingFields(gate.fields ?? [], draft),
    [draft, gate.fields]
  );
  const tier =
    draft && remaining.length > 0
      ? steeringTier(stalledTurns, thresholds)
      : "none";

  const hintDue =
    tier !== "none" &&
    !busy &&
    !!session?.backendSessionId &&
    baseline !== softHintBaseline;
  useEffect(() => {
    if (!hintDue) return;
    setGateSteering(sessionId, { softHintBaseline: baseline });
    void sendGateHiddenTurn(sessionId, steeringHintText(remaining));
  }, [baseline, hintDue, remaining, sessionId, setGateSteering]);

  return {
    tier,
    stalledTurns,
    remaining,
    keepGoing: () =>
      setGateSteering(sessionId, {
        resetAt: Date.now(),
        softHintBaseline: null,
      }),
  };
}
