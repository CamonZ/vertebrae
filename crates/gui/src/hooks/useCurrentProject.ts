import { useEffect, useState } from "react";
import { commands } from "../bindings";

interface CurrentProject {
  /** Last segment of the project path — used for breadcrumb + avatar monogram. */
  name: string | null;
  /** Full filesystem path. */
  path: string | null;
}

const EMPTY: CurrentProject = { name: null, path: null };

let currentProjectRequest: Promise<CurrentProject> | null = null;

async function loadCurrentProject(): Promise<CurrentProject> {
  try {
    const result = await commands.getCurrentProject();
    if (result.status === "ok" && result.data) {
      const parts = result.data.split("/").filter(Boolean);
      return {
        name: parts[parts.length - 1] ?? null,
        path: result.data,
      };
    }
  } catch {
    // Treat command failures the same as no loaded project.
  }
  return EMPTY;
}

/**
 * Subscribes to the currently-loaded project. Concurrent shell consumers share
 * one command request, while later remounts can observe project changes.
 */
export function useCurrentProject(): CurrentProject {
  const [state, setState] = useState<CurrentProject>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const request = (currentProjectRequest ??= loadCurrentProject());
    request.then((project) => {
      if (!cancelled) setState(project);
    });
    request.finally(() => {
      if (currentProjectRequest === request) currentProjectRequest = null;
    });
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
