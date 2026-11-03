import { parsePatchFiles } from "@pierre/diffs";
import { parsePatch } from "./diffLineMapper";
import type {
  BackgroundTask,
  BackgroundOutputs,
} from "../../../background/types";

/** Shared implementation for worker execution and environments without Worker support. */
export function preparePatches(
  task: Extract<BackgroundTask, { kind: "patch" }>
): BackgroundOutputs["patch"] {
  return task.patches.map((patch) => {
    let files: BackgroundOutputs["patch"][number]["files"] = [];

    try {
      files = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
    } catch {
      files = null;
    }

    return { files, reviewFiles: task.review ? parsePatch(patch) : [] };
  });
}
