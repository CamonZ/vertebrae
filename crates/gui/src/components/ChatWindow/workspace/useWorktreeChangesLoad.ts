import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { backgroundClient } from "../../../background/client";
import type {
  BackgroundOutputs,
  BackgroundTask,
} from "../../../background/types";
import {
  commands,
  type ComparisonRequest,
  type WorktreeChanges as Changes,
} from "../../../bindings";
import type { WorktreeSnapshot } from "../../thread/toolChange/diffComments";

export type LoadState =
  | { status: "loading" }
  | {
      status: "error";
      message: string;
      /** Whether the failed load compared against the working copy. */
      workingTree: boolean;
    }
  | {
      status: "ready";
      data: Changes;
      wholeBranch: boolean;
      parsed: BackgroundOutputs["patch"];
    };

/** A reload request; a background one keeps the current list visible. */
export interface ChangesRefresh {
  count: number;
  background: boolean;
}

/**
 * Loads and parses the comparison's changes, again on every `refresh`.
 * Requests made while a load runs coalesce into one more load.
 * `onChangesLoaded` gets the parsed snapshot after every successful load.
 */
export function useWorktreeChangesLoad(
  worktreePath: string,
  comparisonRequest: ComparisonRequest,
  refresh: ChangesRefresh,
  onChangesLoaded?: (snapshot: WorktreeSnapshot) => void
) {
  const wholeBranch = comparisonRequest.merge_base;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);

  const requestLoad = useRef<(() => void) | null>(null);
  const refreshRef = useRef(refresh);
  useLayoutEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    let current = true;
    let running = false;
    let pending = false;
    const controller = new AbortController();

    const workingTree = comparisonRequest.target.kind === "working_tree";
    const load = async () => {
      pending = true;
      if (running) return;

      running = true;

      while (current && pending) {
        pending = false;
        if (!refreshRef.current.background) setState({ status: "loading" });

        try {
          const result = await commands.loadWorktreeChanges(
            worktreePath,
            comparisonRequest
          );
          if (!current) break;

          if (result.status === "error") {
            setState({
              status: "error",
              message: result.error.message,
              workingTree,
            });
          } else {
            const task: Extract<BackgroundTask, { kind: "patch" }> = {
              kind: "patch",
              patches: result.data.files.map((file) =>
                file.marker ? "" : file.patch
              ),
              review: true,
            };

            const parsed =
              typeof Worker === "undefined"
                ? (
                    await import("../../thread/toolChange/preparePatches")
                  ).preparePatches(task)
                : await backgroundClient.run(task, controller.signal);
            if (!current) break;

            setBaseBranch(result.data.base_branch);
            setState({
              status: "ready",
              data: result.data,
              wholeBranch,
              parsed,
            });
            setGeneration((value) => value + 1);
          }
        } catch (error) {
          if (current)
            setState({ status: "error", message: String(error), workingTree });
        }
      }

      running = false;
    };

    requestLoad.current = () => {
      void load();
    };

    return () => {
      current = false;
      controller.abort();
      requestLoad.current = null;
    };
  }, [worktreePath, wholeBranch, comparisonRequest]);

  useEffect(() => {
    requestLoad.current?.();
  }, [worktreePath, wholeBranch, comparisonRequest, refresh]);

  const onChangesLoadedRef = useRef(onChangesLoaded);
  useLayoutEffect(() => {
    onChangesLoadedRef.current = onChangesLoaded;
  });

  useEffect(() => {
    if (state.status !== "ready") return;

    onChangesLoadedRef.current?.({
      wholeBranch: state.wholeBranch,
      comparisonIdentity: JSON.stringify(state.data.comparison),
      comparison: state.data.comparison,
      files: state.parsed.flatMap((file) => file.reviewFiles),
    });
  }, [state]);

  return { state, generation, baseBranch };
}
