import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { FactoryFilterValue } from "../../utils/workflowFactory";
import {
  factoryGroupKey,
  type FactoryOverviewGroup,
} from "./factoryOverviewModel";

interface FactoryIndexProps {
  /** Factories to list, already filtered by the search query. */
  groups: FactoryOverviewGroup[];
  /** How many factories exist before the search filter. */
  totalCount: number;
  query: string;
  /** Group key highlighted from either the list or the map. */
  hotKey: string | null;
  /** Group key of the factory the user last opened, if still present. */
  recentKey: string | null;
  /** Number of other factories each factory hands work to or from. */
  linkCounts: ReadonlyMap<string, number>;
  onHover: (key: string | null) => void;
  onSelect: (scope: FactoryFilterValue) => void;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The calm, scannable entry point to the factory overview: one row per factory
 * with its name and size, linked both ways to the factory markers on the map.
 * Rows are buttons that open the factory; arrow keys move between them.
 */
export function FactoryIndex({
  groups,
  totalCount,
  query,
  hotKey,
  recentKey,
  linkCounts,
  onHover,
  onSelect,
}: FactoryIndexProps) {
  const keys = groups.map(factoryGroupKey);
  const initialIndex = Math.max(0, recentKey ? keys.indexOf(recentKey) : 0);
  const [focusIndex, setFocusIndex] = useState(initialIndex);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.min(focusIndex, Math.max(0, groups.length - 1));

  // Bring a factory hovered on the map into view without stealing focus.
  useEffect(() => {
    if (hotKey === null) return;
    const row = rowRefs.current[keys.indexOf(hotKey)];
    row?.scrollIntoView?.({ block: "nearest" });
    // keys is derived from groups; hotKey is the only trigger that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotKey]);

  const moveFocus = (index: number) => {
    const next = Math.max(0, Math.min(groups.length - 1, index));
    setFocusIndex(next);
    rowRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const keyMoves: Record<string, number> = {
      ArrowDown: activeIndex + 1,
      ArrowUp: activeIndex - 1,
      Home: 0,
      End: groups.length - 1,
    };
    if (!(event.key in keyMoves)) return;
    event.preventDefault();
    moveFocus(keyMoves[event.key]);
  };

  const trimmedQuery = query.trim();

  return (
    <nav
      className="factory-index"
      aria-label="Factories"
      data-no-pan
      data-testid="factory-index"
    >
      <header className="factory-index-head">
        <h2 className="factory-index-title">Factories</h2>
        <span className="factory-index-count">
          {trimmedQuery && groups.length !== totalCount
            ? `${groups.length} of ${totalCount}`
            : totalCount}
        </span>
      </header>
      <p className="factory-index-hint">
        Open a factory to work inside its workflows.
      </p>

      {groups.length === 0 ? (
        <div className="factory-index-empty" role="status">
          {trimmedQuery ? (
            <>
              <span>No factories match</span>
              <q>{trimmedQuery}</q>
            </>
          ) : (
            <>
              <span>No factories yet</span>
              <small>
                Workflows appear here grouped by their factory once the project
                has some.
              </small>
            </>
          )}
        </div>
      ) : (
        <ul className="factory-index-list" onKeyDown={handleKeyDown}>
          {groups.map((group, index) => {
            const key = keys[index];
            const isHot = key === hotKey;
            const isRecent = key === recentKey;
            const links = linkCounts.get(key) ?? 0;
            return (
              <li key={key}>
                <button
                  type="button"
                  ref={(element) => {
                    rowRefs.current[index] = element;
                  }}
                  className={
                    "factory-index-row" +
                    (isHot ? " is-hot" : "") +
                    (isRecent ? " is-recent" : "")
                  }
                  data-testid={`factory-index-row-${group.name}`}
                  tabIndex={index === activeIndex ? 0 : -1}
                  title={group.name}
                  aria-current={isRecent ? "location" : undefined}
                  onMouseEnter={() => onHover(key)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => {
                    setFocusIndex(index);
                    onHover(key);
                  }}
                  onBlur={() => onHover(null)}
                  onClick={() => onSelect(group.scope)}
                >
                  <span className="factory-index-name">{group.name}</span>
                  <span className="factory-index-meta">
                    <span>{plural(group.workflowCount, "workflow")}</span>
                    {group.workItemCount > 0 && (
                      <span>{plural(group.workItemCount, "item")}</span>
                    )}
                    {links > 0 && <span>{plural(links, "link")}</span>}
                  </span>
                  {(group.activeCount > 0 || isRecent) && (
                    <span className="factory-index-tags">
                      {group.activeCount > 0 && (
                        <span className="factory-index-active">
                          <i aria-hidden="true" />
                          {group.activeCount} active
                        </span>
                      )}
                      {isRecent && (
                        <span className="factory-index-recent">
                          last opened
                        </span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
