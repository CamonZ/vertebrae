import type { TaskLevel } from "../../bindings";

type LevelShape = "diamond-filled" | "diamond-hollow" | "dot";

function shapeFor(level: TaskLevel | null): { shape: LevelShape; label: string } {
  switch (level) {
    case "epic":
      return { shape: "diamond-filled", label: "Epic" };
    case "ticket":
      return { shape: "diamond-hollow", label: "Ticket" };
    case "task":
      return { shape: "dot", label: "Task" };
    default:
      return { shape: "dot", label: "Item" };
  }
}

interface LevelMarkProps {
  level: TaskLevel | null;
  /** Sizing/positioning for the centering box (e.g. "h-6 w-5"). */
  className?: string;
  testId?: string;
}

/**
 * The per-level mark used across task surfaces (tree, kanban, pipeline): a
 * filled diamond for epics, a hollow diamond for tickets, and a dot for tasks.
 *
 * Drawn as a CSS shape rather than a font glyph so every level gets a
 * consistent, hand-tuned size — font glyphs render the diamonds large and the
 * bullet tiny at the same font-size. The shape alone encodes the level, so it
 * stays a single neutral tone with no per-level coloring.
 */
export function LevelMark({ level, className, testId }: LevelMarkProps) {
  const { shape, label } = shapeFor(level);
  return (
    <span
      className={["inline-flex shrink-0 items-center justify-center", className]
        .filter(Boolean)
        .join(" ")}
      title={label}
      aria-label={`Level: ${label}`}
      data-testid={testId}
      data-level={level ?? "none"}
    >
      {shape === "dot" ? (
        <span
          data-shape="dot"
          className="block h-[7px] w-[7px] rounded-full bg-[var(--color-fg-soft)]"
        />
      ) : (
        <span
          data-shape={shape}
          className={[
            "block h-[7px] w-[7px] rotate-45 rounded-[1.5px]",
            shape === "diamond-filled"
              ? "bg-[var(--color-fg-soft)]"
              : "border-[1.5px] border-[var(--color-fg-soft)]",
          ].join(" ")}
        />
      )}
    </span>
  );
}
