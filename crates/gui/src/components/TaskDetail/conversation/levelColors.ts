/**
 * Task-level tint (epic / ticket / task) for the conversation log's thinking
 * blocks, keyed by the owning task's level.
 */
export const LEVEL_TINT_CLASS: Record<string, string> = {
  epic: "text-info",
  ticket: "text-accent",
  task: "text-fg-soft",
};

export function levelTintClass(level: string | null | undefined): string {
  return level && LEVEL_TINT_CLASS[level]
    ? LEVEL_TINT_CLASS[level]
    : "text-fg-soft";
}
