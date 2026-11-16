import { useEffect, useRef, useState } from "react";
import { commands } from "../bindings";
import { useUIStore } from "../stores/uiStore";

/** One configured-editor launch owner, shared by inline links and toolbars. */
export function useOpenLocalFile(
  root: string,
  path: string,
  line: number | null,
  column: number | null
) {
  const editor = useUIStore((state) => state.externalEditor);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef({ root, path, busy: false });
  useEffect(() => {
    const current = { root, path, busy: false };
    scope.current = current;
    setOpening(false);
    setError(null);

    return () => {
      if (scope.current === current)
        scope.current = { root: "", path: "", busy: false };
    };
  }, [root, path]);

  const open = async () => {
    const current = scope.current;

    if (current.busy || current.root !== root || current.path !== path) return;

    current.busy = true;
    setOpening(true);
    setError(null);

    try {
      const result = await commands.openLocalFile(
        root,
        path,
        line,
        column,
        editor.trim() || null
      );

      if (scope.current === current && result.status === "error")
        setError(result.error.message);
    } catch (reason) {
      if (scope.current === current) setError(String(reason));
    } finally {
      current.busy = false;

      if (scope.current === current) setOpening(false);
    }
  };

  return { open, opening, error };
}
