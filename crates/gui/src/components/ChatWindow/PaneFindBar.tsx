import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

const MATCH = "[data-find-match]";
const CURRENT = "data-find-current";

interface PaneFindBarProps {
  /** Transcript element whose matched rows the bar steps through. */
  containerRef: RefObject<HTMLElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  /** Normalized query the transcript is rendering matches for. */
  activeQuery: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}

/**
 * Find bar for one chat pane. Matching happens on the Thread model (see
 * thread/find.ts), which marks matched rows and opens collapsed bodies; the
 * bar counts those rows and scrolls between them.
 */
export function PaneFindBar({
  containerRef,
  inputRef,
  query,
  activeQuery,
  onQueryChange,
  onClose,
}: PaneFindBarProps) {
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);

  const matches = useCallback(
    () => [
      ...(containerRef.current?.querySelectorAll<HTMLElement>(MATCH) ?? []),
    ],
    [containerRef]
  );

  const show = useCallback(
    (next: number, scroll: boolean) => {
      const all = matches();
      for (const el of containerRef.current?.querySelectorAll(`[${CURRENT}]`) ??
        [])
        el.removeAttribute(CURRENT);
      setCount(all.length);
      if (!all.length) {
        indexRef.current = 0;
        setIndex(0);
        return;
      }
      const wrapped = ((next % all.length) + all.length) % all.length;
      indexRef.current = wrapped;
      setIndex(wrapped);
      all[wrapped].setAttribute(CURRENT, "");
      if (scroll)
        all[wrapped].scrollIntoView?.({ block: "center", inline: "nearest" });
    },
    [containerRef, matches]
  );

  // A new query starts at its first match once the transcript re-rendered.
  useLayoutEffect(() => {
    show(0, true);
  }, [activeQuery, show]);

  // Live transcripts add or remove matches; keep the count and mark current.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => show(indexRef.current, false));
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [containerRef, show]);

  useEffect(
    () => () => {
      for (const el of containerRef.current?.querySelectorAll(`[${CURRENT}]`) ??
        [])
        el.removeAttribute(CURRENT);
    },
    [containerRef]
  );

  return (
    <div className="hc-find" data-pane-find role="search">
      <input
        ref={inputRef}
        className="hc-find-input"
        type="search"
        value={query}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        data-testid="pane-find-input"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            show(indexRef.current + (event.shiftKey ? -1 : 1), true);
          }
        }}
      />
      <span
        className="hc-find-count"
        data-testid="pane-find-count"
        aria-live="polite"
      >
        {activeQuery ? (count ? `${index + 1}/${count}` : "0/0") : ""}
      </span>
      <button
        type="button"
        className="hc-ctrl"
        aria-label="Previous match"
        title="Previous match (⇧↩)"
        disabled={!count}
        onClick={() => show(indexRef.current - 1, true)}
      >
        ↑
      </button>
      <button
        type="button"
        className="hc-ctrl"
        aria-label="Next match"
        title="Next match (↩)"
        disabled={!count}
        onClick={() => show(indexRef.current + 1, true)}
      >
        ↓
      </button>
      <button
        type="button"
        className="hc-ctrl"
        aria-label="Close find"
        title="Close find (Esc)"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
