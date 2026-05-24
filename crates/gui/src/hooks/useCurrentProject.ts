import { useEffect, useState } from "react";
import { commands } from "../bindings";

interface CurrentProject {
  /** Last segment of the project path — used for breadcrumb + avatar monogram. */
  name: string | null;
  /** Full filesystem path. */
  path: string | null;
}

const EMPTY: CurrentProject = { name: null, path: null };

/**
 * Subscribes to the currently-loaded project. Polls once on mount; the rest
 * of the app refreshes this implicitly by navigating to /setup on switch.
 */
export function useCurrentProject(): CurrentProject {
  const [state, setState] = useState<CurrentProject>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await commands.getCurrentProject();
        if (cancelled) return;
        if (result.status === "ok" && result.data) {
          const parts = result.data.split("/").filter(Boolean);
          setState({
            name: parts[parts.length - 1] ?? null,
            path: result.data,
          });
        } else {
          setState(EMPTY);
        }
      } catch {
        if (!cancelled) setState(EMPTY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * Deterministic project-avatar bucket [0,7] derived from the project name.
 * Used to map a project to one of eight palette swatches without any user
 * setup. Pure FNV-1a 32-bit hash, modulo 8.
 */
export function projectAvatarBucket(name: string | null | undefined): number {
  if (!name) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % 8;
}
