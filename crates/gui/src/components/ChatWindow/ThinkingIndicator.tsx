/**
 * Thinking indicator shown while waiting for Claude to respond
 */
export function ThinkingIndicator({
  label = "Thinking...",
}: {
  label?: string;
}) {
  return (
    <div className="flex justify-start" role="status" aria-live="polite">
      <div className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-2)] px-4 py-3">
        <div className="flex gap-1">
          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)] [animation-delay:-0.3s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)] [animation-delay:-0.15s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)]" />
        </div>
        <span className="text-sm text-[var(--color-fg-mute)]">{label}</span>
      </div>
    </div>
  );
}
