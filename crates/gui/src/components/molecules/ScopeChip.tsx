import { Badge } from "../atoms/Badge";

/**
 * A filter chip with an optional count, used in a `.scope-primary` group
 * (Tasks status scopes, Artifacts type filter).
 */
export function ScopeChip({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count?: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-empty={count === 0 && !active ? true : undefined}
      className={["scope-chip", active ? "active" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <span>{label}</span>
      {count != null && (
        <Badge count={count} intent={active ? "accent" : "neutral"} />
      )}
    </button>
  );
}
