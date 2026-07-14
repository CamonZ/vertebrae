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
}: {
  message: Extract<ChatMessage, { kind: "permission_request" }>;
}) {
  const [updatedInput, setUpdatedInput] = useState(message.input ?? "");
  const [status, setStatus] = useState<
    | "pending"
    | "allowing"
    | "denying"
    | "resolved"
    | "unavailable"
    | "error"
  >(message.requestId ? "pending" : "resolved");
  const [error, setError] = useState<string | null>(null);

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
      setStatus("resolved");
    } else {
      setStatus(
        result.error.kind === "unavailable" ||
          result.error.kind === "not_found"
          ? "unavailable"
          : "error"
      );
      setError(result.error.message);
    }
  };

  const disabled =
    status === "allowing" ||
    status === "denying" ||
    status === "resolved" ||
    status === "unavailable";

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-bg-2)] p-3">
      <p className="mb-2 font-mono text-eyebrow uppercase tracking-wider text-[var(--color-fg-mute)]">
        Permission required
      </p>
      <div className="space-y-3">
        <div>
          <p className="font-mono text-xs text-[var(--color-fg)]">
            {message.toolName}
          </p>
          <p className="mt-1 text-sm text-[var(--color-fg-soft)]">
            {message.message}
          </p>
        </div>
        {message.input && (
          <textarea
            value={updatedInput}
            onChange={(event) => setUpdatedInput(event.target.value)}
            disabled={disabled}
            className="h-32 w-full resize-y rounded border border-[var(--color-line)] bg-[var(--color-bg)] p-2 font-mono text-xs text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            spellCheck={false}
          />
        )}
        {error && <p className="text-xs text-[var(--color-err)]">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void resolve("allow")}
            className="rounded border border-[var(--color-ok)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-ok)] transition-colors hover:bg-[var(--color-ok)]/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "allowing" ? "Approving..." : "Approve"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void resolve("deny")}
            className="rounded border border-[var(--color-err)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-err)] transition-colors hover:bg-[var(--color-err)]/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "denying" ? "Denying..." : "Deny"}
          </button>
          {status === "resolved" && (
            <span className="self-center text-xs text-[var(--color-fg-mute)]">
              Resolved
            </span>
          )}
          {status === "unavailable" && (
            <span className="self-center text-xs text-[var(--color-fg-mute)]">
              Unavailable
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
