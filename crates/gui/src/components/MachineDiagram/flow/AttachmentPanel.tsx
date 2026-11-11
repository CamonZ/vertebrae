import { useContext } from "react";
import { EvidenceNavigationContext } from "../../shared/EvidenceNavigationContext";
import { useFlowRegistry } from "./registryContext";
import type { AttachmentSpec } from "./spec";

/** The host knows only common evidence metadata, never individual kinds. */
export function AttachmentPanel({
  attachments,
  label = "Evidence",
}: {
  attachments: readonly AttachmentSpec[];
  label?: string;
}) {
  const registry = useFlowRegistry();
  const openSource = useContext(EvidenceNavigationContext);
  if (!attachments.length) return null;
  return (
    <ul aria-label={label} className="mt-2 flex min-w-0 flex-col gap-2 text-xs">
      {attachments.map((a, i) => (
        <li
          key={a.id ?? `${a.kind}:${i}`}
          className="min-w-0 rounded border border-[var(--color-line)] p-2"
        >
          <div className="mb-1 flex flex-wrap gap-x-2 gap-y-1">
            <strong>{a.title ?? a.kind}</strong>
            <span
              className={
                a.status === "verified"
                  ? "text-[var(--color-ok)]"
                  : "text-fg-mute"
              }
            >
              {a.status ?? "inferred"}
            </span>
            <span className="text-fg-mute">
              {a.source === "trace" ? "recorded trace" : "scenario"}
            </span>
          </div>
          {registry.attachments.get(a.kind)?.render?.(a, { openSource }) ?? (
            <p>No renderer registered for {a.kind}.</p>
          )}
        </li>
      ))}
    </ul>
  );
}
