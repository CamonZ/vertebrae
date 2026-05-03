/**
 * Model -> max context window lookup table.
 *
 * Per-model maxes are user-specified and may NOT match the backend's
 * hardcoded fallback (200k). The frontend lookup table is the source of
 * truth for the displayed max in the chat utilization badge.
 *
 * Keys are matched as case-insensitive substrings against the model name
 * reported by Claude CLI (e.g. "claude-opus-4-7-20250115").
 */
// Each model appears twice: hyphen format (4-7) for date-stamped CLI names
// like "claude-opus-4-7-20250115", and dot format (4.7) for aliased names.
// Both are needed because Claude CLI uses both in different output contexts.
const MODEL_CONTEXT_WINDOW: Array<{ pattern: string; max: number }> = [
  { pattern: "opus-4-7", max: 1_000_000 },
  { pattern: "opus-4.7", max: 1_000_000 },
  { pattern: "sonnet-4-6", max: 600_000 },
  { pattern: "sonnet-4.6", max: 600_000 },
  { pattern: "haiku-4-5", max: 200_000 },
  { pattern: "haiku-4.5", max: 200_000 },
];

/**
 * Resolve the max context window for a model name.
 *
 * Returns the value from the lookup table when the model matches a known
 * pattern; otherwise returns `fallback` (the backend-supplied
 * `context_window`, or undefined).
 */
export function resolveContextWindow(
  model: string | undefined,
  fallback: number | undefined
): number | undefined {
  if (model) {
    const lower = model.toLowerCase();
    for (const entry of MODEL_CONTEXT_WINDOW) {
      if (lower.includes(entry.pattern)) {
        return entry.max;
      }
    }
  }
  return fallback;
}

/**
 * Format a token count compactly for the badge ("142k", "1M", "12.3k").
 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m >= 10 || Number.isInteger(m) ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  return `${n}`;
}

/**
 * Severity bucket for the badge colour. >=90% danger, >=70% warn, else ok.
 */
export type UtilizationLevel = "ok" | "warn" | "danger";

export function utilizationLevel(used: number, max: number): UtilizationLevel {
  if (max <= 0) return "ok";
  const pct = used / max;
  if (pct >= 0.9) return "danger";
  if (pct >= 0.7) return "warn";
  return "ok";
}
