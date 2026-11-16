import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AtlasGraphLevel } from "./adapter/atlasLevels";
import type { LevelIndexItem } from "./adapter/levelIndex";

interface LevelIndexProps {
  level: AtlasGraphLevel;
  items: readonly LevelIndexItem[];
  /** Row lit from the scene: the part the pointer or focus is on there. */
  hotId: string | null;
  /** Row the pointer or focus is on here; the scene traces it. */
  onPoint: (id: string | null) => void;
  onActivate: (item: LevelIndexItem) => void;
}

const TITLE: Record<AtlasGraphLevel["kind"], string> = {
  factories: "Factories",
  workflows: "Workflows",
  steps: "Steps",
};

const HINT: Record<AtlasGraphLevel["kind"], string> = {
  factories: "Open a factory to see its workflows.",
  workflows: "Open a workflow to see its steps.",
  steps: "Select a step to inspect it.",
};

const EMPTY: Record<AtlasGraphLevel["kind"], string> = {
  factories: "No factories yet",
  workflows: "No workflows in this factory",
  steps: "This workflow has no steps",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The list beside a Graph level: one row per element the level draws.
 * Pointing at a row traces its element on the scene, and pointing at an
 * element on the scene lights its row. Rows open the level below (factories,
 * workflows) or inspect the step; arrow keys move between them.
 */
export function LevelIndex({
  level,
  items,
  hotId,
  onPoint,
  onActivate,
}: LevelIndexProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.min(focusIndex, Math.max(0, items.length - 1));

  // Bring a row lit from the scene into view without stealing focus.
  useEffect(() => {
    if (hotId === null) return;
    const index = items.findIndex((item) => item.id === hotId);
    rowRefs.current[index]?.scrollIntoView?.({ block: "nearest" });
    // items follows the level; hotId is the only trigger that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const moves: Record<string, number> = {
      ArrowDown: activeIndex + 1,
      ArrowUp: activeIndex - 1,
      Home: 0,
      End: items.length - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(items.length - 1, moves[event.key]));
    setFocusIndex(next);
    rowRefs.current[next]?.focus();
  };

  return (
    <nav
      className="factory-index level-index"
      aria-label={TITLE[level.kind]}
      data-no-pan
      data-testid="atlas-level-index"
      data-level={level.kind}
    >
      <header className="factory-index-head">
        <h2 className="factory-index-title">{TITLE[level.kind]}</h2>
        <span className="factory-index-count">{items.length}</span>
      </header>
      <p className="factory-index-hint">{HINT[level.kind]}</p>

      {items.length === 0 ? (
        <div className="factory-index-empty" role="status">
          <span>{EMPTY[level.kind]}</span>
        </div>
      ) : (
        <ul className="factory-index-list" onKeyDown={handleKeyDown}>
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                ref={(element) => {
                  rowRefs.current[index] = element;
                }}
                className={
                  "factory-index-row" + (item.id === hotId ? " is-hot" : "")
                }
                data-testid={`atlas-level-row-${item.name}`}
                tabIndex={index === activeIndex ? 0 : -1}
                title={item.name}
                onMouseEnter={() => onPoint(item.id)}
                onMouseLeave={() => onPoint(null)}
                onFocus={() => {
                  setFocusIndex(index);
                  onPoint(item.id);
                }}
                onBlur={() => onPoint(null)}
                onClick={() => onActivate(item)}
              >
                <span className="factory-index-name">{item.name}</span>
                <span className="factory-index-meta">
                  {item.detail && <span>{item.detail}</span>}
                  {item.total > 0 && <span>{plural(item.total, "task")}</span>}
                  {item.running > 0 && (
                    <span className="factory-index-active">
                      <i aria-hidden="true" />
                      {item.running} running
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
