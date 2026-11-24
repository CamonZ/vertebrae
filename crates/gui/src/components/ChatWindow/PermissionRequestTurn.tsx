import { useState } from "react";
import { commands } from "../../bindings";
import type { JsonValue } from "../../bindings";
import type { ChatMessage } from "../../stores/chatStore";

function isJsonRecord(
  value: JsonValue | null
): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function PermissionRequestTurn({
  message,
  onSettled,
}: {
  message: Extract<ChatMessage, { kind: "permission_request" }>;
  /** Records the answer so the chat's attention state clears. */
  onSettled?: (requestId: string, status: "resolved" | "unavailable") => void;
}) {
  const [updatedInput, setUpdatedInput] = useState(message.input ?? "");
  const [status, setStatus] = useState<
    "pending" | "allowing" | "denying" | "resolved" | "unavailable" | "error"
  >(message.requestId ? (message.status ?? "pending") : "resolved");
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<"allow" | "deny" | null>(null);

  const resolve = async (behavior: "allow" | "deny") => {
    if (!message.requestId) return;
    setStatus(behavior === "allow" ? "allowing" : "denying");
    setError(null);

    let parsedInput: JsonValue | null = null;
    if (behavior === "allow") {
      try {
        parsedInput = updatedInput.trim()
          ? (JSON.parse(updatedInput) as JsonValue)
          : {};
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
      if (!isJsonRecord(parsedInput)) {
        setStatus("error");
        setError("Updated input must be a JSON object");
        return;
      }
    }

    const result = await commands.resolvePermissionRequest({
      request_id: message.requestId,
      behavior,
      message: behavior === "deny" ? "Denied from Vertebrae GUI" : null,
      updated_input: behavior === "allow" ? parsedInput : null,
    });

    if (result.status === "ok") {
      setDecision(behavior);
      setStatus("resolved");
      onSettled?.(message.requestId, "resolved");
    } else {
      const unavailable =
        result.error.kind === "unavailable" ||
        result.error.kind === "not_found";
      setStatus(unavailable ? "unavailable" : "error");
      setError(result.error.message);
      if (unavailable) onSettled?.(message.requestId, "unavailable");
    }
  };

  const disabled =
    status === "allowing" ||
    status === "denying" ||
    status === "resolved" ||
    status === "unavailable";

  const settled = status === "resolved" || status === "unavailable";

  if (settled) {
    const outcome =
      status === "unavailable"
        ? "unavailable"
        : decision === "allow"
          ? "approved"
          : decision === "deny"
            ? "denied"
            : "resolved";
    return (
      <section
        className="needs-you-settled"
        data-outcome={outcome}
        aria-label={`Permission ${outcome}: ${message.toolName}`}
      >
        <span className="needs-you-settled-line">
          <span aria-hidden="true">{decision === "deny" ? "✕" : "✓"}</span>{" "}
          {message.toolName} {outcome}
        </span>
        {message.input ? (
          <details className="needs-you-details">
            <summary>Tool input</summary>
            <pre className="needs-you-input">{updatedInput}</pre>
          </details>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className="needs-you-card"
      data-settled={settled ? "" : undefined}
      aria-label={`Permission required: ${message.toolName}`}
    >
      <header className="needs-you-head">
        <p className="needs-you-eyebrow">Permission required</p>
        <span className="needs-you-tool">{message.toolName}</span>
      </header>
      <p className="needs-you-title">{message.message}</p>
      {message.input && (
        <textarea
          value={updatedInput}
          onChange={(event) => setUpdatedInput(event.target.value)}
          disabled={disabled}
          aria-label="Tool input"
          className="needs-you-input"
          spellCheck={false}
        />
      )}
      {error && (
        <p role="alert" className="needs-you-error">
          {error}
        </p>
      )}
      <div className="needs-you-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() => void resolve("allow")}
          className="needs-you-btn"
          data-primary=""
        >
          {status === "allowing" ? "Approving..." : "Approve"}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void resolve("deny")}
          className="needs-you-btn"
        >
          {status === "denying" ? "Denying..." : "Deny"}
        </button>
      </div>
    </section>
  );
}
