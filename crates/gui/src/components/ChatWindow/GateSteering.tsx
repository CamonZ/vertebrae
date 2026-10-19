import { useState, type ReactNode } from "react";
import {
  commands,
  type GateDraft,
  type GateField,
  type LocalChatGateBinding,
} from "../../bindings";
import { sendGateHiddenTurn } from "../../hooks/useGateChat";
import { useGateSteering } from "../../hooks/useGateSteering";
import { setGateDraft } from "../../hooks/useHumanInputDraft";
import { errorMessage } from "../../query";
import type { GateChatStatus } from "../../utils/gateChat";
import {
  draftValues,
  formAnsweredText,
  type GateDraftValues,
} from "../../utils/gateDraft";
import { Button } from "../atoms/Button";
import { GateAnswerForm } from "../shared/GateAnswerForm";

interface GateSteeringProps {
  sessionId: string;
  gate: LocalChatGateBinding;
  status: GateChatStatus;
  draft: GateDraft;
}

const cardClass =
  "rounded-[var(--radius-lg)] border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 p-3 text-sm";

/**
 * The visible steering tiers of a stalled gate chat, inline at the end of
 * the thread: the remaining fields as a form, then an escape card.
 */
export function GateSteering({
  sessionId,
  gate,
  status,
  draft,
}: GateSteeringProps): ReactNode {
  const { tier, remaining, keepGoing } = useGateSteering(
    sessionId,
    gate,
    status,
    draft
  );
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const executionId = status.waitingExecutionId;
  // Once edited, keep the form and its fields until the user records it.
  // Progress from the agent must not dismiss a form the user is editing.
  const [offered, setOffered] = useState<{
    executionId: string;
    fields: GateField[];
  } | null>(null);
  const offeredFields =
    offered?.executionId === executionId ? offered.fields : null;
  if (!executionId || (!offeredFields && tier !== "form" && tier !== "escape"))
    return null;
  const answerFields = offeredFields ?? remaining;

  const recordAnswers = async (values: GateDraftValues) => {
    await setGateDraft(executionId, values);
    setOffered(null);
    void sendGateHiddenTurn(sessionId, formAnsweredText(answerFields, values));
  };

  const stopRun = async () => {
    setStopping(true);
    setStopError(null);
    try {
      const result = await commands.stopRun({
        task_run_id: gate.task_run_id,
        task_id: null,
      });
      if (result.status === "error") setStopError(result.error.message);
    } catch (error) {
      setStopError(errorMessage(error));
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="gate-steering"
      data-tier={tier}
    >
      <div className={cardClass} data-testid="gate-steering-form">
        <GateAnswerForm
          key={executionId}
          fields={answerFields}
          values={draftValues(draft)}
          submitLabel="Record answers"
          onSubmit={recordAnswers}
          onEdit={() => {
            if (!offeredFields)
              setOffered({ executionId, fields: answerFields });
          }}
          testId="gate-steering-answer-form"
        >
          <p className="text-[var(--color-fg-soft)]">
            You can answer what is still needed here.
          </p>
        </GateAnswerForm>
      </div>
      {tier === "escape" && (
        <div className={cardClass} data-testid="gate-steering-escape">
          <p className="text-[var(--color-fg)]">
            This conversation has not moved the answer forward for a while.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              data-testid="gate-steering-keep-going"
              onClick={() => {
                setOffered(null);
                keepGoing();
              }}
            >
              Keep going
            </Button>
            <Button
              size="sm"
              variant="danger"
              confirm
              confirmLabel="Stop the run?"
              loading={stopping}
              data-testid="gate-steering-stop"
              onClick={() => void stopRun()}
            >
              Stop this run
            </Button>
          </div>
          {stopError && (
            <p role="alert" className="mt-2 text-xs text-[var(--color-err)]">
              {stopError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
