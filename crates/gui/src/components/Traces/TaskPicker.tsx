import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Task } from "../../bindings";
import { ScanIdentifier } from "../shared/EntityId";

export interface TaskPickerProps {
  /** Tasks available to be picked. */
  tasks: Task[];
  /** Called with the chosen task's id when the user selects one. */
  onSelect: (taskId: string) => void;
  /** Maximum number of results to show in the list. Defaults to 50. */
  maxResults?: number;
  /** Optional placeholder text for the search input. */
  placeholder?: string;
  /** Optional auto-focus on mount. Defaults to true. */
  autoFocus?: boolean;
}

export interface TaskPickerHandle {
  focus: () => void;
}

/** Case-insensitive filter by title or id-prefix. */
export function filterTasksForPicker(tasks: Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) => {
    const title = t.title?.toLowerCase() ?? "";
    const id = t.id?.toLowerCase() ?? "";
    return title.includes(q) || id.startsWith(q);
  });
}

/**
 * TaskPicker — a search input + filtered task list with keyboard navigation.
 *
 * Keyboard:
 *   - ArrowDown / ArrowUp: move highlight
 *   - Enter: select highlighted task
 *   - Escape: clear the query (and blur if already empty)
 */
export const TaskPicker = forwardRef<TaskPickerHandle, TaskPickerProps>(
  function TaskPicker(
    { tasks, onSelect, maxResults = 50, placeholder, autoFocus = true },
    ref
  ): ReactNode {
    const [query, setQuery] = useState("");
    const [highlightIndex, setHighlightIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          inputRef.current?.focus();
          inputRef.current?.select();
        },
      }),
      []
    );

    useEffect(() => {
      if (autoFocus) {
        inputRef.current?.focus();
      }
    }, [autoFocus]);

    const filtered = useMemo(
      () => filterTasksForPicker(tasks, query).slice(0, maxResults),
      [tasks, query, maxResults]
    );

    // Keep highlight clamped to filtered results.
    useEffect(() => {
      setHighlightIndex((idx) => {
        if (filtered.length === 0) return 0;
        if (idx >= filtered.length) return filtered.length - 1;
        if (idx < 0) return 0;
        return idx;
      });
    }, [filtered.length]);

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlightIndex((idx) =>
            filtered.length === 0 ? 0 : Math.min(idx + 1, filtered.length - 1)
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlightIndex((idx) => Math.max(idx - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const chosen = filtered[highlightIndex];
          if (chosen) onSelect(chosen.id);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          if (query) {
            setQuery("");
            setHighlightIndex(0);
          } else {
            inputRef.current?.blur();
          }
          return;
        }
      },
      [filtered, highlightIndex, onSelect, query]
    );

    return (
      <div
        data-testid="task-picker"
        className="flex h-full min-h-0 w-full flex-col gap-2"
      >
        <input
          ref={inputRef}
          data-testid="task-picker-input"
          type="text"
          role="combobox"
          aria-expanded={filtered.length > 0}
          aria-controls="task-picker-listbox"
          aria-activedescendant={
            filtered[highlightIndex]
              ? `task-picker-option-${filtered[highlightIndex].id}`
              : undefined
          }
          value={query}
          placeholder={placeholder ?? "Search tasks by title or id…"}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlightIndex(0);
          }}
          onKeyDown={handleKeyDown}
          className="w-full rounded border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />

        <ul
          id="task-picker-listbox"
          role="listbox"
          data-testid="task-picker-list"
          className="min-h-0 flex-1 overflow-y-auto rounded border border-border bg-bg-secondary"
        >
          {filtered.length === 0 && (
            <li
              data-testid="task-picker-empty"
              className="px-3 py-2 text-xs text-text-muted"
            >
              {tasks.length === 0
                ? "No tasks available."
                : "No tasks match your search."}
            </li>
          )}
          {filtered.map((t, i) => {
            const isHighlighted = i === highlightIndex;
            return (
              <li
                key={t.id}
                id={`task-picker-option-${t.id}`}
                role="option"
                aria-selected={isHighlighted}
                data-testid={`task-picker-option-${t.id}`}
                data-highlighted={isHighlighted ? "true" : undefined}
                onMouseEnter={() => setHighlightIndex(i)}
                onClick={() => onSelect(t.id)}
                className={`flex cursor-pointer flex-col gap-0.5 border-b border-border/40 px-3 py-2 text-sm last:border-b-0 ${
                  isHighlighted
                    ? "bg-primary/10 text-primary"
                    : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <span className="truncate font-medium">{t.title}</span>
                <span className="flex items-center gap-1 font-mono text-[10px] text-text-muted">
                  <ScanIdentifier
                    id={t.id}
                    kind="task"
                    className="text-[10px]"
                    testId="task-picker-task-id"
                  />
                  {t.level ? <span>· {t.level}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
);
