import {
  useCallback,
  useDeferredValue,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { normalizeFindQuery } from "../thread/find";
import { PaneFindBar } from "./PaneFindBar";

/**
 * Per-pane find state. `findQuery` feeds ThreadFindContext; `openFind` is
 * registered with the chat manager for ⌘F.
 */
export function usePaneFind(containerRef: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const findQuery = useDeferredValue(open ? normalizeFindQuery(query) : "");

  const openFind = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return true;
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const bar: ReactNode = open ? (
    <PaneFindBar
      containerRef={containerRef}
      inputRef={inputRef}
      query={query}
      activeQuery={findQuery}
      onQueryChange={setQuery}
      onClose={close}
    />
  ) : null;

  return { findQuery, openFind, bar };
}
