import { useCallback, useEffect, useRef, useState } from "react";

export type SkillFileState = "idle" | "queued" | "linking" | "linked";

/**
 * Per-file link states for project skill installation, shared by first-run
 * setup and the sidebar add-project dialog. Files move queued → linking →
 * linked; the linking → linked hop is delayed 250ms so the in-flight state
 * stays visible even when the backend links a file instantly.
 */
export function useSkillFileStates() {
  const timers = useRef<number[]>([]);
  const [fileStates, setFileStates] = useState<Record<string, SkillFileState>>(
    {}
  );

  useEffect(() => {
    return () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current = [];
    };
  }, []);

  const markFileLinking = useCallback((relativePath: string) => {
    setFileStates((current) => ({
      ...current,
      [relativePath]: "linking",
    }));
    const timer = window.setTimeout(() => {
      setFileStates((current) => ({
        ...current,
        [relativePath]: "linked",
      }));
    }, 250);
    timers.current.push(timer);
  }, []);

  const queueFiles = useCallback((paths: string[]) => {
    setFileStates(Object.fromEntries(paths.map((path) => [path, "queued"])));
  }, []);

  const markAllLinked = useCallback((paths: string[]) => {
    setFileStates(Object.fromEntries(paths.map((path) => [path, "linked"])));
  }, []);

  const resetFileStates = useCallback(() => {
    setFileStates({});
  }, []);

  return {
    fileStates,
    queueFiles,
    markFileLinking,
    markAllLinked,
    resetFileStates,
  };
}
